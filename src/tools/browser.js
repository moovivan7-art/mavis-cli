/**
 * Browser tool — Playwright under the hood, persistent profile so logins survive restarts.
 *
 * One tool, many actions. The model sees a compact DOM snapshot with stable [ref] handles
 * and acts on them. Outbound actions (sending) are handled by the caller (drafts) so
 * that nothing leaves the machine without a human "yes".
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { requireOptional, expandHome, ensureDir, truncate } from '../util.js';

const INTERACTIVE = [
  'a', 'button', 'input', 'textarea', 'select', 'summary', 'label[for]',
  '[role="button"]', '[role="link"]', '[role="tab"]', '[role="menuitem"]',
  '[role="checkbox"]', '[role="radio"]', '[role="combobox"]', '[role="textbox"]',
  '[contenteditable="true"]', '[onclick]',
];

let session = null; // { context, page, profileDir }

async function loadPlaywright() {
  try {
    return requireOptional('playwright');
  } catch (err) {
    const e = new Error(
      'Playwright не установлен.\n' +
        '  npm i -g playwright && npx playwright install chromium\n' +
        '  (или установи локально: npm i playwright && npx playwright install chromium)\n' +
        `Оригинал: ${err.message}`,
    );
    e.code = 'PLAYWRIGHT_MISSING';
    throw e;
  }
}

/** Find a Chromium/Chrome binary that actually exists on this machine. */
function findLocalChromium() {
  const roots = [
    process.env.PLAYWRIGHT_BROWSERS_PATH,
    path.join(os.homedir(), '.cache', 'ms-playwright'),
    path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright'),
    path.join(os.homedir(), '.local', 'share', 'ms-playwright'),
  ].filter(Boolean);
  for (const root of roots) {
    let entries = [];
    try {
      entries = fs.readdirSync(root);
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.startsWith('chromium')) continue;
      for (const rel of [
        ['chrome-linux64', 'chrome'],
        ['chrome-linux', 'chrome'],
        ['chrome-linux64', 'headless_shell'],
        ['chrome-linux', 'headless_shell'],
        ['chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'],
        ['chrome-mac-arm64', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'],
        ['chrome-win', 'chrome.exe'],
        ['chrome-win64', 'chrome.exe'],
      ]) {
        const p = path.join(root, e, ...rel);
        if (fs.existsSync(p)) return p;
      }
    }
  }
  return null;
}

export async function getSession(cfg, { headless } = {}) {
  if (session) return session;
  const pw = await loadPlaywright();
  const profileDir = ensureDir(expandHome(cfg.browser.profileDir));
  const useHeadless = headless ?? cfg.browser.headless ?? true;

  const baseArgs = [
    '--disable-blink-features=AutomationControlled',
    ...(process.getuid && process.getuid() === 0 ? ['--no-sandbox', '--disable-dev-shm-usage'] : []),
  ];
  const common = {
    headless: useHeadless,
    slowMo: cfg.browser.slowMo || 0,
    viewport: cfg.browser.viewport || { width: 1440, height: 900 },
    locale: 'ru-RU',
    timezoneId: 'Europe/Moscow',
    acceptDownloads: true,
  };

  const attempts = [
    () => ({
      ...common,
      args: baseArgs,
      ...(cfg.browser.executablePath ? { executablePath: cfg.browser.executablePath } : {}),
    }),
    () => ({ ...common, args: baseArgs, channel: 'chromium' }),
    () => ({ ...common, args: baseArgs, channel: 'chrome' }),
  ];
  const local = cfg.browser.executablePath || findLocalChromium();
  if (local) attempts.push(() => ({ ...common, args: baseArgs, executablePath: local }));

  let context;
  let lastErr;
  for (const make of attempts) {
    try {
      context = await pw.chromium.launchPersistentContext(profileDir, make());
      break;
    } catch (err) {
      lastErr = err;
    }
  }
  if (!context) {
    throw new Error(
      `Не удалось запустить браузер: ${lastErr?.message}\n` +
        'Поставь Chromium: npx playwright install chromium\n' +
        'Или укажи путь в конфиге: browser.executablePath',
    );
  }

  const pages = context.pages();
  const page = pages[0] || (await context.newPage());
  page.setDefaultTimeout(cfg.browser.timeoutMs || 30000);
  session = { context, page, profileDir, headless: useHeadless, pw };
  return session;
}

