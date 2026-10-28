/**
 * End-to-end smoke test.
 *
 * 1) Spin a local HTTP server that speaks the Anthropic /v1/messages protocol and records
 *    every request — so we validate the real wire format, not a mock object.
 * 2) Drive the agent through it: jobs.add -> send_message (approval gate) -> final text.
 * 3) Launch a real Chromium and drive the browser tool + the real send path against a local page.
 * 4) Exercise the delegate tool (sub-agent).
 *
 * Run: node test/smoke.mjs
 */

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mavis-smoke-'));
process.env.MAVIS_HOME = path.join(TMP, 'home');
process.env.MAVIS_NODE_MODULES = '/usr/local/lib/node_modules';
// держим бэкапы и прочий home внутри tmp, а не в реальном HOME
process.env.HOME = TMP;

const { loadConfig, saveConfig } = await import('../src/config.js');
const { createProvider, MockProvider, AnthropicProvider } = await import('../src/providers/index.js');
const { Agent } = await import('../src/agent.js');
const { buildTools } = await import('../src/tools/index.js');
const { buildSystemPrompt } = await import('../src/system-prompt.js');
const { listJobs, listDrafts, upsertJob } = await import('../src/store.js');
const { browserTool, closeSession } = await import('../src/tools/browser.js');
const { sendMessageTool } = await import('../src/tools/send.js');

let passed = 0;
const ok = (name) => {
  passed++;
  console.log(`  ✔ ${name}`);
};
const fail = (name, err) => {
  console.error(`  ✖ ${name}\n    ${err.stack || err.message}`);
  process.exitCode = 1;
};

async function step(name, fn) {
  try {
    await fn();
    ok(name);
  } catch (err) {
    fail(name, err);
  }
}

/* ------------------------------------------------- fake Anthropic server */

const requests = [];
let turn = 0;

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', () => {
    const parsed = JSON.parse(body || '{}');
    requests.push({ path: req.url, headers: req.headers, body: parsed });
    turn++;

    const send = (content, stop = 'end_turn') => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'msg_test',
          type: 'message',
          role: 'assistant',
          model: parsed.model,
          content,
          stop_reason: stop,
          usage: { input_tokens: 10, output_tokens: 10 },
        }),
      );
    };

    if (turn === 1) {
      send(
        [
          { type: 'thinking', thinking: 'Пользователь просит найти заказ — заведу его в пайплайн.' },
          { type: 'text', text: 'Завожу заказ в пайплайн.' },
          {
            type: 'tool_use',
            id: 'toolu_1',
            name: 'jobs',
            input: {
              action: 'add',
              platform: 'flru',
              title: 'Сверстать лендинг на Tilda',
              url: 'https://www.fl.ru/project/123/',
              budget: '5000',
              currency: '₽',
              fit: 88,
              notes: 'По профилю подходит',
            },
          },
        ],
        'tool_use',
      );
    } else if (turn === 2) {
      const jobs = listJobs();
      send(
        [
          {
            type: 'tool_use',
            id: 'toolu_2',
            name: 'send_message',
            input: {
              channel: 'flru',
              to: 'Заказчик с FL.ru',
              body: 'Здравствуйте! Сделаю лендинг на Tilda за 5 дней, 5000 ₽. Покажите примеры?',
              jobId: jobs[0]?.id,
            },
          },
        ],
        'tool_use',
      );
    } else if (turn === 3) {
      send([{ type: 'text', text: 'Отклик отправлен, заказ заведён в пайплайн.' }]);
    } else {
      send([{ type: 'text', text: 'ok' }]);
    }
  });
});

await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const baseUrl = `http://127.0.0.1:${port}/anthropic`;

/* ------------------------------------------------------------------ setup */

