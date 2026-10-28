/**
 * Самодиагностика: `mavis --check`.
 *
 * Проверяет всё, из-за чего агент может не работать, и печатает вердикт:
 *   1. конфиг и ключ;
 *   2. живой запрос к модели (ключ рабочий? модель отвечает?);
 *   3. КОНТЕКСТ ДИАЛОГА — реальная проверка: модель должна помнить факт из предыдущей реплики;
 *   4. окно сообщений и пересказ;
 *   5. тулбелты;
 *   6. браузер (Playwright + Chromium + профиль);
 *   7. профиль пользователя, плейбуки;
 *   8. сессия и пайплайн.
 *
 * Каждый пункт умеет объяснить, что чинить: поле `fix`.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { configPath, profilePath } from './config.js';
import { Agent } from './agent.js';
import { createProvider } from './providers/index.js';
import { buildTools, ALL_TOOLS } from './tools/index.js';
import { buildSystemPrompt } from './system-prompt.js';
import { maskKey } from './config.js';
import { loadSession, saveSession, listJobs, listDrafts, memoryAll } from './store.js';
import { playbooksDir } from './config.js';

const ok = (title, detail = '') => ({ title, ok: true, detail });
const bad = (title, detail = '', fix = '') => ({ title, ok: false, detail, fix });

/** Живой запрос к модели: работает ли ключ и отвечает ли модель. */
async function checkApi(cfg) {
  try {
    const provider = createProvider(cfg);
    const started = Date.now();
    const turn = await provider.complete({
      system: 'Ты — тест. Ответь одним словом.',
      messages: [{ role: 'user', content: 'Скажи «ок».' }],
      tools: [],
    });
    const ms = Date.now() - started;
    const text = String(turn.text || '').trim();
    if (!text) return bad('API: модель отвечает', 'пустой ответ', 'Проверь модель: mavis --model MiniMax-M3.1-Flash');
    return ok('API: модель отвечает', `${cfg.provider.model} · ${ms} мс · «${text.slice(0, 40)}»`);
  } catch (err) {
    return bad('API: модель отвечает', err.message, 'Ключ/модель/URL. Проверь: mavis --model <модель> --base-url <url>');
  }
}

/**
 * Живая проверка контекста: первый ход — факт, второй — вопрос по этому факту.
 * Если модель помнит — значит окно работает и на живой модели, а не только в тестах.
 */
async function checkContext(cfg) {
  const mark = 'Проверка контекста';
  try {
    const provider = createProvider(cfg);
    const agent = new Agent({
      cfg,
      provider,
      ctx: { cfg, ask: async () => ({ approved: false }), runSubAgent: null },
      tools: [],
      system: buildSystemPrompt(cfg),
      onEvent: () => {},
    });

    await agent.run(`Меня зовут ${mark}, я делаю лендинги на Tilda. Запомни это.`);
    const answer = String(await agent.run('Как меня зовут и что я делаю?') || '');

    const rememberedName = answer.includes(mark);
    const rememberedWork = /лендинг|Tilda/i.test(answer);

    if (rememberedName && rememberedWork) {
      return ok('Контекст: модель помнит предыдущую реплику', `«${answer.replace(/\s+/g, ' ').slice(0, 70)}»`);
    }
    return bad(
      'Контекст: модель помнит предыдущую реплику',
      `ответ: «${answer.replace(/\s+/g, ' ').slice(0, 90)}»`,
      'Проверь, что в конфиге agent.contextMessages >= 2, и что версия свежая: mavis --update',
    );
  } catch (err) {
    return bad('Контекст: модель помнит предыдущую реплику', err.message, 'Сначала почини API — пункт выше.');
  }
}

/** Что агент физически отправляет в модель. */
function checkWindow(cfg) {
  const agent = new Agent({
    cfg,
    provider: { complete: async () => ({ text: '', reasoning: '', toolCalls: [] }) },
    ctx: { cfg },
    tools: [],
    system: 'тест',
    onEvent: () => {},
  });
  agent.pushUser('первая реплика');
  agent.messages.push({ role: 'assistant', content: [{ type: 'text', text: 'первый ответ' }] });
  agent.pushUser('вторая реплика');
  agent.trim();
  const system = agent.systemForRequest();
  const hasRecap = /ИСТОРИЯ ДИАЛОГА/.test(system);
  const hasPrev = JSON.stringify(agent.messages).includes('первая реплика');
  if (hasRecap && hasPrev) {
    return ok('Окно: предыдущие реплики + пересказ в запросе', `${agent.messages.length} сообщений, окно ${cfg.agent.contextMessages}`);
  }
  return bad('Окно: предыдущие реплики + пересказ в запросе', 'реплики или пересказ не попали в запрос', 'mavis --update');
}

function checkTools() {
  try {
    const tools = buildTools();
    const names = tools.map((t) => t.name);
    const need = ['browser', 'jobs', 'send_message', 'threads', 'playbook'];
    const missing = need.filter((n) => !names.includes(n));
    if (missing.length) return bad('Тулбелты', `не хватает: ${missing.join(', ')}`, 'mavis --update');
    return ok('Тулбелты', `${names.length} шт: ${names.join(' ')}`);
  } catch (err) {
    return bad('Тулбелты', err.message, 'mavis --update');
  }
}