export async function closeSession() {
  if (!session) return;
  try {
    await session.context.close();
  } catch {
    /* already gone */
  }
  session = null;
}

/* ------------------------------------------------------------- snapshot */

const SNAPSHOT_SCRIPT = (selectors) => {
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const st = window.getComputedStyle(el);
    if (st.visibility === 'hidden' || st.display === 'none' || st.opacity === '0') return false;
    return true;
  };
  const label = (el) => {
    const pick = (v) => (v && String(v).trim() ? String(v).trim().replace(/\s+/g, ' ').slice(0, 120) : '');
    return (
      pick(el.getAttribute('aria-label')) ||
      pick(el.innerText) ||
      pick(el.getAttribute('placeholder')) ||
      pick(el.getAttribute('value')) ||
      pick(el.getAttribute('alt')) ||
      pick(el.getAttribute('title')) ||
      pick(el.getAttribute('name'))
    );
  };
  const tag = (el) => el.tagName.toLowerCase();
  const type = (el) => {
    const t = tag(el);
    if (t === 'input') return `input[${el.getAttribute('type') || 'text'}]`;
    if (t === 'textarea') return 'textarea';
    if (t === 'a') return 'link';
    return t;
  };

  const out = [];
  const seen = new Set();
  let i = 0;
  for (const el of document.querySelectorAll(selectors.join(','))) {
    if (!visible(el) || seen.has(el)) continue;
    seen.add(el);
    i += 1;
    el.setAttribute('data-fluxa-ref', String(i));
    out.push({ ref: i, type: type(el), label: label(el), tag: tag(el) });
    if (i >= 400) break;
  }
  return {
    title: document.title,
    url: location.href,
    elements: out,
    text: (document.body ? document.body.innerText : '').replace(/\n{3,}/g, '\n\n'),
  };
};

export async function snapshot(page, selectors = INTERACTIVE) {
  const data = await page.evaluate(SNAPSHOT_SCRIPT, selectors);
  const lines = [];
  lines.push(`URL: ${data.url}`);
  lines.push(`TITLE: ${data.title}`);
  lines.push('## ЭЛЕМЕНТЫ');
  if (!data.elements.length) lines.push('(интерактивных элементов не найдено)');
  for (const el of data.elements) {
    lines.push(`[${el.ref}] ${el.type}${el.label ? ` — "${el.label}"` : ''}`);
  }
  lines.push('## ТЕКСТ СТРАНИЦЫ');
  lines.push(truncate(data.text.trim(), 6000) || '(пусто)');
  return lines.join('\n');
}

function locatorFor(page, { ref, selector, text }) {
  if (ref !== undefined && ref !== null) {
    return page.locator(`[data-fluxa-ref="${ref}"]`).first();
  }
  if (selector) return page.locator(selector).first();
  if (text) return page.getByText(text, { exact: false }).first();
  throw new Error('Нужно указать ref, selector или text');
}

async function describeError(err) {
  return `Ошибка браузера: ${truncate(err.message, 500)}`;
}

/* --------------------------------------------------------------- actions */