const cfg = loadConfig();
cfg.provider.protocol = 'anthropic';
cfg.provider.baseUrl = baseUrl;
cfg.provider.model = 'MiniMax-M3.1-Flash';
cfg.provider.apiKey = 'test-key-123';
cfg.provider.maxTokens = 2048;
cfg.agent.workspace = path.join(TMP, 'workspace');
cfg.agent.approvalMode = 'ask';
cfg.browser.profileDir = path.join(TMP, 'browser');
cfg.browser.headless = true;
cfg.playbooksDir = path.join(TMP, 'playbooks');
cfg.profileFile = path.join(TMP, 'profile.md');
fs.mkdirSync(cfg.playbooksDir, { recursive: true });
fs.writeFileSync(cfg.profileFile, '# Профиль\nСверстаю лендинг на Tilda.\n');
saveConfig({
  provider: { protocol: 'anthropic', baseUrl, model: cfg.provider.model, apiKey: 'test-key-123', maxTokens: 2048 },
  agent: { workspace: cfg.agent.workspace, approvalMode: 'ask' },
  browser: { profileDir: cfg.browser.profileDir, headless: true },
  playbooksDir: cfg.playbooksDir,
  profileFile: cfg.profileFile,
});

const provider = createProvider(cfg);

let asked = [];
const ctx = {
  cfg,
  ask: async ({ title, body }) => {
    asked.push({ title, body });
    return { approved: true, action: 'approve', text: body };
  },
  runSubAgent: null,
};

const agent = new Agent({
  cfg,
  provider,
  ctx,
  tools: buildTools(),
  system: buildSystemPrompt(cfg),
  maxSteps: 8,
  childProvider: () => new MockProvider({ mockScript: [{ text: 'Найдено 3 подходящих заказа.' }] }),
  onEvent: () => {},
});
ctx.runSubAgent = (opts) => agent.runSubAgent(opts);

/* --------------------------------------------------------------- the run */

console.log('\n[1] Агент против локального Anthropic-совместимого сервера');

await step('цикл агента: tool call → tool result → финальный текст', async () => {
  const answer = await agent.run('Найди подходящий заказ на лендинг и откликнись');
  assert.match(answer, /Отклик отправлен/);
});

await step('запрос ушёл в правильном формате (system + tools + anthropic body)', async () => {
  assert.ok(requests.length >= 3, `ожидалось >=3 запросов, получили ${requests.length}`);
  const first = requests[0];
  assert.equal(first.path, '/anthropic/v1/messages');
  assert.ok(first.body.system, 'нет system-промпта');
  assert.ok(Array.isArray(first.body.tools) && first.body.tools.length > 5, 'нет описания инструментов');
  assert.ok(first.body.tools.some((t) => t.name === 'send_message'), 'нет инструмента send_message');
  assert.ok(first.body.tools.every((t) => t.input_schema), 'у инструмента нет input_schema');
  assert.equal(first.headers['x-api-key'], 'test-key-123');
});

await step('второй запрос содержит tool_result с правильным tool_use_id', async () => {
  const second = requests[1].body.messages;
  const tr = second.flatMap((m) => (Array.isArray(m.content) ? m.content : [])).find((m) => m.type === 'tool_result');
  assert.ok(tr, 'нет tool_result в истории');
  assert.equal(tr.tool_use_id, 'toolu_1');
  assert.match(String(tr.content), /Сверстать лендинг/);
});

await step('thinking-блок сохранён в истории (interleaved thinking)', async () => {
  const second = requests[1].body.messages;
  const assistant = second.find((m) => m.role === 'assistant');
  assert.ok(
    assistant.content.some((b) => b.type === 'thinking'),
    'thinking-блок потерялся',
  );
});

await step('заказ попал в пайплайн', async () => {
  const jobs = listJobs();
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].platform, 'flru');
  assert.equal(jobs[0].fit, 88);
  assert.equal(jobs[0].status, 'new', 'статус не должен меняться, пока отклик реально не ушёл');
});

await step('гейт подтверждения сработал перед отправкой', async () => {
  assert.equal(asked.length, 1, `ask должен был вызваться один раз, вызвался ${asked.length}`);
  assert.match(asked[0].title, /Отправить в flru/);
  assert.match(asked[0].body, /Tilda/);
});

await step('при сбое доставки черновик остаётся в pending, а не «отправлен»', async () => {
  const drafts = listDrafts();
  assert.equal(drafts.length, 1);
  assert.equal(drafts[0].status, 'pending', 'черновик не должен помечаться отправленным');
  assert.match(String(drafts[0].result || ''), /не наш|не отправлено|Отправлено/i);
});

