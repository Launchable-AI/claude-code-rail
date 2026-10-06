import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { spawn } from 'node:child_process';
import {
  CLAUDE_DIR, CONFIG, HOME, RAIL_DIR, OVERVIEW,
  ensureDirs, loadConfig, loadUI, saveUI, readJSON, writeJSON,
} from './paths.js';
import { polledUsage, pollUsage } from './usage.js';
import { runRail } from './rail.js';
import { runDaemon, daemonAlive } from './daemon.js';
import { adoptAll, bindNav, bindRecall, openSession, wireStatusBar, RAIL_BIN, railCommand } from './session.js';
import {
  listPanes, tmux, tmuxOk, setOption, insideTmux,
  renameWindow, getWindowOption, setWindowOption,
} from './tmux.js';

import { dur, tokens, modelShort } from './format.js';
import { STATUS, pickTheme } from './theme.js';
import { usageSnapshot } from './account.js';
import { step } from './nav.js';

const HOOK_EVENTS = [
  'SessionStart', 'SessionEnd', 'UserPromptSubmit',
  'PreToolUse', 'PostToolUse', 'Notification', 'Stop',
];

const USAGE = `cc-rail - a session rail for Claude Code

  cc-rail up [--width N]     attach rails to every claude window, start the daemon
  cc-rail rail               run the rail (this is what a rail pane runs)
  cc-rail daemon             run the collector in the foreground
  cc-rail adopt              add a rail to any claude window missing one
  cc-rail new [dir] [--session S]
                          open a new claude session in its own window
  cc-rail next|prev [pane]   focus the next / previous session (Alt-. / Alt-,)
  cc-rail status [--json]    print the current overview and exit
  cc-rail install            register the cc-rail hooks in Claude Code settings
  cc-rail uninstall          remove them again
  cc-rail doctor             check the installation
  cc-rail restart            restart the collector and reload every rail
                          (--collector-only to leave the rails alone)
  cc-rail down               stop the collector
  cc-rail theme light|dark|auto   set the palette for every rail, live
  cc-rail usage on|off|now   poll the plan limits instead of waiting for /usage
  cc-rail statusbar on|off   show the summary in the tmux status line
  cc-rail service install|uninstall|status
                          run the collector as a systemd user service
  cc-rail names restore      put every window name cc-rail changed back
`;

export async function main(argv) {
  const [cmd = 'up', ...rest] = argv;
  const flag = (name) => rest.includes('--' + name);
  const value = (name, dflt) => {
    const i = rest.indexOf('--' + name);
    return i >= 0 && rest[i + 1] ? rest[i + 1] : dflt;
  };

  switch (cmd) {
    case 'rail': return runRail();
    case 'daemon': return runDaemon({ statusBar: !flag('no-status-bar') });
    case 'up': return up({ width: Number(value('width', 0)) || undefined, statusBar: !flag('no-status-bar') });
    case 'adopt': { ensureDirs(); const r = adoptAll({}); console.log(`rails added: ${r.added.length}, already present: ${r.skipped.length}`); return; }
    case 'new': return newSession(rest, {
      session: value('session', undefined),
      model: value('model', undefined),
      name: value('name', undefined),
      permissionMode: value('permission-mode', undefined),
    });
    case 'next': step(1, rest[0]); return;
    case 'prev': step(-1, rest[0]); return;
    case 'status': return status({ json: flag('json') });
    case 'install': return install({ settings: value('settings', path.join(CLAUDE_DIR, 'settings.json')), dry: flag('dry-run') });
    case 'uninstall': return uninstall({ settings: value('settings', path.join(CLAUDE_DIR, 'settings.json')) });
    case 'doctor': return doctor();
    case 'down': return down();
    case 'restart': {
      // Stop first, replace the rails, then start: with the collector running,
      // its auto-adopt and this adopt would both add a rail to the same window.
      down({ quiet: true });
      if (!flag('collector-only')) { reloadRails(); if (insideTmux()) { bindRecall(); bindNav(); } }
      startDaemon();
      execFileSync('sleep', ['1']);
      console.log(daemonAlive() ? 'collector restarted' : 'collector failed to start - see ~/.cc-rail/state/daemon.log');
      return;
    }
    case 'theme': return theme(rest[0]);
    case 'usage': return usage(rest[0]);
    case 'statusbar': return statusbar(rest[0]);
    case 'service': return service(rest[0]);
    case 'names': return names(rest[0]);
    case 'help': case '--help': case '-h': console.log(USAGE); return;
    default:
      console.error(`cc-rail: unknown command "${cmd}"\n`);
      console.log(USAGE);
      process.exitCode = 2;
  }
}

