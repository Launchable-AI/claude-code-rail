import { FOCUS, OVERVIEW, loadConfig, readJSON, writeJSON } from './paths.js';
import { focusPane, sessionNameOfPane, windowIdOfPane } from './tmux.js';

/**
 * Step to the next (+1) or previous (-1) claude session from the pane you are
 * in, in the same order the rail lists them, wrapping at either end. Run by
 * tmux from a root-table binding, so it works from any pane -- the claude one
 * included -- without focusing the rail first.
 */
export function step(delta, fromPane) {
  const pane = fromPane || process.env.TMUX_PANE || null;
  const mySession = pane ? sessionNameOfPane(pane) : null;
  const myWindowId = pane ? windowIdOfPane(pane) : null;
  const o = readJSON(OVERVIEW, null);
  // Same scope rule as the rail, so the keys walk exactly the list you see.
  const scope = process.env.CC_RAIL_SCOPE || loadConfig().scope || 'session';
  const all = (o && o.sessions) || [];
  const list = scope === 'global' || !mySession ? all : all.filter((s) => s.tmuxSession === mySession);
  if (!list.length) return null;

  const i = list.findIndex((s) => s.windowId === myWindowId);
  // From a window that is not a session (a plain shell), j lands on the
  // first one and k on the last, as if you had stepped onto the list.
  const at = i < 0 ? (delta > 0 ? -1 : list.length) : i;
  const s = list[(at + delta + list.length) % list.length];
  if (s.windowId === myWindowId) return s;

  focusPane(s.paneId, s.tmuxSession, mySession);
  // Tell the rails now rather than a collector tick from now, as a jump from
  // the rail does, so the destination highlight is right on arrival.
  const f = readJSON(FOCUS, null) || {};
  try {
    writeJSON(FOCUS, { at: Date.now(), active: { ...(f.active || {}), [s.tmuxSession]: s.windowId } });
  } catch { /* the collector will catch up */ }
  return s;
}
