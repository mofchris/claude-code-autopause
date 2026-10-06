#!/usr/bin/env node
// usage-guard: pause Claude Code development at a usage-limit percentage, resume after reset.
// Zero dependencies. Node 18+. All state lives in ~/.claude/usage-guard/.
//
// Subcommands (run: node usage-guard.mjs <cmd> [flags]):
//   install [--five-hour N] [--seven-day N] [--chain "<existing statusline cmd>"] [--settings PATH]
//   uninstall [--settings PATH]
//   status [--json]
//   set [--five-hour N] [--seven-day N] [--resume-delay MIN] [--warn-below N] [--stale-minutes N] [--session [ID] | --global]
//   on | off [--session [ID] | --global]
//   override [MIN|off] [--session [ID] | --global]   -> suspend pausing (default: this session, 120 min)
//   clear-session [--session ID]                     -> drop this session's overrides
//   Scope: --session (bare) uses $CLAUDE_CODE_SESSION_ID; set/on/off default to global, override defaults to session.
//   record [--five-hour N --five-hour-resets ISO] [--seven-day N --seven-day-resets ISO]  (or stdin JSON from get_usage)
//   resume-at [--json]            -> when to resume (ISO, local, 5-field cron)
//   statusline                    -> stdin: statusline JSON; caches rate_limits; prints a status line
//   hook-pretool                  -> stdin: PreToolUse JSON; denies build tools while paused
//   hook-prompt                   -> stdin: UserPromptSubmit JSON; injects usage context when relevant
//   hook-posttool                 -> stdin: PostToolUse JSON; nudges a refresh when the cache is aging
//   hook-session-start            -> stdin: SessionStart JSON; injects usage context
//   checkpoint-path | clear-checkpoint

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HOME = os.homedir();
const DIR = path.join(HOME, '.claude', 'usage-guard');
const CONFIG_PATH = path.join(DIR, 'config.json');
const STATE_PATH = path.join(DIR, 'state.json');
const CHECKPOINT_PATH = path.join(DIR, 'checkpoint.md');
const DEFAULT_SETTINGS = path.join(HOME, '.claude', 'settings.json');
const SELF = fileURLToPath(import.meta.url).replace(/\\/g, '/');
const TAG = 'usage-guard'; // marks the hook/statusline entries we own

const DEFAULT_CONFIG = {
  enabled: true,
  fiveHour: 80,        // pause when the 5-hour window reaches this percent
  sevenDay: 95,        // pause when the weekly window reaches this percent
  resumeDelayMinutes: 3,
  warnBelow: 10,       // start warning this many points under the threshold
  staleMinutes: 30,    // cache older than this is "unknown" (never blocks)
  chain: '',           // pre-existing statusline command to run and prefix
};

// Tools that do "development". Anything else (Read, Grep, Glob, CronCreate, ...) stays allowed while paused.
const BUILD_TOOLS = /^(Bash|Edit|Write|MultiEdit|NotebookEdit|Agent|Task|Workflow)$/;

// ---------- small helpers ----------
const readJson = (p, fallback) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; } };
const writeJson = (p, v) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(v, null, 2) + '\n'); };
const readStdin = () => { try { return fs.readFileSync(0, 'utf8'); } catch { return ''; } };
const num = (v) => (v === undefined || v === null || v === '' ? undefined : Number(v));

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) out[key] = true; else { out[key] = next; i++; }
    } else out._.push(a);
  }
  return out;
}

