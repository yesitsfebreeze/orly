#!/bin/sh
# Put the orly owl in Claude Code's status line. The owl, the last verdict, the round,
# the unmet specs and the top goal render there instead of in the transcript.
#
#   sh scripts/install-statusline.sh              user settings (~/.claude/settings.json)
#   sh scripts/install-statusline.sh --project    this project's .claude/settings.json
#   sh scripts/install-statusline.sh --uninstall  restore the status line it replaced
#
# An existing status line is kept: orly runs it after the owl (`--then`). Safe to run twice.
set -eu
command -v jq >/dev/null || { echo "needs jq" >&2; exit 1; }
root=$(cd "$(dirname "$0")/.." && pwd)
settings="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/settings.json"
uninstall=0
for a in "$@"; do
  case "$a" in
    --project) settings="$PWD/.claude/settings.json" ;;
    --uninstall) uninstall=1 ;;
    *) echo "unknown flag: $a" >&2; exit 1 ;;
  esac
done
mkdir -p "$(dirname "$settings")"
[ -f "$settings" ] || echo '{}' >"$settings"
# The status line orly replaced, kept beside the settings so --uninstall can restore it.
saved="$(dirname "$settings")/.orly-statusline-previous"

current=$(jq -r '.statusLine.command // ""' "$settings")
# What ran before orly, whether or not orly is installed already.
case "$current" in
  *"orly.ts\" statusline"*|*"scripts/orly-status"*) prev=$(cat "$saved" 2>/dev/null || true) ;;
  *) prev=$current ;;
esac

tmp=$(mktemp)
if [ "$uninstall" = 1 ]; then
  if [ -n "$prev" ]; then
    jq --arg c "$prev" '.statusLine = {type: "command", command: $c}' "$settings" >"$tmp"
  else
    jq 'del(.statusLine)' "$settings" >"$tmp"
  fi
  mv "$tmp" "$settings"
  rm -f "$saved"
  echo "orly status line removed from $settings"
  exit 0
fi

cmd="\"$root/scripts/orly-status\""
[ -n "$prev" ] && cmd="$cmd --then $(printf '%s' "$prev" | jq -Rr @sh)"
jq --arg c "$cmd" '.statusLine = {type: "command", command: $c, padding: 0}' "$settings" >"$tmp"
mv "$tmp" "$settings"
if [ -n "$prev" ]; then printf '%s' "$prev" >"$saved"; else rm -f "$saved"; fi
echo "orly status line installed in $settings"
[ -n "$prev" ] && echo "keeps running after it: $prev"
echo "restart Claude Code, or start a new session, to see it"
