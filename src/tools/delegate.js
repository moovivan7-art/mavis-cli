/**
 * Sub-agent tool. Spawns a child agent with a fresh context, a scoped task and a restricted
 * toolset; returns its report. Used for parallel research ("find 10 suitable orders") so the
 * main thread keeps its context clean.
 */
export const delegateTool = {
  name: 'delegate',
  description:
    'Запустить подагента-исследователя с чистым контекстом: task — что сделать, ' +
    'role — краткая роль ("искатель заказов", "аналитик"), tools — какие инструменты ему доступны ' +
    '(по умолчанию browser+read only, без отправки сообщений). Возвращает его отчёт.',
  schema: {
    type: 'object',
    properties: {
      task: { type: 'string', description: 'Задача для подагента' },
      role: { type: 'string', description: 'Роль подагента' },
      tools: { type: 'array', items: { type: 'string' }, description: 'Список доступных инструментов' },
      maxSteps: { type: 'integer', description: 'Лимит шагов подагента (по умолчанию 12)' },
    },
    required: ['task'],
  },
  handler: async (ctx, args) => {
    if (!ctx.runSubAgent) return 'Подагенты недоступны в этом режиме.';
    return await ctx.runSubAgent({
      task: args.task,
      role: args.role || 'исследователь',
      tools: args.tools,
      maxSteps: args.maxSteps || 12,
    });
  },
};
