import { spawnSync } from 'node:child_process';

// U+241F (visible 'unit separator' glyph): a delimiter that never occurs in titles or paths.
// NB: a raw 0x1f control byte does NOT survive tmux -F -- tmux re-escapes it to the literal text \037.
const SEP = '\u241F';

export function tmux(args) {
  const r = spawnSync('tmux', args, { encoding: 'utf8', maxBuffer: 8 << 20 });
  if (r.status !== 0) throw new Error(`tmux ${args.join(' ')} failed: ${(r.stderr || '').trim()}`);
  return r.stdout;
}

export function tmuxOk(args) {
  return spawnSync('tmux', args, { encoding: 'utf8' }).status === 0;
}

export function insideTmux() {
  return Boolean(process.env.TMUX);
}

const PANE_FIELDS = [
  'session_name', 'window_id', 'window_index', 'window_name', 'window_active',
  'pane_id', 'pane_index', 'pane_pid', 'pane_active', 'pane_current_command',
  'pane_current_path', 'pane_title', 'pane_width', 'pane_height', 'pane_dead',
  'window_activity', 'pane_start_command', '@cc_rail_pane',
];

/** One tmux call for the whole world; called once per collector tick. */
export function listPanes() {
  const fmt = PANE_FIELDS.map((f) => '#{' + f + '}').join(SEP);
  let out;
  try { out = tmux(['list-panes', '-a', '-F', fmt]); } catch { return []; }
  return out.split('\n').filter(Boolean).map((line) => {
    const parts = line.split(SEP);
    const o = {};
    PANE_FIELDS.forEach((f, i) => { o[f] = parts[i]; });
    return {
      session: o.session_name,
      windowId: o.window_id,
      windowIndex: Number(o.window_index),
      windowName: o.window_name,
      windowActive: o.window_active === '1',
      paneId: o.pane_id,
      paneIndex: Number(o.pane_index),
      panePid: Number(o.pane_pid),
      paneActive: o.pane_active === '1',
      command: o.pane_current_command,
      cwd: o.pane_current_path,
      title: o.pane_title || '',
      width: Number(o.pane_width),
      height: Number(o.pane_height),
      dead: o.pane_dead === '1',
      activityAt: Number(o.window_activity) * 1000 || 0,
      startCommand: o.pane_start_command || '',
      isRail: o['@cc_rail_pane'] === '1',
    };
  });
}

/** Visible region only -- scrollback is history, not current state. */
export function capturePane(paneId) {
  try { return tmux(['capture-pane', '-p', '-t', paneId]); } catch { return ''; }
}

/** 'light' | 'dark' as tmux (>= 3.6) last heard from the client viewing this pane, else null. */
export function clientTheme(paneId) {
  const r = spawnSync('tmux', ['display', '-p', ...(paneId ? ['-t', paneId] : []), '#{client_theme}'], { encoding: 'utf8' });
  const v = (r.stdout || '').trim();
  return v === 'light' || v === 'dark' ? v : null;
}

export function currentPaneId() { return process.env.TMUX_PANE || null; }

/**
 * Focus a pane. `select-window` only sets the current window *within* the
 * target's own tmux session -- it does not move an attached client. Crossing
 * tmux sessions additionally needs switch-client.
 */
export function focusPane(paneId, targetSession, mySession) {
  tmuxOk(['select-window', '-t', paneId]);
  tmuxOk(['select-pane', '-t', paneId]);
  if (targetSession && mySession && targetSession !== mySession) {
    tmuxOk(['switch-client', '-t', targetSession + ':']);
  }
}

/** The tmux window a given pane belongs to. */
export function windowIdOfPane(paneId) {
  try { return tmux(['display-message', '-p', '-t', paneId, '#{window_id}']).trim(); } catch { return null; }
}

/** The tmux session a given pane belongs to. */
export function sessionNameOfPane(paneId) {
  try { return tmux(['display-message', '-p', '-t', paneId, '#{session_name}']).trim(); } catch { return null; }
}

/** A user option's value, or '' when it was never set. */
export function getOption(name, global = true) {
  try { return tmux(['show-options', ...(global ? ['-g'] : []), '-qv', name]).trim(); }
  catch { return ''; }
}

export function setOption(name, value, global = true) {
  tmuxOk(['set-option', ...(global ? ['-g'] : []), name, value]);
}

export function displayMessage(msg) { tmuxOk(['display-message', msg]); }

export function currentSessionName() {
  try { return tmux(['display-message', '-p', '#{session_name}']).trim(); } catch { return null; }
}

export function newWindow({ name, cwd, command, session }) {
  const args = ['new-window', '-P', '-F', '#{pane_id}'];
  if (session) args.push('-t', session + ':');
  if (name) args.push('-n', name);
  if (cwd) args.push('-c', cwd);
  if (command) args.push(command);
  try { return tmux(args).trim(); } catch { return null; }
}

export function splitRail({ target, width, command }) {
  // -d: leave the cursor where it was. A rail arrives while you are typing in
  // a session you just started, and tmux would otherwise hand it the focus --
  // so your next keystroke lands in a status view instead of in claude.
  const args = ['split-window', '-d', '-h', '-b', '-l', String(width), '-P', '-F', '#{pane_id}', '-t', target, command];
  try { return tmux(args).trim(); } catch { return null; }
}

export function killPane(paneId) { tmuxOk(['kill-pane', '-t', paneId]); }
export function sendKeys(paneId, keys) { tmuxOk(['send-keys', '-t', paneId, ...keys]); }

/** Mark a pane as a rail so we never mistake it for a session pane. */
export function markRail(paneId) {
  tmuxOk(['set-option', '-p', '-t', paneId, '@cc_rail_pane', '1']);
}

export function renameWindow(windowId, name) {
  // rename-window also turns automatic-rename off for that window, so the name sticks.
  return tmuxOk(['rename-window', '-t', windowId, name]);
}

export function getWindowOption(windowId, name) {
  try { return tmux(['show-options', '-wqv', '-t', windowId, name]).trim(); } catch { return ''; }
}

export function setWindowOption(windowId, name, value) {
  tmuxOk(['set-option', '-w', '-t', windowId, name, value]);
}

/**
 * The active window of every tmux session, as a session -> window id map.
 * One cheap call, and the answer a rail needs to know whether it is the one
 * being looked at right now.
 */
export function activeWindows() {
  const out = {};
  let raw;
  try { raw = tmux(['list-windows', '-a', '-F', ['#{session_name}', '#{window_id}', '#{window_active}'].join(SEP)]); } catch { return out; }
  for (const line of raw.split('\n')) {
    if (!line) continue;
    const [session, windowId, active] = line.split(SEP);
    if (active === '1') out[session] = windowId;
  }
  return out;
}