// ---------- scope: global config + optional per-session overrides ----------
const SESSIONS_DIR = path.join(DIR, 'sessions');
const SESSION_KEYS = ['enabled', 'fiveHour', 'sevenDay', 'resumeDelayMinutes', 'warnBelow', 'overrideUntil'];
const sessionFile = (id) => path.join(SESSIONS_DIR, `${String(id).replace(/[^\w.-]/g, '_')}.json`);
const envSession = () => process.env.CLAUDE_CODE_SESSION_ID || process.env.CLAUDE_SESSION_ID || null;
// --session (bare) = this session from env; --session <id>; --global / nothing = global
function resolveScope(args) {
  if (args.global) return null;
  if (args.session === true) { const id = envSession(); if (!id) throw new Error('--session given but CLAUDE_CODE_SESSION_ID is not set; pass --session <id>'); return id; }
  if (typeof args.session === 'string') return args.session;
  return null;
}
const loadSession = (id) => (id ? readJson(sessionFile(id), {}) : {});
const saveSession = (id, v) => writeJson(sessionFile(id), v);
const loadGlobalConfig = () => ({ ...DEFAULT_CONFIG, ...readJson(CONFIG_PATH, {}) });
function loadConfig(sessionId) {
  const g = loadGlobalConfig();
  const s = loadSession(sessionId);
  const merged = { ...g, sessionId: sessionId || null, sessionOverrides: Object.keys(s).filter((k) => SESSION_KEYS.includes(k)) };
  for (const k of SESSION_KEYS) if (s[k] !== undefined) merged[k] = s[k];
  // a session-level overrideUntil wins; otherwise fall back to a global one
  merged.overrideUntil = s.overrideUntil ?? g.overrideUntil ?? null;
  return merged;
}
const saveConfig = (c) => { const { sessionId, sessionOverrides, ...rest } = c; writeJson(CONFIG_PATH, rest); };
function pruneSessions() { // drop per-session files untouched for 7 days
  try { for (const f of fs.readdirSync(SESSIONS_DIR)) { const p = path.join(SESSIONS_DIR, f); if (Date.now() - fs.statSync(p).mtimeMs > 7 * 86400e3) fs.unlinkSync(p); } } catch { /* none */ }
}
const loadState = () => readJson(STATE_PATH, null);

function saveState(windows, source) {
  const prev = loadState() || { windows: {} };
  const merged = { ...prev.windows };
  for (const [k, v] of Object.entries(windows)) if (v && Number.isFinite(v.used)) merged[k] = v;
  writeJson(STATE_PATH, { updatedAt: new Date().toISOString(), source, windows: merged });
}

const fmtDuration = (ms) => {
  if (ms <= 0) return 'now';
  const m = Math.round(ms / 60000);
  const d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), mm = m % 60;
  return d ? `${d}d ${h}h` : h ? `${h}h ${mm}m` : `${mm}m`;
};
const fmtLocal = (iso) => new Date(iso).toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' });
const toCron = (iso) => { const d = new Date(iso); return `${d.getMinutes()} ${d.getHours()} ${d.getDate()} ${d.getMonth() + 1} *`; };

// ---------- core evaluation ----------
// Returns { paused, warn, unknown, windows:[{key,label,used,threshold,resetsAt,expired,tripped}], resumeAt, reason, summary }
function evaluate(now = Date.now(), sessionId = null) {
  const cfg = loadConfig(sessionId);
  const state = loadState();
  const thresholds = { five_hour: cfg.fiveHour, seven_day: cfg.sevenDay };
  const labels = { five_hour: '5h', seven_day: 'weekly' };
  const overrideMs = cfg.overrideUntil ? new Date(cfg.overrideUntil).getTime() - now : 0;
  const overridden = overrideMs > 0;
  const res = { enabled: cfg.enabled, paused: false, warn: false, unknown: false, overridden, overrideLeft: overridden ? fmtDuration(overrideMs) : null, windows: [], resumeAt: null, reason: '', summary: '', cfg, updatedAt: state?.updatedAt || null, source: state?.source || null };

  if (!state || !state.windows || !Object.keys(state.windows).length) {
    res.unknown = true;
    res.summary = 'usage unknown (no cache yet)';
    return res;
  }
  const ageMs = now - new Date(state.updatedAt).getTime();
  const stale = ageMs > cfg.staleMinutes * 60000;

  for (const key of ['five_hour', 'seven_day']) {
    const w = state.windows[key];
    if (!w) continue;
    const resetsAt = w.resetsAt ? new Date(w.resetsAt).getTime() : null;
    const expired = resetsAt !== null && now >= resetsAt; // window rolled over since we cached it
    const used = expired ? 0 : w.used;
    const threshold = thresholds[key];
    const tripped = !expired && !stale && used >= threshold;
    res.windows.push({ key, label: labels[key], used, cachedUsed: w.used, threshold, resetsAt: w.resetsAt || null, expired, tripped });
    if (!expired && !stale && used >= threshold - cfg.warnBelow && used < threshold) res.warn = true;
  }

  const tripped = res.windows.filter((w) => w.tripped);
  if (stale) res.unknown = true;
  if (cfg.enabled && tripped.length && !overridden) {
    res.paused = true;
    const earliest = tripped.filter((w) => w.resetsAt).map((w) => new Date(w.resetsAt).getTime()).sort((a, b) => a - b)[0];
    if (earliest) res.resumeAt = new Date(earliest + cfg.resumeDelayMinutes * 60000).toISOString();
    res.reason = tripped.map((w) => `${w.label} at ${w.used}% (threshold ${w.threshold}%, resets ${w.resetsAt ? fmtLocal(w.resetsAt) + ', in ' + fmtDuration(new Date(w.resetsAt).getTime() - now) : 'unknown'})`).join('; ');
  }
  res.summary = res.windows.map((w) => `${w.label} ${w.used}%/${w.threshold}%${w.expired ? ' (reset)' : ''}`).join(' · ')
    + (stale ? ` · cache stale (${fmtDuration(ageMs)} old)` : '')
    + (cfg.enabled ? '' : ' · guard OFF')
    + (overridden ? ` · override ${res.overrideLeft} left` : '')
    + (cfg.sessionOverrides.length ? ' · session-scoped' : '');
  return res;
}
const scopeLabel = (id) => (id ? `session ${String(id).slice(0, 8)}` : 'global');