/**
 * Rails are separate processes, so new cc-rail code does not reach them until the
 * panes are replaced. Killing a rail leaves its session pane untouched.
 */
function reloadRails() {
  const rails = listPanes().filter((p) => p.isRail);
  for (const p of rails) tmuxOk(['kill-pane', '-t', p.paneId]);
  execFileSync('sleep', ['0.3']);
  const r = adoptAll({});
  console.log(`rails reloaded: ${r.added.length}`);
}

function down({ quiet = false } = {}) {
  const pid = daemonAlive();
  if (!pid) { if (!quiet) console.log('collector not running'); return; }
  // Ask systemd first when the unit owns the collector -- signalling the
  // process behind its back would just make it restart it. A collector
  // started by hand before the unit existed answers to the signal below
  // instead, so check the pid again either way.
  const viaSystemd = serviceInstalled() && systemctl(['stop', UNIT]).ok;
  if (daemonAlive()) {
    try { process.kill(pid, 'SIGTERM'); } catch { /* it went on its own */ }
  }
  // Wait for it to actually go, otherwise a successor sees a live pid and bails.
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    try { process.kill(pid, 0); } catch { break; }
    execFileSync('sleep', ['0.05']);
  }
  if (!quiet) console.log(`stopped collector (pid ${pid}${viaSystemd ? ', via systemd' : ''})`);
}

/**
 * bin/cc-rail is a POSIX shell script and cannot find an nvm-managed node on the
 * bare PATH a tmux pane inherits. Record the interpreter we are running under,
 * so rails and the daemon launch with the same node. Machine-specific, so it is
 * gitignored and rewritten on each setup.
 */
function ensureNodePath() {
  const file = path.join(path.dirname(RAIL_BIN), '..', '.nodepath');
  try {
    const cur = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim() : '';
    if (cur !== process.execPath) fs.writeFileSync(file, process.execPath + '\n');
  } catch { /* read-only checkout; the PATH fallback still applies */ }
}

/**
 * Whose collector is it? Once the unit exists, systemd owns starting and
 * stopping it -- spawning our own alongside would leave an orphan running
 * while `systemctl status` reported the service dead.
 */
function serviceInstalled() {
  return fs.existsSync(path.join(UNIT_DIR, UNIT));
}

function startDaemon() {
  if (daemonAlive()) return false;
  if (serviceInstalled()) { systemctl(['start', UNIT]); return true; }
  spawn(RAIL_BIN, ['daemon'], { detached: true, stdio: 'ignore' }).unref();
  return true;
}

async function up({ width, statusBar }) {
  ensureDirs();
  ensureNodePath();
  if (!insideTmux() && !process.env.CC_RAIL_ALLOW_OUTSIDE) {
    console.error('cc-rail up must be run inside tmux (that is where the sessions live)');
    process.exitCode = 1;
    return;
  }
  const started = startDaemon();
  const claude = listPanes().filter((p) => p.command === 'claude' && !p.dead);
  if (!claude.length) {
    console.log('no claude sessions yet - opening one');
    openSession({ cwd: process.cwd() });
  } else {
    const r = adoptAll({ width });
    console.log(`rails added: ${r.added.length}, already present: ${r.skipped.length}`);
  }
  if (statusBar && loadConfig().statusBar !== false) wireStatusBar();
  const key = insideTmux() ? bindRecall() : null;
  const nav = insideTmux() ? bindNav() : [];
  if (started) console.log('collector started');
  console.log('rail keys: ↵ go · tab next · r resume · i detail · ? all keys');
  if (key) console.log(`tmux: prefix ${key} brings back a rail you hid with q`);
  if (nav.length) console.log(`tmux: ${nav.join(' / ')} step to the next / previous session from any pane`);
}