/* --------------------------------------------------- approval deny path */

await step('отказ пользователя блокирует отправку', async () => {
  const denyCtx = { cfg, ask: async () => ({ approved: false, action: 'n', text: 'x' }), runSubAgent: null };
  const out = await sendMessageTool.handler(denyCtx, {
    channel: 'telegram',
    to: 'Клиент',
    body: 'Привет!',
  });
  assert.match(out, /НЕ отправлено|не подтвердил/i);
  const denied = listDrafts('denied');
  assert.ok(denied.some((d) => d.body === 'Привет!'), 'отклонённый черновик должен сохраниться со статусом denied');
  assert.equal(listDrafts('sent').filter((d) => d.body === 'Привет!').length, 0, 'отклонённое не должно уйти');
});

/* ------------------------------------------------- real browser + send */

console.log('\n[2] Браузер (реальный Chromium) и реальная доставка');

const html = `<!doctype html><html><body>
<h1>Тестовая страница</h1>
<input id="name" placeholder="Как тебя зовут">
<textarea id="msg" name="text" placeholder="Сообщение"></textarea>
<button onclick="document.getElementById('out').textContent='Отправлено: '+document.getElementById('msg').value">Отправить</button>
<div id="out"></div>
</body></html>`;
const htmlFile = path.join(TMP, 'page.html');
fs.writeFileSync(htmlFile, html);

await step('браузер открывает страницу и отдаёт snapshot с ref', async () => {
  const out = await browserTool.handler({ cfg }, { action: 'open', url: `file://${htmlFile}` });
  assert.match(out, /Открыл file:\/\//);
  assert.match(out, /\[1\]/);
  assert.match(out, /input/);
  assert.match(out, /Отправить/);
});

await step('fill вводит текст, click нажимает кнопку', async () => {
  const out = await browserTool.handler({ cfg }, { action: 'fill', ref: 2, value: 'Привет из теста' });
  assert.match(out, /Заполнил поле/);
  const clicked = await browserTool.handler({ cfg }, { action: 'click', text: 'Отправить' });
  assert.match(clicked, /Кликнул/);
  const read = await browserTool.handler({ cfg }, { action: 'read' });
  assert.match(read, /Отправлено: Привет из теста/);
});

await step('screenshot сохраняет файл', async () => {
  const out = await browserTool.handler({ cfg }, { action: 'screenshot', path: 'smoke.png' });
  assert.match(out, /Скриншот:/);
  const saved = out.split('Скриншот: ')[1].trim();
  assert.ok(fs.existsSync(saved), 'файл скриншота не найден');
});

await step('реальная отправка через send_message: текст ушёл в форму, статус sent', async () => {
  // Открываем страницу с формой ответа — имитация открытой карточки заказа.
  await browserTool.handler({ cfg }, { action: 'open', url: `file://${htmlFile}` });

  const job = upsertJob({ platform: 'flru', title: 'Проверка доставки', fit: 50 });
  const sendCtx = {
    cfg,
    ask: async () => ({ approved: true, action: 'approve', text: 'Проверочный ответ' }),
    runSubAgent: null,
  };
  const out = await sendMessageTool.handler(sendCtx, {
    channel: 'flru',
    to: 'Заказчик',
    body: 'Проверочный ответ',
    jobId: job.id,
  });
  assert.match(out, /Отправлено/i, `получено: ${out}`);

  const drafts = listDrafts();
  const sent = drafts.find((d) => d.body === 'Проверочный ответ');
  assert.ok(sent, 'нет черновика с отправленным текстом');
  assert.equal(sent.status, 'sent');
  assert.equal(listJobs().find((j) => j.id === job.id).status, 'replied');
});

/* ------------------------------------------------------------ sub-agent */

console.log('\n[3] Подагенты');

await step('delegate возвращает отчёт подагента', async () => {
  const { delegateTool } = await import('../src/tools/delegate.js');
  const out = await delegateTool.handler(ctx, { task: 'Найди 3 заказа', role: 'искатель заказов' });
  assert.match(out, /3 подходящих заказа/);
});

/* ------------------------------------------------- openai protocol path */

console.log('\n[4] OpenAI-совместимый протокол');

const oaRequests = [];
let oaTurn = 0;
const oaServer = http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', () => {
    const parsed = JSON.parse(body || '{}');
    oaRequests.push({ path: req.url, headers: req.headers, body: parsed });
    oaTurn++;
    const finish = (message) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'chatcmpl-test',
          object: 'chat.completion',
          created: 1,
          model: parsed.model,
          choices: [{ index: 0, message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }],
        }),
      );
    };
    if (oaTurn === 1) {
      finish({
        role: 'assistant',
        content: 'Смотрю заказы.',
        reasoning_content: 'Думаю, что делать.',
        tool_calls: [
          {
            id: 'call_a',
            type: 'function',
            function: { name: 'jobs', arguments: JSON.stringify({ action: 'add', platform: 'kwork', title: 'Дизайн баннера' }) },
          },
        ],
      });
    } else {
      finish({ role: 'assistant', content: 'Заказ заведён.' });
    }
  });
});
await new Promise((r) => oaServer.listen(0, '127.0.0.1', r));
const oaPort = oaServer.address().port;