function pauseInstructions(ev) {
  const resume = ev.resumeAt ? `${fmtLocal(ev.resumeAt)} (${ev.resumeAt}; cron "${toCron(ev.resumeAt)}")` : 'unknown';
  return [
    `usage-guard PAUSED development: ${ev.reason}.`,
    `Do NOT retry build tools. Do this instead, in order:`,
    `1. Write a resume checkpoint to ${CHECKPOINT_PATH} (goal, what is done, exact next steps, files touched, how to verify). Writes to that path are allowed.`,
    `2. Schedule a one-shot wake-up for ${resume} with the prompt "/usage-guard resume" (CronCreate with recurring:false; cron fields are LOCAL time; load it first via ToolSearch "select:CronCreate" if deferred; inside /loop use ScheduleWakeup). If no scheduler tool exists, tell the user the resume time instead.`,
    `3. Tell the user in one short message that work is paused, why, and when it resumes. Then stop.`,
    `Override: if the user explicitly says to keep going, run "/usage-guard override 60" (minutes; this session only) and continue; "/usage-guard off" or "/usage-guard set 90" also lift it.`,
  ].join('\n');
}

// ---------- subcommands ----------
function cmdStatus(args) {
  pruneSessions();
  const sid = args.global ? null : (resolveScope({ ...args, session: args.session ?? true }) || null);
  const ev = evaluate(Date.now(), sid);
  if (args.json) { console.log(JSON.stringify(ev, null, 2)); return; }
  console.log(`usage-guard ${ev.cfg.enabled ? 'ON' : 'OFF'} · thresholds 5h ${ev.cfg.fiveHour}% / weekly ${ev.cfg.sevenDay}% · resume delay ${ev.cfg.resumeDelayMinutes}m · scope ${scopeLabel(sid)}${ev.cfg.sessionOverrides.length ? ` (session overrides: ${ev.cfg.sessionOverrides.join(', ')})` : ''}`);
  if (ev.overridden) console.log(`OVERRIDE active: pausing suspended for ${ev.overrideLeft}`);
  console.log(`state: ${ev.summary}${ev.updatedAt ? ` · cached ${fmtDuration(Date.now() - new Date(ev.updatedAt).getTime())} ago via ${ev.source}` : ''}`);
  for (const w of ev.windows) console.log(`  ${w.label.padEnd(7)} ${String(w.used).padStart(3)}%  threshold ${w.threshold}%  resets ${w.resetsAt ? fmtLocal(w.resetsAt) + ' (in ' + fmtDuration(new Date(w.resetsAt).getTime() - Date.now()) + ')' : '?'}${w.tripped ? '  <-- TRIPPED' : w.expired ? '  (window reset since cache)' : ''}`);
  if (ev.paused) console.log(`PAUSED · resume at ${fmtLocal(ev.resumeAt)} (${ev.resumeAt})`);
  else if (ev.warn) console.log('WARNING: approaching threshold');
  else if (ev.unknown) console.log('No fresh usage data: refresh with the get_usage tool + "record", or let the status line fill the cache.');
  if (fs.existsSync(CHECKPOINT_PATH)) console.log(`checkpoint present: ${CHECKPOINT_PATH}`);
}

