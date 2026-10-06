import fs from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import {
  alt, at, bg, bold, clampAnsi, clearLine, cursor, fg, fit, mouse, probeBackground, reset, themeReports, truncate, width,
} from './ansi.js';
import { pickTheme, STATUS, SPINNER, FEED } from './theme.js';
import { dur, tokens, modelShort, wrap } from './format.js';
import { usageSnapshot, accountShort } from './account.js';
import { FOCUS, OVERVIEW, STATE_DIR, loadConfig, loadUI, saveUI, readJSON, writeJSON } from './paths.js';
import { clientTheme, currentPaneId, focusPane, getOption, markRail, sessionNameOfPane, windowIdOfPane, tmuxOk } from './tmux.js';
import { openSession, RAIL_BIN } from './session.js';
import { recentSessions } from './transcript.js';
import { daemonAlive } from './daemon.js';
import { decodeKeys } from './keys.js';
import { cpuSampler, diskPercent, memPercent } from './sysstat.js';

// Ordered by how much a key needs advertising, not by how often it is used:
// hintLine drops from the end when the rail is narrow, so whatever nobody would
// guess is there has to come first. 'r' opens a picker of past sessions that is
// otherwise invisible.
const HINTS = [['↵', 'go'], ['tab', 'next'], ['r', 'resume'], ['i', 'detail'], ['?', 'keys']];

const DETAIL_MODES = ['off', 'one', 'all'];

/** The detail mode the last rail to change it chose, shared by all of them. */
function savedDetail() {
  const d = loadUI().detail;
  return DETAIL_MODES.includes(d) ? d : null;
}

/** How to get this rail back, in the words of whatever is actually bound. */
function recallHint() {
  const key = getOption('@cc_rail_key');
  return key
    ? `rail hidden - prefix ${key} brings it back`
    : 'rail hidden - `cc-rail adopt` brings it back';
}

// Claude Code fetches the plan windows only when you open /usage, and it
// distrusts its own cache after an hour -- so past that the rail is reading a
// reading, and says so rather than dressing it up as the current number.
const USAGE_STALE_MS = 3600 * 1000;

/** How old a reading is, coarsely: past the first hour the minutes are noise. */
function ageTag(ms) {
  const h = Math.floor(ms / 3600000);
  if (h >= 24) return Math.floor(h / 24) + 'd old';
  if (h >= 1) return h + 'h old';
  return Math.max(1, Math.round(ms / 60000)) + 'm old';
}

const THEMES = ['auto', 'light', 'dark'];

/** Likewise the palette: one terminal, so one answer for every rail in it. */
function savedTheme() {
  const t = loadUI().theme;
  return THEMES.includes(t) ? t : null;
}

const HELP = [
  ['j k  ↑ ↓', 'move'],
  ['gg  G', 'top / bottom'],
  ['↵  or  l', 'go to session'],
  ['1 - 9', 'go by number'],
  ['tab', 'next needing you'],
  ['i', 'detail: off / one / all'],
  ['w', 'widen / narrow rail'],
  ['t', 'auto / light / dark'],
  ['d', 'session facts'],
  ['n', 'new session here'],
  ['N', 'new session in…'],
  ['r', 'resume a session'],
  ['x', 'close session'],
  ['a', 'add rails to all'],
  ['click', 'go to that session'],
  ['wheel', 'browse without going'],
  ['q', 'hide this rail'],
];

