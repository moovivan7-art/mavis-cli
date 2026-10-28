import fs from 'node:fs';
import path from 'node:path';
import { FLUXA_HOME, ensureDir, readJson, writeJson, nowIso, uid } from './util.js';

const STATE_DIR = path.join(FLUXA_HOME, 'state');
const JOBS_FILE = path.join(STATE_DIR, 'jobs.json');
const DRAFTS_FILE = path.join(STATE_DIR, 'drafts.json');
const MEMORY_FILE = path.join(STATE_DIR, 'memory.json');
const THREADS_FILE = path.join(STATE_DIR, 'threads.json');

function readList(file) {
  ensureDir(STATE_DIR);
  return readJson(file, []);
}

function writeList(file, data) {
  ensureDir(STATE_DIR);
  writeJson(file, data);
}

/* ------------------------------------------------------------------ jobs */

export function listJobs(filter = {}) {
  let jobs = readList(JOBS_FILE);
  if (filter.status) jobs = jobs.filter((j) => j.status === filter.status);
  if (filter.platform) jobs = jobs.filter((j) => j.platform === filter.platform);
  if (filter.minFit !== undefined) jobs = jobs.filter((j) => (j.fit ?? 0) >= filter.minFit);
  return jobs.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
}

export function getJob(id) {
  return readList(JOBS_FILE).find((j) => j.id === id || j.id.endsWith(id)) || null;
}

export function upsertJob(input) {
  const jobs = readList(JOBS_FILE);
  const id = input.id || uid('job');
  const existing = jobs.find((j) => j.id === id);
  const ts = nowIso();
  if (existing) {
    Object.assign(existing, input, { id: existing.id, updatedAt: ts });
    if (input.history) existing.history = [...(existing.history || []), ...input.history];
    writeList(JOBS_FILE, jobs);
    return existing;
  }
  const job = {
    id,
    platform: input.platform || 'unknown',
    title: input.title || '(без названия)',
    url: input.url || null,
    budget: input.budget ?? null,
    currency: input.currency || null,
    client: input.client || null,
    fit: input.fit ?? null,
    status: input.status || 'new',
    tags: input.tags || [],
    notes: input.notes || '',
    history: input.history || [{ ts, type: 'created', text: 'Добавлено в пайплайн' }],
    createdAt: ts,
    updatedAt: ts,
  };
  jobs.push(job);
  writeList(JOBS_FILE, jobs);
  return job;
}

export function removeJob(id) {
  const jobs = readList(JOBS_FILE);
  const rest = jobs.filter((j) => j.id !== id);
  writeList(JOBS_FILE, rest);
  return rest.length !== jobs.length;
}

export function logJob(id, type, text) {
  const jobs = readList(JOBS_FILE);
  const job = jobs.find((j) => j.id === id);
  if (!job) return null;
  job.history = [...(job.history || []), { ts: nowIso(), type, text }];
  job.updatedAt = nowIso();
  writeList(JOBS_FILE, jobs);
  return job;
}

/* ---------------------------------------------------------------- drafts */

export function listDrafts(status) {
  let drafts = readList(DRAFTS_FILE);
  if (status) drafts = drafts.filter((d) => d.status === status);
  return drafts.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
}

export function addDraft(input) {
  const drafts = readList(DRAFTS_FILE);
  const draft = {
    id: input.id || uid('draft'),
    kind: input.kind || 'message',
    target: input.target || '',
    platform: input.platform || null,
    jobId: input.jobId || null,
    body: input.body || '',
    status: 'pending',
    createdAt: nowIso(),
    approvedAt: null,
    sentAt: null,
    result: null,
  };
  drafts.push(draft);
  writeList(DRAFTS_FILE, drafts);
  return draft;
}

export function updateDraft(id, patch) {
  const drafts = readList(DRAFTS_FILE);
  const draft = drafts.find((d) => d.id === id);
  if (!draft) return null;
  Object.assign(draft, patch);
  writeList(DRAFTS_FILE, drafts);
  return draft;
}

/* --------------------------------------------------------------- threads */

