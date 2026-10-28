import fs from 'node:fs';
import path from 'node:path';
import { FLUXA_HOME, ensureDir, readJson, writeJson, nowIso } from '../util.js';

const TODO_FILE = path.join(FLUXA_HOME, 'state', 'todo.json');

function readTodos() {
  ensureDir(path.dirname(TODO_FILE));
  return readJson(TODO_FILE, []);
}

function writeTodos(items) {
  ensureDir(path.dirname(TODO_FILE));
  writeJson(TODO_FILE, items);
}

export const todoTool = {
  name: 'todo',
  description:
    'Список задач текущего захода. list() | add(text) | done(id) | remove(id) | clear(). ' +
    'Держи план в актуальном состоянии на многошаговых задачах.',
  schema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['list', 'add', 'done', 'remove', 'clear'] },
      text: { type: 'string' },
      id: { type: 'integer' },
    },
    required: ['action'],
  },
  handler: async (ctx, args) => {
    const items = readTodos();
    switch (args.action) {
      case 'list':
        if (!items.length) return 'Список пуст.';
        return items
          .map((t) => `${t.done ? '[x]' : '[ ]'} #${t.id} ${t.text}`)
          .join('\n');
      case 'add': {
        const id = items.length ? Math.max(...items.map((t) => t.id)) + 1 : 1;
        items.push({ id, text: args.text || '', done: false, ts: nowIso() });
        writeTodos(items);
        return `Добавил задачу #${id}`;
      }
      case 'done': {
        const t = items.find((x) => x.id === args.id);
        if (!t) return 'Задача не найдена';
        t.done = true;
        t.doneAt = nowIso();
        writeTodos(items);
        return `Готово: #${t.id}`;
      }
      case 'remove': {
        writeTodos(items.filter((t) => t.id !== args.id));
        return 'Удалил';
      }
      case 'clear':
        writeTodos([]);
        return 'Очистил список';
    }
  },
};
