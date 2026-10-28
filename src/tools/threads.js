import { listThreads, upsertThread, appendThreadMessage, trimThreadMessages, setThreadUnread } from '../store.js';
import { truncate } from '../util.js';

const MAX_MESSAGES = 60;

function findThread(threads, id) {
  return (
    threads.find((t) => t.id === id) ||
    threads.find((t) => t.id.endsWith(id)) ||
    threads.find((t) => (t.chat || '').toLowerCase() === String(id || '').toLowerCase())
  );
}

function renderThread(t) {
  const lines = [
    `id: ${t.id}`,
    `платформа: ${t.platform}`,
    `чат: ${t.chat}`,
    `непрочитанных: ${t.unread ?? 0}`,
    `обновлён: ${t.updatedAt}`,
    '--- история ---',
  ];
  for (const m of (t.messages || []).slice(-30)) {
    lines.push(`${m.ts} [${m.direction || 'in'}] ${m.from ? `${m.from}: ` : ''}${m.text}`);
  }
  return lines.join('\n');
}

export const threadsTool = {
  name: 'threads',
  description:
    'Переписка с клиентами — память диалогов. list() | get(id) | open({platform, chat, lastMessage, unread}) | ' +
    'append({id, text, direction: in|out, from}) | ingest({platform, chats: [{chat, lastMessage, unread, text}]}) | ' +
    'markRead(id). ' +
    'Перед ответом клиенту — get(id), чтобы не повторяться и помнить, о чём договорились. ' +
    'После разговора — append, чтобы следующий раз не спрашивать то же самое.',
  schema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['list', 'get', 'open', 'append', 'ingest', 'markRead'] },
      id: { type: 'string', description: 'id чата (platform:chat)' },
      platform: { type: 'string', description: 'telegram | flru | kwork | other' },
      chat: { type: 'string', description: 'Имя чата/собеседника' },
      lastMessage: { type: 'string' },
      unread: { type: 'integer' },
      text: { type: 'string', description: 'Текст сообщения' },
      from: { type: 'string', description: 'Кто написал' },
      direction: { type: 'string', enum: ['in', 'out'] },
      chats: {
        type: 'array',
        description: 'Массив чатов для ingest',
        items: {
          type: 'object',
          properties: {
            chat: { type: 'string' },
            lastMessage: { type: 'string' },
            unread: { type: 'integer' },
            text: { type: 'string' },
          },
        },
      },
    },
    required: ['action'],
  },
  handler: async (ctx, args) => {
    switch (args.action) {
      case 'list': {
        const threads = listThreads();
        if (!threads.length) return 'Переписки пока нет.';
        return threads
          .map(
            (t) =>
              `${t.id}  непрочитанных=${t.unread ?? 0}  ${t.updatedAt}  ${truncate(t.lastMessage || '', 80)}`,
          )
          .join('\n');
      }
      case 'get': {
        const t = findThread(listThreads(), args.id);
        return t ? renderThread(t) : 'Переписка не найдена';
      }
      case 'open': {
        const t = upsertThread({
          platform: args.platform || 'unknown',
          chat: args.chat || args.id || '',
          lastMessage: args.lastMessage,
          unread: args.unread ?? 0,
        });
        return `Открыл переписку ${t.id}`;
      }
      case 'append': {
        const t = findThread(listThreads(), args.id);
        if (!t) return 'Переписка не найдена — сначала open.';
        appendThreadMessage(t.id, {
          text: args.text || '',
          direction: args.direction || 'in',
          from: args.from,
        });
        trimThreadMessages(t.id, MAX_MESSAGES);
        if (args.direction !== 'out') setThreadUnread(t.id, 0);
        return `Записал сообщение в ${t.id}`;
      }
      case 'ingest': {
        const chats = args.chats || [];
        if (!chats.length) return 'Нечего загружать: пустой список чатов.';
        const done = [];
        for (const c of chats) {
          const t = upsertThread({
            platform: args.platform || 'unknown',
            chat: c.chat || '',
            lastMessage: c.lastMessage,
            unread: c.unread ?? 0,
          });
          if (c.text) {
            appendThreadMessage(t.id, { text: c.text, direction: 'in' });
            trimThreadMessages(t.id, MAX_MESSAGES);
          }
          done.push(`${t.id} (непрочитанных ${c.unread ?? 0})`);
        }
        return `Загрузил чатов: ${done.length}\n${done.join('\n')}`;
      }
      case 'markRead': {
        const t = findThread(listThreads(), args.id);
        if (!t) return 'Переписка не найдена';
        setThreadUnread(t.id, 0);
        return `Отметил прочитанным: ${t.id}`;
      }
      default:
        return 'Неизвестное действие';
    }
  },
};