await step('OpenAI-протокол: tool_call → role:tool result → финальный текст', async () => {
  const { OpenAIProvider } = await import('../src/providers/index.js');
  const oaCfg = { ...cfg, provider: { ...cfg.provider, protocol: 'openai', baseUrl: `http://127.0.0.1:${oaPort}/v1` } };
  const oaProvider = new OpenAIProvider(oaCfg);
  const oaCtx = { cfg: oaCfg, ask: async () => ({ approved: true, text: '' }), runSubAgent: null };
  const oaAgent = new Agent({
    cfg: oaCfg,
    provider: oaProvider,
    ctx: oaCtx,
    tools: buildTools(),
    system: 'тест',
    maxSteps: 5,
    onEvent: () => {},
  });
  const answer = await oaAgent.run('добавь заказ');
  assert.match(answer, /Заказ заведён/);

  assert.equal(oaRequests[0].path, '/v1/chat/completions');
  const body = oaRequests[0].body;
  assert.ok(body.tools[0].type === 'function', 'инструменты должны уходить как functions');
  assert.ok(body.tools.some((t) => t.function.name === 'send_message'));
  assert.equal(body.messages[0].role, 'system');

  const second = oaRequests[1].body.messages;
  const toolMsg = second.find((m) => m.role === 'tool');
  assert.ok(toolMsg, 'нет сообщения с ролью tool');
  assert.equal(toolMsg.tool_call_id, 'call_a');
  assert.match(String(toolMsg.content), /Дизайн баннера/);
});

oaServer.close();

/* ------------------------------------------------------- threads + session */

console.log('\n[5] Переписка и память диалога');

await step('threads: open → append → get → markRead', async () => {
  const { threadsTool } = await import('../src/tools/threads.js');
  await threadsTool.handler({ cfg }, { action: 'open', platform: 'telegram', chat: 'Иван', unread: 2, lastMessage: 'Привет' });
  await threadsTool.handler({ cfg }, { action: 'append', id: 'telegram:Иван', text: 'Сколько стоит?', direction: 'in', from: 'Иван' });
  const got = await threadsTool.handler({ cfg }, { action: 'get', id: 'telegram:Иван' });
  assert.match(got, /Сколько стоит\?/);
  assert.match(got, /непрочитанных: 0/, 'входящее сообщение должно снимать счётчик непрочитанных');

  const list = await threadsTool.handler({ cfg }, { action: 'list' });
  assert.match(list, /telegram:Иван/);

  await threadsTool.handler({ cfg }, { action: 'append', id: 'telegram:Иван', text: '5000, 5 дней', direction: 'out' });
  const got2 = await threadsTool.handler({ cfg }, { action: 'get', id: 'telegram:Иван' });
  assert.match(got2, /5000, 5 дней/);
  assert.match(got2, /\[in\]/, 'направления должны сохраняться');
});