function cmdSet(args) {
  const sid = resolveScope(args);
  const target = sid ? loadSession(sid) : loadGlobalConfig();
  const fh = num(args.fiveHour ?? args._[0]);
  if (fh !== undefined) target.fiveHour = clampPct(fh);
  if (args.sevenDay !== undefined) target.sevenDay = clampPct(num(args.sevenDay));
  if (args.resumeDelay !== undefined) target.resumeDelayMinutes = Math.max(0, num(args.resumeDelay));
  if (args.warnBelow !== undefined) target.warnBelow = Math.max(0, num(args.warnBelow));
  if (args.staleMinutes !== undefined) { if (sid) throw new Error('--stale-minutes is global only'); target.staleMinutes = Math.max(1, num(args.staleMinutes)); }
  if (sid) saveSession(sid, target); else saveConfig(target);
  const eff = loadConfig(sid);
  console.log(`saved (${scopeLabel(sid)}): 5h ${eff.fiveHour}% · weekly ${eff.sevenDay}% · resume delay ${eff.resumeDelayMinutes}m · warn below ${eff.warnBelow} · stale after ${eff.staleMinutes}m`);
}
const clampPct = (n) => { if (!Number.isFinite(n) || n < 1 || n > 100) throw new Error(`percentage must be 1-100, got ${n}`); return Math.round(n); };

function cmdToggle(on, args) {
  const sid = resolveScope(args);
  if (sid) { const s = loadSession(sid); s.enabled = on; saveSession(sid, s); }
  else { const cfg = loadGlobalConfig(); cfg.enabled = on; saveConfig(cfg); }
  console.log(`usage-guard ${on ? 'ON' : 'OFF'} (${scopeLabel(sid)})`);
}

// override [minutes|off]: suspend pausing for a while. Defaults to THIS session (env id) when available.
function cmdOverride(args) {
  const arg = args._[0];
  const sid = args.global ? null : (resolveScope({ ...args, session: args.session ?? (envSession() ? true : undefined) }) || null);
  const target = sid ? loadSession(sid) : loadGlobalConfig();
  if (arg === 'off' || arg === 'clear') { delete target.overrideUntil; if (sid) saveSession(sid, target); else saveConfig(target); console.log(`override cleared (${scopeLabel(sid)})`); return; }
  const minutes = num(arg) ?? 120;
  if (!Number.isFinite(minutes) || minutes <= 0) throw new Error(`minutes must be a positive number, got ${arg}`);
  target.overrideUntil = new Date(Date.now() + minutes * 60000).toISOString();
  if (sid) saveSession(sid, target); else saveConfig(target);
  console.log(`override ON (${scopeLabel(sid)}): pausing suspended for ${fmtDuration(minutes * 60000)}, until ${fmtLocal(target.overrideUntil)}. Clear early with "override off".`);
}

function cmdClearSession(args) {
  const sid = resolveScope({ ...args, session: args.session ?? true });
  const f = sessionFile(sid);
  if (fs.existsSync(f)) fs.unlinkSync(f);
  console.log(`session overrides cleared (${scopeLabel(sid)}); global settings apply`);
}

// Accepts flags, or stdin JSON in either the desktop get_usage shape or the statusline rate_limits shape.
function cmdRecord(args) {
  let windows = {};
  const stdin = readStdin().trim();
  if (stdin) windows = windowsFromAny(JSON.parse(stdin));
  if (args.fiveHour !== undefined) windows.five_hour = { used: num(args.fiveHour), resetsAt: args.fiveHourResets || windows.five_hour?.resetsAt };
  if (args.sevenDay !== undefined) windows.seven_day = { used: num(args.sevenDay), resetsAt: args.sevenDayResets || windows.seven_day?.resetsAt };
  if (!Object.keys(windows).length) throw new Error('nothing to record: pass --five-hour/--seven-day flags or pipe get_usage JSON on stdin');
  saveState(windows, 'record');
  const ev = evaluate(Date.now(), envSession());
  console.log(`recorded · ${ev.summary}`);
  if (ev.paused) console.log(pauseInstructions(ev));
}

