import { memoryGet, memorySet, memoryAll, memoryDelete } from '../store.js';
import { truncate } from '../util.js';

export const memoryTool = {
  name: 'memory',
  description:
    'Долговременные заметки агента: set(key, value) | get(key) | list() | delete(key). ' +
    'Сюда пиши всё, что должно помниться между запусками: ставки, стиль ответов, пожелания, гайд по площадкам.',
  schema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['set', 'get', 'list', 'delete'] },
      key: { type: 'string' },
      value: { type: 'string' },
    },
    required: ['action'],
  },
  handler: async (ctx, args) => {
    switch (args.action) {
      case 'set':
        memorySet(args.key, args.value);
        return `Запомнил "${args.key}"`;
      case 'get': {
        const v = memoryGet(args.key);
        return v ? truncate(String(v.value), 4000) : 'Не найдено';
      }
      case 'list': {
        const all = memoryAll();
        const keys = Object.keys(all);
        if (!keys.length) return 'Память пуста.';
        return keys.map((k) => `${k}: ${truncate(String(all[k].value), 120)}`).join('\n');
      }
      case 'delete':
        memoryDelete(args.key);
        return `Удалил "${args.key}"`;
      default:
        return 'Неизвестное действие';
    }
  },
};