export async function runRail() {
  if (!process.env.TMUX) {
    process.stderr.write('cc-rail must run inside tmux\n');
    process.exit(1);
  }
  const cfg = loadConfig();
  // Ask this terminal what colour it actually is before drawing on it. Every
  // other signal is a guess about someone else's terminal. Kept, rather than
  // used and discarded, so switching back to auto later needs no second probe
  // -- one mid-flight would land in the key stream of a running rail.
  // A rail started while no client is attached gets no answer to the probe, so
  // tmux's own record of the client's theme (3.6+) stands in for it; after that
  // the terminal's theme reports, and a slow poll of that record, keep it current.
  let probed = await probeBackground() || clientTheme(currentPaneId());
  let themePref = savedTheme() || cfg.theme || 'auto';
  let theme = pickTheme(themePref, probed);
  // Recessive text is dimmed on a dark background and simply greyer on a light
  // one, where dim would push it under the readability floor.
  let soft = theme.soft;
  const self = currentPaneId();
  if (self) markRail(self);
  // The rail belongs to one tmux session; by default it shows that session's
  // work only. CC_RAIL_SCOPE=global shows every claude session on the machine.
  const mySession = self ? sessionNameOfPane(self) : null;
  // A rail belongs to one window, and that window hosts exactly one session.
  // Anchoring to it is what keeps the rail and the tmux window tabs agreeing.
  const myWindowId = self ? windowIdOfPane(self) : null;
  const scope = process.env.CC_RAIL_SCOPE || cfg.scope || 'session';
  ensureDaemon();

  const out = process.stdout;
  const ui = {
    mode: 'list', // list | detail | help | confirm | prompt | resume
    cursorKey: null,
    scroll: 0,
    scrollLine: 0,
    // How much of each session's recent output to show: nothing, the selected
    // session's, or every session's at once. Shared by every rail -- it is a
    // view of the same thing, so moving between windows must not change it.
    detailMode: savedDetail() || (DETAIL_MODES.includes(cfg.detail) ? cfg.detail : 'off'),
    frame: 0,
    message: null,
    messageAt: 0,
    input: '',
    inputLabel: '',
    onSubmit: null,
    confirm: null,
    resumeRows: [],
    resumeIdx: 0,
    lineMap: [],        // body line -> what that line belongs to
    lineMapKind: 'list',
    usage: [],
    sys: null,
    tags: new Map(),
    focus: readJSON(FOCUS, null),
    overview: readJSON(OVERVIEW, { sessions: [], counts: {} }),
  };
  let prevLines = [];
  // Anything on the machine can write to a pane's tty -- wall(1) is the common
  // one -- and a row diff leaves that text sitting there until the rows it
  // landed on happen to change. Repaint everything periodically so the rail
  // heals itself instead of staying corrupted.
  const REPAINT_MS = 5000;
  let lastFull = 0;
  // And ask not to be written to in the first place. wall(1) skips a terminal
  // whose messages are off unless it is run by root, so this stops the ones
  // that come from us.
  try { execFileSync('mesg', ['n'], { stdio: ['inherit', 'ignore', 'ignore'] }); }
  catch { /* no mesg, or stdin is not a tty: the repaint still cleans up */ }

  const cleanup = () => {
    out.write(reset + themeReports.off + mouse.off + alt.off + cursor.show);
    try { process.stdin.setRawMode(false); } catch { /* not a tty */ }
  };
  const quit = (code = 0) => { cleanup(); process.exit(code); };

  function ensureDaemon() {
    if (daemonAlive()) return;
    spawn(RAIL_BIN, ['daemon'], { detached: true, stdio: 'ignore' }).unref();
  }

  const sessions = () => {
    const all = ui.overview.sessions || [];
    if (scope === 'global' || !mySession) return all;
    return all.filter((s) => s.tmuxSession === mySession);
  };
  const here = () => sessions().find((s) => s.windowId === myWindowId) || null;
  const multiSession = () => new Set((ui.overview.sessions || []).map((s) => s.tmuxSession)).size > 1;
  // Which account a session runs as is only worth a column when they differ.
  const multiAccount = () => new Set((ui.overview.sessions || [])
    .map((s) => s.account).filter(Boolean)).size > 1;
  const selected = () => {
    const list = sessions();
    if (!list.length) return null;
    return list.find((s) => s.key === ui.cursorKey) || list[0];
  };

  function moveCursor(delta) {
    const list = sessions();
    if (!list.length) return;
    const i = Math.max(0, list.findIndex((s) => s.key === ui.cursorKey));
    ui.cursorKey = list[Math.min(list.length - 1, Math.max(0, i + delta))].key;
  }

  const note = (msg) => { ui.message = msg; ui.messageAt = Date.now(); };

  const TAG_MAX = 10;

  /**
   * A short name per account, only as long as it needs to be to tell them
   * apart: the local part normally, the domain when two accounts share one.
   */
  function accountTags() {
    const emails = [...new Set((ui.overview.sessions || []).map((s) => s.account).filter(Boolean))];
    const count = new Map();
    for (const e of emails) {
      const t = accountShort(e);
      count.set(t, (count.get(t) || 0) + 1);
    }
    const out = new Map();
    for (const e of emails) {
      const t = accountShort(e);
      out.set(e, truncate(count.get(t) > 1 ? (e.split('@')[1] || e) : t, TAG_MAX));
    }
    return out;
  }

  /**
   * Each signed-in account keeps its own plan usage in its own config file, so
   * read one per account actually in use rather than only the default one. A
   * session on a bare API key has no plan window and contributes nothing.
   */
  function readUsage() {
    const tags = accountTags();
    const byConfig = new Map();
    for (const s of ui.overview.sessions || []) {
      if (!s.accountConfig || byConfig.has(s.accountConfig)) continue;
      byConfig.set(s.accountConfig, tags.get(s.account) || 'account');
    }
    if (!byConfig.size) byConfig.set(null, '');   // nothing bound yet: the default
    const out = [];
    for (const [file, tag] of byConfig) {
      const snap = file ? usageSnapshot(file) : usageSnapshot();
      if (snap) out.push({ tag, snap });
    }
    return out;
  }

  // ---------------------------------------------------------------- rendering

  const statusColor = (s) => theme[(STATUS[s.status] || {}).key] ?? theme.muted;

  function countOf(list) {
    const c = { total: list.length, working: 0, yourturn: 0, permission: 0, idle: 0, unknown: 0, exited: 0 };
    for (const s of list) c[s.status] = (c[s.status] || 0) + 1;
    return c;
  }

  function rowLines(s, w, isCursor) {
    const st = STATUS[s.status] || STATUS.unknown;
    const color = statusColor(s);
    const glyph = s.status === 'working' ? SPINNER[ui.frame % SPINNER.length] : st.glyph;
    // "You are here" is a different question from "what will enter do", so the
    // window you are in gets its own marker, independent of the cursor.
    const isHere = s.windowId === myWindowId;
    const mark = isHere ? '▌' : ' ';
    const idx = String(s.windowIndex ?? '').padStart(2);
    const titleW = Math.max(0, w - 7);
    const title = truncate(s.title || 'session', titleW);
    // Emphasis is scarce: only an unlooked-at result or a block earns bold.
    const strong = s.unread || s.status === 'permission';

    let l1;
    if (isCursor) {
      l1 = bg(theme.cursorBg) + fg(theme.cursorFg) + mark + idx + ' '
        + fg(color) + bold + glyph + reset + bg(theme.cursorBg) + fg(theme.cursorFg) + bold
        + ' ' + fit(title, titleW) + reset;
    } else {
      l1 = fg(isHere ? theme.working : theme.muted) + mark + reset
        + fg(theme.muted) + idx + ' ' + reset
        + fg(color) + (strong ? bold : '') + glyph + reset + ' '
        + fg(s.status === 'idle' ? theme.idle : theme.text) + (strong ? bold : '') + title + reset;
    }

    const time = dur(s.status === 'working' && s.turnStartAt ? Date.now() - s.turnStartAt : s.sinceMs);
    let left;
    if (s.status === 'working' && s.activity) {
      left = s.activity.kind === 'tool'
        ? s.activity.name + (s.activity.arg ? ' ' + s.activity.arg : '')
        : 'thinking';
      if (s.agents) left = s.agents + ' agents · ' + left;
    } else if (s.status === 'permission') {
      left = s.statusDetail ? 'approve ' + s.statusDetail : 'waiting for approval';
    } else {
      left = s.project + (s.branch ? ' · ' + s.branch : '');
      if (scope === 'global' && multiSession() && s.tmuxSession !== mySession) {
        left = '@' + s.tmuxSession + ' · ' + left;
      }
    }
    // Two accounts signed in at once is the only time it matters which one a
    // session is spending -- and then it matters more than the branch.
    if (multiAccount() && s.account) left = (ui.tags.get(s.account) || '') + ' · ' + left;

    // The model rides on the right of the same line, so it stays visible while
    // a session is working and the left half is describing the current tool.
    const mdl = modelShort(s.model);
    const gap = mdl && time ? 1 : 0;
    const right = (mdl ? fg(theme.faint) + soft + mdl + reset : '')
      + ' '.repeat(gap)
      + (time ? fg(s.status === 'permission' ? theme.alert : theme.faint) + time + reset : '');
    const rightW = width(mdl) + gap + width(time);
    const leftW = Math.max(0, w - 6 - rightW - 1);
    const l2 = '     ' + soft + fg(theme.muted) + fit(truncate(left, leftW), leftW) + reset
      + ' ' + right;
    return [l1, l2];
  }

  const MODE_TITLES = { help: 'keys', detail: 'session', prompt: 'new session', confirm: 'confirm' };

  function headerLine(w) {
    // Every mode but the list is a view of something else entirely; leaving the
    // session counts up there is how you end up staring at a list of names with
    // no idea what they are.
    if (ui.mode !== 'list') {
      const label = ui.mode === 'resume'
        ? `resume · ${ui.resumeRows.length} past ${ui.resumeRows.length === 1 ? 'session' : 'sessions'}`
        : MODE_TITLES[ui.mode] || ui.mode;
      return ' ' + fg(theme.headFg) + bold + truncate(label, w - 2) + reset;
    }
    const visible = sessions();
    const c = scope === 'global' ? (ui.overview.counts || {}) : countOf(visible);
    const n = visible.length;
    const left = n + (n === 1 ? ' session' : ' sessions') + (scope === 'global' ? ' (all)' : '');
    let right = '';
    let rc = theme.faint;
    let strong = false;
    if (c.permission) { right = c.permission + ' blocked'; rc = theme.alert; strong = true; }
    else if (c.yourturn) { right = c.yourturn + ' ready'; rc = theme.ready; }
    else if (c.working) { right = c.working + ' running'; rc = theme.working; }
    const pad = Math.max(1, w - width(left) - width(right) - 2);
    return ' ' + fg(theme.headFg) + left + reset + ' '.repeat(pad)
      + fg(rc) + (strong ? bold : '') + right + reset;
  }

  /** The last few things that happened, compact enough for a narrow column. */
  function feedLines(s, w, want) {
    const n = Math.max(1, Math.min(12, want));
    const rows = (s.recent || []).slice(-n);
    const textW = Math.max(4, w - 9);
    if (!rows.length) {
      return ['      ' + soft + fg(theme.faint) + 'nothing yet' + reset];
    }
    return rows.map((e) => {
      let glyph;
      let gc;
      let text;
      if (e.k === 't') {
        glyph = e.d ? (e.e ? FEED.fail : FEED.done) : SPINNER[ui.frame % SPINNER.length];
        gc = e.e ? theme.alert : (e.d ? theme.faint : theme.working);
        text = e.n + (e.a ? ' ' + e.a : '');
      } else if (e.k === 'a') {
        glyph = FEED.ask; gc = theme.muted; text = e.t;
      } else {
        glyph = FEED.say; gc = theme.ready; text = e.t;
      }
      return '      ' + fg(gc) + glyph + reset + ' '
        + soft + fg(e.k === 'a' ? theme.text : theme.muted) + truncate(text, textW) + reset;
    });
  }

  function listBody(w, h) {
    const list = sessions();
    if (!list.length) {
      return ['', fg(theme.muted) + '  no claude sessions' + reset, '',
        fg(theme.faint) + soft + '  press n to start one' + reset];
    }
    const cur = selected();
    // Showing every session's feed at once has to stay glanceable, so each one
    // gets a shorter slice than the single-session view does.
    const oneN = Math.max(3, Math.min(12, cfg.detailLines || 8));
    const allN = Math.max(1, Math.min(oneN, cfg.detailLinesAll || 4));
    // Scroll by line, not by row: with the feed open, rows are not equal height.
    const flat = [];
    const owner = [];
    let curStart = 0;
    let curLen = 2;
    for (const s of list) {
      const isCur = cur && s.key === cur.key;
      const block = rowLines(s, w, isCur);
      if (ui.detailMode === 'all') block.push(...feedLines(s, w, allN));
      else if (isCur && ui.detailMode === 'one') block.push(...feedLines(s, w, oneN));
      if (isCur) { curStart = flat.length; curLen = block.length; }
      for (const line of block) { flat.push(line); owner.push(s.key); }
    }
    if (curStart < ui.scrollLine) ui.scrollLine = curStart;
    if (curStart + curLen > ui.scrollLine + h) ui.scrollLine = curStart + curLen - h;
    ui.scrollLine = Math.min(Math.max(0, flat.length - h), Math.max(0, ui.scrollLine));
    ui.lineMapKind = 'list';
    ui.lineMap = owner.slice(ui.scrollLine, ui.scrollLine + h);
    return flat.slice(ui.scrollLine, ui.scrollLine + h);
  }

  function detailBody(w, h) {
    const s = selected();
    if (!s) return [];
    const lines = [];
    const kv = (k, v) => {
      if (!v) return;
      lines.push(' ' + soft + fg(theme.muted) + fit(k, 9) + reset
        + fg(theme.text) + truncate(String(v), w - 10) + reset);
    };
    for (const l of wrap(s.title, w - 2, 2)) lines.push(' ' + fg(theme.text) + bold + l + reset);
    lines.push('');
    kv('status', (STATUS[s.status] || {}).label + ' · ' + dur(s.sinceMs));
    kv('where', s.project + (s.branch ? ' · ' + s.branch : ''));
    kv('model', modelShort(s.model));
    kv('account', s.account);
    kv('context', tokens(s.contextTokens));
    kv('turn', s.toolsThisTurn ? s.toolsThisTurn + ' tools' : null);
    kv('mode', s.permissionMode);
    kv('id', (s.sessionId || '').slice(0, 8));
    if (s.identified === 'guess' || s.identified === 'none') kv('bound', 'inferred');
    if (s.lastPrompt) {
      lines.push('');
      lines.push(' ' + soft + fg(theme.muted) + 'you said' + reset);
      for (const l of wrap(s.lastPrompt, w - 2, 3)) lines.push(' ' + fg(theme.text) + l + reset);
    }
    if (s.lastAssistant) {
      lines.push('');
      lines.push(' ' + soft + fg(theme.muted) + 'claude said' + reset);
      for (const l of wrap(s.lastAssistant, w - 2, 8)) lines.push(' ' + fg(theme.muted) + l + reset);
    }
    return lines.slice(0, h);
  }

  function helpBody(w, h) {
    const lines = [''];
    for (const [k, v] of HELP) {
      lines.push(' ' + fg(theme.working) + fit(k, 10) + reset + fg(theme.muted) + truncate(v, w - 11) + reset);
    }
    return lines.slice(0, h);
  }

  function resumeBody(w, h) {
    const lines = [''];
    const rows = ui.resumeRows;
    if (!rows.length) return [...lines, ' ' + fg(theme.muted) + 'nothing found' + reset];
    const cap = Math.max(1, Math.floor((h - 2) / 2));
    const start = Math.min(Math.max(0, ui.resumeIdx - cap + 1), Math.max(0, rows.length - cap));
    ui.lineMapKind = 'resume';
    ui.lineMap = [null, null];
    for (let i = start; i < Math.min(rows.length, start + cap); i += 1) {
      ui.lineMap.push(i, i);
      const r = rows[i];
      const t = truncate(r.title, w - 3);
      lines.push(i === ui.resumeIdx
        ? bg(theme.cursorBg) + fg(theme.cursorFg) + bold + fit(' ' + t, w) + reset
        : ' ' + fg(theme.text) + t + reset);
      lines.push(' ' + soft + fg(theme.faint)
        + fit(truncate(r.project + ' · ' + dur(Date.now() - r.mtimeMs), w - 2), w - 2) + reset);
    }
    return lines.slice(0, h);
  }

  // A plan window is only worth colour once it is close enough to bite.
  function usageColor(pct, severity) {
    if (pct >= 90 || severity === 'critical') return theme.alert;
    if (pct >= 75 || severity === 'warning') return theme.working;
    return theme.muted;
  }

  /** One account's plan limits: how much of the 5h, weekly and per-model
   *  windows is gone, and how long until each comes back. Windows that reset
   *  together share a line, so the one countdown they share is stated once --
   *  right-aligned, like every other duration in the rail. */
  function usageBlock(u, w, tag) {
    if (!u || !u.rows.length) return [];
    const now = Date.now();
    const age = u.at ? now - u.at : 0;
    const stale = age > USAGE_STALE_MS;
    const indent = tag ? tag.length + 2 : 1;

    const groups = [];
    for (const r of u.rows) {
      // Two windows quoted milliseconds apart are the same weekly reset.
      const at = r.resetsAt ? Math.round(r.resetsAt / 60000) : 0;
      let g = groups.find((x) => x.at === at);
      if (!g) { g = { at, resetsAt: r.resetsAt, rows: [] }; groups.push(g); }
      g.rows.push(r);
    }

    const out = [];
    for (const g of groups) {
      // A window whose reset has already passed makes its percentage a
      // leftover from before it, so date the reading rather than count down
      // from zero: '22h old' says what a bare 'old' left you to guess.
      const left = g.resetsAt ? g.resetsAt - now : 0;
      const right = g.resetsAt ? (left > 0 ? dur(left) : ageTag(age)) : '';
      let body = '';
      let plainW = indent;
      for (const r of g.rows) {
        const plain = r.label + ' ' + r.pct + '%';
        const sep = plainW > indent ? 2 : 0;
        if (plainW + sep + plain.length + 1 + width(right) > w - 1) break;
        const c = stale ? theme.faint : usageColor(r.pct, r.severity);
        body += ' '.repeat(sep)
          + fg(theme.faint) + soft + r.label + reset
          + ' ' + fg(c) + (r.pct >= 90 && !stale ? bold : '') + r.pct + '%' + reset;
        plainW += sep + plain.length;
      }
      if (plainW === indent) continue;
      // The account name sits on its first line only; the rest line up under it.
      const head = tag && !out.length
        ? ' ' + fg(theme.muted) + tag + reset + ' '
        : ' '.repeat(indent);
      const pad = Math.max(1, w - 1 - plainW - width(right));
      out.push(head + body + ' '.repeat(pad)
        + (right ? fg(theme.faint) + soft + right + reset : ''));
    }
    return out;
  }

  /** This machine's CPU, memory and disk, coloured like the plan windows. */
  function systemLine(w) {
    const sys = ui.sys;
    if (!sys) return [];
    let body = '';
    let plainW = 1;
    for (const [label, pct] of [['cpu', sys.cpu], ['mem', sys.mem], ['disk', sys.disk]]) {
      if (pct == null) continue;
      const plain = label + ' ' + pct + '%';
      const sep = plainW > 1 ? 2 : 0;
      if (plainW + sep + plain.length > w - 1) break;
      body += ' '.repeat(sep) + fg(theme.faint) + soft + label + reset
        + ' ' + fg(usageColor(pct)) + (pct >= 90 ? bold : '') + pct + '%' + reset;
      plainW += sep + plain.length;
    }
    return plainW > 1 ? [' ' + body] : [];
  }

  function usageLines(w) {
    // With one account the limits are just "your limits"; with two they are the
    // main thing you need the account names for, so each gets its own block.
    if (ui.usage.length < 2) return usageBlock(ui.usage[0] && ui.usage[0].snap, w, '');
    return ui.usage.flatMap((a) => usageBlock(a.snap, w, a.tag));
  }

  function hintLine(w) {
    // '? keys' is what makes everything else findable, so it is the one hint
    // that is never dropped for want of room.
    const last = HINTS[HINTS.length - 1];
    const tailW = width(last[0]) + 1 + width(last[1]) + 2;
    let s = '';
    let plain = 0;
    for (const [k, v] of HINTS.slice(0, -1)) {
      const w2 = width(k) + 1 + width(v);
      if (plain + (plain ? 2 : 0) + w2 + tailW > w - 2) break;
      s += (s ? '  ' : '') + fg(theme.working) + k + reset + ' ' + soft + fg(theme.faint) + v + reset;
      plain += (plain ? 2 : 0) + w2;
    }
    s += (s ? '  ' : '') + fg(theme.working) + last[0] + reset + ' ' + soft + fg(theme.faint) + last[1] + reset;
    return ' ' + s;
  }

  function footer(w) {
    const lines = footerBody(w);
    const u = [
      ...(cfg.showSystem === false ? [] : systemLine(w)),
      ...(cfg.showUsage === false ? [] : usageLines(w)),
    ];
    if (!u.length) return lines;
    // The footer's spacer row exists only to keep it two rows tall, so the
    // usage block takes it rather than pushing a gap between the two.
    if (lines[lines.length - 1] === '') lines.pop();
    return [...lines, ...u];
  }

  function footerBody(w) {
    if (ui.mode === 'confirm') {
      return [' ' + fg(theme.alert) + bold + truncate(ui.confirm.label, w - 2) + reset,
        ' ' + fg(theme.muted) + 'y confirm' + reset + soft + fg(theme.faint) + '   n cancel' + reset];
    }
    if (ui.mode === 'prompt') {
      return [' ' + soft + fg(theme.muted) + truncate(ui.inputLabel, w - 2) + reset,
        ' ' + fg(theme.text) + truncate(ui.input, w - 4) + bg(theme.cursorBg) + ' ' + reset];
    }
    if (ui.message && Date.now() - ui.messageAt < 4000) {
      return [' ' + fg(theme.working) + truncate(ui.message, w - 2) + reset, hintLine(w)];
    }
    if (ui.mode === 'resume') {
      return [' ' + fg(theme.working) + '↵' + reset + ' ' + fg(theme.faint) + 'resume it' + reset
        + '   ' + fg(theme.working) + 'esc' + reset + ' ' + fg(theme.faint) + 'back' + reset, ''];
    }
    if (ui.mode !== 'list') return [' ' + soft + fg(theme.faint) + 'esc  back' + reset, ''];
    return [hintLine(w), ''];
  }

  function render() {
    const w = Math.max(18, out.columns || 34);
    const h = Math.max(8, out.rows || 24);
    const foot = footer(w);
    // header + rule + body + rule + footer must total exactly h rows;
    // an extra line would land on the last row and erase the footer.
    const bodyH = Math.max(1, h - 3 - foot.length);

    let body;
    if (ui.mode === 'detail') body = detailBody(w, bodyH);
    else if (ui.mode === 'help') body = helpBody(w, bodyH);
    else if (ui.mode === 'resume') body = resumeBody(w, bodyH);
    else body = listBody(w, bodyH);

    const rule = fg(theme.rule) + '─'.repeat(Math.max(0, w - 1)) + reset;
    const lines = [headerLine(w), rule];
    for (let i = 0; i < bodyH; i += 1) lines.push(body[i] ?? '');
    lines.push(rule);
    for (const f of foot) lines.push(f);

    // Only repaint rows that changed: cheap, and flicker-free over ssh.
    if (Date.now() - lastFull > REPAINT_MS) { prevLines = []; lastFull = Date.now(); }
    let buf = '';
    for (let i = 0; i < Math.min(lines.length, h); i += 1) {
      if (prevLines[i] === lines[i]) continue;
      buf += at(i + 1, 1) + clampAnsi(lines[i], w - 1) + reset + clearLine;
    }
    if (buf) out.write(buf);
    prevLines = lines;
  }

  // ------------------------------------------------------------------ actions

  /** Is this rail's window the one being looked at right now? */
  function hereActive(mine) {
    const f = ui.focus;
    // The collector republishes focus on every tick it changes; if it has gone
    // quiet the file is not evidence any more, so fall back to the overview.
    if (f && f.active && Date.now() - f.at < 5000) return f.active[mySession] === myWindowId;
    return Boolean(mine && mine.windowActive);
  }

  const jump = (s) => {
    if (!s) return;
    focusPane(s.paneId, s.tmuxSession, mySession);
    // tmux switches in single-digit milliseconds; the collector will not notice
    // for up to a tick. Say so here so the destination rail can re-anchor its
    // highlight now instead of a beat after the window has already changed.
    const active = { ...((ui.focus && ui.focus.active) || {}), [s.tmuxSession]: s.windowId };
    ui.focus = { at: Date.now(), active };
    try { writeJSON(FOCUS, ui.focus); } catch { /* the collector will catch up */ }
  };

  function nextNeeding() {
    const want = sessions().filter((s) => s.status === 'permission' || s.status === 'yourturn');
    if (!want.length) { note('nothing waiting'); return; }
    want.sort((a, b) => (b.status === 'permission') - (a.status === 'permission')
      || (b.unread ? 1 : 0) - (a.unread ? 1 : 0)
      || a.statusAt - b.statusAt);
    const cur = selected();
    const pick = want.find((s) => s.key !== (cur && cur.key)) || want[0];
    ui.cursorKey = pick.key;
    jump(pick);
  }

  function cycleDetail() {
    const i = DETAIL_MODES.indexOf(ui.detailMode);
    ui.detailMode = DETAIL_MODES[(i + 1) % DETAIL_MODES.length];
    // Every other rail picks this up from its watch, so all the rails keep
    // showing the same thing.
    saveUI({ detail: ui.detailMode });
    note(ui.detailMode === 'off' ? 'detail off'
      : ui.detailMode === 'one' ? 'detail: this session' : 'detail: all sessions');
  }

  const WIDTHS = [34, 56, 80];

  // The shared width this rail last acted on. Compared against the *intent*
  // rather than the pane's actual width, because tmux clamps a resize it cannot
  // satisfy -- reconciling against the result would retry it every tick.
  let appliedWidth = null;

  function applyWidth(w) {
    if (!self || !w || w === appliedWidth) return;
    appliedWidth = w;
    tmuxOk(['resize-pane', '-t', self, '-x', String(w)]);
    prevLines = [];
  }

  function cycleWidth() {
    if (!self) return;
    const now = appliedWidth || out.columns || 34;
    const next = WIDTHS.find((x) => x > now + 2) ?? WIDTHS[0];
    // Every rail is the same column in a different window; widening one and
    // finding the next still narrow is just the old per-rail bug again.
    saveUI({ width: next });
    applyWidth(next);
  }

  /** Adopt whatever the shared view settings currently say. */
  function applyUI() {
    const u = loadUI();
    let changed = false;
    if (DETAIL_MODES.includes(u.detail) && u.detail !== ui.detailMode) {
      ui.detailMode = u.detail;
      changed = true;
    }
    if (THEMES.includes(u.theme) && u.theme !== themePref) {
      themePref = u.theme;
      theme = pickTheme(themePref, probed);
      soft = theme.soft;
      // Every line's colour just changed while its text did not, so the diff
      // would repaint nothing. Force the whole rail.
      prevLines = [];
      changed = true;
    }
    if (u.width) applyWidth(u.width);
    return changed;
  }

  function cycleTheme() {
    const i = THEMES.indexOf(themePref);
    const next = THEMES[(i + 1) % THEMES.length];
    // The terminal is one terminal: a rail left on the old palette after you
    // switch themes is the unreadable one you then have to hunt down.
    saveUI({ theme: next });
    themePref = next;
    theme = pickTheme(next, probed);
    soft = theme.soft;
    prevLines = [];
    note(next === 'auto' ? 'theme: auto (' + (probed || 'unknown') + ')' : 'theme: ' + next);
  }

  /** The terminal said it is now light or dark; only auto follows it. */
  function setProbed(next) {
    if (!next || next === probed) return false;
    probed = next;
    if (themePref !== 'auto') return false;
    theme = pickTheme(themePref, probed);
    soft = theme.soft;
    prevLines = [];
    return true;
  }

  function startPrompt(label, initial, onSubmit) {
    ui.mode = 'prompt';
    ui.inputLabel = label;
    ui.input = initial || '';
    ui.onSubmit = onSubmit;
  }

  const BODY_TOP = 3; // header + rule occupy rows 1 and 2

  function handleMouse(ev) {
    if (ev.wheel) {
      if (ui.mode === 'resume') {
        ui.resumeIdx = Math.max(0, Math.min(ui.resumeRows.length - 1,
          ui.resumeIdx + (ev.wheel === 'down' ? 1 : -1)));
      } else if (ui.mode === 'list') {
        moveCursor(ev.wheel === 'down' ? 1 : -1);
      }
      return;
    }
    if (!ev.press || ev.button !== 0) return;      // left button, on press only
    const idx = ev.y - BODY_TOP;
    if (idx < 0 || idx >= ui.lineMap.length) return;
    const hit = ui.lineMap[idx];
    if (hit === null || hit === undefined) return;

    if (ui.lineMapKind === 'resume') {
      ui.resumeIdx = hit;
      handleKey('enter');
      return;
    }
    // A click on a row goes there, like clicking a tab. Browsing without
    // switching is what the wheel and j/k are for.
    ui.cursorKey = hit;
    jump(sessions().find((x) => x.key === hit));
  }

  function handleKey(key) {
    const s = selected();

    if (ui.mode === 'prompt') {
      if (key === 'escape') ui.mode = 'list';
      else if (key === 'enter') {
        const v = ui.input.trim();
        ui.mode = 'list';
        if (v) ui.onSubmit(v);
      } else if (key === 'backspace') ui.input = ui.input.slice(0, -1);
      else if (key.length === 1) ui.input += key;
      return;
    }
    if (ui.mode === 'confirm') {
      if (key === 'y') { const run = ui.confirm.run; ui.mode = 'list'; ui.confirm = null; run(); }
      else if (key === 'n' || key === 'escape') { ui.mode = 'list'; ui.confirm = null; }
      return;
    }
    if (ui.mode === 'resume') {
      if (key === 'escape' || key === 'q') ui.mode = 'list';
      else if (key === 'j' || key === 'down') ui.resumeIdx = Math.min(ui.resumeRows.length - 1, ui.resumeIdx + 1);
      else if (key === 'k' || key === 'up') ui.resumeIdx = Math.max(0, ui.resumeIdx - 1);
      // 'g' jumps rather than waiting for a second one, so 'gg' works without
      // 'g' alone leaving you in a pending state that shows nothing.
      else if (key === 'g' || key === 'home') ui.resumeIdx = 0;
      else if (key === 'G' || key === 'end') ui.resumeIdx = Math.max(0, ui.resumeRows.length - 1);
      else if (key === 'enter' || key === 'l' || key === 'right') {
        const r = ui.resumeRows[ui.resumeIdx];
        ui.mode = 'list';
        if (r) { openSession({ cwd: r.cwd || process.env.HOME, resume: r.id }); note('resuming…'); }
      }
      return;
    }
    if (ui.mode === 'detail' || ui.mode === 'help') {
      if (['escape', 'd', 'q', '?', 'left', 'h'].includes(key)) ui.mode = 'list';
      else if (key === 'enter') { ui.mode = 'list'; jump(s); }
      else if (key === 'j' || key === 'down') moveCursor(1);
      else if (key === 'k' || key === 'up') moveCursor(-1);
      return;
    }

    switch (key) {
      case 'j': case 'down': moveCursor(1); break;
      case 'k': case 'up': moveCursor(-1); break;
      case 'g': case 'home': ui.cursorKey = (sessions()[0] || {}).key; break;
      case 'G': case 'end': ui.cursorKey = (sessions().slice(-1)[0] || {}).key; break;
      case 'enter': case 'l': case 'right': jump(s); break;
      case 'tab': nextNeeding(); break;
      case 'd': ui.mode = 'detail'; break;
      // 'o' was this cycle's only key before it grew a third state; keep it.
      case 'i': case 'o': cycleDetail(); break;
      case 'w': cycleWidth(); break;
      case 't': cycleTheme(); break;
      case '?': ui.mode = 'help'; break;
      case 'q':
        // Remember the choice, or the collector would put the rail straight back.
        if (self) tmuxOk(['set-option', '-w', '-t', self, '@cc_rail_off', '1']);
        // The pane is about to vanish, taking every hint about itself with it.
        // Say where it went, in the one place still on screen -- naming the key
        // if there is one, since reaching a shell means leaving what you were
        // doing.
        tmuxOk(['display-message', recallHint()]);
        quit(0);
        break;
      case 'n': openSession({ cwd: (s && s.cwd) || process.env.HOME }); note('new session'); break;
      case 'N':
        startPrompt('new session in…', (s && s.cwd) || process.env.HOME, (v) => {
          if (!fs.existsSync(v)) { note('no such directory'); return; }
          openSession({ cwd: v });
        });
        break;
      case 'r':
        ui.resumeRows = recentSessions({ limit: 40 });
        ui.resumeIdx = 0;
        ui.mode = 'resume';
        break;
      case 'x':
        if (!s) break;
        ui.mode = 'confirm';
        ui.confirm = {
          label: 'close ' + truncate(s.title, 18) + '?',
          run: () => { tmuxOk(['kill-window', '-t', s.windowId]); note('closed'); },
        };
        break;
      case 'a':
        spawn(RAIL_BIN, ['adopt'], { detached: true, stdio: 'ignore' }).unref();
        note('adding rails…');
        break;
      default:
        if (/^[1-9]$/.test(key)) {
          const hit = sessions().find((x) => String(x.windowIndex) === key);
          if (hit) { ui.cursorKey = hit.key; jump(hit); }
        }
    }
  }

  // -------------------------------------------------------------------- input

  process.on('exit', cleanup);
  process.on('SIGINT', () => quit(0));
  process.on('SIGTERM', () => quit(0));
  process.on('SIGWINCH', () => { prevLines = []; render(); });

  // tmux forwards mouse events to a pane whose application asks for them, and
  // its default MouseDown1Pane binding selects the pane first, so a single
  // click both focuses the rail and lands here.
  out.write(alt.on + cursor.hide + mouse.on + themeReports.on);
  process.stdin.setRawMode?.(true);
  process.stdin.resume();
  process.stdin.on('data', (buf) => {
    for (const key of decodeKeys(buf)) {
      if (key.type === 'theme') { setProbed(key.value); continue; }
      if (typeof key === 'object') { handleMouse(key); continue; }
      if (key === 'ctrl-c') return quit(0);
      handleKey(key);
    }
    render();
  });

  // ------------------------------------------------------------------ refresh

  const reload = () => {
    const next = readJSON(OVERVIEW, null);
    if (next) ui.overview = next;
    const f = readJSON(FOCUS, null);
    if (f) ui.focus = f;
    // The watch above is the fast path; this is what makes the sharing work at
    // all on a filesystem with no inotify.
    applyUI();
    const mine = here();
    if (!ui.cursorKey && sessions().length) {
      ui.cursorKey = (mine || sessions().find((s) => s.focused) || sessions()[0]).key;
    }
    // Arriving in this window re-anchors the cursor, so what is highlighted is
    // always the session you are actually looking at -- browsing with j/k while
    // you stay put is left alone.
    const active = hereActive(mine);
    if (active && !ui.wasActive && mine) {
      ui.cursorKey = mine.key;
      // A picker or a prompt is a thing you are in the middle of, not a state a
      // window should still be sitting in when you come back to it later.
      if (ui.mode !== 'list') { ui.mode = 'list'; ui.confirm = null; ui.input = ''; }
    }
    ui.wasActive = active;
  };
  // Watch the directory, not the file: focus.json is replaced by rename on
  // every write, which would leave a watch on the old inode watching nothing.
  try {
    fs.watch(STATE_DIR, (_ev, name) => {
      if (name === 'focus.json') {
        const next = readJSON(FOCUS, null);
        if (!next) return;
        ui.focus = next;
        reload();
        render();
        return;
      }
      if (name === 'ui.json') {
        if (applyUI()) render();
      }
    });
  } catch { /* no inotify: the 200ms poll still picks it up */ }

  reload();
  applyUI();
  ui.tags = accountTags();
  ui.usage = readUsage();
  const cpu = cpuSampler();
  const diskDir = cfg.diskPath || '/';
  const readSys = () => { ui.sys = { cpu: cpu(), mem: memPercent(), disk: diskPercent(diskDir) }; };
  setInterval(() => {
    reload();
    ui.frame += 1;
    // Claude Code writes these at most once a request; two seconds is plenty.
    if (ui.frame % 10 === 0) { ui.tags = accountTags(); ui.usage = readUsage(); readSys(); }
    // Backstop for a missed report (e.g. the switch happened while detached).
    if (ui.frame % 15 === 0) setProbed(clientTheme(self));
    render();
  }, 200);
  render();
}