function windowsFromAny(obj) {
  const out = {};
  // statusline shape: { rate_limits: { five_hour: {used_percentage, resets_at(epoch s)}, seven_day: {...} } }
  const rl = obj?.rate_limits;
  if (rl) {
    for (const k of ['five_hour', 'seven_day']) {
      if (rl[k] && Number.isFinite(Number(rl[k].used_percentage))) {
        const ra = rl[k].resets_at;
        out[k] = { used: Math.round(Number(rl[k].used_percentage)), resetsAt: ra ? new Date(Number(ra) < 1e12 ? Number(ra) * 1000 : Number(ra)).toISOString() : undefined };
      }
    }
  }
  // desktop get_usage shape: { plan: { windows: [{label, percentUsed, resetsAt}] } }
  const wins = obj?.plan?.windows || obj?.windows;
  if (Array.isArray(wins)) {
    for (const w of wins) {
      const label = String(w.label || '').toLowerCase();
      const key = /5.?hour/.test(label) ? 'five_hour' : /week/.test(label) && /all/.test(label) ? 'seven_day' : null;
      if (key && Number.isFinite(Number(w.percentUsed))) out[key] = { used: Math.round(Number(w.percentUsed)), resetsAt: w.resetsAt };
    }
  }
  return out;
}

function cmdResumeAt(args) {
  const ev = evaluate(Date.now(), args.global ? null : (typeof args.session === 'string' ? args.session : envSession()));
  const at = ev.resumeAt || (() => { // not paused: still useful -> next 5h reset
    const w = ev.windows.find((x) => x.key === 'five_hour' && x.resetsAt && !x.expired);
    return w ? new Date(new Date(w.resetsAt).getTime() + ev.cfg.resumeDelayMinutes * 60000).toISOString() : null;
  })();
  if (!at) { console.log(args.json ? '{"resumeAt":null}' : 'no reset time known'); return; }
  const info = { resumeAt: at, local: new Date(at).toString(), cron: toCron(at), paused: ev.paused };
  console.log(args.json ? JSON.stringify(info) : `resume at ${info.local}\ncron: ${info.cron}\nprompt: /usage-guard resume`);
}

function cmdStatusline() {
  const raw = readStdin();
  let input = {};
  try { input = JSON.parse(raw); } catch { /* ignore */ }
  const windows = windowsFromAny(input);
  if (Object.keys(windows).length) saveState(windows, 'statusline');
  const cfg = loadGlobalConfig();
  let prefix = '';
  if (cfg.chain) {
    const r = spawnSync(cfg.chain, { input: raw, shell: true, encoding: 'utf8' });
    prefix = (r.stdout || '').trim();
  }
  const ev = evaluate(Date.now(), input.session_id || envSession());
  const ours = ev.paused ? `⏸ guard: ${ev.summary}` : ev.warn ? `⚠ guard: ${ev.summary}` : `guard: ${ev.summary}`;
  process.stdout.write(prefix ? `${prefix} | ${ours}` : ours);
}

function cmdHookPreTool() {
  const input = (() => { try { return JSON.parse(readStdin()); } catch { return {}; } })();
  const tool = input.tool_name || '';
  const ev = evaluate(Date.now(), input.session_id || envSession());
  if (!ev.paused || !BUILD_TOOLS.test(tool)) return;
  const ti = input.tool_input || {};
  // Always allow the guard's own housekeeping while paused.
  const fp = String(ti.file_path || ti.notebook_path || '').replace(/\\/g, '/');
  if (fp && fp.startsWith(DIR.replace(/\\/g, '/'))) return;
  if (tool === 'Bash' && /usage-guard\.mjs/.test(String(ti.command || ''))) return;
  console.log(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: pauseInstructions(ev),
    },
  }));
}