const FLAGS_WITH_VALUES = new Set(['--session', '--model', '--name', '--permission-mode']);

function newSession(rest, opts = {}) {
  const dir = rest.find((a, i) => !a.startsWith('--') && !FLAGS_WITH_VALUES.has(rest[i - 1])) || process.cwd();
  if (!fs.existsSync(dir)) { console.error(`no such directory: ${dir}`); process.exitCode = 1; return; }
  const extraArgs = [];
  if (opts.model) extraArgs.push('--model', opts.model);
  if (opts.permissionMode) extraArgs.push('--permission-mode', opts.permissionMode);
  const id = openSession({
    cwd: path.resolve(dir), session: opts.session, name: opts.name, extraArgs,
  });
  console.log(id ? `opened ${id}` : 'failed to open a window');
}

function status({ json }) {
  const o = readJSON(OVERVIEW, null);
  if (!o) { console.error('no overview yet - is the daemon running? (cc-rail up)'); process.exitCode = 1; return; }
  if (json) { console.log(JSON.stringify(o, null, 2)); return; }
  const age = Date.now() - o.at;
  if (age > 5000) console.log(`(overview is ${dur(age)} old - daemon may be stopped)`);
  const c = o.counts;
  console.log(`${c.total} sessions - ${c.working} working, ${c.yourturn} ready, ${c.permission} blocked, ${c.idle} idle`);
  for (const s of o.sessions) {
    const label = (STATUS[s.status] || {}).label || s.status;
    const act = s.activity ? ` ${s.activity.name} ${s.activity.arg || ''}`.trimEnd() : '';
    console.log(
      `  ${String(s.windowIndex).padStart(2)}  ${label.padEnd(10)} ${dur(s.sinceMs).padStart(5)}  `
      + `${(s.title || '').slice(0, 38).padEnd(40)}${s.project.padEnd(16)}`
      + `${modelShort(s.model).padEnd(10)}${tokens(s.contextTokens).padStart(6)}${act}`,
    );
  }
}


function RAIL_DIR_BIN() {
  return path.join(path.dirname(RAIL_BIN), 'cc-rail-hook');
}

function install({ settings, dry }) {
  ensureDirs();
  ensureNodePath();
  const hookBin = RAIL_DIR_BIN();
  if (!fs.existsSync(hookBin)) { console.error(`missing ${hookBin}`); process.exitCode = 1; return; }

  const cur = readJSON(settings, {}) || {};
  const next = structuredClone(cur);
  next.hooks = next.hooks || {};
  let added = 0;
  for (const ev of HOOK_EVENTS) {
    const cmd = `${hookBin} ${ev}`;
    const matchers = next.hooks[ev] || [];
    const already = matchers.some((m) => (m.hooks || []).some((h) => (h.command || '').includes('cc-rail-hook')));
    if (already) continue;
    matchers.push({ hooks: [{ type: 'command', command: cmd, timeout: 5 }] });
    next.hooks[ev] = matchers;
    added += 1;
  }
  if (!added) { console.log('cc-rail hooks already installed'); return; }
  if (dry) { console.log(JSON.stringify(next.hooks, null, 2)); return; }

  const backup = path.join(RAIL_DIR, `settings.backup.${Date.now()}.json`);
  if (fs.existsSync(settings)) fs.copyFileSync(settings, backup);
  writeJSON(settings, next);
  // Keep the file readable for a human.
  fs.writeFileSync(settings, JSON.stringify(next, null, 2) + '\n');
  console.log(`installed ${added} hooks into ${settings}`);
  if (fs.existsSync(backup)) console.log(`backup: ${backup}`);
  console.log('sessions started before now keep their old hooks until they restart.');
}