await step('threads: ingest пачки чатов из скана списка диалогов', async () => {
  const { threadsTool } = await import('../src/tools/threads.js');
  const out = await threadsTool.handler(
    { cfg },
    {
      action: 'ingest',
      platform: 'telegram',
      chats: [
        { chat: 'Мария', lastMessage: 'Цена?', unread: 1 },
        { chat: 'Пётр', lastMessage: 'Спасибо', unread: 0 },
      ],
    },
  );
  assert.match(out, /Загрузил чатов: 2/);
  const list = await threadsTool.handler({ cfg }, { action: 'list' });
  assert.match(list, /telegram:Мария/);
  assert.match(list, /telegram:Пётр/);
});

await step('диалог сохраняется и поднимается в новой сессии', async () => {
  const { saveSession, loadSession } = await import('../src/store.js');
  const sessionName = 'test-session';
  saveSession(sessionName, [{ role: 'user', content: 'помни меня' }], [{ role: 'user', text: 'помни меня' }]);
  const restored = loadSession(sessionName);
  assert.ok(restored?.messages?.length === 1, 'сессия не восстановилась');
  assert.equal(restored.messages[0].content, 'помни меня');
  assert.equal(restored.recap.length, 1, 'пересказ не сохранился');
});

await step('snapshot экспортируется (команда /snapshot не падает)', async () => {
  const mod = await import('../src/tools/browser.js');
  assert.equal(typeof mod.snapshot, 'function', 'snapshot не экспортирован');
});

/* ------------------------------------------------- контекст диалога */

console.log('\n[6] Контекст диалога: последние сообщения + пересказ');

await step('окно держит последние 6 диалоговых сообщений', async () => {
  const { trimMessages, isConversational } = await import('../src/context.js');
  const messages = [];
  for (let i = 1; i <= 10; i++) {
    messages.push({ role: 'user', content: `реплика ${i}` });
    messages.push({ role: 'assistant', content: [{ type: 'text', text: `ответ ${i}` }] });
  }
  const window = trimMessages(messages, { contextMessages: 6, historyLimit: 60 });
  const conv = window.filter(isConversational);
  assert.equal(conv.length, 6, `ожидалось 6 диалоговых сообщений, получили ${conv.length}`);
  const text = JSON.stringify(window);
  assert.match(text, /реплика 10/, 'последняя реплика должна остаться в окне');
  assert.doesNotMatch(text, /реплика 1"/, 'первая реплика должна выпасть из окна');
});

await step('вызовы инструментов не выедают исходную задачу', async () => {
  const { trimMessages } = await import('../src/context.js');
  const messages = [{ role: 'user', content: 'ИСХОДНАЯ ЗАДАЧА' }];
  for (let i = 0; i < 30; i++) {
    messages.push({ role: 'assistant', content: [{ type: 'tool_use', id: `t${i}`, name: 'jobs', input: {} }] });
    messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: `t${i}`, content: 'ok' }] });
  }
  messages.push({ role: 'user', content: 'ПОСЛЕДНЯЯ РЕПЛИКА' });
  const window = trimMessages(messages, { contextMessages: 6, historyLimit: 60 });
  const text = JSON.stringify(window);
  assert.match(text, /ПОСЛЕДНЯЯ РЕПЛИКА/, 'последняя реплика должна быть в окне');
  assert.match(text, /ИСХОДНАЯ ЗАДАЧА/, 'исходная задача не должна выпасть из контекста');
});

await step('tool_use в окне всегда имеет парный tool_result', async () => {
  const { trimMessages } = await import('../src/context.js');
  const messages = [{ role: 'user', content: 'задача' }];
  for (let i = 0; i < 12; i++) {
    messages.push({ role: 'assistant', content: [{ type: 'tool_use', id: `t${i}`, name: 'jobs', input: {} }] });
    messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: `t${i}`, content: 'ok' }] });
  }
  const window = trimMessages(messages, { contextMessages: 6, historyLimit: 40 });
  const blocks = window.flatMap((m) => (Array.isArray(m.content) ? m.content : []));
  const uses = blocks.filter((b) => b.type === 'tool_use').map((b) => b.id);
  const results = blocks.filter((b) => b.type === 'tool_result').map((b) => b.tool_use_id);
  for (const id of uses) assert.ok(results.includes(id), `tool_use ${id} остался без результата`);
  assert.equal(window[0].role, 'user', 'первым в окне должен идти user');
});

