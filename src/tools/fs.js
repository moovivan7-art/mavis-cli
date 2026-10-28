import fs from 'node:fs';
import path from 'node:path';
import { expandHome, truncate, ensureDir } from '../util.js';

export const fsTool = {
  name: 'files',
  description:
    'Работа с файлами: read(path) | write(path, content) | list(dir) | append(path, content) | mkdir(path) | rm(path). ' +
    'Чтение — из любого места. Запись — в рабочую папку агента (или явный абсолютный путь).',
  schema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['read', 'write', 'append', 'list', 'mkdir', 'rm'] },
      path: { type: 'string', description: 'Путь к файлу или папке' },
      content: { type: 'string', description: 'Содержимое для write/append' },
    },
    required: ['action', 'path'],
  },
  handler: async (ctx, args) => {
    const p = expandHome(args.path);
    try {
      switch (args.action) {
        case 'read': {
          if (!fs.existsSync(p)) return `Файл не найден: ${p}`;
          return truncate(fs.readFileSync(p, 'utf8'), 20000);
        }
        case 'write': {
          ensureDir(path.dirname(p));
          fs.writeFileSync(p, args.content ?? '');
          return `Записал ${p} (${(args.content ?? '').length} символов)`;
        }
        case 'append': {
          ensureDir(path.dirname(p));
          fs.appendFileSync(p, args.content ?? '');
          return `Дописал в ${p}`;
        }
        case 'list': {
          const dir = p && fs.existsSync(p) ? p : ctx.cfg.agent.workspace;
          const entries = fs.readdirSync(dir, { withFileTypes: true });
          return entries
            .map((e) => `${e.isDirectory() ? 'dir ' : 'file'}  ${e.name}`)
            .join('\n') || '(пусто)';
        }
        case 'mkdir': {
          ensureDir(p);
          return `Создал ${p}`;
        }
        case 'rm': {
          if (!fs.existsSync(p)) return `Не найдено: ${p}`;
          fs.rmSync(p, { recursive: true, force: true });
          return `Удалил ${p}`;
        }
        default:
          return 'Неизвестное действие';
      }
    } catch (err) {
      return `Ошибка ФС: ${err.message}`;
    }
  },
};
