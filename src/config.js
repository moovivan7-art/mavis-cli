import fs from 'node:fs';
import path from 'node:path';
import { FLUXA_HOME, ensureDir, readJson, writeJson, expandHome } from './util.js';

const CONFIG_PATH = path.join(FLUXA_HOME, 'config.json');

export const DEFAULT_CONFIG = {
  provider: {
    // "anthropic" -> https://api.minimax.io/anthropic/v1/messages (recommended by MiniMax)
    // "openai"   -> https://api.minimax.io/v1/chat/completions  (works with any OpenAI-compatible endpoint)
    protocol: 'anthropic',
    baseUrl: 'https://api.minimax.io/anthropic',
    model: 'MiniMax-M3.1-Flash',
    apiKey: null,
    maxTokens: 8192,
    effort: 'medium', // low | medium | high | max
    temperature: 1.0,
  },
  agent: {
    maxSteps: 30,
    workspace: '~/.mavis-cli/workspace',
    approvalMode: 'ask', // ask | auto | deny
    maxDelegateDepth: 1,
    historyLimit: 60, // потолок на сырые сообщения (реплики + tool-обвязка)
    contextMessages: 6, // сколько последних диалоговых сообщений агент обязан видеть
    recapLimit: 24, // сколько раундов хранить в пересказе диалога
  },
  browser: {
    profileDir: '~/.mavis-cli/browser-profile',
    headless: true,
    slowMo: 0,
    timeoutMs: 30000,
    viewport: { width: 1440, height: 900 },
  },
  playbooksDir: '~/.mavis-cli/playbooks',
  profileFile: '~/.mavis-cli/profile.md',
};

function deepMerge(base, override) {
  if (!override || typeof override !== 'object' || Array.isArray(override)) return override ?? base;
  const out = { ...base };
  for (const [k, v] of Object.entries(override)) {
    out[k] = k in base && base[k] && typeof base[k] === 'object' && !Array.isArray(base[k])
      ? deepMerge(base[k], v)
      : v;
  }
  return out;
}

export function loadConfig() {
  ensureDir(FLUXA_HOME);
  const raw = readJson(CONFIG_PATH, {});
  const cfg = deepMerge(DEFAULT_CONFIG, raw);
  if (!cfg.provider.apiKey && process.env.MINIMAX_API_KEY) cfg.provider.apiKey = process.env.MINIMAX_API_KEY;
  if (!cfg.provider.apiKey && process.env.OPENAI_API_KEY) cfg.provider.apiKey = process.env.OPENAI_API_KEY;
  if (process.env.MAVIS_BASE_URL) cfg.provider.baseUrl = process.env.MAVIS_BASE_URL;
  if (process.env.MAVIS_MODEL) cfg.provider.model = process.env.MAVIS_MODEL;
  return cfg;
}

export function saveConfig(patch) {
  const cfg = deepMerge(loadConfig(), patch);
  writeJson(CONFIG_PATH, cfg);
  return cfg;
}

export function configPath() {
  return CONFIG_PATH;
}

export function maskKey(key) {
  if (!key) return '(not set)';
  return `${key.slice(0, 6)}…${key.slice(-4)}`;
}

export function setApiKey(key) {
  const cfg = loadConfig();
  cfg.provider.apiKey = key;
  writeJson(CONFIG_PATH, cfg);
  fs.chmodSync(CONFIG_PATH, 0o600);
  return cfg;
}

export function workspaceDir(cfg) {
  const dir = expandHome(cfg.agent.workspace);
  ensureDir(dir);
  return dir;
}

export function playbooksDir(cfg) {
  const dir = expandHome(cfg.playbooksDir);
  ensureDir(dir);
  return dir;
}

export function profilePath(cfg) {
  return expandHome(cfg.profileFile);
}