export const browserActions = {
  async open(ctx, args) {
    const { page } = await getSession(ctx.cfg);
    const raw = String(args.url || '');
    const url = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(raw) ? raw : `https://${raw}`;
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: ctx.cfg.browser.timeoutMs || 30000 });
    if (args.waitMs) await page.waitForTimeout(args.waitMs);
    return `Открыл ${page.url()}\n\n${await snapshot(page, INTERACTIVE)}`;
  },

  async snapshot(ctx) {
    const { page } = await getSession(ctx.cfg);
    return await snapshot(page, INTERACTIVE);
  },

  async read(ctx, args) {
    const { page } = await getSession(ctx.cfg);
    const text = await page.evaluate(() => document.body?.innerText || '');
    return truncate(text.trim(), args.maxChars || 8000);
  },

  async click(ctx, args) {
    const { page } = await getSession(ctx.cfg);
    try {
      const loc = locatorFor(page, args);
      await loc.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
      await loc.click({ timeout: 10000 });
      await page.waitForTimeout(args.waitMs ?? 700);
      return `Кликнул (${args.ref ?? args.selector ?? args.text})\n\n${await snapshot(page, INTERACTIVE)}`;
    } catch (err) {
      return `${await describeError(err)}\nСделай snapshot ещё раз — refs устарели после перерисовки.`;
    }
  },

  async fill(ctx, args) {
    const { page } = await getSession(ctx.cfg);
    try {
      const loc = locatorFor(page, args);
      await loc.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
      await loc.fill(args.value ?? '', { timeout: 10000 });
      if (args.submit) {
        await loc.press('Enter');
        await page.waitForTimeout(args.waitMs ?? 900);
      }
      return `Заполнил поле (${args.ref ?? args.selector ?? args.text}) = ${truncate(args.value ?? '', 200)}${
        args.submit ? ' и отправил' : ''
      }\n\n${await snapshot(page, INTERACTIVE)}`;
    } catch (err) {
      return await describeError(err);
    }
  },

  async press(ctx, args) {
    const { page } = await getSession(ctx.cfg);
    try {
      if (args.ref !== undefined) {
        await page.locator(`[data-fluxa-ref="${args.ref}"]`).first().press(args.key);
      } else {
        await page.keyboard.press(args.key);
      }
      await page.waitForTimeout(args.waitMs ?? 400);
      return `Нажал ${args.key}`;
    } catch (err) {
      return await describeError(err);
    }
  },

  async select(ctx, args) {
    const { page } = await getSession(ctx.cfg);
    try {
      const loc = locatorFor(page, args);
      await loc.selectOption(args.value, { timeout: 10000 });
      return `Выбрал "${args.value}"`;
    } catch (err) {
      return await describeError(err);
    }
  },

  async upload(ctx, args) {
    const { page } = await getSession(ctx.cfg);
    try {
      const loc = locatorFor(page, args);
      const file = path.resolve(expandHome(args.file));
      if (!fs.existsSync(file)) return `Файл не найден: ${file}`;
      await loc.setInputFiles(file);
      return `Загрузил ${file}`;
    } catch (err) {
      return await describeError(err);
    }
  },

  async wait(ctx, args) {
    const { page } = await getSession(ctx.cfg);
    try {
      if (args.selector) await page.waitForSelector(args.selector, { timeout: args.timeoutMs || 15000 });
      else if (args.text) await page.getByText(args.text, { exact: false }).first().waitFor({ timeout: args.timeoutMs || 15000 });
      else await page.waitForTimeout(args.ms || 1000);
      return `Дождался\n\n${await snapshot(page, INTERACTIVE)}`;
    } catch (err) {
      return await describeError(err);
    }
  },

  async scroll(ctx, args) {
    const { page } = await getSession(ctx.cfg);
    const delta = args.amount || 600;
    await page.mouse.wheel(0, args.direction === 'up' ? -delta : delta);
    await page.waitForTimeout(400);
    return await snapshot(page, INTERACTIVE);
  },

  async tabs(ctx, args) {
    const { context, page } = await getSession(ctx.cfg);
    const action = args.action || 'list';
    if (action === 'list') {
      const pages = context.pages();
      return pages
        .map((p, i) => `[${i}] ${p.url()}${p === page ? '  ← активная' : ''}`)
        .join('\n');
    }
    if (action === 'new') {
      const p = await context.newPage();
      if (args.url) await p.goto(args.url, { waitUntil: 'domcontentloaded' });
      return `Открыл новую вкладку: ${p.url()}`;
    }
    if (action === 'switch') {
      const pages = context.pages();
      const target = pages[args.index || 0];
      if (!target) return 'Нет такой вкладки';
      await target.bringToFront();
      session.page = target;
      return `Активная вкладка: ${target.url()}\n\n${await snapshot(target, INTERACTIVE)}`;
    }
    if (action === 'close') {
      const pages = context.pages();
      const target = pages[args.index ?? pages.length - 1];
      if (!target) return 'Нет такой вкладки';
      await target.close();
      if (session.page === target) session.page = (context.pages()[0] || (await context.newPage()));
      return 'Закрыл вкладку';
    }
    return 'Неизвестное действие tabs';
  },

  async back(ctx) {
    const { page } = await getSession(ctx.cfg);
    await page.goBack();
    return `Назад → ${page.url()}`;
  },

  async forward(ctx) {
    const { page } = await getSession(ctx.cfg);
    await page.goForward();
    return `Вперёд → ${page.url()}`;
  },

  async screenshot(ctx, args) {
    const { page } = await getSession(ctx.cfg);
    const dir = ensureDir(path.join(ctx.cfg.agent.workspace, 'screenshots'));
    const file = path.join(dir, args.path || `shot-${Date.now()}.png`);
    await page.screenshot({ path: file, fullPage: !!args.fullPage });
    return `Скриншот: ${file}`;
  },

  async eval(ctx, args) {
    const { page } = await getSession(ctx.cfg);
    try {
      const result = await page.evaluate((expr) => {
        // eslint-disable-next-line no-new-func
        const fn = new Function(`return (${expr})`);
        const value = fn();
        return typeof value === 'string' ? value : JSON.stringify(value);
      }, args.expression);
      return truncate(result ?? 'undefined', 4000);
    } catch (err) {
      return await describeError(err);
    }
  },

  async close(ctx) {
    await closeSession();
    return 'Браузер закрыт';
  },
};

