import fs from 'node:fs';
import path from 'node:path';
import { playbooksDir } from '../config.js';
import { truncate } from '../util.js';

export const playbookTool = {
  name: 'playbook',
  description:
    'Гайды по площадкам и сценариям. list() — что доступно; read(name) — текст гайда. ' +
    'Перед работой с конкретной площадкой (flru, kwork, telegram) прочитай соответствующий гайд.',
  schema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['list', 'read'] },
      name: { type: 'string', description: 'Имя гайда без расширения' },
    },
    required: ['action'],
  },
  handler: async (ctx, args) => {
    const dir = playbooksDir(ctx.cfg);
    if (args.action === 'list') {
      const files = fs.readdirSync(dir).filter((f) => f.endsWith('.md'));
      if (!files.length) return 'Гайдов нет.';
      return files.map((f) => `- ${f.replace(/\.md$/, '')}`).join('\n');
    }
    const file = path.join(dir, `${args.name}.md`);
    if (!fs.existsSync(file)) return `Гайд "${args.name}" не найден. Доступные: ${fs.readdirSync(dir).join(', ')}`;
    return truncate(fs.readFileSync(file, 'utf8'), 20000);
  },
};
