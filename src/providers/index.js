/**
 * Provider abstraction.
 *
 * Two wire protocols are supported:
 *   - anthropic: POST {baseUrl}/v1/messages   (MiniMax recommends this one; supports interleaved thinking)
 *   - openai:    POST {baseUrl}/chat/completions (any OpenAI-compatible endpoint)
 *
 * A provider returns a normalized turn:
 *   { text, reasoning, toolCalls: [{id, name, args}], raw }
 */

import { extractText, truncate } from '../util.js';

async function readSse(response, onEvent) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf('\n\n')) !== -1) {
      const chunk = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const dataLines = chunk
        .split('\n')
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).trim());
      if (!dataLines.length) continue;
      const payload = dataLines.join('\n');
      if (payload === '[DONE]') continue;
      try {
        onEvent(JSON.parse(payload));
      } catch {
        /* ignore keep-alive garbage */
      }
    }
  }
}

/* --------------------------------------------------------------- anthropic */

export class AnthropicProvider {
  constructor(cfg) {
    this.cfg = cfg;
    this.protocol = 'anthropic';
    this.name = 'anthropic';
  }

  get baseUrl() {
    const b = (this.cfg.provider.baseUrl || 'https://api.minimax.io/anthropic').replace(/\/+$/, '');
    return b.endsWith('/v1/messages') ? b : `${b}/v1/messages`;
  }

  buildTools(tools) {
    return tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.schema,
    }));
  }

  toWire(messages) {
    return messages.map((m) => {
      if (m.role === 'user' && typeof m.content === 'string') return { role: 'user', content: m.content };
      if (m.role === 'user' && Array.isArray(m.content)) {
        const parts = m.content.map((c) =>
          c.type === 'tool_result'
            ? { type: 'tool_result', tool_use_id: c.tool_use_id, content: c.content, is_error: !!c.is_error }
            : { type: 'text', text: String(c.text ?? '') },
        );
        return { role: 'user', content: parts };
      }
      if (m.role === 'assistant' && Array.isArray(m.content)) return { role: 'assistant', content: m.content };
      return { role: m.role, content: m.content };
    });
  }

  /**
   * Плоская история: tool-обвязка превращается в обычный текст.
   * Нужна как запасной вариант, когда модель не принимает tool_use/tool_result в истории.
   */
  toFlatWire(messages) {
    const out = [];
    const push = (role, content) => {
      if (!content || !String(content).trim()) return;
      const last = out[out.length - 1];
      if (last && last.role === role) last.content = `${last.content}\n\n${content}`;
      else out.push({ role, content });
    };

    for (const m of messages) {
      if (m.role === 'user' && typeof m.content === 'string') {
        push('user', m.content);
        continue;
      }
      if (m.role === 'user' && Array.isArray(m.content)) {
        const parts = m.content.map((b) =>
          b.type === 'tool_result'
            ? `↳ результат инструмента: ${truncate(String(b.content ?? ''), 2000)}`
            : String(b.text ?? ''),
        );
        push('user', parts.filter(Boolean).join('\n'));
        continue;
      }
      if (m.role === 'assistant' && Array.isArray(m.content)) {
        const parts = m.content.map((b) => {
          if (b.type === 'text') return String(b.text || '');
          if (b.type === 'tool_use') return `⚙ ${b.name}(${truncate(JSON.stringify(b.input || {}), 200)})`;
          return '';
        });
        push('assistant', parts.filter(Boolean).join('\n'));
        continue;
      }
    }
    while (out.length && out[0].role !== 'user') out.shift();
    return out;
  }

  async post(body) {
    const p = this.cfg.provider;
    return fetch(this.baseUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': p.apiKey,
        Authorization: `Bearer ${p.apiKey}`,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout((p.timeoutMs || 300000)),
    });
  }

  async complete({ system, messages, tools, onText, onReasoning }) {
    const p = this.cfg.provider;
    const body = {
      model: p.model,
      max_tokens: p.maxTokens || 8192,
      messages: this.toWire(messages),
    };
    if (system) body.system = system;
    if (tools?.length) {
      body.tools = this.buildTools(tools);
      body.tool_choice = { type: 'auto' };
    }
    if (p.effort) body.output_config = { effort: p.effort };

    let res = await this.post(body);

    if (!res.ok) {
      const detail = await res.text();
      // Модель не приняла tool-обвязку в истории — пробуем один раз с плоской историей,
      // чтобы диалог не умирал из-за одного сломанного шага.
      const hasToolBlocks = body.messages.some((m) =>
        Array.isArray(m.content) ? m.content.some((b) => b.type === 'tool_use' || b.type === 'tool_result') : false,
      );
      const flat = hasToolBlocks ? this.toFlatWire(body.messages) : [];
      if ([400, 422].includes(res.status) && flat.length) {
        const retry = await this.post({ ...body, messages: flat });
        if (retry.ok) {
          res = retry;
        } else {
          throw new Error(`LLM ${retry.status}: ${truncate(await retry.text(), 600)}`);
        }
      } else {
        throw new Error(`LLM ${res.status}: ${truncate(detail, 600)}`);
      }
    }

    const json = await res.json();
    const content = json.content || [];
    const text = content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
    const reasoning = content
      .filter((c) => c.type === 'thinking')
      .map((c) => c.thinking || '')
      .join('\n');
    const toolCalls = content
      .filter((c) => c.type === 'tool_use')
      .map((c) => ({ id: c.id, name: c.name, args: c.input || {} }));

    onText?.(text);
    onReasoning?.(reasoning);
    return { text, reasoning, toolCalls, raw: json, assistantContent: content };
  }
}