function uninstall({ settings }) {
  const cur = readJSON(settings, null);
  if (!cur || !cur.hooks) { console.log('nothing to remove'); return; }
  let removed = 0;
  for (const ev of Object.keys(cur.hooks)) {
    const kept = (cur.hooks[ev] || []).filter((m) => {
      const hit = (m.hooks || []).some((h) => (h.command || '').includes('cc-rail-hook'));
      if (hit) removed += 1;
      return !hit;
    });
    if (kept.length) cur.hooks[ev] = kept; else delete cur.hooks[ev];
  }
  if (!Object.keys(cur.hooks).length) delete cur.hooks;
  fs.writeFileSync(settings, JSON.stringify(cur, null, 2) + '\n');
  console.log(`removed ${removed} cc-rail hooks from ${settings}`);
  // Give the key back, but only if it is still ours to give.
  const key = tmuxGet('@cc_rail_key');
  if (key) {
    let bound = '';
    try { bound = tmux(['list-keys', '-T', 'prefix', key]); } catch { bound = ''; }
    if (/cc-rail/.test(bound)) tmuxOk(['unbind-key', '-T', 'prefix', key]);
    setOption('@cc_rail_key', '');
    console.log(`unbound prefix ${key}`);
  }
  for (const k of tmuxGet('@cc_rail_nav_keys').split(' ').filter(Boolean)) {
    let bound = '';
    try { bound = tmux(['list-keys', '-T', 'root', k]); } catch { bound = ''; }
    if (/cc-rail/.test(bound)) { tmuxOk(['unbind-key', '-T', 'root', k]); console.log(`unbound ${k}`); }
  }
  setOption('@cc_rail_nav_keys', '');
}

/**
 * Pin the palette for every rail at once. Written to the shared view state,
 * which each rail is watching, so they repaint where they stand -- restarting
 * them would lose whatever each one was showing.
 */
function theme(mode) {
  if (!['light', 'dark', 'auto'].includes(mode)) {
    const cur = loadUI().theme || loadConfig().theme;
    console.log(`usage: cc-rail theme light|dark|auto   (currently ${cur})`);
    return;
  }
  ensureDirs();
  // Config is the default for rails started later; the shared state is what
  // the running ones read.
  const cfg = readJSON(CONFIG, {}) || {};
  cfg.theme = mode;
  writeJSON(CONFIG, cfg);
  saveUI({ theme: mode });
  console.log(`theme: ${mode} (every rail)`);
}

/**
 * Whether the collector fetches the plan windows itself. Off by default
 * because it reads the stored OAuth token and calls an endpoint Anthropic does
 * not document -- worth opting into, not worth doing behind your back.
 */
async function usage(mode) {
  const cfg = loadConfig();
  const KEY = path.join(HOME, '.claude.json');
  if (mode === 'now') {
    // One poll, in the foreground, saying what happened: the endpoint is
    // undocumented, so 'it stopped working' needs somewhere to show itself.
    ensureDirs();
    const rec = (await pollUsage([]))[KEY] || {};
    if (rec.error) console.log(`usage poll failed: ${rec.error}`);
    else {
      const snap = usageSnapshot();
      console.log(`usage polled: ${snap ? snap.rows.map((r) => `${r.label} ${r.pct}%`).join(', ') : 'no windows'}`);
    }
    return;
  }
  if (mode !== 'on' && mode !== 'off') {
    const rec = polledUsage()[KEY] || {};
    console.log(`usage polling: ${cfg.pollUsage ? 'on' : 'off'} (cc-rail usage on|off)`);
    if (rec.fetchedAtMs) console.log(`  last reading: ${new Date(rec.fetchedAtMs).toLocaleTimeString()}`);
    if (rec.error) console.log(`  last error:   ${rec.error}`);
    return;
  }
  ensureDirs();
  const raw = readJSON(CONFIG, {}) || {};
  raw.pollUsage = mode === 'on';
  writeJSON(CONFIG, raw);
  console.log(mode === 'on'
    ? `usage polling: on (every ${Math.round(Math.max(60000, cfg.usagePollMs) / 60000)}m, while sessions are open)`
    : 'usage polling: off (the rail follows Claude Code\'s own cache again)');
  if (daemonAlive()) console.log('run `cc-rail restart --collector-only` to pick it up now');
}

