#!/usr/bin/env bash
# Установка Mavis — фриланс-агента в терминале.
set -euo pipefail

echo "▸ Проверяю Node.js"
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js не найден. Поставь версию 20+ : https://nodejs.org"
  exit 1
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 20 ]; then
  echo "Нужен Node.js 20+, стоит $(node -v)"
  exit 1
fi
echo "  node $(node -v) — ок"

SRC_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "▸ Ставлю пакет глобально"
if npm i -g "$SRC_DIR" 2>/dev/null; then
  echo "  установлено через npm"
else
  echo "  npm не смог — ставлю вручную в ~/.local/bin"
  mkdir -p "$HOME/.local/bin"
  ln -sf "$SRC_DIR/bin/mavis.js" "$HOME/.local/bin/mavis"
  chmod +x "$SRC_DIR/bin/mavis.js"
  echo "  добавь ~/.local/bin в PATH"
fi

echo "▸ Ставлю Playwright + Chromium"
if ! npx --yes playwright@latest install chromium 2>/dev/null; then
  npm i -g playwright >/dev/null 2>&1 || true
  npx --yes playwright@latest install chromium || {
    echo "  ⚠ Не удалось скачать Chromium — поставь вручную: npx playwright install chromium"
  }
fi

echo
echo "✔ Готово. Дальше:"
echo
echo "  1) Войди в площадки в своём обычном браузере (FL.ru, Kwork, Telegram Web)."
echo "     Агент работает через свой профиль: ~/.mavis-cli/browser-profile"
echo "     Чтобы войти вместе с ним — запусти:  mavis --headed"
echo
echo "  2) Заполни профиль:  ~/.mavis-cli/profile.md   (навыки, ставки, стиль)"
echo
echo "  3) Первый запуск попросит API-ключ MiniMax:"
echo "        mavis"
echo "     Ключ: https://platform.minimax.io → API Keys"
echo
echo "  Проверить, что всё живо:  mavis --offline --task \"привет\""
