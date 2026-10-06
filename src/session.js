import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getOption, listPanes, newWindow, setOption, splitRail, tmux, tmuxOk } from './tmux.js';
import { loadConfig, loadUI } from './paths.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const RAIL_BIN = path.join(HERE, '..', 'bin', 'cc-rail');

function shq(s) { return "'" + String(s).replace(/'/g, `'\\''`) + "'"; }

export function railCommand() {
  return `${shq(RAIL_BIN)} rail`;
}

// Hiding a rail with `q` is easy to do by accident and hard to undo without
// leaving whatever you were doing. prefix+R is the way back from inside tmux.
const RECALL_KEY = 'R';

/**
 * Bind prefix+R to `cc-rail adopt`, but never over a binding you already have:
 * a key that stops doing what you expect is a worse bug than the one this
 * fixes. Returns the key if it is ours, otherwise null. Callers check that a
 * tmux server exists first -- `list-keys` on an unbound key also fails, and
 * that failure means "free to bind", not "no tmux".
 */
export function bindRecall() {
  let existing = '';
  try { existing = tmux(['list-keys', '-T', 'prefix', RECALL_KEY]); } catch { existing = ''; }
  if (existing && !/cc-rail/.test(existing)) return null;
  tmuxOk(['bind-key', '-T', 'prefix', RECALL_KEY, 'run-shell', `${RAIL_BIN} adopt`]);
  // The rail reads this to name the key when it hides itself.
  setOption('@cc_rail_key', RECALL_KEY);
  return RECALL_KEY;
}

// Next / previous session from any pane. Root table, so no prefix: moving
// between sessions is the thing you do most. Alt rather than Ctrl because
// Ctrl-[ is Escape to a terminal, and Ctrl-] is Claude Code's own. Not
// Alt-j/k either: window managers and host terminals commonly take those
// before they ever reach ssh. Period / comma read as > / < for next / prev.
const NAV_DEFAULT = { next: 'M-.', prev: 'M-,' };

/**
 * Bind the session-stepping keys, under the same rule as bindRecall: a key
 * already bound to something that is not ours is left alone. `"navKeys":
 * false` in config.json turns them off; `{ "next": .., "prev": .. }` moves them.
 * Returns the keys that are ours.
 */
export function bindNav() {
  const want = loadConfig().navKeys;
  const keys = want === false ? {} : { ...NAV_DEFAULT, ...(want || {}) };
  const ours = [];
  const isOurs = (key) => {
    let existing = '';
    try { existing = tmux(['list-keys', '-T', 'root', key]); } catch { existing = ''; }
    return { bound: Boolean(existing), ours: /cc-rail/.test(existing) };
  };
  // Keys we bound before and no longer want (the defaults moved, or config
  // did) go back, so a move never leaves the old keys stepping too.
  const wanted = new Set(Object.values(keys).filter(Boolean));
  for (const old of (getOption('@cc_rail_nav_keys') || '').split(' ').filter(Boolean)) {
    if (!wanted.has(old) && isOurs(old).ours) tmuxOk(['unbind-key', '-T', 'root', old]);
  }
  for (const [dir, key] of Object.entries(keys)) {
    if (!key) continue;
    const b = isOurs(key);
    if (b.bound && !b.ours) continue;
    // run-shell expands #{pane_id} to the pane the key was pressed in. It
    // must print nothing: any output takes over the pane until dismissed.
    tmuxOk(['bind-key', '-T', 'root', key, 'run-shell',
      `${shq(RAIL_BIN)} ${dir} '#{pane_id}' >/dev/null 2>&1`]);
    ours.push(key);
  }
  // uninstall reads this to give back exactly the keys that were ours.
  setOption('@cc_rail_nav_keys', ours.join(' '));
  return ours;
}

/** Put the collector's one-line summary in front of whatever status-right had. */
export function wireStatusBar() {
  const cur = getOption('status-right') || '';
  if (cur.includes('@cc_rail_summary')) return false;
  setOption('@cc_rail_saved_status_right', cur);
  setOption('status-right', `#[fg=colour160,bold]#{@cc_rail_summary}#[default]  ${cur}`);
  return true;
}

/**
 * The tmux-server-scoped half of cc-rail: a key binding and a status line.
 * Both live in the tmux server, not on disk, so they vanish with it -- which
 * is why the collector reapplies them whenever a server appears rather than
 * leaving them to whoever last ran `cc-rail up`.
 */
export function ensureTmuxSetup({ statusBar = true } = {}) {
  const key = bindRecall();
  bindNav();
  if (statusBar) wireStatusBar();
  return key;
}

/** Add a rail pane to a window that does not have one yet. */
export function addRail(target, width) {
  // A new rail comes up at whatever width the others are at, so adopting a
  // window does not leave one rail a different size from the rest.
  const shared = loadUI().width;
  return splitRail({ target, width: width || shared || loadConfig().railWidth, command: railCommand() });
}

/**
 * Give every window that hosts a claude session a rail, without disturbing the
 * sessions themselves. Splitting only resizes the pane; the process is untouched.
 */
export function adoptAll({ width } = {}) {
  const panes = listPanes();
  const byWindow = new Map();
  for (const p of panes) {
    if (!byWindow.has(p.windowId)) byWindow.set(p.windowId, []);
    byWindow.get(p.windowId).push(p);
  }
  const added = [];
  const skipped = [];
  for (const [windowId, ps] of byWindow) {
    const hasClaude = ps.some((p) => p.command === 'claude' && !p.dead);
    if (!hasClaude) continue;
    if (ps.some((p) => p.isRail || /cc-rail.? rail/.test(p.startCommand))) { skipped.push(windowId); continue; }
    // An explicit adopt overrides an earlier `q` in that window.
    tmuxOk(['set-option', '-w', '-t', windowId, '@cc_rail_off', '0']);
    const target = ps.find((p) => p.command === 'claude').paneId;
    const id = addRail(target, width);
    if (id) added.push({ windowId, paneId: id });
  }
  return { added, skipped };
}

/** Open a new claude session in its own window, with a rail attached. */
export function openSession({ cwd, resume, name, session, extraArgs = [] }) {
  const parts = ['claude'];
  if (resume) parts.push('--resume', shq(resume));
  if (name) parts.push('--name', shq(name));
  // Flags pass through as-is; their values are quoted.
  for (const a of extraArgs) parts.push(a.startsWith('--') ? a : shq(a));
  const cmd = parts.join(' ');
  const paneId = newWindow({
    name: name || (cwd ? path.basename(cwd) : 'claude'),
    cwd,
    session,
    // `set -m` gives claude its own process group, so tmux reports the pane's
    // command as "claude" rather than the wrapper shell -- which is how the
    // collector finds it. The wrapper keeps the window alive if claude exits,
    // so an error stays readable.
    command: `set -m; ${cmd}; echo; echo '[session ended - press enter to close]'; read _`,
  });
  if (!paneId) return null;
  addRail(paneId);
  return paneId;
}
