#!/bin/sh
# Symlink bin/stage.js to ~/.local/bin/stage (installs dependencies first if needed).
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
[ -d "$ROOT/node_modules" ] || (cd "$ROOT" && npm install)
mkdir -p "$HOME/.local/bin"
chmod +x "$ROOT/bin/stage.js"
ln -sf "$ROOT/bin/stage.js" "$HOME/.local/bin/stage"
echo "Linked $HOME/.local/bin/stage -> $ROOT/bin/stage.js"
case ":$PATH:" in *":$HOME/.local/bin:"*) ;; *) echo "Add ~/.local/bin to your PATH to run 'stage'." ;; esac