function statusbar(mode) {
  if (mode === 'on' || mode === 'off') {
    writeJSON(CONFIG, { ...(readJSON(CONFIG, {}) || {}), statusBar: mode === 'on' });
  }
  if (mode === 'off') {
    const saved = tmuxGet('@cc_rail_saved_status_right');
    if (saved) setOption('status-right', saved);
    setOption('@cc_rail_summary', '');
    console.log('status bar restored');
    return;
  }
  wireStatusBar();
}

// --------------------------------------------------------------- as a service
// The collector is a background process with no terminal, so it belongs to the
// init system rather than to whichever shell happened to start it. A user unit
// (not a system one) because everything it touches -- the tmux server, the
// transcripts, the config -- belongs to one user.
const UNIT = 'cc-rail.service';
const UNIT_DIR = path.join(HOME, '.config', 'systemd', 'user');

function systemctl(args, { check = false } = {}) {
  try {
    return { ok: true, out: execFileSync('systemctl', ['--user', ...args], { encoding: 'utf8' }).trim() };
  } catch (err) {
    // is-enabled and friends exit non-zero to answer the question, not to fail.
    const out = String((err.stdout || '') + (err.stderr || '')).trim();
    if (!check) return { ok: false, out };
    throw new Error(out || `systemctl --user ${args.join(' ')} failed`);
  }
}

function unitFile() {
  return `[Unit]
Description=cc-rail collector for Claude Code sessions
Documentation=https://github.com/Launchable-AI/claude-code-rail

[Service]
Type=simple
# The launcher looks here first, so an nvm node is found without a login shell.
Environment=CC_RAIL_NODE=${process.execPath}
ExecStart=${RAIL_BIN} daemon
# A clean exit is deliberate -- \`cc-rail down\`, or another collector already
# holding the pid file -- so only a crash is worth restarting.
Restart=on-failure
RestartSec=5s
Nice=5

[Install]
WantedBy=default.target
`;
}

function lingerOn() {
  try {
    return /yes/i.test(execFileSync('loginctl', ['show-user', os.userInfo().username, '-p', 'Linger'], { encoding: 'utf8' }));
  } catch { return false; }
}

function service(mode) {
  if (mode === 'install') {
    // Hand over cleanly, and before the unit file exists: a collector started
    // by hand would otherwise keep the pid file and the service would exit as
    // a duplicate. (`down` routes through systemd once the unit is there, and
    // systemd does not know it yet.)
    if (daemonAlive()) down({ quiet: true });
    fs.mkdirSync(UNIT_DIR, { recursive: true });
    fs.writeFileSync(path.join(UNIT_DIR, UNIT), unitFile());
    ensureNodePath();
    systemctl(['daemon-reload'], { check: true });
    systemctl(['enable', '--now', UNIT], { check: true });
    console.log(`installed ${path.join(UNIT_DIR, UNIT)}`);
    console.log(`collector: ${systemctl(['is-active', UNIT]).out} (starts again at login)`);
    if (!lingerOn()) {
      console.log('to start it at boot rather than at login:');
      console.log(`  sudo loginctl enable-linger ${os.userInfo().username}`);
    }
    return;
  }
  if (mode === 'uninstall') {
    systemctl(['disable', '--now', UNIT]);
    const file = path.join(UNIT_DIR, UNIT);
    try { fs.unlinkSync(file); } catch { /* already gone */ }
    systemctl(['daemon-reload']);
    console.log(`removed ${file}`);
    return;
  }
  const installed = fs.existsSync(path.join(UNIT_DIR, UNIT));
  console.log(`service:   ${installed ? `${systemctl(['is-enabled', UNIT]).out}, ${systemctl(['is-active', UNIT]).out}` : 'not installed (cc-rail service install)'}`);
  console.log(`at boot:   ${lingerOn() ? 'yes' : 'no - only from your first login (loginctl enable-linger)'}`);
  const pid = daemonAlive();
  console.log(`collector: ${pid ? `running (pid ${pid})` : 'not running'}`);
}