await step('битая сессия (обрыв на tool_use) чистится и не ломает диалог', async () => {
  const { sanitizeMessages } = await import('../src/context.js');
  const broken = [
    { role: 'user', content: 'привет' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'x1', name: 'jobs', input: {} }] },
  ];
  const clean = sanitizeMessages(broken);
  assert.equal(clean.length, 1, 'сиротский tool_use должен выпасть');
  assert.equal(clean[0].role, 'user');
  assert.equal(clean[0].content, 'привет');
});

await step('агент шлёт в модель предыдущие реплики, а не только текущую', async () => {
  const ctxRequests = [];
  const ctxServer = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      const parsed = JSON.parse(body || '{}');
      ctxRequests.push(parsed);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'msg_ctx',
          type: 'message',
          role: 'assistant',
          model: parsed.model,
          content: [{ type: 'text', text: 'ок' }],
          stop_reason: 'end_turn',
        }),
      );
    });
  });
  await new Promise((r) => ctxServer.listen(0, '127.0.0.1', r));
  const ctxPort = ctxServer.address().port;
  const ctxCfg = {
    ...cfg,
    provider: { ...cfg.provider, protocol: 'anthropic', baseUrl: `http://127.0.0.1:${ctxPort}/anthropic` },
    agent: { ...cfg.agent, contextMessages: 6 },
  };
  const ctxAgent = new Agent({
    cfg: ctxCfg,
    provider: new AnthropicProvider(ctxCfg),
    ctx: { cfg: ctxCfg, ask: async () => ({ approved: false }), runSubAgent: null },
    tools: [],
    system: 'системный промпт',
    onEvent: () => {},
  });

  await ctxAgent.run('ПЕРВАЯ реплика');
  await ctxAgent.run('ВТОРАЯ реплика');
  await ctxAgent.run('ТРЕТЬЯ реплика');

  const last = ctxRequests[ctxRequests.length - 1];
  const wire = JSON.stringify(last.messages);
  assert.match(wire, /ПЕРВАЯ реплика/, 'первая реплика пропала из контекста');
  assert.match(wire, /ВТОРАЯ реплика/, 'вторая реплика пропала из контекста');
  assert.match(wire, /ТРЕТЬЯ реплика/, 'текущая реплика потерялась');
  assert.match(String(last.system), /ИСТОРИЯ ДИАЛОГА/, 'в системный промпт не попал пересказ диалога');
  assert.match(String(last.system), /ПЕРВАЯ реплика/, 'пересказ не содержит ранних реплик');
  ctxServer.close();
});

await step('пересказ переживает обрезку окна и попадает в запрос', async () => {
  const ctxCfg = { ...cfg, agent: { ...cfg.agent, contextMessages: 2 } };
  const ctxAgent = new Agent({
    cfg: ctxCfg,
    provider: new MockProvider({ mockScript: [{ text: 'ответ агента' }] }),
    ctx: { cfg: ctxCfg, ask: async () => ({ approved: false }), runSubAgent: null },
    tools: [],
    system: 'системный промпт',
    onEvent: () => {},
  });
  await ctxAgent.run('очень ранняя реплика');
  await ctxAgent.run('средняя реплика');
  await ctxAgent.run('последняя реплика');
  const system = ctxAgent.systemForRequest();
  assert.match(system, /ИСТОРИЯ ДИАЛОГА/);
  assert.match(system, /очень ранняя реплика/, 'пересказ должен помнить и выпавшие из окна реплики');
});

