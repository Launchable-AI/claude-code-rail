import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

export const HOME = os.homedir();
export const CLAUDE_DIR = path.join(HOME, '.claude');
export const PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects');
export const RAIL_DIR = process.env.CC_RAIL_HOME || path.join(HOME, '.cc-rail');
export const STATE_DIR = path.join(RAIL_DIR, 'state');
export const HOOK_DIR = path.join(STATE_DIR, 'hooks');
export const OVERVIEW = path.join(STATE_DIR, 'overview.json');
// Which window is active in each tmux session. Split out of the overview
// because it has to be current within a frame, not within a collector tick.
export const FOCUS = path.join(STATE_DIR, 'focus.json');
// View settings a rail shares with every other rail, so switching windows does
// not switch what you are looking at.
export const UISTATE = path.join(STATE_DIR, 'ui.json');
// Plan windows the collector polled itself, for when Claude Code's own cache
// has gone stale (it only refills when a session opens /usage).
export const USAGE = path.join(STATE_DIR, 'usage.json');

/** The view settings every rail shares. Absent keys mean "never set". */
export function loadUI() {
  return readJSON(UISTATE, {}) || {};
}

/** Merge a change in, so one setting never clobbers another. */
export function saveUI(patch) {
  const next = { ...loadUI(), ...patch, at: Date.now() };
  try { writeJSON(UISTATE, next); } catch { /* this rail keeps its own view */ }
  return next;
}
export const DAEMON_PID = path.join(STATE_DIR, 'daemon.pid');
export const DAEMON_LOG = path.join(STATE_DIR, 'daemon.log');
export const CONFIG = path.join(RAIL_DIR, 'config.json');

export function ensureDirs() {
  for (const d of [RAIL_DIR, STATE_DIR, HOOK_DIR]) fs.mkdirSync(d, { recursive: true });
}

/** ~/.claude/projects encodes a cwd by replacing every non-alphanumeric run with '-'. */
export function projectDirFor(cwd) {
  return path.join(PROJECTS_DIR, cwd.replace(/[^a-zA-Z0-9]/g, '-'));
}

export function readJSON(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

/** Atomic write: rails read these files constantly, a torn read must be impossible. */
export function writeJSON(file, value) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value));
  fs.renameSync(tmp, file);
}

export function loadConfig() {
  return {
    theme: 'auto',
    railWidth: 34,
    idleAfterMin: 45,
    detailLines: 8,
    // Recent-output feed: 'off', 'one' (the selected session) or 'all'. The
    // 'all' view shows fewer lines each so a rail of sessions still fits.
    detail: 'off',
    detailLinesAll: 4,
    // Plan-limit percentages along the bottom of the rail.
    showUsage: true,
    // Ask the API for those percentages ourselves rather than waiting for
    // someone to open /usage. Off by default: it reads the stored OAuth token
    // and calls an endpoint Anthropic does not document. `cc-rail usage on`.
    pollUsage: false,
    usagePollMs: 5 * 60 * 1000,
    // 'auto' renames only uninformative windows, 'always' every cc-rail window, 'off' none.
    renameWindows: 'auto',
    ...(readJSON(CONFIG, {}) || {}),
  };
}
