/**
 * Самообновление: `mavis --update`.
 *
 * Два пути, оба без участия человека:
 *   1) установка — git-клон: просто `git pull --ff-only`;
 *   2) установка — распакованная папка (npm -g, tar): скачиваем последний релиз
 *      с GitHub и раскладываем поверх, предварительно сбросив бэкап в ~/.mavis-cli/backups.
 *
 * Настройки (для нестандартных установок):
 *   MAVIS_REPO         — owner/repo, по умолчанию moovivan7-art/mavis-cli
 *   MAVIS_RELEASE_URL  — прямая ссылка на архив, если релиз лежит не на GitHub
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const REPO = process.env.MAVIS_REPO || 'moovivan7-art/mavis-cli';
export const RELEASE_URL =
  process.env.MAVIS_RELEASE_URL || `https://github.com/${REPO}/archive/refs/heads/main.tar.gz`;

const ITEMS = ['src', 'bin', 'test', 'playbooks', 'templates', 'README.md', 'package.json', 'install.sh'];

/** Корень установленного пакета (родитель src/). */
export function packageRoot() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
}

/** Копия текущих файлов в ~/.mavis-cli/backups/<метка> — чтобы откат был возможен. */
export function backupRoot(root, stamp) {
  const label = stamp || new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
  const dir = path.join(os.homedir(), '.mavis-cli', 'backups', label);
  fs.mkdirSync(dir, { recursive: true });
  for (const item of ITEMS) {
    const from = path.join(root, item);
    if (!fs.existsSync(from)) continue;
    fs.cpSync(from, path.join(dir, item), { recursive: true, force: true });
  }
  return dir;
}

/** Раскладывает новую версию поверх старой (слиянием: лишние файлы не удаляем). */
export function layOver(newRoot, root) {
  for (const item of ITEMS) {
    const from = path.join(newRoot, item);
    if (!fs.existsSync(from)) continue;
    const to = path.join(root, item);
    if (fs.statSync(from).isDirectory()) {
      fs.mkdirSync(to, { recursive: true });
      fs.cpSync(from, to, { recursive: true, force: true });
    } else {
      fs.cpSync(from, to, { force: true });
    }
  }
}

export async function selfUpdate({ log = console.log } = {}) {
  const root = packageRoot();
  log(`▸ обновляю mavis (установка: ${root})`);

  /* 1. git-клон — самый чистый путь */
  if (fs.existsSync(path.join(root, '.git'))) {
    try {
      execFileSync('git', ['-C', root, 'pull', '--ff-only'], { stdio: 'inherit' });
      log('✔ обновлено через git pull');
      return { ok: true, how: 'git' };
    } catch (err) {
      log(`  git pull не сработал (${err.message}) — пробую релиз`);
    }
  }

  /* 2. релиз с GitHub */
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mavis-update-'));
  try {
    log(`  качаю обновление: ${RELEASE_URL}`);
    const res = await fetch(RELEASE_URL, { redirect: 'follow' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const tgz = path.join(tmp, 'mavis-cli.tar.gz');
    fs.writeFileSync(tgz, Buffer.from(await res.arrayBuffer()));
    execFileSync('tar', ['-xzf', tgz, '-C', tmp], { stdio: 'inherit' });

    const newRoot = findPackageRoot(tmp);
    if (!newRoot) throw new Error('в архиве не нашлось папки с package.json');

    const backup = backupRoot(root);
    layOver(newRoot, root);
    log(`✔ обновлено. бэкап старых файлов: ${backup}`);
    log('  перезапусти mavis, чтобы заработала новая версия');
    return { ok: true, how: 'release', backup };
  } catch (err) {
    log(`✖ обновиться не вышло: ${err.message}`);
    if (/EACCES|EPERM|permission/i.test(err.message)) {
      log('  похоже, папка установки защищена — попробуй: sudo mavis --update');
    }
    return { ok: false, error: err.message };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/** Ищет корень пакета в распакованном архиве (имя папки у GitHub — mavis-cli-main). */
export function findPackageRoot(dir, depth = 2) {
  if (depth < 0) return null;
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const p = path.join(dir, e.name);
    if (fs.existsSync(path.join(p, 'package.json'))) return p;
    const deeper = findPackageRoot(p, depth - 1);
    if (deeper) return deeper;
  }
  return null;
}
