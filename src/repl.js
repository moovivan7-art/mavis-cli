import readline from 'node:readline';
import { Agent } from './agent.js';
import { createProvider } from './providers/index.js';
import { buildTools } from './tools/index.js';
import { buildSystemPrompt } from './system-prompt.js';
import { listJobs, listDrafts, updateDraft, memoryAll, saveSession, loadSession, listThreads, listSessions } from './store.js';
import { closeSession } from './tools/browser.js';
import { c, ICON, renderUser, renderAgent, renderToolCall, renderToolResult, renderNotice, renderTable, renderBox } from './render.js';
import { maskKey } from './config.js';
import { truncate, plural } from './util.js';
import { isConversational, textOf, recapLines } from './context.js';

const HELP = `
${c.bold('Команды:')}
  /help                 этот список
  /context              что агент сейчас видит: последние сообщения + пересказ диалога
  /jobs                 список заказов в пайплайне
  /job <id>             карточка заказа
  /threads              переписки с клиентами
  /drafts               черновики, ждущие отправки
  /approve <id|all>     показать текст черновика для отправки
  /deny <id>            отклонить черновик
  /session [save|load]  работа с сохранённым диалогом
  /browser <url>        открыть страницу в браузере агента
  /snapshot             снимок текущей страницы
  /playbooks            список гайдов по площадкам
  /profile              показать профиль пользователя
  /config               текущая конфигурация (ключ скрыт)
  /stats                сводка по пайплайну
  /clear                очистить контекст диалога
  /exit                 выйти
  !<команда>            выполнить команду в терминале напрямую
`;

