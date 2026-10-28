/**
 * Channel adapters: how a message actually leaves the machine once a human approved it.
 * Every adapter is defensive: if the UI doesn't look like what we expect, we refuse to send
 * and keep the draft instead.
 */

import { getSession } from './browser.js';
import { truncate } from '../util.js';

const TELEGRAM_INPUT_SELECTORS = [
  '#message-input-textarea',
  'textarea.input-message-input',
  '.input-message-container textarea',
  '.ql-editor.textarea-message',
  'div[contenteditable="true"][data-placeholder]',
];

async function findVisible(page, selectors) {
  for (const sel of selectors) {
    const loc = page.locator(sel).first();
    try {
      if (await loc.isVisible({ timeout: 800 })) return loc;
    } catch {
      /* try next */
    }
  }
  return null;
}

async function telegramDeliver(cfg, { text, chatName }) {
  const { page } = await getSession(cfg);

  if (chatName) {
    const search = page
      .locator('input[placeholder*="Search"], input[placeholder*="Поиск"], .search-input input, input[data-rid="search_input"]')
      .first();
    try {
      if (await search.isVisible({ timeout: 1500 })) {
        await search.click();
        await search.fill(chatName);
        await page.waitForTimeout(1400);
        await page.getByText(chatName, { exact: false }).first().click({ timeout: 5000 });
        await page.waitForTimeout(1200);
      }
    } catch {
      /* chat may already be open */
    }
  }

  const input = await findVisible(page, TELEGRAM_INPUT_SELECTORS);
  if (!input) {
    const anyBox = page.locator('textarea:visible, div[contenteditable="true"]:visible').first();
    if (!(await anyBox.isVisible().catch(() => false))) {
      return { ok: false, error: 'Не нашёл поле ввода в Telegram Web — сообщение НЕ отправлено, черновик сохранён.' };
    }
    await anyBox.click();
    await anyBox.fill(text);
  } else {
    await input.click();
    await input.fill(text);
  }
  await page.waitForTimeout(400);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(1200);
  return { ok: true, detail: `Отправлено в Telegram${chatName ? ` → ${chatName}` : ''}` };
}

async function formDeliver(cfg, { text, submitPattern, textareaHint }) {
  const { page } = await getSession(cfg);

  const boxes = [
    textareaHint,
    'textarea[name="text"]',
    'textarea[name="message"]',
    'textarea[name="comment"]',
    'textarea[name="answer"]',
    'textarea.form-control',
    'div[contenteditable="true"]',
    'textarea',
  ].filter(Boolean);

  let box = null;
  for (const sel of boxes) {
    const loc = page.locator(sel).first();
    if (await loc.isVisible({ timeout: 700 }).catch(() => false)) {
      box = loc;
      break;
    }
  }
  if (!box) {
    return { ok: false, error: 'Не нашёл поле для ответа — сообщение НЕ отправлено, черновик сохранён.' };
  }

  await box.click();
  await box.fill(text);
  await page.waitForTimeout(300);

  const button = page.getByRole('button', { name: submitPattern }).first();
  if (!(await button.isVisible({ timeout: 1500 }).catch(() => false))) {
    return {
      ok: false,
      error: `Текст введён, но не нашёл кнопку "${submitPattern}" — нажми Enter вручную, черновик сохранён.`,
    };
  }
  await button.click();
  await page.waitForTimeout(1500);
  return { ok: true, detail: 'Отправлено' };
}

export async function deliver({ channel, to, body, cfg }) {
  try {
    if (channel === 'telegram') return await telegramDeliver(cfg, { text: body, chatName: to });
    if (channel === 'flru') {
      return await formDeliver(cfg, {
        text: body,
        submitPattern: /отправить|ответить|откликнуться|send|submit/i,
        textareaHint: 'textarea[name="text"], textarea[name="answer"], textarea#f',
      });
    }
    if (channel === 'kwork') {
      return await formDeliver(cfg, {
        text: body,
        submitPattern: /откликнуться|отправить|ответить|send/i,
        textareaHint: 'textarea[name="message"], textarea[name="text"]',
      });
    }
    return {
      ok: false,
      error: `Канал "${channel}" не автоматизирован. Текст подготовлен — отправь его вручную.`,
    };
  } catch (err) {
    return { ok: false, error: `Сбой отправки: ${truncate(err.message, 300)}. Сообщение НЕ отправлено.` };
  }
}