export function listThreads() {
  ensureDir(STATE_DIR);
  return readJson(THREADS_FILE, []);
}

export function upsertThread(input) {
  const threads = listThreads();
  const id = input.id || input.platform + ':' + (input.chat || input.target || '');
  const existing = threads.find((t) => t.id === id);
  const ts = nowIso();
  if (existing) {
    Object.assign(existing, input, { id: existing.id, updatedAt: ts });
    writeJson(THREADS_FILE, threads);
    return existing;
  }
  const thread = {
    id,
    platform: input.platform || 'unknown',
    chat: input.chat || input.target || '',
    unread: input.unread ?? 0,
    lastMessage: input.lastMessage || '',
    messages: input.messages || [],
    createdAt: ts,
    updatedAt: ts,
  };
  threads.push(thread);
  writeJson(THREADS_FILE, threads);
  return thread;
}

export function appendThreadMessage(id, message) {
  const threads = listThreads();
  const thread = threads.find((t) => t.id === id);
  if (!thread) return null;
  thread.messages = [...(thread.messages || []), { ...message, ts: nowIso() }];
  thread.lastMessage = message.text || thread.lastMessage;
  thread.updatedAt = nowIso();
  writeJson(THREADS_FILE, threads);
  return thread;
}

export function trimThreadMessages(id, max = 60) {
  const threads = listThreads();
  const thread = threads.find((t) => t.id === id);
  if (!thread) return null;
  thread.messages = (thread.messages || []).slice(-max);
  writeJson(THREADS_FILE, threads);
  return thread;
}

export function setThreadUnread(id, unread) {
  const threads = listThreads();
  const thread = threads.find((t) => t.id === id);
  if (!thread) return null;
  thread.unread = unread;
  thread.updatedAt = nowIso();
  writeJson(THREADS_FILE, threads);
  return thread;
}

/* ---------------------------------------------------------------- memory */

export function memoryGet(key) {
  const mem = readJson(MEMORY_FILE, {});
  return mem[key] ?? null;
}

export function memorySet(key, value) {
  const mem = readJson(MEMORY_FILE, {});
  mem[key] = { value, ts: nowIso() };
  writeJson(MEMORY_FILE, mem);
  return mem[key];
}

export function memoryAll() {
  return readJson(MEMORY_FILE, {});
}

export function memoryDelete(key) {
  const mem = readJson(MEMORY_FILE, {});
  delete mem[key];
  writeJson(MEMORY_FILE, mem);
}

/* ------------------------------------------------------------- sessions */

/**
 * Сессия хранит и сырые сообщения, и пересказ диалога: сырые — чтобы модель видела
 * последние реплики дословно, пересказ — чтобы помнила, о чём говорили раньше.
 */
export function saveSession(name, messages, recap = []) {
  ensureDir(STATE_DIR);
  writeJson(path.join(STATE_DIR, `session-${name}.json`), {
    version: 2,
    updatedAt: nowIso(),
    messages: Array.isArray(messages) ? messages : [],
    recap: Array.isArray(recap) ? recap : [],
  });
}

/** Возвращает { version, messages, recap }. Старый формат (просто массив) тоже понимаем. */
export function loadSession(name) {
  const raw = readJson(path.join(STATE_DIR, `session-${name}.json`), null);
  if (!raw) return null;
  if (Array.isArray(raw)) return { version: 1, messages: raw, recap: [] };
  return {
    version: raw.version || 2,
    updatedAt: raw.updatedAt || null,
    messages: Array.isArray(raw.messages) ? raw.messages : [],
    recap: Array.isArray(raw.recap) ? raw.recap : [],
  };
}

export function listSessions() {
  ensureDir(STATE_DIR);
  return fs
    .readdirSync(STATE_DIR)
    .filter((f) => f.startsWith('session-') && f.endsWith('.json'))
    .map((f) => {
      const name = f.slice('session-'.length, -'.json'.length);
      const s = loadSession(name);
      return { name, messages: s?.messages?.length || 0, recap: s?.recap?.length || 0, updatedAt: s?.updatedAt || null };
    })
    .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
}
