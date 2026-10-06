# Contributing

Thanks for looking. Two rules keep this project easy to trust:

1. **One file, zero dependencies.** Everything lives in `scripts/usage-guard.mjs`. If a change needs a package, it probably belongs somewhere else.
2. **Hooks fail open.** A bug in the guard must never block a session. Hook subcommands catch every error and exit 0.

## Running the checks

The script reads and writes only under `$HOME/.claude/`, so point `HOME` (and `USERPROFILE` on Windows) at a scratch directory and exercise it there:

```bash
export HOME=/tmp/ug-test USERPROFILE=/tmp/ug-test CLAUDE_CODE_SESSION_ID=test-1
mkdir -p "$HOME/.claude"
S=scripts/usage-guard.mjs
FUT=$(node -e 'console.log(Math.floor(Date.now()/1000)+7200)')

node --check $S
node $S record --five-hour 40 --five-hour-resets 2030-01-01T00:00:00Z
echo '{"tool_name":"Bash","tool_input":{"command":"ls"}}' | node $S hook-pretool          # expect: no output (allowed)

echo "{\"rate_limits\":{\"five_hour\":{\"used_percentage\":85,\"resets_at\":$FUT}}}" | node $S statusline
echo '{"tool_name":"Bash","tool_input":{"command":"ls"}}' | node $S hook-pretool          # expect: deny JSON
echo "{\"tool_name\":\"Write\",\"tool_input\":{\"file_path\":\"$HOME/.claude/usage-guard/checkpoint.md\"}}" | node $S hook-pretool   # expect: allowed

node $S override 30
echo '{"tool_name":"Bash","tool_input":{"command":"ls"}}' | node $S hook-pretool          # expect: allowed
node $S override off

PAST=$(node -e 'console.log(Math.floor(Date.now()/1000)-60)')
echo "{\"rate_limits\":{\"five_hour\":{\"used_percentage\":85,\"resets_at\":$PAST}}}" | node $S statusline
echo '{"tool_name":"Bash","tool_input":{"command":"ls"}}' | node $S hook-pretool          # expect: allowed (window reset)

echo '{"statusLine":{"type":"command","command":"echo mine"}}' > "$HOME/.claude/settings.json"
node $S install && node $S uninstall && cat "$HOME/.claude/settings.json"                   # expect: original restored
```

If you add a hook decision, add a line here that proves it.

## Changing SKILL.md

The skill text shapes model behaviour under pressure. Before changing the pause or resume protocol, run a fresh session (or subagent) that is mid-task, hand it a simulated "usage-guard PAUSED" denial, and confirm it checkpoints, schedules, reports and stops without retrying a build tool.
