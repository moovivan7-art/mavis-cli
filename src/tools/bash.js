import { spawn } from 'node:child_process';
import { truncate } from '../util.js';

const DANGEROUS = /\b(rm\s+-rf\s+\/|mkfs|shutdown|reboot|dd\s+if=|:\(\)\{)\b/i;

export const bashTool = {
  name: 'bash',
  description:
    'Выполнить команду в терминале (локально, в рабочей папке агента). Возвращает stdout+stderr. ' +
    'Используй для системных задач, скачивания файлов, запуска утилит. Таймаут 120 сек.',
  schema: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'Команда для выполнения' },
      cwd: { type: 'string', description: 'Рабочая папка (по умолчанию — рабочая папка агента)' },
      timeoutMs: { type: 'integer', description: 'Таймаут в мс (по умолчанию 120000)' },
    },
    required: ['command'],
  },
  handler: async (ctx, args) => {
    const cwd = args.cwd || ctx.cfg.agent.workspace;
    const timeout = Math.min(args.timeoutMs || 120000, 600000);
    if (DANGEROUS.test(args.command)) {
      const ok = await ctx.ask({
        title: 'Опасная команда',
        body: args.command,
        actions: ['y', 'n'],
      });
      if (ok !== 'y') return 'Отменено пользователем.';
    }
    return await new Promise((resolve) => {
      let out = '';
      let errOut = '';
      const child = spawn('bash', ['-lc', args.command], { cwd, timeout, env: process.env });
      child.stdout.on('data', (d) => {
        out += d.toString();
      });
      child.stderr.on('data', (d) => {
        errOut += d.toString();
      });
      child.on('error', (e) => resolve(`Ошибка запуска: ${e.message}`));
      child.on('close', (code) => {
        const parts = [];
        if (out.trim()) parts.push(out.trimEnd());
        if (errOut.trim()) parts.push(`[stderr]\n${errOut.trimEnd()}`);
        parts.push(`[exit code: ${code}]`);
        resolve(truncate(parts.join('\n'), 12000));
      });
    });
  },
};
