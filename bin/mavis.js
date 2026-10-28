#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { loadConfig, saveConfig, setApiKey, playbooksDir, profilePath, workspaceDir } from '../src/config.js';
import { createProvider } from '../src/providers/index.js';
import { Agent } from '../src/agent.js';
import { buildTools } from '../src/tools/index.js';
import { buildSystemPrompt } from '../src/system-prompt.js';
import { startRepl } from '../src/repl.js';
import { closeSession } from '../src/tools/browser.js';
import { parseArgs, ensureDir, plural } from '../src/util.js';
import { loadSession, saveSession } from '../src/store.js';
import { c } from '../src/render.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(__dirname, '..');

async function main() {
  const { _: positional, flags } = parseArgs(process.argv.slice(2));

  const cfg = loadConfig();

  /* ------------------------------------------------------- самообновление */
  if (flags.update) {
    const { selfUpdate } = await import('../src/updater.js');
    const res = await selfUpdate();
    process.exit(res.ok ? 0 : 1);
  }

  /* ------------------------------------------------- config from flags */
  const patch = {};
  if (flags.model) patch.provider = { ...(patch.provider || {}), model: flags.model };
  if (flags['base-url']) patch.provider = { ...(patch.provider || {}), baseUrl: flags['base-url'] };
  if (flags.protocol) patch.provider = { ...(patch.provider || {}), protocol: flags.protocol };
  if (flags['max-steps']) patch.agent = { ...(patch.agent || {}), maxSteps: Number(flags['max-steps']) };
  if (flags['context']) patch.agent = { ...(patch.agent || {}), contextMessages: Number(flags['context']) };
  if (flags['approval']) patch.agent = { ...(patch.agent || {}), approvalMode: flags.approval };
  if (flags.workspace) patch.agent = { ...(patch.agent || {}), workspace: path.resolve(String(flags.workspace)) };
  if (Object.keys(patch).length) {
    Object.assign(cfg, patch);
    saveConfig(patch);
  }
  if (flags.key) {
    setApiKey(String(flags.key));
    cfg.provider.apiKey = String(flags.key);
  }

  /* --------------------------------------------------- first-run assets */
  // Идёт ДО самодиагностики: плейбуки и профиль должны быть на месте, когда их проверяют.
  workspaceDir(cfg);
  const pbDir = playbooksDir(cfg);
  const srcPlaybooks = path.join(PKG_ROOT, 'playbooks');
  if (fs.existsSync(srcPlaybooks)) {
    for (const f of fs.readdirSync(srcPlaybooks)) {
      const dest = path.join(pbDir, f);
      if (!fs.existsSync(dest)) fs.copyFileSync(path.join(srcPlaybooks, f), dest);
    }
  }
  const prof = profilePath(cfg);
  if (!fs.existsSync(prof)) {
    const tpl = path.join(PKG_ROOT, 'templates', 'profile.md');
    if (fs.existsSync(tpl)) {
      fs.copyFileSync(tpl, prof);
      console.log(c.gray(`Создан профиль: ${prof} — заполни его, чтобы отклики были твоими.`));
    }
  }

  /* ------------------------------------------------------ самодиагностика */
  // Ставим после разбора флагов (чтобы --model/--key применялись) и ДО запроса ключа
  // (иначе проверка без ключа зависнет на вопросе в терминале).
  if (flags.check) {
    const { runCheck, renderCheck } = await import('../src/doctor.js');
    const result = await runCheck({ cfg, api: !flags['check-fast'] });
    console.log(renderCheck(result));
    process.exit(result.ok ? 0 : 1);
  }

  const offline = !!flags.offline;
  if (offline) cfg.provider.protocol = 'mock';

  /* --------------------------------------------------------------- key */
  if (!offline && !cfg.provider.apiKey) {
    console.log(c.yellow('Нужен API-ключ MiniMax (или любой OpenAI-совместимый провайдер).'));
    console.log(c.gray('  Получить: https://platform.minimax.io  →  API Keys'));
    console.log(c.gray('  Вставить сюда (не сохранится в репозитории, файл конфига с правами 600):'));
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const key = await new Promise((res) => rl.question('  API key: ', res));
    rl.close();
    if (!key.trim()) {
      console.log(c.red('Без ключа агент не поедет. Выход.'));
      process.exit(1);
    }
    setApiKey(key.trim());
    cfg.provider.apiKey = key.trim();
  }

  const provider = createProvider(cfg);
  const headless = flags.headed ? false : cfg.browser.headless;
  const sessionName = flags.session ? String(flags.session) : 'main';

  /* ------------------------------------------------------- one-shot run */
  const task = flags.task || positional[0];
  if (task) {
    const ctx = {
      cfg,
      ask: async ({ title, body }) => {
        if (cfg.agent.approvalMode === 'auto') {
          console.log(c.yellow(`[auto-approve] ${title}`));
          console.log(body);
          return { approved: true, action: 'approve', text: body };
        }
        console.log(c.yellow(`[нужно подтверждение] ${title}`));
        console.log(body);
        console.log(c.gray('Режим ask без терминала → действие заблокировано. Запусти интерактивно, чтобы подтвердить.'));
        return { approved: false, action: 'n', text: body };
      },
      runSubAgent: null,
    };
    const agent = new Agent({
      cfg,
      provider,
      ctx,
      tools: buildTools(),
      system: buildSystemPrompt(cfg),
      childProvider: () => createProvider(cfg),
      onEvent: (ev) => {
        if (ev.type === 'tool-start') console.log(c.yellow(`⚙ ${ev.name}`), c.gray(JSON.stringify(ev.args).slice(0, 160)));
        if (ev.type === 'tool-end' && !ev.ok) console.log(c.red(`  ✖ ${ev.result}`));
        if (ev.type === 'subagent-start') console.log(c.blue(`⇢ подагент: ${ev.role}`));
      },
    });
    ctx.runSubAgent = (opts) => agent.runSubAgent(opts);

    // Разовый заход — тоже часть диалога: поднимаем прошлый контекст, иначе агент
    // каждый раз отвечает вслепую, не помня предыдущих реплик.
    if (!flags.new) {
      const saved = loadSession(sessionName);
      if (saved?.messages?.length) {
        agent.setHistory(saved.messages, saved.recap);
        console.log(
          c.gray(
            `диалог «${sessionName}» — ${agent.messages.length} ` +
              `${plural(agent.messages.length, ['сообщение', 'сообщения', 'сообщений'])} в контексте, ` +
              `пересказ ${agent.recap.length} ${plural(agent.recap.length, ['раунд', 'раунда', 'раундов'])}`,
          ),
        );
      }
    }

    const answer = await agent.run(String(task));
    console.log('\n' + answer);
    try {
      saveSession(sessionName, agent.messages, agent.recap);
    } catch {
      /* не критично */
    }
    await closeSession();
    process.exit(0);
  }

  /* ------------------------------------------------------------- repl */
  await startRepl({
    cfg,
    provider,
    headless,
    sessionName,
    fresh: !!flags.new,
  });
}

main().catch((err) => {
  console.error(c.red(`Фатальная ошибка: ${err.stack || err.message}`));
  process.exit(1);
});