// After a build tool runs: if the cache is aging and no nudge went out recently, ask the model to refresh.
// Keeps the guard live in the desktop app during long unattended runs (no status line, no user prompts).
const hookInput = () => { try { return JSON.parse(readStdin()); } catch { return {}; } };

function cmdHookPostTool() {
  const input = hookInput();
  const ev = evaluate(Date.now(), input.session_id || envSession());
  if (!ev.enabled || ev.paused) return;
  const state = loadState();
  const now = Date.now();
  const ageMin = state?.updatedAt ? (now - new Date(state.updatedAt).getTime()) / 60000 : Infinity;
  const refreshAfter = Math.max(5, Math.floor(ev.cfg.staleMinutes / 2));
  const lastNudge = state?.lastNudgeAt ? (now - new Date(state.lastNudgeAt).getTime()) / 60000 : Infinity;
  if (ageMin < refreshAfter || lastNudge < refreshAfter) return;
  writeJson(STATE_PATH, { ...(state || { windows: {} }), lastNudgeAt: new Date(now).toISOString() });
  const why = state?.updatedAt ? `usage cache is ${fmtDuration(ageMin * 60000)} old` : 'no usage data cached';
  console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext:
    `usage-guard: ${why}. Before continuing, call the get_usage tool (if available) and pipe its JSON to: node "${SELF}" record  — one call, then carry on. If the result says PAUSED, follow its instructions.` } }));
}

function contextLine(ev, verbose) {
  if (ev.paused) return pauseInstructions(ev);
  if (ev.warn) return `usage-guard WARNING: ${ev.summary}. Approaching the pause threshold; finish the current step cleanly and keep ${CHECKPOINT_PATH}-style notes of where you are.`;
  if (ev.unknown) return `usage-guard is ON (thresholds 5h ${ev.cfg.fiveHour}% / weekly ${ev.cfg.sevenDay}%) but has ${ev.windows.length ? 'stale' : 'no'} usage data. If a get_usage tool is available, call it now and pipe its JSON to: node "${SELF}" record`;
  if (verbose) return `usage-guard ON: ${ev.summary}${ev.updatedAt ? ` (cached ${fmtDuration(Date.now() - new Date(ev.updatedAt).getTime())} ago)` : ''}.`;
  return '';
}

function cmdHookPrompt() {
  const input = hookInput();
  const ev = evaluate(Date.now(), input.session_id || envSession());
  if (!ev.enabled) return;
  const line = contextLine(ev, false);
  if (!line) return;
  console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: line } }));
}

function cmdHookSessionStart() {
  const input = hookInput();
  pruneSessions();
  const ev = evaluate(Date.now(), input.session_id || envSession());
  if (!ev.enabled) return;
  let line = contextLine(ev, true);
  if (ev.cfg.sessionOverrides.length) line += `\nThis session has its own usage-guard settings (${ev.cfg.sessionOverrides.join(', ')}); "/usage-guard clear-session" returns it to the global ones.`;
  if (fs.existsSync(CHECKPOINT_PATH)) line += `\nA usage-guard checkpoint exists at ${CHECKPOINT_PATH}; if the user wants to continue the paused work, read it first (or run /usage-guard resume).`;
  console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: line } }));
}

// ---------- install / uninstall ----------
const hookCmd = (sub) => `node "${SELF}" ${sub}`;
const ownedHook = (h) => h && typeof h.command === 'string' && h.command.includes(SELF.split('/').slice(-3).join('/'));

