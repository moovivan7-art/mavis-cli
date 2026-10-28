#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
#  mavis-update.sh — обновление mavis-cli одной командой.
#
#  Версия «вечная»: тянет свежий код с GitHub, а не из вшитого архива,
#  поэтому остаётся рабочей и через год.
#
#  Что делает:
#    1. скачивает последнюю версию (GitHub);
#    2. находит твою установленную копию mavis-cli;
#    3. делает бэкап старых файлов в ~/.mavis-cli/backups/<дата>;
#    4. раскладывает новые файлы поверх (твои доп. плейбуки не трогает);
#    5. прогоняет node test/smoke.mjs и печатает результат.
#
#  Запуск:   bash mavis-update.sh
#  Дальше:   mavis --update     (обновляет сам, одной командой)
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

REPO="${MAVIS_REPO:-moovivan7-art/mavis-cli}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

say() { printf '%s\n' "$*"; }

# ── 1. качаем свежую версию ─────────────────────────────────────────────────
say "▸ Качаю свежую версию…"
TGZ="$TMP/mavis-cli.tar.gz"
GOT=""
for u in \
  "https://github.com/${REPO}/archive/refs/heads/main.tar.gz" \
  "https://codeload.github.com/${REPO}/tar.gz/refs/heads/main"
do
  if curl -fsSL "$u" -o "$TGZ" 2>/dev/null; then GOT="$u"; break; fi
done
if [ -z "$GOT" ]; then
  say "✖ Не скачалось. Проверь интернет или возьми архив вручную."
  exit 1
fi
say "  скачал: $GOT"

tar -xzf "$TGZ" -C "$TMP"
NEW=""
for d in "$TMP"/*/; do
  if [ -f "$d/package.json" ]; then NEW="${d%/}"; break; fi
done
if [ -z "$NEW" ]; then
  say "✖ В архиве не нашлось пакета."
  exit 1
fi

# ── 2. ищем установленную копию ────────────────────────────────────────────
TARGET=""
if [ -n "${1:-}" ] && [ -f "$1/package.json" ]; then
  TARGET="$(cd "$1" && pwd)"
fi
if [ -z "$TARGET" ] && command -v mavis >/dev/null 2>&1; then
  BIN="$(readlink -f "$(command -v mavis)" 2>/dev/null || command -v mavis)"
  CAND="$(cd "$(dirname "$BIN")/.." 2>/dev/null && pwd || true)"
  if [ -n "$CAND" ] && [ -f "$CAND/package.json" ]; then
    TARGET="$CAND"
  fi
fi

# Если мы запущены прямо из только что распакованного архива — это первый запуск,
# а не обновление. Нечаянно «обновить» временную папку нельзя: говорим честно.
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -z "$TARGET" ]; then
  if [ -f "$SELF_DIR/package.json" ]; then
    say ""
    say "▸ mavis-cli ещё не установлен — но код уже у тебя в руках."
    say "  Установи его отсюда:"
    say ""
    say "      cd $SELF_DIR && npm i -g . && npx playwright install chromium"
    say ""
    say "  После этого обновления будут одной командой: mavis --update"
    exit 0
  fi
  say ""
  say "✖ Не нашёл, где установлен mavis-cli. Скажи путь:"
  say "      bash mavis-update.sh ~/путь/к/mavis-cli"
  exit 1
fi
say "  установленная копия: $TARGET"

# ── 3. бэкап ───────────────────────────────────────────────────────────────
STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP="$HOME/.mavis-cli/backups/$STAMP"
mkdir -p "$BACKUP"
for item in src bin test playbooks templates README.md package.json install.sh mavis-update.sh; do
  [ -e "$TARGET/$item" ] && cp -a "$TARGET/$item" "$BACKUP/" || true
done
say "  бэкап старых файлов: $BACKUP"

# ── 4. раскладываем (слиянием, лишние файлы не удаляем) ────────────────────
for item in src bin test playbooks templates README.md package.json install.sh mavis-update.sh; do
  [ -e "$NEW/$item" ] || continue
  if [ -d "$NEW/$item" ]; then
    mkdir -p "$TARGET/$item"
    cp -a "$NEW/$item/." "$TARGET/$item/"
  else
    cp -a "$NEW/$item" "$TARGET/"
  fi
done
say "  файлы обновлены"

# ── 5. проверка ─────────────────────────────────────────────────────────────
say ""
say "▸ Прогоняю проверку (node test/smoke.mjs)…"
cd "$TARGET"
if node test/smoke.mjs; then
  say ""
  say "✔ Обновлено и проверено."
else
  say ""
  say "⚠ Проверка не прошла. Откат одной командой:"
  say "    cp -a $BACKUP/. $TARGET/"
  exit 1
fi
