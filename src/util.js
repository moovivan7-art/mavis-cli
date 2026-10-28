import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';

export const HOME = os.homedir();
export const FLUXA_HOME = process.env.MAVIS_HOME || path.join(HOME, '.mavis-cli');

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

export function writeJson(file, data) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify(data, null, 2), { mode: 0o600 });
}

export function expandHome(p) {
  if (!p) return p;
  if (p === '~') return HOME;
  if (p.startsWith('~/')) return path.join(HOME, p.slice(2));
  return path.resolve(p);
}

export function nowIso() {
  return new Date().toISOString();
}

export function uid(prefix = 'id') {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

export function truncate(str, max = 4000) {
  const s = String(str ?? '');
  if (s.length <= max) return s;
  return `${s.slice(0, max)}\n… [truncated ${s.length - max} chars]`;
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}

/** Русские склонения: plural(2, ['сообщение','сообщения','сообщений']) → 'сообщения'. */
export function plural(n, forms) {
  const abs = Math.abs(Number(n) || 0) % 100;
  const last = abs % 10;
  if (abs > 10 && abs < 20) return forms[2];
  if (last > 1 && last < 5) return forms[1];
  if (last === 1) return forms[0];
  return forms[2];
}

/** Resolve an optional module that may live in a global npm root. */
export function requireOptional(name) {
  const require = createRequire(import.meta.url);
  const candidates = [
    name,
    process.env.MAVIS_NODE_MODULES ? path.join(process.env.MAVIS_NODE_MODULES, name) : null,
    path.join('/usr/local/lib/node_modules', name),
    path.join('/usr/lib/node_modules', name),
  ].filter(Boolean);
  const errors = [];
  for (const candidate of candidates) {
    try {
      return require(candidate);
    } catch (err) {
      errors.push(`${candidate}: ${err.message}`);
    }
  }
  const error = new Error(`Cannot load module "${name}". Install it: npm i -g ${name}\n${errors.join('\n')}`);
  error.code = 'MODULE_NOT_FOUND';
  throw error;
}

export function parseArgs(argv) {
  const out = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, inline] = a.slice(2).split('=');
      if (inline !== undefined) out.flags[k] = inline;
      else if (argv[i + 1] && !argv[i + 1].startsWith('-')) out.flags[k] = argv[++i];
      else out.flags[k] = true;
    } else if (a.startsWith('-') && a.length > 1) {
      out.flags[a.slice(1)] = true;
    } else {
      out._.push(a);
    }
  }
  return out;
}

/** Extract a fenced code block or plain text from a model message. */
export function extractText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((c) => c.type === 'text' && c.text)
    .map((c) => c.text)
    .join('\n');
}
