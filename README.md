# usage-guard

A Claude Code skill that makes a session aware of your plan's usage limits, pauses development at a percentage you choose, and resumes on its own after the limit resets.

Built for Pro and Max subscribers who run long or unattended sessions and want to keep headroom on the 5-hour and weekly windows instead of hitting the wall mid-task.

```
/usage-guard set 80 --seven-day 95     # pause at 80% of the 5-hour window, 95% of the weekly window
/usage-guard                           # live usage, thresholds, resume time
/usage-guard override 60               # "I'm busy, give me an hour"
```

## What it does

- **Watches** the 5-hour and weekly usage windows.
- **Pauses** development when a window reaches your threshold: build tools (Bash, Edit, Write, agents) are denied by a hook, while read-only tools keep working.
- **Checkpoints** the current task to a file so nothing is lost: goal, what is done, exact next steps, how to verify.
- **Schedules** a one-shot wake-up for reset time plus a few minutes, then stops cleanly.
- **Resumes** when the wake-up fires: re-checks usage, reads the checkpoint, continues from the next step.
- **Warns** as usage approaches the threshold so the session finishes the current step cleanly instead of racing.
- **Never blocks blind.** With no fresh usage data it fails open and asks for a refresh instead.

## Requirements

- Claude Code 2.x (CLI or the Claude desktop app) signed in with a Pro or Max plan. API-key, Bedrock, and Vertex sessions have no plan limits and nothing to guard.
- Node.js 18 or newer on your PATH. The script has zero dependencies.

## Install

Clone into your personal skills directory and run the installer once:

```bash
git clone https://github.com/mofchris/usage-guard ~/.claude/skills/usage-guard
node ~/.claude/skills/usage-guard/scripts/usage-guard.mjs install --five-hour 80 --seven-day 95
```

On Windows the same two commands work in Git Bash. In PowerShell use `$HOME\.claude\skills\usage-guard`.

The installer merges four hooks and a status line into `~/.claude/settings.json` (a backup is written next to it) and writes defaults to `~/.claude/usage-guard/config.json`. It only ever adds or removes entries it owns, so your existing hooks and status line survive. If you already had a status line, it is kept and the guard's usage summary is appended to it.

The Claude desktop app picks the hooks up live. The CLI reads hooks at session start, so open a new session there.

## Usage

Everything runs through the `/usage-guard` skill inside a session, or directly through the script.

| Command | Effect |
|---|---|
| `/usage-guard` | Refresh usage and show windows, thresholds, resume time |
| `/usage-guard set 80` | Pause at 80% of the 5-hour window |
| `/usage-guard set 80 --seven-day 95` | Also pause at 95% of the weekly window |
| `/usage-guard set 85 --session` | Same, but only for the current session |
| `/usage-guard override 60` | Suspend pausing for 60 minutes in this session, then re-arm (default 120) |
| `/usage-guard override off` | End an override early |
| `/usage-guard off` / `on` | Disable or enable pausing (add `--session` to scope it) |
| `/usage-guard clear-session` | Drop this session's settings, back to global |
| `/usage-guard resume` | Continue paused work from the checkpoint |
| `/usage-guard uninstall` | Remove the hooks and status line entries the guard owns |

Script equivalents: `node ~/.claude/skills/usage-guard/scripts/usage-guard.mjs <command>`. `status --json` gives the full evaluation for scripting. Other knobs: `--resume-delay MIN`, `--warn-below N`, `--stale-minutes N`.

### Scope

Settings are global by default and persist across sessions. Add `--session` to any `set`, `on`, or `off` to make it apply only to the current session (the script reads `CLAUDE_CODE_SESSION_ID`). `override` is the other way round: session-scoped by default, `--global` to widen. Session files live under `~/.claude/usage-guard/sessions/` and are pruned after seven days.

### A prompt for a running session

```
/usage-guard set 85 --seven-day 80 --session
Then refresh the usage cache (call get_usage and pipe its JSON to the usage-guard record command) and show me /usage-guard status. These thresholds are for this session only. If a tool call is ever denied with "usage-guard PAUSED", follow the usage-guard pause protocol: checkpoint, schedule the "/usage-guard resume" wake-up, tell me, and stop. If I then tell you to keep going, run the usage-guard override and continue.
```

## How it works

Claude Code gives hooks no usage data, so the guard keeps a small cache at `~/.claude/usage-guard/state.json` and lets two writers feed it:

1. **The status line.** Claude Code passes `rate_limits.five_hour` and `rate_limits.seven_day` (percent used and reset time) to the status line command on every refresh. The guard's status line command records them and prints a short summary.
2. **The session itself.** In the Claude desktop app a `get_usage` tool reports the same numbers. The session pipes that JSON into `record`. A SessionStart hook asks for this at the start of every session, and a PostToolUse hook asks again when the cache is about 15 minutes old, so long unattended runs stay current.

The hooks then read that cache:

| Hook | Role |
|---|---|
| `PreToolUse` on Bash, Edit, Write, MultiEdit, NotebookEdit, Agent, Task, Workflow | Denies the call while a window is at or over its threshold. The denial reason contains the full pause protocol, so it works even if the skill was never loaded. Writes to the guard's own directory and calls to the guard script are always allowed. |
| `PostToolUse` on the same tools | Nudges a usage refresh when the cache is aging. Throttled. |
| `UserPromptSubmit` | Injects a one-line warning or the pause protocol when relevant. Silent otherwise. |
| `SessionStart` | Reports the current state, asks for a refresh, and mentions an existing checkpoint. |

Reset detection needs no fresh data: a cached window whose reset time has passed counts as 0%, so the guard lifts itself the moment the limit rolls over. A cache older than `staleMinutes` (default 30) never blocks.

### The pause protocol

When a build tool is denied, the session:

1. Writes `~/.claude/usage-guard/checkpoint.md` with the goal, what is done, exact next steps, files touched, and how to verify.
2. Schedules a one-shot wake-up at reset time plus `resumeDelayMinutes` with the prompt `/usage-guard resume` (Claude Code's `CronCreate`, or `ScheduleWakeup` inside a `/loop`).
3. Tells you in a few sentences what happened and when it resumes, then ends its turn.

"Then ends its turn" is load-bearing. The scheduled wake-up only fires while the session is idle, and stopping is what keeps a pressured model from retrying the denied command or routing the same edit through a different tool.

If you say "keep going", the session runs `override`, cancels the wake-up, and continues. It never overrides on its own.

## Limitations

- The resume timer lives inside the session. Close the session or the app while paused and the timer dies with it. The next session's start hook points out the checkpoint, and `/usage-guard resume` picks it up.
- Weekly-limit pauses can be days away, so those usually end as a manual resume in a later session.
- The guard knows only what the cache knows. In environments that run neither the status line nor a usage tool, nothing feeds the cache and the guard stays in its fail-open "unknown" state.
- Claude Code's own `autoContinueAtUsageLimit` setting handles the 100% case. This skill handles everything below it.

## Files

```
~/.claude/skills/usage-guard/
  SKILL.md                 # what the session reads: commands, protocols, rationalizations
  scripts/usage-guard.mjs  # the whole implementation, no dependencies
~/.claude/usage-guard/
  config.json              # global thresholds and options
  state.json               # usage cache
  checkpoint.md            # written on pause, cleared on completion
  sessions/<id>.json       # per-session overrides, pruned after 7 days
```

## Uninstall

```bash
node ~/.claude/skills/usage-guard/scripts/usage-guard.mjs uninstall
rm -rf ~/.claude/skills/usage-guard ~/.claude/usage-guard
```

## License

MIT
