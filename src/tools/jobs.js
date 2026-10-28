import { listJobs, getJob, upsertJob, removeJob, logJob } from '../store.js';
import { truncate } from '../util.js';

function renderJob(j) {
  const lines = [
    `id: ${j.id}`,
    `title: ${j.title}`,
    `platform: ${j.platform}`,
    j.url ? `url: ${j.url}` : null,
    j.budget ? `budget: ${j.budget} ${j.currency || ''}`.trim() : null,
    j.client ? `client: ${j.client}` : null,
    j.fit !== null && j.fit !== undefined ? `fit: ${j.fit}` : null,
    `status: ${j.status}`,
    j.tags?.length ? `tags: ${j.tags.join(', ')}` : null,
    j.notes ? `notes: ${truncate(j.notes, 800)}` : null,
  ].filter(Boolean);
  if (j.history?.length) {
    lines.push('--- история ---');
    for (const h of j.history.slice(-12)) lines.push(`${h.ts}  [${h.type}] ${h.text}`);
  }
  return lines.join('\n');
}

export const jobsTool = {
  name: 'jobs',
  description:
    'Пайплайн заказов/клиентов. list(status?) | get(id) | add({platform,title,url,budget,client,fit,tags,notes}) | ' +
    'update(id, {...}) | note(id, text) | archive(id) | remove(id). ' +
    'Хранится локально, переживает перезапуски. Обязательно заводи заказ, когда нашёл подходящий.',
  schema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['list', 'get', 'add', 'update', 'note', 'archive', 'remove'] },
      id: { type: 'string', description: 'id заказа' },
      platform: { type: 'string', description: 'flru | kwork | telegram | upwork | direct | other' },
      title: { type: 'string' },
      url: { type: 'string' },
      budget: { type: 'string' },
      currency: { type: 'string' },
      client: { type: 'string' },
      fit: { type: 'integer', description: 'Оценка подходямости 0-100' },
      status: { type: 'string', description: 'new | reviewed | shortlisted | applied | replied | won | lost | archived' },
      tags: { type: 'array', items: { type: 'string' } },
      notes: { type: 'string' },
      text: { type: 'string', description: 'Текст заметки для note' },
    },
    required: ['action'],
  },
  handler: async (ctx, args) => {
    switch (args.action) {
      case 'list': {
        const jobs = listJobs({ status: args.status, platform: args.platform });
        if (!jobs.length) return 'Пайплайн пуст.';
        return jobs
          .map((j) => {
            const fit = j.fit !== null && j.fit !== undefined ? `fit=${j.fit}` : 'fit=?';
            const bud = j.budget ? ` | ${j.budget} ${j.currency || ''}` : '';
            return `${j.id}  [${j.status}] ${j.platform} — ${j.title}${bud}  (${fit})`;
          })
          .join('\n');
      }
      case 'get': {
        const job = getJob(args.id);
        return job ? renderJob(job) : 'Заказ не найден';
      }
      case 'add': {
        const job = upsertJob({
          platform: args.platform,
          title: args.title,
          url: args.url,
          budget: args.budget,
          currency: args.currency,
          client: args.client,
          fit: args.fit,
          status: args.status,
          tags: args.tags,
          notes: args.notes,
        });
        return `Добавил заказ ${job.id}\n${renderJob(job)}`;
      }
      case 'update': {
        const patch = {};
        for (const k of ['title', 'url', 'budget', 'currency', 'client', 'fit', 'status', 'tags', 'notes', 'platform']) {
          if (args[k] !== undefined) patch[k] = args[k];
        }
        const job = upsertJob({ id: args.id, ...patch });
        return job ? `Обновил ${job.id}\n${renderJob(job)}` : 'Заказ не найден';
      }
      case 'note': {
        const job = logJob(args.id, 'note', args.text || '');
        return job ? `Записал заметку в ${job.id}` : 'Заказ не найден';
      }
      case 'archive': {
        const job = upsertJob({ id: args.id, status: 'archived' });
        return job ? `В архиве: ${job.id}` : 'Заказ не найден';
      }
      case 'remove': {
        return removeJob(args.id) ? 'Удалил заказ' : 'Заказ не найден';
      }
      default:
        return 'Неизвестное действие';
    }
  },
};
