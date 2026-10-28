const useColor = process.stdout.isTTY && process.env.NO_COLOR !== '1' && process.env.TERM !== 'dumb';

const wrap = (open, close) => (s) => (useColor ? `[${open}m${s}[${close}m` : String(s));

export const c = {
  dim: wrap('2', '22'),
  bold: wrap('1', '22'),
  red: wrap('31', '39'),
  green: wrap('32', '39'),
  yellow: wrap('33', '39'),
  blue: wrap('34', '39'),
  magenta: wrap('35', '39'),
  cyan: wrap('36', '39'),
  gray: wrap('90', '39'),
  bgBlue: wrap('44', '49'),
};

export const ICON = {
  user: '›',
  agent: '◆',
  tool: '⚙',
  ok: '✔',
  fail: '✖',
  warn: '!',
  arrow: '→',
  sub: '⇢',
};

export function renderUser(text) {
  console.log(`\n${c.cyan(ICON.user)} ${c.bold(text)}`);
}

export function renderAgent(text) {
  if (!text) return;
  console.log(`\n${c.magenta(ICON.agent)} ${text}`);
}

export function renderToolCall(name, args) {
  const brief = summarizeArgs(args);
  console.log(`${c.gray(ICON.tool)} ${c.yellow(name)}${brief ? c.gray(' ' + brief) : ''}`);
}

export function renderToolResult(name, ok, summary) {
  const mark = ok ? c.green(ICON.ok) : c.red(ICON.fail);
  console.log(`  ${mark} ${c.gray(summary)}`);
}

export function renderNotice(kind, text) {
  const map = { info: c.blue(ICON.arrow), warn: c.yellow(ICON.warn), error: c.red(ICON.fail) };
  console.log(`${map[kind] || map.info} ${text}`);
}

export function summarizeArgs(args) {
  if (!args || typeof args !== 'object') return '';
  const parts = [];
  for (const [k, v] of Object.entries(args)) {
    if (v === undefined || v === null || v === '') continue;
    let s;
    if (typeof v === 'string') s = v.length > 90 ? v.slice(0, 90) + '…' : v;
    else s = JSON.stringify(v);
    s = s.replace(/\s+/g, ' ');
    parts.push(`${k}=${s}`);
  }
  return parts.join(' ');
}

export function renderTable(rows, columns) {
  if (!rows.length) {
    console.log(c.gray('  (пусто)'));
    return;
  }
  const widths = {};
  for (const col of columns) {
    widths[col.key] = Math.max(
      col.width ?? 4,
      col.title.length,
      ...rows.map((r) => String(col.value(r) ?? '').length),
    );
  }
  const line = (cells) =>
    '  ' + cells.map((cell, i) => String(cell).padEnd(widths[columns[i].key])).join('  ').trimEnd();
  console.log(c.bold(line(columns.map((col) => col.title))));
  console.log(c.gray('  ' + columns.map((col) => '─'.repeat(widths[col.key])).join('  ')));
  for (const row of rows) {
    console.log(line(columns.map((col) => col.value(row))));
  }
}

export function renderBox(title, body, color = c.cyan) {
  const lines = String(body).split('\n');
  const width = Math.min(72, Math.max(...lines.map((l) => l.length), title.length + 4)) + 2;
  console.log(color('┌' + '─'.repeat(width) + '┐'));
  console.log(color('│') + color(` ${title}`) + ' '.repeat(Math.max(0, width - title.length - 1)) + color('│'));
  console.log(color('├' + '─'.repeat(width) + '┤'));
  for (const line of lines) {
    console.log(color('│') + ` ${line}` + ' '.repeat(Math.max(0, width - line.length - 1)) + color('│'));
  }
  console.log(color('└' + '─'.repeat(width) + '┘'));
}