await step('REPL: команда /context показывает, что агент видит', async () => {
  const { spawn } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const child = spawn(process.execPath, [path.join(pkgRoot, 'bin/mavis.js'), '--offline'], {
    env: { ...process.env, MAVIS_HOME: path.join(TMP, 'home-repl') },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => {
    out += d.toString();
  });
  child.stderr.on('data', () => {});
  child.stdin.write('привет\n');
  await new Promise((r) => setTimeout(r, 700));
  child.stdin.write('/context\n');
  await new Promise((r) => setTimeout(r, 700));
  child.stdin.write('/exit\n');
  await new Promise((resolve) => {
    child.on('close', resolve);
    setTimeout(() => child.kill('SIGKILL'), 5000);
  });
  assert.match(out, /Что агент видит сейчас/, 'команда /context не отработала');
  assert.match(out, /контекст:/, 'REPL не показывает состояние контекста');
});

await closeSession();

/* ------------------------------------------------------- самообновление */

console.log('\n[7] Самообновление (mavis --update)');

await step('обновление раскладывает новую версию поверх старой и делает бэкап', async () => {
  const { backupRoot, layOver, findPackageRoot } = await import('../src/updater.js');

  // "старая установка"
  const root = path.join(TMP, 'fake-install');
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'agent.js'), 'старая версия');

  // "новая версия" — так же, как распаковывается архив с GitHub: папка mavis-cli-main/
  const archive = path.join(TMP, 'archive');
  const fresh = path.join(archive, 'mavis-cli-main');
  fs.mkdirSync(path.join(fresh, 'src'), { recursive: true });
  fs.writeFileSync(path.join(fresh, 'package.json'), '{"name":"mavis-cli"}');
  fs.writeFileSync(path.join(fresh, 'src', 'agent.js'), 'новая версия');
  fs.writeFileSync(path.join(fresh, 'src', 'context.js'), 'добавленный файл');

  // корень пакета в распакованном архиве ищется по package.json
  const found = findPackageRoot(archive);
  assert.equal(found, fresh, 'корень пакета не найден в архиве');

  const backup = backupRoot(root, 'test-stamp');
  assert.ok(fs.existsSync(path.join(backup, 'src', 'agent.js')), 'бэкап не сделан');
  assert.equal(fs.readFileSync(path.join(backup, 'src', 'agent.js'), 'utf8'), 'старая версия');

  layOver(fresh, root);
  assert.equal(fs.readFileSync(path.join(root, 'src', 'agent.js'), 'utf8'), 'новая версия', 'файл не обновился');
  assert.ok(fs.existsSync(path.join(root, 'src', 'context.js')), 'новый файл не добавился');
});

await step('в проекте лежит mavis-update.sh — вечная точка входа для обновления', async () => {
  const { fileURLToPath } = await import('node:url');
  const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const script = path.join(pkgRoot, 'mavis-update.sh');
  assert.ok(fs.existsSync(script), 'mavis-update.sh не найден');
  const body = fs.readFileSync(script, 'utf8');
  assert.match(body, /archive\/refs\/heads\/main/, 'скрипт должен тянуть код с GitHub');
});

await closeSession();

/* ----------------------------------------------------- самодиагностика */

console.log('\n[8] Самодиагностика (mavis --check)');

await step('doctor: все пункты зелёные на рабочем окружении', async () => {
  const { runCheck, renderCheck } = await import('../src/doctor.js');

  // профиль и плейбук — чтобы их пункты тоже были зелёными
  fs.writeFileSync(
    cfg.profileFile,
    '# Профиль\nСверстаю лендинг на Tilda, делаю быстро, беру от 5000 ₽, пишу коротко и по делу.\n',
  );
  fs.writeFileSync(path.join(cfg.playbooksDir, 'flru.md'), '# FL.ru\nгайд по площадке\n');

  // локальный сервер, который отвечает с учётом контекста диалога
  const docServer = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      const parsed = JSON.parse(body || '{}');
      const all = JSON.stringify(parsed.messages || []);
      const found = all.match(/Меня зовут ([^"\\,.]+)/);
      const name = found ? found[1] : 'не знаю';
      const text = /Как меня зовут/.test(all)
        ? `Тебя зовут ${name}, ты делаешь лендинги на Tilda.`
        : 'ок';
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'msg_doc',
          type: 'message',
          role: 'assistant',
          model: parsed.model,
          content: [{ type: 'text', text }],
          stop_reason: 'end_turn',
        }),
      );
    });
  });
  await new Promise((r) => docServer.listen(0, '127.0.0.1', r));
  const docPort = docServer.address().port;
  const docCfg = {
    ...cfg,
    provider: { ...cfg.provider, protocol: 'anthropic', baseUrl: `http://127.0.0.1:${docPort}/anthropic`, apiKey: 'test-key' },
  };

  const result = await runCheck({ cfg: docCfg, api: true });
  const report = renderCheck(result);
  if (!result.ok) console.log(report);
  assert.ok(result.ok, 'диагностика нашла проблемы:\n' + report);
  assert.match(report, /Контекст: модель помнит/, 'в отчёте нет пункта про контекст');
  docServer.close();
});

