#!/bin/sh
# Builds Stage and links dist/bin/stage.js to ~/.local/bin/stage (installs dependencies first if needed).
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
[ -d node_modules ] || npm install
npm run build
mkdir -p "$HOME/.local/bin"
ln -sf "$ROOT/dist/bin/stage.js" "$HOME/.local/bin/stage"
echo "Linked $HOME/.local/bin/stage -> $ROOT/dist/bin/stage.js"
case ":$PATH:" in *":$HOME/.local/bin:"*) ;; *) echo "Add ~/.local/bin to your PATH to run 'stage'." ;; esac
