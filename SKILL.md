---
name: usage-guard
description: Use when a session should stop building before the Claude plan usage limit (5-hour or weekly rate limit) is exhausted, pause at a user-chosen percentage, and resume automatically after the limit resets. Also use when the user asks how much usage is left, wants to set or change the pause threshold, sees a "usage-guard PAUSED" tool denial, or a scheduled "/usage-guard resume" prompt fires.
argument-hint: "[status | set <5h%> [--seven-day N] [--session] | override [MIN|off] | on | off | clear-session | install | resume | checkpoint]"
---

# usage-guard

Keeps the session aware of plan usage and pauses development at a threshold the user picks, then resumes after the reset. A tiny Node script owns all state; hooks enforce the pause; this skill tells you how to behave around it.

**Script:** `node "~/.claude/skills/usage-guard/scripts/usage-guard.mjs" <cmd>` (use the absolute path: `C:/Users/<you>/.claude/skills/usage-guard/scripts/usage-guard.mjs`).
**State dir:** `~/.claude/usage-guard/` (config.json, state.json cache, checkpoint.md).

## How it works

1. **Usage cache.** Two writers feed `state.json`: the Claude Code status line (automatic; the status line stdin JSON carries `rate_limits.five_hour` / `seven_day`) and you, by piping the desktop `get_usage` tool's JSON into `record`.
2. **Enforcement.** A PreToolUse hook denies Bash/Edit/Write/Agent/Task while a window is at or above its threshold. Read, Grep, Glob, CronCreate, and writes inside the state dir stay allowed, so you can still checkpoint and schedule.
3. **Reset detection.** A cached window whose `resetsAt` has passed counts as 0%, so the guard lifts itself the moment the limit resets, even with a stale cache. A cache older than `staleMinutes` (default 30) never blocks; it asks for a refresh instead.
4. **Resume.** You schedule a one-shot wake-up for reset time plus a small delay; its prompt is `/usage-guard resume`.

## Commands (`/usage-guard <arg>`)

**Scope rule:** settings are global unless the user says "this session", "only here", "for now" or similar; then add `--session` (the script reads `CLAUDE_CODE_SESSION_ID`). `override` is the opposite: session-scoped by default, `--global` to widen. Session settings live in `~/.claude/usage-guard/sessions/<id>.json` and are pruned after 7 days.

| Arg | Do this |
|---|---|
| (none) / `status` | Refresh (step A below), then run `status` and report the lines to the user. |
| `set 80` / `set 80 --seven-day 95` | Run `set --five-hour 80 [--seven-day 95]` (add `--session` per the scope rule). Also `--resume-delay MIN`, `--warn-below N`, `--stale-minutes N` (global only). |
| `on` / `off` | Run `on` / `off` (`--session` per the scope rule). `off` disables pausing but keeps reporting. |
| `override [MIN]` / "keep going" | Run `override 60` (minutes; default 120; this session only). Pausing is suspended for that long, then re-arms. `override off` ends it early. Only on the user's explicit say-so, never on your own initiative. |
| `clear-session` | Run `clear-session`: this session goes back to the global settings. |
| `install` | Run `install [--five-hour N --seven-day N]`. Merges hooks + status line into `~/.claude/settings.json` (backup written). Hooks start in the next session. |
| `uninstall` | Run `uninstall`. Removes only the entries the guard owns. |
| `resume` | Follow **Resume protocol**. |
| `checkpoint` | Write the checkpoint now (see Pause protocol step 1) without stopping. |

## A. Refresh the cache (do this at session start and whenever a hook says the data is stale)

If the tool `mcp__ccd_session_mgmt__get_usage` exists (Claude desktop app): call it, then pipe its JSON into the script:

```bash
node "C:/Users/<you>/.claude/skills/usage-guard/scripts/usage-guard.mjs" record <<'EOF'
<paste the get_usage JSON here>
EOF
```

Flags work too: `record --five-hour 22 --five-hour-resets 2026-10-06T04:10:00Z --seven-day 57 --seven-day-resets 2026-10-07T16:00:00Z`.
If no usage tool exists (CLI), the status line fills the cache by itself; nothing to do.

Re-record roughly every 20 minutes of heavy work or after large subagent fan-outs; the PreToolUse hook only knows what the cache knows.

## Pause protocol (a tool call was denied with "usage-guard PAUSED", or `record` printed it)

Do these in order, then stop. Do not retry the denied tool, do not "finish one more small thing", do not switch to a different build tool to get around the denial. While paused, the only file you write is the checkpoint, even if some tool would let you edit the project.

1. **Checkpoint.** Write `~/.claude/usage-guard/checkpoint.md` (path from `checkpoint-path`; writes there are allowed while paused):
   - Goal of the current task, in the user's words.
   - Done so far (files changed, commands run, tests passing/failing).
   - Exact next steps, as a numbered list a fresh session could execute.
   - How to verify completion.
   - Working directory and branch.
2. **Schedule the wake-up.** Run `resume-at --json`, then `CronCreate` with `recurring: false`, `cron` from the output (already in local time, which is what CronCreate expects), and `prompt: "/usage-guard resume"`. CronCreate is usually a deferred tool: load it with `ToolSearch` query `select:CronCreate` first. Inside a `/loop`, use `ScheduleWakeup` with the equivalent delay instead. If neither tool exists (common inside subagents), tell the user the resume time and ask them to send `/usage-guard resume` then; a cloud scheduled task is an option only if the user approves it, since it is persistent configuration.
3. **Tell the user** in two or three sentences: paused, which window at what percent, resume time, and that `/usage-guard override 60` (this session) or `/usage-guard set <higher>` lifts it. Then end the turn.

**If the user then says to keep going anyway:** run `override <minutes>` (ask none; default 120 if they gave no number), delete the scheduled wake-up if one exists (`CronDelete`), say in one line how long the override lasts, and continue from where you stopped. The override is session-scoped and expires on its own.

Session-only schedulers die with the session: the window must stay open for auto-resume. Weekly resets days away will usually need a manual `/usage-guard resume` in a later session; the SessionStart hook reminds you a checkpoint exists.

## Resume protocol (`/usage-guard resume` fired, or the user asks to continue paused work)

1. Refresh the cache (section A) and run `status`.
2. If still PAUSED (reset not reached, or the weekly window tripped): reschedule per Pause protocol step 2 and say so in one line. Stop.
3. If clear: read `checkpoint.md`, confirm in one line what you are resuming, continue from "Exact next steps". Run `clear-checkpoint` once that work is finished or superseded.

## Rationalizations that are not allowed

| Thought | Reality |
|---|---|
| "The denial is a glitch, retry once" | The hook reads a file; it is deterministic. Follow the protocol. |
| "I'll just use Write instead of Bash" | Every build tool is covered. Switching tools to touch the project is bypassing the user's limit. (Write to the checkpoint file is the one intended exception.) |
| "The user wants this finished, the limit is their problem" | The user set the threshold precisely so they keep headroom. Honor it. |
| "Threshold is close, I'll race it" | Warnings exist so you can stop at a clean point, not sprint. |
| "Cache is stale so nothing applies" | Stale means refresh (section A), not ignore. |

## Notes

- Thresholds default to 5h 80%, weekly 95%. The guard never blocks when it has no data; it fails open with a refresh request.
- Claude Code's own `autoContinueAtUsageLimit` setting handles the 100% case; this skill handles everything below it.
- `status --json` gives the full evaluation (windows, tripped, resumeAt) for scripting.
