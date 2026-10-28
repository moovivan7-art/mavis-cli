import { buildTools, toolByName } from './tools/index.js';
import { buildSystemPrompt } from './system-prompt.js';
import { truncate } from './util.js';
import {
  DEFAULT_CONTEXT_MESSAGES,
  DEFAULT_HISTORY_LIMIT,
  DEFAULT_RECAP_LIMIT,
  pushRecap,
  renderRecap,
  sanitizeMessages,
  trimMessages,
} from './context.js';

export class Agent {
  constructor({ cfg, provider, ctx, tools, system, maxSteps, onEvent, childProvider }) {
    this.cfg = cfg;
    this.provider = provider;
    this.childProvider = childProvider || null;
    this.ctx = ctx;
    this.tools = tools;
    this.system = system;
    this.maxSteps = maxSteps || cfg.agent.maxSteps || 30;
    this.onEvent = onEvent || (() => {});
    this.messages = [];
    this.recap = [];
    this.stopped = false;
  }

  /* ------------------------------------------------------------- контекст */

  get contextMessages() {
    return this.cfg.agent.contextMessages || DEFAULT_CONTEXT_MESSAGES;
  }

  get historyLimit() {
    return this.cfg.agent.historyLimit || DEFAULT_HISTORY_LIMIT;
  }

  get recapLimit() {
    return this.cfg.agent.recapLimit || DEFAULT_RECAP_LIMIT;
  }

  reset() {
    this.messages = [];
    this.recap = [];
  }

  /** Поднимает сохранённый диалог: сырые сообщения + пересказ. */
  setHistory(messages, recap) {
    this.messages = sanitizeMessages(messages || []);
    this.recap = Array.isArray(recap) ? recap.slice(-this.recapLimit) : [];
    return this.messages.length;
  }

  pushUser(text) {
    this.messages.push({ role: 'user', content: text });
    this.recap = pushRecap(this.recap, { role: 'user', text: String(text ?? '') }, this.recapLimit);
  }

  /**
   * Подрезает окно до последних диалоговых сообщений (по умолчанию 6) вместе с tool-обвязкой.
   * Всё, что выпало из окна, остаётся в пересказе — см. recap.
   */
  trim() {
    const before = this.messages.length;
    this.messages = trimMessages(this.messages, {
      contextMessages: this.contextMessages,
      historyLimit: this.historyLimit,
    });
    return before - this.messages.length;
  }

  /** Системный промпт + пересказ диалога. Считается на каждый запрос, пересказ меняется. */
  systemForRequest() {
    const base = typeof this.system === 'function' ? this.system() : this.system;
    const recap = renderRecap(this.recap);
    if (!recap) return base;
    return [
      base,
      '',
      '=== ИСТОРИЯ ДИАЛОГА (краткий пересказ — не переспрашивай то, что уже известно) ===',
      recap,
      '',
      'Последние реплики диалога приложены ниже обычными сообщениями. Отвечай по существу текущей',
      'реплики, опираясь на них: продолжай с того места, где остановились, и не начинай ответ с нуля.',
    ].join('\n');
  }

  async run(userText) {
    this.pushUser(userText);
    const answer = await this.loop();
    if (answer) {
      this.recap = pushRecap(this.recap, { role: 'agent', text: String(answer) }, this.recapLimit);
    }
    return answer;
  }

