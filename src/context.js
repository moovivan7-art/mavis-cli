/**
 * Контекст диалога — что агент реально видит.
 *
 * Три сущности, которые важно не путать:
 *
 *   1. messages — сырые сообщения, которые уходят в модель (реплики + tool-обвязка).
 *   2. диалоговые сообщения — реплики пользователя и текстовые ответы агента, без tool_use/tool_result.
 *      Именно их человек имеет в виду под «последние 5–6 сообщений».
 *   3. recap — компактный пересказ всех раундов диалога. Переживает обрезку сырых сообщений,
 *      поэтому модель всегда помнит, о чём шла речь, даже если ранние реплики уже выпали из окна.
 *
 * Модуль чистый: никакого состояния, только функции. Так его легко покрыть тестами.
 */

export const DEFAULT_CONTEXT_MESSAGES = 6;
export const DEFAULT_HISTORY_LIMIT = 60;
export const DEFAULT_RECAP_LIMIT = 24;

/** Пользовательское сообщение, состоящее только из результатов инструментов (не реплика). */
export function isToolResultOnly(message) {
  if (!message || message.role !== 'user' || !Array.isArray(message.content)) return false;
  return message.content.length > 0 && message.content.every((b) => b.type === 'tool_result');
}

/** Реплика человека или текстовый ответ агента — то, что человек считает «сообщением». */
export function isConversational(message) {
  if (!message || !message.role) return false;
  if (message.role === 'user') {
    if (typeof message.content === 'string') return message.content.trim().length > 0;
    if (Array.isArray(message.content)) {
      return message.content.some((b) => b.type === 'text' && String(b.text || '').trim().length > 0);
    }
    return false;
  }
  if (message.role === 'assistant' && Array.isArray(message.content)) {
    return message.content.some((b) => b.type === 'text' && String(b.text || '').trim().length > 0);
  }
  return false;
}

/** Текст сообщения без tool-блоков. */
export function textOf(message) {
  if (!message) return '';
  if (typeof message.content === 'string') return message.content.trim();
  if (!Array.isArray(message.content)) return '';
  return message.content
    .filter((b) => b.type === 'text' && b.text)
    .map((b) => b.text)
    .join('\n')
    .trim();
}

function oneLine(text, max = 200) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  return s.length <= max ? s : `${s.slice(0, max)}…`;
}

/**
 * Чистит историю перед отправкой в модель.
 *
 * API Anthropic строгий: у каждого tool_use должен быть парный tool_result, первое сообщение
 * должно быть от пользователя, а пустой content[] недопустим. Битая сохранённая сессия
 * (процесс убили посреди работы инструмента) иначе ломает весь диалог — поэтому чистим.
 */
export function sanitizeMessages(messages) {
  if (!Array.isArray(messages)) return [];
  let list = messages.filter((m) => m && m.role);

  // Отрезаем всё до первой настоящей реплики пользователя: API требует user первым,
  // и сиротские tool_result в этом префиксе нам не нужны.
  const firstUser = list.findIndex((m) => m.role === 'user' && !isToolResultOnly(m));
  if (firstUser === -1) return [];
  if (firstUser > 0) list = list.slice(firstUser);

  const useIds = new Set();
  const resultIds = new Set();
  for (const m of list) {
    if (!Array.isArray(m.content)) continue;
    for (const b of m.content) {
      if (b.type === 'tool_use' && b.id) useIds.add(b.id);
      if (b.type === 'tool_result' && b.tool_use_id) resultIds.add(b.tool_use_id);
    }
  }

  const out = [];
  for (const m of list) {
    if (m.role === 'assistant') {
      const blocks = Array.isArray(m.content) ? m.content : [];
      const kept = blocks.filter((b) => {
        if (b.type === 'tool_use') return !!b.id && resultIds.has(b.id);
        if (b.type === 'text') return String(b.text || '').trim().length > 0;
        return true;
      });
      if (!kept.length) continue;
      out.push({ role: 'assistant', content: kept });
      continue;
    }
    if (m.role === 'user' && Array.isArray(m.content)) {
      const kept = m.content.filter((b) => {
        if (b.type === 'tool_result') return !!b.tool_use_id && useIds.has(b.tool_use_id);
        if (b.type === 'text') return String(b.text || '').trim().length > 0;
        return true;
      });
      if (!kept.length) continue;
      out.push({ role: 'user', content: kept });
      continue;
    }
    if (m.role === 'user' && typeof m.content === 'string') {
      if (!m.content.trim()) continue;
      out.push({ role: 'user', content: m.content });
      continue;
    }
    out.push(m);
  }
  return out;
}

/**
 * Сдвигает начало окна так, чтобы оно не попало в середину связки tool_use → tool_result
 * и начиналось с обычной реплики пользователя.
 */
function alignStart(messages, start) {
  let s = Math.max(0, Math.min(start, messages.length - 1));
  while (s > 0) {
    const m = messages[s];
    if (m.role === 'user' && !isToolResultOnly(m)) break;
    s--;
  }
  return s;
}

