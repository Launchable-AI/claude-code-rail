import fs from 'node:fs';
import { collect } from './collect.js';
import { loadIndex, drain } from './hooks.js';
import { setOption, renameWindow, getWindowOption, setWindowOption, activeWindows } from './tmux.js';
import { addRail, ensureTmuxSetup } from './session.js';
import { killPane, tmuxOk } from './tmux.js';
import { windowNameForWindow, isGenericWindowName } from './naming.js';
import { pollUsage } from './usage.js';
import {
  DAEMON_PID, FOCUS, OVERVIEW, STATE_DIR, ensureDirs, loadConfig, loadUI, readJSON, writeJSON,
} from './paths.js';
import path from 'node:path';

const PREV = path.join(STATE_DIR, 'prev.json');

export function daemonAlive() {
  const pid = Number(readJSON(DAEMON_PID, {})?.pid || 0);
  if (!pid) return 0;
  try { process.kill(pid, 0); return pid; } catch { return 0; }
}

// Only what needs you earns a place in the tmux status line; counts of ready
// or running sessions are always non-zero and so carry no news.
function statusSummary(counts) {
  if (counts.permission) return `#[bold]${counts.permission} blocked#[nobold]`;
  return '';
}

export async function runDaemon({ interval = 600, statusBar = true } = {}) {
  ensureDirs();
  const alive = daemonAlive();
  if (alive && alive !== process.pid) {
    process.stderr.write(`cc-rail daemon already running (pid ${alive})\n`);
    return;
  }
  writeJSON(DAEMON_PID, { pid: process.pid, at: Date.now() });

  const cfg = loadConfig();
  // `cc-rail statusbar off` is a standing choice, not a one-off: honour it
  // across restarts and new tmux servers.
  if (cfg.statusBar === false) statusBar = false;
  let { records } = loadIndex();

  // Restore status timestamps so a daemon restart does not reset every "for 4m".
  const prev = new Map();
  for (const [k, v] of Object.entries(readJSON(PREV, {}) || {})) prev.set(k, v);

  const adoptTried = new Map();
  let lastPersist = 0;
  let lastUsagePoll = 0;
  let lastBar = '';
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    // Only clear the pid file if it is still ours: a successor may already own it.
    try {
      if (Number(readJSON(DAEMON_PID, {})?.pid || 0) === process.pid) fs.unlinkSync(DAEMON_PID);
    } catch { /* already gone */ }
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  // Running as a service means outliving tmux itself: the collector starts at
  // boot and waits. There is nothing to collect until a server exists, so it
  // polls slowly until one does, and sets up the key binding and status line
  // when one appears -- those live in the tmux server and die with it.
  const IDLE_INTERVAL = 5000;
  let lastFocus = '';
  let tmuxWasUp = false;
  for (;;) {
    const t0 = Date.now();
    let idle = false;
    try {
      // Published first, and on its own, because a rail needs to know which
      // window is being looked at within a frame -- not once the rest of the
      // tick's capture-pane work has finished. Written only when it changes,
      // so a rail's watch fires on real switches and nothing else.
      const active = activeWindows();
      const tmuxUp = Object.keys(active).length > 0;
      if (tmuxUp && !tmuxWasUp) ensureTmuxSetup({ statusBar });
      tmuxWasUp = tmuxUp;
      if (!tmuxUp) { idle = true; continue; }

      const key = JSON.stringify(active);
      if (key !== lastFocus) {
        lastFocus = key;
        writeJSON(FOCUS, { at: Date.now(), active });
      }

      ({ records } = drain(records));
      const idx = loadIndexFrom(records);
      const overview = collect(prev, idx, cfg);
      for (const s of overview.sessions) {
        prev.set(s.key, {
          status: s.status, statusAt: s.statusAt, seenAt: s.seenAt,
          transcript: s.transcript, pid: s.pid, how: s.identified,
        });
      }
      // Drop bookkeeping for panes that no longer exist.
      const live = new Set(overview.sessions.map((s) => s.key));
      for (const k of [...prev.keys()]) if (!live.has(k)) prev.delete(k);

      pruneDuplicateRails(overview.rails, loadUI().width || cfg.railWidth);
      if (cfg.autoAdopt !== false) autoAdopt(overview.sessions, adoptTried);
      if (cfg.renameWindows !== 'off') applyWindowNames(overview.sessions, cfg.renameWindows);
      overview.daemon = { pid: process.pid, interval };
      writeJSON(OVERVIEW, overview);

      if (statusBar) {
        const bar = statusSummary(overview.counts);
        if (bar !== lastBar) {
          lastBar = bar;
          setOption('@cc_rail_summary', bar);
        }
      }
      if (t0 - lastPersist > 5000) {
        lastPersist = t0;
        writeJSON(PREV, Object.fromEntries(prev));
      }
      // Plan windows, if we have been asked to fetch them ourselves. Not
      // awaited: a slow or hanging request must not hold up a 600ms tick, and
      // there is nothing here for the tick to do with the answer. Only while
      // sessions exist -- an idle tmux left open overnight has nothing to poll
      // about.
      if (cfg.pollUsage && overview.sessions.length
          && t0 - lastUsagePoll > Math.max(60000, cfg.usagePollMs)) {
        lastUsagePoll = t0;
        pollUsage(overview.sessions.map((s) => s.accountConfig).filter(Boolean))
          .catch(() => { /* the rail keeps showing Claude Code's own cache */ });
      }
    } catch (err) {
      try { fs.appendFileSync(path.join(STATE_DIR, 'daemon.log'), `${new Date().toISOString()} ${err.stack || err}\n`); } catch {}
    } finally {
      // In the finally so that the tick that finds no tmux server -- which
      // leaves early -- still waits before the next one.
      const spent = Date.now() - t0;
      await new Promise((r) => setTimeout(r, Math.max(120, (idle ? IDLE_INTERVAL : interval) - spent)));
    }
  }
}