await step('doctor: без ключа честно говорит, что ключ не найден', async () => {
  const { runCheck } = await import('../src/doctor.js');
  const noKey = { ...cfg, provider: { ...cfg.provider, apiKey: null } };
  const result = await runCheck({ cfg: noKey, api: false });
  assert.equal(result.ok, false, 'без ключа должно быть «не работает»');
  const cfgCheck = result.checks.find((c) => c.title.includes('API-ключ'));
  assert.ok(cfgCheck && !cfgCheck.ok, 'пункт про ключ должен быть красным');
  assert.ok(cfgCheck.fix, 'должна быть подсказка, что делать');
});

await closeSession();

/* ------------------------------- [9] Операционный протокол (подключаемый файл) */

console.log('\n[9] Операционный протокол');

await step('протокол из файла попадает в системный промпт', async () => {
  const { protocolPath } = await import('../src/config.js');
  const p = protocolPath(cfg);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, 'ТЕСТОВЫЙ ПРОТОКОЛ: БЕРЁМ J-001 означает полный цикл.', 'utf8');
  const sys = buildSystemPrompt(cfg);
  assert.match(sys, /ОПЕРАЦИОННЫЙ ПРОТОКОЛ/, 'в промпте нет блока протокола');
  assert.match(sys, /ТЕСТОВЫЙ ПРОТОКОЛ/, 'текст протокола не попал в промпт');
  fs.rmSync(p);
});

await step('без файла протокола промпт собирается и не падает', async () => {
  const { protocolPath } = await import('../src/config.js');
  const p = protocolPath(cfg);
  if (fs.existsSync(p)) fs.rmSync(p);
  const sys = buildSystemPrompt(cfg);
  assert.ok(sys.length > 500, 'промпт подозрительно короткий');
  assert.doesNotMatch(sys, /ТЕСТОВЫЙ ПРОТОКОЛ/, 'протокол не должен подмешиваться');
});

await step('doctor видит протокол и предлагает его поставить', async () => {
  const { runCheck } = await import('../src/doctor.js');
  const { protocolPath } = await import('../src/config.js');
  const p = protocolPath(cfg);
  if (fs.existsSync(p)) fs.rmSync(p);
  const result = await runCheck({ cfg, api: false });
  const check = result.checks.find((c) => c.title.includes('Операционный протокол'));
  assert.ok(check, 'в диагностике нет пункта про протокол');
  assert.ok(check.fix && /protocol\.md/.test(check.fix), 'нет подсказки, куда положить файл');
});

await step('в репозитории лежит эталонный протокол', async () => {
  const here = path.dirname(new URL(import.meta.url).pathname);
  const proto = path.join(here, '..', 'templates', 'protocol.md');
  assert.ok(fs.existsSync(proto), 'нет templates/protocol.md');
  const body = fs.readFileSync(proto, 'utf8');
  assert.ok(body.length > 5000, `протокол слишком короткий: ${body.length}`);
  for (const marker of ['БЕРЁМ J-001', 'СТАТУС', 'ОТКЛИК J-001', 'являются согласием']) {
    assert.ok(body.includes(marker), `в протоколе нет маркера «${marker}»`);
  }
});

/* -------------------------------------------------------------- итог */

server.close();
console.log(`\n${process.exitCode ? '✖ ЕСТЬ ОШИБКИ' : '✔ ВСЁ ПРОШЛО'} — проверок: ${passed}\n`);
