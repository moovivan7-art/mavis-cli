import { listDrafts, addDraft, updateDraft } from '../store.js';
import { truncate, nowIso } from '../util.js';

export const draftsTool = {
  name: 'drafts',
  description:
    'Черновики исходящих сообщений. list(status?) | get(id) | add({kind,target,platform,jobId,body}) | ' +
    'setBody(id, body). Любое исходящее сообщение сначала создаётся здесь, а потом отправляется через send_message ' +
    '(то есть человек подтверждает отправку).',
  schema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['list', 'get', 'add', 'setBody'] },
      id: { type: 'string' },
      status: { type: 'string', description: 'pending | approved | sent | denied' },
      kind: { type: 'string', description: 'message | proposal | reply' },
      target: { type: 'string', description: 'Кому (имя/чат/ссылка)' },
      platform: { type: 'string' },
      jobId: { type: 'string' },
      body: { type: 'string', description: 'Текст сообщения' },
    },
    required: ['action'],
  },
  handler: async (ctx, args) => {
    switch (args.action) {
      case 'list': {
        const drafts = listDrafts(args.status);
        if (!drafts.length) return 'Черновиков нет.';
        return drafts
          .map((d) => `${d.id}  [${d.status}] ${d.platform || ''} → ${d.target}: ${truncate(d.body, 160)}`)
          .join('\n');
      }
      case 'get': {
        const d = listDrafts().find((x) => x.id === args.id);
        return d ? `${d.id}\n${d.target}\n\n${d.body}\n\n[статус: ${d.status}]` : 'Черновик не найден';
      }
      case 'add': {
        const d = addDraft({
          kind: args.kind,
          target: args.target,
          platform: args.platform,
          jobId: args.jobId,
          body: args.body,
        });
        return `Черновик ${d.id} создан. Отправь его через send_message.`;
      }
      case 'setBody': {
        const d = updateDraft(args.id, { body: args.body, updatedAt: nowIso() });
        return d ? 'Текст обновлён' : 'Черновик не найден';
      }
      default:
        return 'Неизвестное действие';
    }
  },
};