/** Undo window renames, restoring whatever the window was called before. */
function names(mode) {
  if (mode !== 'restore') { console.log('usage: cc-rail names restore'); return; }
  let n = 0;
  for (const w of new Set(listPanes().map((p) => p.windowId))) {
    const orig = getWindowOption(w, '@cc_rail_orig_name');
    if (!getWindowOption(w, '@cc_rail_named')) continue;
    if (orig) renameWindow(w, orig);
    setWindowOption(w, '@cc_rail_named', '');
    setWindowOption(w, '@cc_rail_orig_name', '');
    n += 1;
  }
  console.log(`restored ${n} window name(s)`);
}

function tmuxGet(name) {
  try { return tmux(['show-options', '-gqv', name]).trim(); } catch { return ''; }
}

function doctor() {
  const cfg = loadConfig();
  const rows = [];
  const ok = (label, good, detail) => rows.push([good ? 'ok  ' : 'FAIL', label, detail || '']);

  ok('tmux available', tmuxOk(['-V']), '');
  ok('inside tmux', insideTmux(), process.env.TMUX ? '' : 'run cc-rail from a tmux pane');
  const pid = daemonAlive();
  ok('collector running', Boolean(pid), pid ? `pid ${pid}` : 'start with: cc-rail up');
  const o = readJSON(OVERVIEW, null);
  ok('overview fresh', Boolean(o) && Date.now() - o.at < 10000, o ? `${dur(Date.now() - o.at)} old` : 'never written');

  const settings = readJSON(path.join(CLAUDE_DIR, 'settings.json'), {}) || {};
  const installed = Object.values(settings.hooks || {})
    .flat()
    .some((m) => (m.hooks || []).some((h) => (h.command || '').includes('cc-rail-hook')));
  ok('hooks installed', installed, installed ? '' : 'run: cc-rail install  (identity falls back to inference without them)');

  const panes = listPanes();
  const claude = panes.filter((p) => p.command === 'claude' && !p.dead);
  const railed = new Set(panes.filter((p) => p.isRail).map((p) => p.windowId));
  const missing = claude.filter((p) => !railed.has(p.windowId));
  ok('rails attached', missing.length === 0, missing.length ? `${missing.length} window(s) without a rail - run: cc-rail adopt` : `${claude.length} session(s)`);

  if (o) {
    const guessed = o.sessions.filter((s) => s.identified === 'guess' || s.identified === 'none');
    ok('sessions identified', guessed.length === 0, guessed.length ? `${guessed.length} inferred by guess` : '');
  }
  ok('rail command', fs.existsSync(RAIL_BIN), railCommand());
  // 'auto' resolves differently per terminal, so say which palette it landed on.
  const pref = loadUI().theme || cfg.theme;
  const resolved = pickTheme(pref) === pickTheme('light') ? 'light' : 'dark';
  ok('theme', true, pref === 'auto' ? `auto -> ${resolved} (each rail probes its terminal)` : pref);

  const u = usageSnapshot();
  ok('plan usage', Boolean(u), u
    ? `${u.rows.map((r) => `${r.label} ${r.pct}%`).join(', ')} (${dur(Date.now() - u.at)} old)`
    : 'no reading yet - Claude Code caches one when a session opens /usage');
  // The reading above is only ever as fresh as its source, and Claude Code's
  // source refills on /usage alone, so say which one it came from.
  const poll = polledUsage()[path.join(HOME, '.claude.json')] || {};
  ok('usage polling', !cfg.pollUsage || !poll.error,
    !cfg.pollUsage ? 'off - readings come from Claude Code, which refreshes them on /usage'
      : poll.error ? `on, but failing: ${poll.error}`
        : `on - polled ${dur(Date.now() - poll.fetchedAtMs)} ago`);

  for (const [state, label, detail] of rows) console.log(`${state} ${label}${detail ? '  -  ' + detail : ''}`);
  if (rows.some((r) => r[0] !== 'ok  ')) process.exitCode = 1;
}

main(process.argv.slice(2)).catch((err) => {
  console.error(err && err.stack ? err.stack : String(err));
  process.exit(1);
});