export async function startRepl({ cfg, provider, headless, sessionName = 'main', fresh = false }) {
  const tools = buildTools();
  const system = buildSystemPrompt(cfg);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: c.cyan('mavis › ') });
  rl.pause();

  const ask = ({ title, body, actions = ['y', 'n'], hint }) =>
    new Promise((resolve) => {
      renderBox(title, body, c.yellow);
      if (hint) console.log(c.gray(hint));
      const opts = actions.map((a) => (a === 'y' ? '[y] да' : a === 'e' ? '[e] отредактировать' : a === 'n' ? '[n] нет' : `[${a}]`)).join('  ');
      rl.resume();
      rl.question(`${c.bold(opts)} `, (answer) => {
        const a = String(answer).trim().toLowerCase();
        if (a === 'e') {
          rl.question(c.gray('Новый текст: '), (edited) => {
            resolve({ approved: true, action: 'edit', text: edited });
          });
          return;
        }
        if (a === 'y' || a === 'д' || a === 'yes') {
          resolve({ approved: true, action: 'approve', text: body });
          return;
        }
        resolve({ approved: false, action: 'n', text: body });
      });
    });

  const ctx = {
    cfg,
    ask,
    runSubAgent: null,
  };

  const agent = new Agent({
    cfg,
    provider,
    ctx,
    tools,
    system,
    onEvent: (ev) => {
      if (ev.type === 'tool-start') renderToolCall(ev.name, ev.args);
      else if (ev.type === 'tool-end') renderToolResult(ev.name, ev.ok, truncate(ev.result, 160));
      else if (ev.type === 'subagent-start') renderNotice('info', `подагент «${ev.role}» начал: ${truncate(ev.task, 100)}`);
      else if (ev.type === 'subagent-end') renderNotice('info', `подагент «${ev.role}» закончил`);
      else if (ev.type === 'subagent-tool') renderNotice('info', c.gray(`  ↳ ${ev.name}`));
      else if (ev.type === 'error') renderNotice('error', ev.message);
    },
  });

  ctx.runSubAgent = (opts) => agent.runSubAgent(opts);

  console.log(c.bold(c.magenta('Mavis')) + c.gray(' — фриланс-агент в терминале'));
  console.log(c.gray(`модель: ${cfg.provider.model} · протокол: ${cfg.provider.protocol} · подтверждения: ${cfg.agent.approvalMode}`));
  console.log(c.gray('/help — команды, Ctrl+C — выход'));

  // Диалог переживает перезапуск: поднимаем прошлую сессию, если она есть.
  if (!fresh) {
    const saved = loadSession(sessionName);
    if (saved?.messages?.length) {
      agent.setHistory(saved.messages, saved.recap);
      console.log(
        c.gray(
          `продолжаю сессию «${sessionName}» — ${agent.messages.length} ` +
            `${plural(agent.messages.length, ['сообщение', 'сообщения', 'сообщений'])} в контексте, ` +
            `пересказ: ${agent.recap.length} ${plural(agent.recap.length, ['раунд', 'раунда', 'раундов'])}`,
        ),
      );
    } else {
      console.log(c.gray(`сессия «${sessionName}» пустая — начинаем с чистого листа`));
    }
  } else {
    saveSession(sessionName, [], []);
    console.log(c.gray(`новая сессия «${sessionName}» — контекст пуст`));
  }
  console.log('');

  const handle = async (line) => {
    const text = line.trim();
    if (!text) return;

    if (text.startsWith('!')) {
      const { execSync } = await import('node:child_process');
      try {
        console.log(execSync(text.slice(1), { encoding: 'utf8' }));
      } catch (e) {
        console.log(c.red(String(e.stdout || e.message)));
      }
      return;
    }

    if (text.startsWith('/')) {
      await command(text);
      return;
    }

    renderUser(text);
    const answer = await agent.run(text);
    if (answer) renderAgent(answer);
    try {
      saveSession(sessionName, agent.messages, agent.recap);
    } catch {
      /* не критично */
    }
    console.log(
      c.gray(
        `  ↳ контекст: ${agent.messages.length} ${plural(agent.messages.length, ['сообщение', 'сообщения', 'сообщений'])}` +
          ` · пересказ: ${agent.recap.length} ${plural(agent.recap.length, ['раунд', 'раунда', 'раундов'])}` +
          ` · /context — посмотреть`,
      ),
    );
  };

  const command = async (text) => {
    const [cmd, ...rest] = text.slice(1).split(/\s+/);
    const arg = rest.join(' ');
    switch (cmd) {
      case 'help':
        console.log(HELP);
        break;
      case 'jobs': {
        const jobs = listJobs();
        if (!jobs.length) {
          console.log(c.gray('Пайплайн пуст.'));
          break;
        }
        renderTable(jobs, [
          { key: 'id', title: 'ID', value: (j) => j.id.slice(0, 12) },
          { key: 'status', title: 'СТАТУС', value: (j) => j.status },
          { key: 'platform', title: 'ПЛАТФОРМА', value: (j) => j.platform },
          { key: 'title', title: 'ЗАКАЗ', value: (j) => truncate(j.title, 60) },
          { key: 'budget', title: 'БЮДЖЕТ', value: (j) => (j.budget ? `${j.budget} ${j.currency || ''}` : '—') },
          { key: 'fit', title: 'FIT', value: (j) => (j.fit ?? '—') },
        ]);
        break;
      }
      case 'job': {
        const job = listJobs().find((j) => j.id === arg || j.id.endsWith(arg));
        if (!job) {
          console.log(c.gray('Заказ не найден.'));
          break;
        }
        renderBox(`${job.platform} · ${job.title}`, job.history.map((h) => `${h.ts} [${h.type}] ${h.text}`).join('\n'));
        console.log(c.gray(`url: ${job.url || '—'}  budget: ${job.budget || '—'}  status: ${job.status}`));
        break;
      }
      case 'threads': {
        const threads = listThreads();
        if (!threads.length) {
          console.log(c.gray('Переписок пока нет.'));
          break;
        }
        renderTable(threads, [
          { key: 'id', title: 'ЧАТ', value: (t) => truncate(t.chat || t.id, 28) },
          { key: 'platform', title: 'ПЛАТФОРМА', value: (t) => t.platform },
          { key: 'unread', title: 'НОВЫХ', value: (t) => t.unread ?? 0 },
          { key: 'last', title: 'ПОСЛЕДНЕЕ', value: (t) => truncate(t.lastMessage || '', 50) },
        ]);
        break;
      }
      case 'context': {
        const conv = agent.messages.filter(isConversational);
        const show = conv.slice(-Math.max(2, agent.contextMessages));
        console.log(c.bold('Что агент видит сейчас:'));
        console.log(
          c.gray(
            `  сырых сообщений: ${agent.messages.length} · диалоговых: ${conv.length} · ` +
              `в окне: последние ${show.length} · пересказ: ${agent.recap.length} ` +
              `${plural(agent.recap.length, ['раунд', 'раунда', 'раундов'])}`,
          ),
        );
        for (const m of show) {
          const who = m.role === 'user' ? c.cyan('Ты') : c.magenta('Mavis');
          const body = textOf(m).replace(/\s+/g, ' ');
          console.log(`  ${who}: ${c.gray(body.length > 160 ? body.slice(0, 160) + '…' : body)}`);
        }
        const recap = recapLines(agent.recap);
        if (recap.length) {
          console.log('');
          console.log(c.bold('Пересказ диалога (помнит и то, что уже выпало из окна):'));
          for (const line of recap) console.log(c.gray(`  ${line}`));
        }
        break;
      }
      case 'session': {
        const [sub, name] = arg.split(/\s+/);
        if (!sub) {
          console.log(
            c.gray(
              `сессия «${sessionName}» — ${agent.messages.length} сообщений в контексте, ` +
                `пересказ ${agent.recap.length} раундов`,
            ),
          );
          break;
        }
        if (sub === 'save') {
          const target = name || sessionName;
          saveSession(target, agent.messages, agent.recap);
          console.log(c.green(`Сохранено: ${target}`));
          break;
        }
        if (sub === 'load') {
          const target = name || sessionName;
          const saved = loadSession(target);
          if (!saved?.messages?.length) {
            console.log(c.gray('Сессия не найдена.'));
            break;
          }
          agent.setHistory(saved.messages, saved.recap);
          console.log(c.green(`Загружена сессия «${target}» (${agent.messages.length} сообщений)`));
          break;
        }
        if (sub === 'list') {
          const sessions = listSessions();
          if (!sessions.length) {
            console.log(c.gray('Сохранённых сессий нет.'));
            break;
          }
          renderTable(sessions, [
            { key: 'name', title: 'СЕССИЯ', value: (s) => s.name },
            { key: 'messages', title: 'СООБЩЕНИЙ', value: (s) => s.messages },
            { key: 'recap', title: 'РАУНДОВ', value: (s) => s.recap },
            { key: 'updatedAt', title: 'ОБНОВЛЕНА', value: (s) => (s.updatedAt || '—').slice(0, 19).replace('T', ' ') },
          ]);
          break;
        }
        console.log(c.gray('/session save [name] · /session load [name] · /session list'));
        break;
      }
      case 'drafts': {
        const drafts = listDrafts();
        if (!drafts.length) {
          console.log(c.gray('Черновиков нет.'));
          break;
        }
        renderTable(drafts, [
          { key: 'id', title: 'ID', value: (d) => d.id.slice(0, 12) },
          { key: 'status', title: 'СТАТУС', value: (d) => d.status },
          { key: 'target', title: 'КОМУ', value: (d) => truncate(d.target || '—', 30) },
          { key: 'body', title: 'ТЕКСТ', value: (d) => truncate(d.body, 70) },
        ]);
        break;
      }
      case 'approve': {
        const drafts = listDrafts('pending');
        const target = arg === 'all' ? drafts : drafts.filter((d) => d.id === arg || d.id.endsWith(arg));
        if (!target.length) {
          console.log(c.gray('Нет таких черновиков.'));
          break;
        }
        for (const d of target) {
          updateDraft(d.id, { status: 'approved', approvedAt: new Date().toISOString() });
          renderBox(`${d.platform || ''} → ${d.target || ''}`, d.body, c.green);
        }
        console.log(c.green('Скопируй и отправь сам, либо попроси агента отправить через send_message.'));
        break;
      }
      case 'deny': {
        const d = listDrafts('pending').find((x) => x.id === arg || x.id.endsWith(arg));
        if (!d) {
          console.log(c.gray('Черновик не найден.'));
          break;
        }
        updateDraft(d.id, { status: 'denied' });
        console.log(c.yellow('Отклонено.'));
        break;
      }
      case 'browser': {
        const { getSession } = await import('./tools/browser.js');
        const { page } = await getSession(cfg, { headless });
        const raw = String(arg || '');
        const url = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(raw) ? raw : `https://${raw}`;
        await page.goto(url, { waitUntil: 'domcontentloaded' });
        console.log(c.gray(`Открыл ${page.url()}`));
        break;
      }
      case 'snapshot': {
        const { browserActions } = await import('./tools/browser.js');
        const { getSession } = await import('./tools/browser.js');
        const { snapshot } = await import('./tools/browser.js');
        const { page } = await getSession(cfg, { headless });
        console.log(await snapshot(page, ['a', 'button', 'input', 'textarea', 'select', '[role="button"]', '[contenteditable="true"]']));
        break;
      }
      case 'playbooks': {
        const { playbookTool } = await import('./tools/playbook.js');
        console.log(await playbookTool.handler({ cfg }, { action: 'list' }));
        break;
      }
      case 'profile': {
        const { profilePath } = await import('./config.js');
        const fs = await import('node:fs');
        const p = profilePath(cfg);
        console.log(fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : c.gray(`Профиль не заполнен: ${p}`));
        break;
      }
      case 'config': {
        console.log(
          c.gray(
            JSON.stringify(
              { ...cfg, provider: { ...cfg.provider, apiKey: maskKey(cfg.provider.apiKey) } },
              null,
              2,
            ),
          ),
        );
        break;
      }
      case 'stats': {
        const jobs = listJobs();
        const byStatus = {};
        for (const j of jobs) byStatus[j.status] = (byStatus[j.status] || 0) + 1;
        console.log(c.bold('Пайплайн:'), c.gray(`${jobs.length} заказов`), byStatus);
        console.log(c.bold('Черновики:'), c.gray(`${listDrafts('pending').length} ждут отправки`));
        console.log(c.bold('Память:'), c.gray(`${Object.keys(memoryAll()).length} заметок`));
        break;
      }
      case 'clear':
        agent.reset();
        saveSession(sessionName, [], []);
        console.log(c.gray('Контекст очищен.'));
        break;
      case 'exit':
      case 'quit':
        rl.close();
        break;
      default:
        console.log(c.gray(`Неизвестная команда: /${cmd}. /help — список.`));
    }
  };

  let chain = Promise.resolve();

  const processLine = async (line) => {
    try {
      await handle(line);
    } catch (err) {
      console.log(c.red(`Ошибка: ${err.message}`));
    } finally {
      if (!rl.closed) {
        rl.prompt();
        rl.resume();
      }
    }
  };

  rl.on('line', (line) => {
    chain = chain.then(() => processLine(line)).catch((err) => console.log(c.red(`Ошибка: ${err.message}`)));
  });

  rl.on('close', () => {
    chain.finally(async () => {
      console.log('');
      await closeSession();
      process.exit(0);
    });
  });

  rl.prompt();
  rl.resume();
}