function checkBrowser(cfg) {
  try {
    execFileSync(process.execPath, ['-e', "require('playwright')"], { stdio: 'ignore' });
  } catch {
    try {
      execFileSync(process.execPath, ['-e', "require('playwright')"], {
        stdio: 'ignore',
        env: { ...process.env, NODE_PATH: process.env.MAVIS_NODE_MODULES || '/usr/local/lib/node_modules' },
      });
    } catch {
      return bad('Браузер: Playwright установлен', 'модуль playwright не найден', 'npm i -g playwright && npx playwright install chromium');
    }
  }
  const profileDir = path.dirname(cfg.browser.profileDir || '');
  const exists = fs.existsSync(cfg.browser.profileDir || '');
  return ok(
    'Браузер: Playwright + папка профиля',
    `${exists ? 'профиль есть' : 'профиля пока нет (создастся при первом запуске)'} · ${cfg.browser.profileDir}`,
  );
}

function checkProfile(cfg) {
  const p = profilePath(cfg);
  if (!fs.existsSync(p)) {
    return bad('Профиль пользователя', `нет файла ${p}`, 'Заполни навыки, ставки и стиль — без них отклики будут пустыми');
  }
  const body = fs.readFileSync(p, 'utf8').trim();
  const size = body.length;
  if (size < 80) {
    return bad('Профиль пользователя', `файл есть, но почти пустой (${size} символов)`, 'Заполни profile.md: навыки, ставки, портфолио, стиль');
  }
  return ok('Профиль пользователя', `${size} символов · ${p}`);
}

function checkPlaybooks(cfg) {
  const dir = playbooksDir(cfg);
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.md')) : [];
  if (!files.length) return bad('Плейбуки', `в ${dir} нет .md`, 'mavis --update');
  return ok('Плейбуки', `${files.length} шт: ${files.join(' ')}`);
}

function checkSession() {
  try {
    const name = `check-${Date.now().toString(36)}`;
    saveSession(name, [{ role: 'user', content: 'проверка' }], [{ role: 'user', text: 'проверка' }]);
    const back = loadSession(name);
    const good = back?.messages?.length === 1 && back.recap?.length === 1;
    return good
      ? ok('Сессия: сохраняется и поднимается', 'проверено на временной сессии')
      : bad('Сессия: сохраняется и поднимается', 'сессия не восстановилась', 'проверь права на ~/.mavis-cli/state');
  } catch (err) {
    return bad('Сессия: сохраняется и поднимается', err.message, 'проверь права на ~/.mavis-cli/state');
  }
}

function checkPipeline() {
  try {
    const jobs = listJobs();
    const drafts = listDrafts('pending');
    const mem = Object.keys(memoryAll()).length;
    return ok('Пайплайн и память', `заказов: ${jobs.length} · черновиков ждут: ${drafts.length} · заметок: ${mem}`);
  } catch (err) {
    return bad('Пайплайн и память', err.message, 'проверь права на ~/.mavis-cli/state');
  }
}

function checkConfig(cfg) {
  const file = configPath();
  const p = path.join(file);
  if (!fs.existsSync(p)) return bad('Конфиг', `нет ${p}`, 'Запусти mavis и вставь API-ключ');
  let mode = '?';
  try {
    mode = (fs.statSync(p).mode & 0o777).toString(8);
  } catch {
    /* не критично */
  }
  if (!cfg.provider.apiKey) {
    return bad('Конфиг: API-ключ', `ключа нет в ${p}`, 'Вставь ключ: mavis --key <ключ>');
  }
  const keyOk = ok('Конфиг: API-ключ', `${maskKey(cfg.provider.apiKey)} · права ${mode}`);
  if (mode !== '600') {
    return { ...keyOk, fix: `права ${mode} — лучше 600: chmod 600 ${p}` };
  }
  return keyOk;
}

/**
 * Полная проверка. Возвращает массив пунктов и общий вердикт.
 * Опция api=false пропускает живые запросы к модели (быстрая проверка без трат токенов).
 */
export async function runCheck({ cfg, api = true } = {}) {
  const checks = [];

  checks.push(checkConfig(cfg));
  checks.push(checkWindow(cfg));
  checks.push(checkTools());
  checks.push(checkBrowser(cfg));
  checks.push(checkProfile(cfg));
  checks.push(checkPlaybooks(cfg));
  checks.push(checkSession());
  checks.push(checkPipeline());

  if (api) {
    checks.push(await checkApi(cfg));
    checks.push(await checkContext(cfg));
  } else {
    checks.push(ok('API: модель отвечает', 'пропущено (--check быстрый)'));
    checks.push(ok('Контекст: модель помнит предыдущую реплику', 'пропущено (--check быстрый)'));
  }

  const failed = checks.filter((c) => !c.ok);
  return { checks, ok: failed.length === 0, failed: failed.length };
}

export function renderCheck(result) {
  const lines = [];
  lines.push('');
  lines.push('  ПРОВЕРКА MAVIS');
  lines.push('  ' + '─'.repeat(64));
  for (const c of result.checks) {
    lines.push(`  ${c.ok ? '✔' : '✖'} ${c.title}`);
    if (c.detail) lines.push(`      ${c.detail}`);
    if (c.fix) lines.push(`      → ${c.fix}`);
  }
  lines.push('  ' + '─'.repeat(64));
  if (result.ok) {
    lines.push('  ВСЁ РАБОТАЕТ. Можно запускать: mavis');
  } else {
    lines.push(`  Не пройдено пунктов: ${result.failed}. Подсказки выше — что чинить.`);
  }
  lines.push('');
  return lines.join('\n');
}
