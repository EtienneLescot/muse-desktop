#!/bin/sh
# Robust dev launch for muse-desktop.
# Kills stale instances (a leftover vite/tauri would shadow the fresh code),
# clears the vite transform cache, then starts `tauri dev` detached.
# Bracket tricks ([v]ite) keep pkill patterns from matching this script itself.
set -eu
cd "$(dirname "$0")/.."
export PATH="$HOME/.nvm/versions/node/v22.16.0/bin:$PATH"
pkill -f 'target/debug/muse-deskto[p]' 2>/dev/null || true
pkill -f 'node.*/\.bin/vit[e]' 2>/dev/null || true
pkill -f 'tauri de[v]' 2>/dev/null || true
sleep 2
rm -rf node_modules/.vite
: > /tmp/tauri-dev.log
setsid -f npm run tauri dev </dev/null >>/tmp/tauri-dev.log 2>&1
echo "dev launched (log: /tmp/tauri-dev.log)"