/** Склеивает соседние сообщения одной роли — чтобы чередование user/assistant не ломалось. */
function mergeSameRole(messages) {
  const out = [];
  for (const m of messages) {
    const last = out[out.length - 1];
    if (last && last.role === m.role) {
      if (typeof last.content === 'string' && typeof m.content === 'string') {
        last.content = `${last.content}\n\n${m.content}`;
      } else if (Array.isArray(last.content) && Array.isArray(m.content)) {
        last.content = [...last.content, ...m.content];
      } else {
        const a = typeof last.content === 'string' ? [{ type: 'text', text: last.content }] : last.content;
        const b = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content;
        last.content = [...a, ...b];
      }
      continue;
    }
    out.push({ ...m });
  }
  return out;
}

/**
 * Старую tool-обвязку (за пределами нужных реплик) превращает в обычный текст.
 * Так контекст не растёт от служебных сообщений, но агент всё равно видит, что делал.
 */
function collapseToolTraffic(messages, keepFrom) {
  const head = messages.slice(0, keepFrom);
  const tail = messages.slice(keepFrom);
  const collapsed = [];

  for (const m of head) {
    if (m.role === 'assistant' && Array.isArray(m.content)) {
      const calls = m.content.filter((b) => b.type === 'tool_use');
      const texts = m.content.filter((b) => b.type === 'text').map((b) => b.text).filter(Boolean);
      if (calls.length) {
        const names = [...new Set(calls.map((b) => b.name))].join(', ');
        collapsed.push({ role: 'user', content: `⚙ инструменты: ${names} — вызовы выполнены (подробности выпали из окна)` });
        if (texts.length) collapsed.push({ role: 'assistant', content: [{ type: 'text', text: texts.join('\n') }] });
        continue;
      }
    }
    if (isToolResultOnly(m)) continue; // результат уже отражён в сводке
    collapsed.push(m);
  }
  return mergeSameRole(collapsed).concat(tail);
}

/**
 * Оставляет в окне последние `contextMessages` диалоговых сообщений (реплики + ответы агента)
 * вместе со всей tool-обвязкой между ними, но не больше `historyLimit` сырых сообщений.
 *
 * Старый код резал по счётчику сырых сообщений: два десятка вызовов инструментов выедали
 * исходную задачу, и модель отвечала вслепую. Теперь считаем именно реплики.
 */
export function trimMessages(
  messages,
  { contextMessages = DEFAULT_CONTEXT_MESSAGES, historyLimit = DEFAULT_HISTORY_LIMIT } = {},
) {
  if (!Array.isArray(messages) || messages.length <= 1) return Array.isArray(messages) ? messages : [];
  const keepConv = Math.max(2, Number(contextMessages) || DEFAULT_CONTEXT_MESSAGES);
  const limitRaw = Math.max(keepConv * 2, Number(historyLimit) || DEFAULT_HISTORY_LIMIT);

  // Где начинается область последних `keepConv` диалоговых сообщений.
  let start = 0;
  let conv = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (isConversational(messages[i])) {
      conv++;
      if (conv >= keepConv) {
        start = i;
        break;
      }
    }
  }
  const keepFrom = alignStart(messages, start);

  let window = messages.slice(keepFrom);

  // Окно не влезает в потолок — старую tool-обвязку схлопываем в текст,
  // чтобы служебные сообщения не вытесняли живую речь.
  if (window.length > limitRaw) {
    const head = collapseToolTraffic(messages, keepFrom);
    const tail = messages.slice(keepFrom);
    if (head.length + tail.length <= limitRaw) {
      window = mergeSameRole(head.concat(tail));
    } else {
      // Даже так не влезает — режем по границе реплик, как раньше.
      const capped = messages.slice(alignStart(messages, messages.length - limitRaw));
      if (capped.length && capped.length < window.length) window = capped;
    }
  }

  return sanitizeMessages(mergeSameRole(window));
}

/** Добавляет раунд в пересказ и держит его в рамках лимита. */
export function pushRecap(recap, entry, limit = DEFAULT_RECAP_LIMIT) {
  const list = Array.isArray(recap) ? recap.slice() : [];
  if (!entry || !String(entry.text || '').trim()) return list;
  list.push({ role: entry.role === 'agent' ? 'agent' : 'user', text: String(entry.text).trim() });
  return list.slice(-Math.max(2, Number(limit) || DEFAULT_RECAP_LIMIT));
}

/** Пересказ в виде блока для системного промпта. */
export function renderRecap(recap, max = 12) {
  if (!Array.isArray(recap) || !recap.length) return '';
  return recap
    .slice(-max)
    .map((e) => `${e.role === 'agent' ? 'Mavis' : 'Ты'}: ${oneLine(e.text)}`)
    .join('\n');
}

/** Пересказ для показа пользователю (/context). */
export function recapLines(recap, max = 12) {
  if (!Array.isArray(recap) || !recap.length) return [];
  return recap.slice(-max).map((e) => `${e.role === 'agent' ? 'Mavis' : 'Ты'}: ${oneLine(e.text, 160)}`);
}
