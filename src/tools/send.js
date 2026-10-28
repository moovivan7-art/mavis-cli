import { addDraft, updateDraft, logJob, getJob } from '../store.js';
import { deliver } from './deliver.js';
import { nowIso } from '../util.js';

/**
 * The only tool that puts words into somebody else's inbox.
 * It always: 1) writes a draft, 2) asks the human, 3) sends only on "yes".
 */
export const sendMessageTool = {
  name: 'send_message',
  description: [
    'Отправить сообщение клиенту. ВСЕГДА требует подтверждения человеком перед отправкой.',
    'channel: telegram | flru | kwork | manual. to: имя чата/заказ. body: текст.',
    'Сначала сформулируй текст сам, покажи пользователю, и только потом вызывай этот инструмент.',
    'Если текст неуверенный — не вызывай, верни черновик через drafts.',
  ].join(' '),
  schema: {
    type: 'object',
    properties: {
      channel: { type: 'string', enum: ['telegram', 'flru', 'kwork', 'manual'] },
      to: { type: 'string', description: 'Имя чата в Telegram / название заказа / получатель' },
      body: { type: 'string', description: 'Текст сообщения' },
      jobId: { type: 'string', description: 'id заказа из пайплайна (если это отклик на заказ)' },
      draftId: { type: 'string', description: 'id уже созданного черновика' },
    },
    required: ['channel', 'body'],
  },
  handler: async (ctx, args) => {
    let draft = args.draftId ? updateDraft(args.draftId, { body: args.body }) : null;
    if (!draft) {
      draft = addDraft({
        kind: args.jobId ? 'proposal' : 'message',
        target: args.to || '',
        platform: args.channel,
        jobId: args.jobId || null,
        body: args.body,
      });
    } else {
      draft = updateDraft(draft.id, { body: args.body, status: 'pending' });
    }

    const answer = await ctx.ask({
      title: `Отправить в ${args.channel}${args.to ? ` → ${args.to}` : ''}`,
      body: args.body,
      actions: ['y', 'e', 'n'],
      hint: 'y — отправить, e — отредактировать и отправить, n — не отправлять (черновик останется)',
    });

    if (answer.approved === false || answer.action === 'n') {
      updateDraft(draft.id, { status: 'denied', deniedAt: nowIso() });
      if (args.jobId) logJob(args.jobId, 'draft', 'Отклик отклонён пользователем, черновик сохранён');
      return 'Пользователь не подтвердил отправку. Сообщение НЕ отправлено, черновик сохранён в пайплайне.';
    }

    const body = answer.text || args.body;
    if (body !== args.body) {
      updateDraft(draft.id, { body });
    }

    const result = await deliver({ channel: args.channel, to: args.to, body, cfg: ctx.cfg });

    if (result.ok) {
      updateDraft(draft.id, { status: 'sent', sentAt: nowIso(), result: result.detail });
      if (args.jobId) {
        logJob(args.jobId, 'replied', `Отправлен ответ: ${body.slice(0, 200)}`);
        const job = getJob(args.jobId);
        if (job && job.status !== 'replied') {
          // keep status consistent with reality
          const { upsertJob } = await import('../store.js');
          upsertJob({ id: args.jobId, status: 'replied' });
        }
      }
      return `Отправлено. ${result.detail}`;
    }

    updateDraft(draft.id, { status: 'pending', result: result.error });
    return result.error;
  },
};
