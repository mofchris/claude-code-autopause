#!/usr/bin/env bash
# One-line installer for claude-code-autopause.
#   curl -fsSL https://raw.githubusercontent.com/mofchris/claude-code-autopause/main/install.sh | bash
# Optional thresholds:  ... | bash -s -- --five-hour 80 --seven-day 95
set -euo pipefail

REPO="https://github.com/mofchris/claude-code-autopause"
DEST="$HOME/.claude/skills/usage-guard"

command -v node >/dev/null 2>&1 || { echo "claude-code-autopause needs Node.js 18+ on your PATH."; exit 1; }
command -v git  >/dev/null 2>&1 || { echo "claude-code-autopause needs git on your PATH."; exit 1; }

if [ -d "$DEST/.git" ]; then
  echo "Updating existing install in $DEST"
  git -C "$DEST" pull --ff-only --quiet
else
  echo "Installing into $DEST"
  git clone --depth 1 --quiet "$REPO" "$DEST"
fi

node "$DEST/scripts/usage-guard.mjs" install "$@"
echo
echo "Done. Open a Claude Code session and run:  /usage-guard"