export const browserTool = {
  name: 'browser',
  description: [
    'Управление браузером (Playwright, постоянный профиль — логины сохраняются).',
    'Действия: open(url) | snapshot() | read() | click({ref|selector|text}) | fill({ref|selector|text, value, submit?}) |',
    'press({key, ref?}) | select({ref|selector, value}) | upload({ref|selector, file}) | wait({selector|text|ms}) |',
    'scroll({direction, amount}) | tabs({action: list|new|switch|close, index?, url?}) | back() | forward() |',
    'screenshot({path?, fullPage?}) | eval({expression}) | close().',
    'Сначала сделай snapshot — он даёт [ref] интерактивных элементов. ref живёт до перерисовки страницы.',
  ].join(' '),
  schema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: [
          'open', 'snapshot', 'read', 'click', 'fill', 'press', 'select', 'upload',
          'wait', 'scroll', 'tabs', 'back', 'forward', 'screenshot', 'eval', 'close',
        ],
        description: 'Что сделать в браузере',
      },
      url: { type: 'string', description: 'Адрес для open / new tab' },
      ref: { type: 'integer', description: 'Номер элемента из snapshot' },
      selector: { type: 'string', description: 'CSS-селектор' },
      text: { type: 'string', description: 'Текст для поиска элемента или ожидания' },
      value: { type: 'string', description: 'Значение для fill/select' },
      key: { type: 'string', description: 'Клавиша для press (Enter, Tab, Escape...)' },
      file: { type: 'string', description: 'Путь к файлу для upload' },
      ms: { type: 'integer', description: 'Пауза в мс' },
      waitMs: { type: 'integer', description: 'Пауза после действия в мс' },
      timeoutMs: { type: 'integer', description: 'Таймаут ожидания в мс' },
      amount: { type: 'integer', description: 'Скорость прокрутки в px' },
      direction: { type: 'string', enum: ['up', 'down'] },
      action2: { type: 'string', description: 'Не используется (зарезервировано)' },
      index: { type: 'integer', description: 'Индекс вкладки' },
      fullPage: { type: 'boolean', description: 'Скриншот всей страницы' },
      path: { type: 'string', description: 'Имя файла скриншота' },
      expression: { type: 'string', description: 'JS-выражение для eval' },
      maxChars: { type: 'integer', description: 'Лимит символов для read' },
    },
    required: ['action'],
  },
  handler: async (ctx, args) => {
    const fn = browserActions[args.action];
    if (!fn) return `Неизвестное действие: ${args.action}`;
    return await fn(ctx, args);
  },
};