/**
 * One rail per window. Two adopters racing (a manual `cc-rail adopt` alongside the
 * collector) can each add one, so drop any extra rather than trusting that
 * never to happen.
 */
function pruneDuplicateRails(rails, width) {
  if (!rails || rails.length < 2) return;
  const keep = new Map();
  for (const r of rails) {
    if (!keep.has(r.windowId)) { keep.set(r.windowId, r.paneId); continue; }
    // tmux hands the dead pane's columns to its sibling, so put the rail back
    // to its configured width instead of leaving it double-sized.
    killPane(r.paneId);
    tmuxOk(['resize-pane', '-t', keep.get(r.windowId), '-x', String(width)]);
  }
}

/**
 * A session you started yourself is listed in the rail immediately, but its own
 * window has no rail until one is put there. Do it automatically, unless the
 * user closed the rail in that window -- pressing q is a decision, not an
 * accident, and it must not be undone a moment later.
 */
function autoAdopt(sessions, tried) {
  const now = Date.now();
  for (const s of sessions) {
    if (s.hasRail || !s.windowId || !s.paneId) continue;
    if (getWindowOption(s.windowId, '@cc_rail_off') === '1') continue;
    if (now - (tried.get(s.windowId) || 0) < 10000) continue;  // do not spam a failing split
    tried.set(s.windowId, now);
    addRail(s.paneId);
  }
}

/**
 * Improve a window name only when it carries no information ("ubuntu", "bash").
 * A name the user chose is never overwritten; a name cc-rail set is kept current
 * as the session's title settles, and cc-rail stops managing it the moment the
 * user renames it by hand.
 */
function applyWindowNames(sessions, mode) {
  // Per window, not per session: a window with two sessions in it has one name
  // to give, and deciding it twice a tick is what made the name flicker.
  const byWindow = new Map();
  for (const s of sessions) {
    if (!s.windowId) continue;
    if (!byWindow.has(s.windowId)) byWindow.set(s.windowId, []);
    byWindow.get(s.windowId).push(s);
  }

  for (const [windowId, group] of byWindow) {
    const windowName = group[0].windowName;   // one window, one current name
    const desired = windowNameForWindow(group);
    if (!desired || desired === windowName) continue;

    const ours = getWindowOption(windowId, '@cc_rail_named');
    const weOwnIt = ours && ours === windowName;
    // Uninformative against any of the sessions in there -- the cwd of the
    // second one is no more the window's subject than the first one's.
    const adoptable = !ours
      && (mode === 'always' || group.some((s) => isGenericWindowName(windowName, s)));
    if (!weOwnIt && !adoptable) continue;

    if (!getWindowOption(windowId, '@cc_rail_orig_name')) {
      setWindowOption(windowId, '@cc_rail_orig_name', windowName || '');
    }
    if (renameWindow(windowId, desired)) setWindowOption(windowId, '@cc_rail_named', desired);
  }
}

function loadIndexFrom(records) {
  const byPane = new Map();
  const bySession = new Map();
  for (const r of Object.values(records)) {
    if (r.session_id) bySession.set(r.session_id, r);
    if (r.paneId && !r.ended) byPane.set(r.paneId, r);
  }
  return { byPane, bySession };
}