/* ------------------------------------------------------------------ openai */

export class OpenAIProvider {
  constructor(cfg) {
    this.cfg = cfg;
    this.protocol = 'openai';
    this.name = 'openai';
  }

  get baseUrl() {
    const b = (this.cfg.provider.baseUrl || 'https://api.minimax.io/v1').replace(/\/+$/, '');
    return b.endsWith('/chat/completions') ? b : `${b}/chat/completions`;
  }

  buildTools(tools) {
    return tools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.schema },
    }));
  }

  toWire(messages) {
    const out = [];
    for (const m of messages) {
      if (m.role === 'user' && Array.isArray(m.content)) {
        for (const c of m.content) {
          if (c.type === 'tool_result') {
            out.push({ role: 'tool', tool_call_id: c.tool_use_id, content: String(c.content ?? '') });
          } else {
            out.push({ role: 'user', content: String(c.text ?? '') });
          }
        }
      } else if (m.role === 'assistant' && Array.isArray(m.content)) {
        const text = m.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
        const calls = m.content
          .filter((c) => c.type === 'tool_use')
          .map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.input || {}) } }));
        out.push({ role: 'assistant', content: text || null, ...(calls.length ? { tool_calls: calls } : {}) });
      } else if (m.role === 'user' && typeof m.content === 'string') {
        out.push({ role: 'user', content: m.content });
      } else {
        out.push(m);
      }
    }
    return out;
  }

  async complete({ system, messages, tools, onText, onReasoning }) {
    const p = this.cfg.provider;
    const wire = [];
    if (system) wire.push({ role: 'system', content: system });
    wire.push(...this.toWire(messages));

    const body = {
      model: p.model,
      messages: wire,
      max_completion_tokens: p.maxTokens || 8192,
      temperature: p.temperature ?? 1.0,
    };
    if (tools?.length) {
      body.tools = this.buildTools(tools);
      body.tool_choice = 'auto';
    }

    const res = await fetch(this.baseUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${p.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout((p.timeoutMs || 300000)),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`LLM ${res.status}: ${truncate(text, 600)}`);
    }

    const json = await res.json();
    const msg = json.choices?.[0]?.message || {};
    const text = typeof msg.content === 'string' ? msg.content : extractText(msg.content);
    const reasoning = msg.reasoning_content || '';
    const toolCalls = (msg.tool_calls || []).map((c) => ({
      id: c.id,
      name: c.function?.name,
      args: safeParse(c.function?.arguments),
    }));

    onText?.(text);
    onReasoning?.(reasoning);
    return { text, reasoning, toolCalls, raw: json };
  }
}

function safeParse(str) {
  if (!str) return {};
  if (typeof str === 'object') return str;
  try {
    return JSON.parse(str);
  } catch {
    return { _raw: String(str) };
  }
}

/* ------------------------------------------------------------------- mock */

/** Deterministic scripted provider used by the test suite and `--offline` mode. */
export class MockProvider {
  constructor(cfg) {
    this.cfg = cfg;
    this.protocol = 'mock';
    this.name = 'mock';
    this.script = cfg?.mockScript || [];
    this.turn = 0;
  }

  async complete({ messages, onText }) {
    const step = this.script[Math.min(this.turn, this.script.length - 1)] || { text: 'Готово.' };
    this.turn++;
    onText?.(step.text || '');
    const toolCalls = (step.toolCalls || []).map((c, i) => ({
      id: `call_${this.turn}_${i}`,
      name: c.name,
      args: c.args || {},
    }));
    return { text: step.text || '', reasoning: '', toolCalls, raw: {} };
  }
}

export function createProvider(cfg) {
  const protocol = cfg.provider.protocol || 'anthropic';
  if (protocol === 'openai') return new OpenAIProvider(cfg);
  if (protocol === 'mock') return new MockProvider(cfg);
  return new AnthropicProvider(cfg);
}