  async loop() {
    for (let step = 0; step < this.maxSteps; step++) {
      if (this.stopped) return 'Остановлено пользователем.';
      this.trim();

      let turn;
      try {
        turn = await this.provider.complete({
          system: this.systemForRequest(),
          messages: this.messages,
          tools: this.tools,
          onText: (t) => this.onEvent({ type: 'text', text: t }),
          onReasoning: (r) => this.onEvent({ type: 'reasoning', text: r }),
        });
      } catch (err) {
        this.onEvent({ type: 'error', message: err.message });
        return `Ошибка модели: ${err.message}`;
      }

      const assistantContent = [];
      if (turn.reasoning) assistantContent.push({ type: 'thinking', thinking: turn.reasoning });
      if (turn.text) assistantContent.push({ type: 'text', text: turn.text });
      for (const call of turn.toolCalls) {
        assistantContent.push({ type: 'tool_use', id: call.id, name: call.name, input: call.args || {} });
      }
      // Пустой content[] API не принимает — подставляем заглушку.
      if (!assistantContent.length) assistantContent.push({ type: 'text', text: '(агент промолчал)' });
      this.messages.push({ role: 'assistant', content: assistantContent });

      if (!turn.toolCalls.length) {
        this.onEvent({ type: 'done', text: turn.text });
        return turn.text || '';
      }

      const results = await this.executeTools(turn.toolCalls);
      if (results.length) this.messages.push({ role: 'user', content: results });
    }
    return `Достигнут лимит шагов (${this.maxSteps}). Остановился — скажи, что делать дальше.`;
  }

  async executeTools(calls) {
    const results = new Map();
    const parallel = calls.filter((c) => c.name === 'delegate');
    const sequential = calls.filter((c) => c.name !== 'delegate');

    for (const call of sequential) {
      results.set(call.id, await this.runTool(call));
    }
    if (parallel.length) {
      const outs = await Promise.all(parallel.map((call) => this.runTool(call)));
      parallel.forEach((call, i) => results.set(call.id, outs[i]));
    }

    return calls.map((call) => {
      const r = results.get(call.id) || { ok: false, content: 'Инструмент не отработал' };
      return { type: 'tool_result', tool_use_id: call.id, content: r.content, is_error: !r.ok };
    });
  }

  async runTool(call) {
    const tool = toolByName(call.name);
    if (!tool) {
      this.onEvent({ type: 'tool', name: call.name, args: call.args, ok: false, result: 'нет такого инструмента' });
      return { ok: false, content: `Инструмент "${call.name}" не существует.` };
    }
    this.onEvent({ type: 'tool-start', name: call.name, args: call.args });
    try {
      const out = await tool.handler(this.ctx, call.args || {});
      const text = typeof out === 'string' ? out : JSON.stringify(out);
      this.onEvent({ type: 'tool-end', name: call.name, ok: true, result: text });
      return { ok: true, content: truncate(text, 20000) };
    } catch (err) {
      this.onEvent({ type: 'tool-end', name: call.name, ok: false, result: err.message });
      return { ok: false, content: `Ошибка инструмента ${call.name}: ${err.message}` };
    }
  }

  /* ------------------------------------------------------- sub-agents */

  async runSubAgent({ task, role, tools, maxSteps }) {
    const allowed = tools?.length ? tools : ['browser', 'files', 'jobs', 'playbook', 'todo', 'bash'];
    const childTools = buildTools(allowed.filter((t) => t !== 'send_message'));
    const childSystem = [
      buildSystemPrompt(this.cfg),
      '',
      '=== РЕЖИМ ПОДАГЕНТА ===',
      `Ты подагент: ${role || 'исследователь'}. У тебя чистый контекст и ограниченный набор инструментов.`,
      'Выполни задачу и верни СЖАТЫЙ отчёт: факты, цифры, ссылки, ничего лишнего.',
      'Ты НЕ отправляешь сообщения и НЕ общаешься с клиентами — только собираешь информацию.',
    ].join('\n');

    const child = new Agent({
      cfg: this.cfg,
      provider: this.childProvider ? this.childProvider() : this.provider,
      ctx: this.ctx,
      tools: childTools,
      system: childSystem,
      maxSteps: maxSteps || 12,
      onEvent: (ev) => {
        if (ev.type === 'tool-start') {
          this.onEvent({ type: 'subagent-tool', name: ev.name, args: ev.args });
        }
      },
    });

    this.onEvent({ type: 'subagent-start', role: role || 'исследователь', task });
    const report = await child.run(task);
    this.onEvent({ type: 'subagent-end', role: role || 'исследователь' });
    return report || '(подагент не вернул отчёт)';
  }
}