function cmdInstall(args) {
  const settingsPath = args.settings || DEFAULT_SETTINGS;
  const cfg = loadGlobalConfig();
  if (args.fiveHour !== undefined) cfg.fiveHour = clampPct(num(args.fiveHour));
  if (args.sevenDay !== undefined) cfg.sevenDay = clampPct(num(args.sevenDay));
  if (args.chain !== undefined) cfg.chain = String(args.chain);
  saveConfig(cfg);

  const settings = readJson(settingsPath, {});
  if (fs.existsSync(settingsPath)) fs.copyFileSync(settingsPath, settingsPath + '.usage-guard.bak');
  settings.hooks = settings.hooks || {};
  const add = (event, matcher, sub, timeout) => {
    const list = (settings.hooks[event] = settings.hooks[event] || []);
    // drop any previous copy of ours
    for (const entry of list) entry.hooks = (entry.hooks || []).filter((h) => !ownedHook(h));
    settings.hooks[event] = list.filter((e) => (e.hooks || []).length);
    const entry = { hooks: [{ type: 'command', command: hookCmd(sub), timeout, statusMessage: TAG }] };
    if (matcher) entry.matcher = matcher;
    settings.hooks[event].push(entry);
  };
  add('PreToolUse', 'Bash|Edit|Write|MultiEdit|NotebookEdit|Agent|Task|Workflow', 'hook-pretool', 5);
  add('PostToolUse', 'Bash|Edit|Write|MultiEdit|NotebookEdit|Agent|Task|Workflow', 'hook-posttool', 5);
  add('UserPromptSubmit', null, 'hook-prompt', 5);
  add('SessionStart', null, 'hook-session-start', 5);

  const existing = settings.statusLine;
  if (existing && existing.type === 'command' && !ownedHook(existing) && !cfg.chain && !args.noChain) {
    cfg.chain = existing.command; saveConfig(cfg); // keep the user's status line, prefix it
  }
  settings.statusLine = { type: 'command', command: hookCmd('statusline'), padding: existing?.padding ?? 0 };
  writeJson(settingsPath, settings);
  console.log(`installed into ${settingsPath} (backup: ${settingsPath}.usage-guard.bak)`);
  console.log(`thresholds: 5h ${cfg.fiveHour}% · weekly ${cfg.sevenDay}%${cfg.chain ? ` · chained statusline: ${cfg.chain}` : ''}`);
  console.log('hooks take effect in new sessions (hooks are snapshotted at session start).');
}

function cmdUninstall(args) {
  const settingsPath = args.settings || DEFAULT_SETTINGS;
  const settings = readJson(settingsPath, {});
  for (const [event, list] of Object.entries(settings.hooks || {})) {
    for (const entry of list) entry.hooks = (entry.hooks || []).filter((h) => !ownedHook(h));
    settings.hooks[event] = list.filter((e) => (e.hooks || []).length);
    if (!settings.hooks[event].length) delete settings.hooks[event];
  }
  if (!Object.keys(settings.hooks || {}).length) delete settings.hooks;
  const cfg = loadGlobalConfig();
  if (ownedHook(settings.statusLine)) {
    if (cfg.chain) settings.statusLine = { type: 'command', command: cfg.chain, padding: settings.statusLine.padding ?? 0 };
    else delete settings.statusLine;
  }
  writeJson(settingsPath, settings);
  console.log(`removed usage-guard hooks/statusline from ${settingsPath}; config and cache left in ${DIR}`);
}

// ---------- main ----------
const args = parseArgs(process.argv.slice(2));
const cmd = args._.shift() || 'status';
try {
  switch (cmd) {
    case 'install': cmdInstall(args); break;
    case 'uninstall': cmdUninstall(args); break;
    case 'status': cmdStatus(args); break;
    case 'set': cmdSet(args); break;
    case 'on': cmdToggle(true, args); break;
    case 'off': cmdToggle(false, args); break;
    case 'override': case 'snooze': cmdOverride(args); break;
    case 'clear-session': cmdClearSession(args); break;
    case 'record': cmdRecord(args); break;
    case 'resume-at': cmdResumeAt(args); break;
    case 'statusline': cmdStatusline(); break;
    case 'hook-pretool': cmdHookPreTool(); break;
    case 'hook-prompt': cmdHookPrompt(); break;
    case 'hook-posttool': cmdHookPostTool(); break;
    case 'hook-session-start': cmdHookSessionStart(); break;
    case 'checkpoint-path': console.log(CHECKPOINT_PATH); break;
    case 'clear-checkpoint': if (fs.existsSync(CHECKPOINT_PATH)) fs.unlinkSync(CHECKPOINT_PATH); console.log('checkpoint cleared'); break;
    default: console.error(`unknown command: ${cmd}`); process.exit(1);
  }
} catch (e) {
  // Hooks must never break the session: fail open with a message on stderr.
  console.error(`usage-guard error: ${e.message}`);
  process.exit(cmd.startsWith('hook') || cmd === 'statusline' ? 0 : 1);
}
