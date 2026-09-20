#!/usr/bin/env bash
# Point dsh's web profile at THIS checkout's built plugin.
#
# Why this exists: the profile pins `@changfenhuang/dsh-genui` to a git SHA, so
# every `pnpm install` / plugin command in `~/.dsh/profiles/web` re-materializes
# the published package and silently drops the symlink (observed twice, which
# makes the patched client disappear after a restart). The fork cannot be
# installed as a git dependency either: its build output (`lib/`) is
# .gitignore'd, so a fresh clone ships no `lib/index.js` entry.
#
# Run after any profile install, then reload the page (client half) and restart
# dsh web (node half: system prompt + validate_dsh_ui live there).
#
#   ./tools/relink-dsh-genui.sh [profile_dir]
set -euo pipefail

FORK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROFILE_DIR="${1:-$HOME/.dsh/profiles/web}"
TARGET="$PROFILE_DIR/node_modules/@changfenhuang/dsh-genui"

[ -f "$FORK_DIR/lib/index.js" ] || { echo "ERROR: build first (pnpm run build) — $FORK_DIR/lib/index.js missing" >&2; exit 1; }
[ -d "$PROFILE_DIR" ] || { echo "ERROR: profile dir not found: $PROFILE_DIR" >&2; exit 1; }

BACKUP="$TARGET.pkg-backup"
if [ -L "$TARGET" ]; then
  if [ "$(readlink "$TARGET")" = "$FORK_DIR" ]; then
    echo "already linked → $FORK_DIR"
    exit 0
  fi
  rm "$TARGET"
elif [ -d "$TARGET" ]; then
  rm -rf "$BACKUP"
  mv "$TARGET" "$BACKUP"
  echo "backed up the materialized package → $BACKUP"
fi

ln -s "$FORK_DIR" "$TARGET"
echo "linked $TARGET → $FORK_DIR"
node -e "console.log('profile resolves @changfenhuang/dsh-genui', require('$TARGET/package.json').version)"
