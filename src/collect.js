import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listPanes, capturePane } from './tmux.js';
import { summarize, transcriptsFor } from './transcript.js';
import { accountFor } from './account.js';
import { CLAUDE_DIR } from './paths.js';

const CLAUDE_COMMANDS = new Set((process.env.CC_RAIL_CLAUDE_CMDS || 'claude').split(','));

/**
 * tmux reports the foreground process group leader, which is the wrapper shell
 * when claude was started without job control. Walk a shell pane's descendants
 * so those sessions are still found, and return the pid we landed on -- the
 * session's own environment is what says which account it is signed in as.
 */
function claudePidOf(pid, depth = 0) {
  if (!pid || depth > 3) return null;
  let kids;
  try { kids = fs.readFileSync(`/proc/${pid}/task/${pid}/children`, 'utf8').trim(); } catch { return null; }
  if (!kids) return null;
  for (const k of kids.split(/\s+/)) {
    let comm;
    try { comm = fs.readFileSync(`/proc/${k}/comm`, 'utf8').trim(); } catch { continue; }
    if (CLAUDE_COMMANDS.has(comm)) return Number(k);
    const deeper = claudePidOf(Number(k), depth + 1);
    if (deeper) return deeper;
  }
  return null;
}

// Claude Code sets the terminal title to a status glyph + the AI title.
const TITLE_GLYPH = /^[✨✳✻✽✴✶✹·•●○✶✸*\s]+/u;

// Deliberately narrow: an ordinary numbered list in Claude's own output must
// never read as a permission prompt.
const PERMISSION_RE = /Do you want\b|❯\s*1\.\s*Yes\b|\b1\.\s*Yes\b/;
const SPINNER_RE = /…\s*\((?:\d+h\s*)?(?:\d+m\s*)?\d+s\b/;
const INTERRUPT_RE = /esc to interrupt/i;

export const RANK = { permission: 4, yourturn: 3, working: 2, unknown: 1, idle: 0, exited: -1 };

function cleanTitle(t) { return (t || '').replace(TITLE_GLYPH, '').trim(); }

/** Read the bottom of a pane to answer what the transcript cannot: is a
 *  permission prompt on screen, and is the spinner actually turning? */
function paneSignal(paneId) {
  const raw = capturePane(paneId);
  if (!raw) return { permission: false, spinner: false };
  // The prompt box and spinner sit at the end of the pane's content -- which is
  // not the bottom of the pane when the screen is not yet full.
  const lines = raw.split('\n');
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  const text = lines.slice(-16).join('\n');
  return {
    permission: PERMISSION_RE.test(text),
    spinner: SPINNER_RE.test(text) || INTERRUPT_RE.test(text),
  };
}

// A pane whose session has not been titled yet shows the generic brand title;
// matching on it would bind the wrong transcript.
const GENERIC_TITLE = /^(claude|claude code|bash|node|zsh|sh)$/i;
const HOSTNAME = os.hostname();

function usefulTitle(paneTitle) {
  const t = cleanTitle(paneTitle);
  if (!t || GENERIC_TITLE.test(t) || t === HOSTNAME) return null;
  return t;
}

/**
 * Bind every claude pane to its transcript, strongest evidence first and
 * globally rather than pane-by-pane, so a pane with no evidence can never
 * steal a transcript that another pane matches exactly.
 *
 * 1. a hook told us (exact)
 * 2. the binding we already had, if the pane is the same process (sticky)
 * 3. the pane's terminal title equals the session name or AI title
 * 4. the newest unclaimed, recently-written transcript for that cwd (a guess)
 */
function resolveAll(panes, hooks, prev) {
  const bound = new Map();
  const claimed = new Set();
  const take = (pane, file, how) => {
    if (!file || claimed.has(file)) return false;
    claimed.add(file);
    bound.set(pane.paneId, { file, how });
    return true;
  };

  // Pass 1: hooks are authoritative.
  // Pass 2: honour a previous binding only if it was made on real evidence.
  //         A previous *guess* must stay upgradable, or one early wrong guess
  //         would be pinned for the life of the pane.
  const rest = [];
  for (const p of panes) {
    const hooked = hooks.byPane.get(p.paneId);
    // A hook is authoritative only while what it named still exists: a session
    // whose worktree has since been deleted would otherwise stay pinned to a
    // transcript that can never be read, and report nothing forever.
    if (hooked && hooked.transcript_path && fsExists(hooked.transcript_path)
      && take(p, hooked.transcript_path, 'hook')) continue;
    const before = prev.get(p.paneId);
    const solid = before && (before.how === 'hook' || before.how === 'title');
    if (solid && before.pid === p.panePid && before.transcript && fsExists(before.transcript)
      && take(p, before.transcript, before.how)) continue;
    rest.push(p);
  }

  const cands = new Map(); // cwd -> transcripts
  const candsFor = (cwd) => {
    if (!cands.has(cwd)) cands.set(cwd, transcriptsFor(cwd, { maxAgeMs: 7 * 24 * 3600 * 1000, limit: 25 }));
    return cands.get(cwd);
  };

  // Pass 3: the pane's terminal title equals the session name or AI title.
  const stillRest = [];
  for (const p of rest) {
    const want = (usefulTitle(p.title) || '').toLowerCase();
    let hit = null;
    if (want) {
      for (const key of ['name', 'title']) {
        for (const c of candsFor(p.cwd)) {
          if (claimed.has(c.file)) continue;
          const s = summarize(c.file);
          if (s && s[key] && s[key].toLowerCase() === want) { hit = c.file; break; }
        }
        if (hit) break;
      }
    }
    if (!(hit && take(p, hit, 'title'))) stillRest.push(p);
  }

  // Pass 4: fall back to the previous guess before making a fresh one, so the
  // rail does not shuffle identities tick to tick while nothing is known.
  const unguessed = [];
  for (const p of stillRest) {
    const before = prev.get(p.paneId);
    if (before && before.how === 'guess' && before.pid === p.panePid && before.transcript
      && fsExists(before.transcript) && take(p, before.transcript, 'guess')) continue;
    unguessed.push(p);
  }

  // Last resort. Never guess a session a hook has already told us ended.
  const ended = new Set();
  for (const r of hooks.bySession.values()) if (r.ended && r.transcript_path) ended.add(r.transcript_path);
  for (const p of unguessed) {
    const fresh = candsFor(p.cwd).find((c) => !claimed.has(c.file)
      && !ended.has(c.file)
      && Date.now() - c.mtimeMs < 12 * 3600 * 1000);
    if (fresh) take(p, fresh.file, 'guess');
  }
  return bound;
}

function fsExists(f) { try { return fs.existsSync(f); } catch { return false; } }

/**
 * Claude Code's own record of each running session (~/.claude/sessions/<pid>.json):
 * 'busy' while a turn runs, 'idle' between turns, 'waiting' on a prompt. It is
 * the ground truth the transcript heuristics only approximate.
 */
function liveStatuses() {
  const out = new Map();
  let names = [];
  try { names = fs.readdirSync(path.join(CLAUDE_DIR, 'sessions')); } catch { return out; }
  for (const n of names) {
    if (!n.endsWith('.json')) continue;
    try {
      const d = JSON.parse(fs.readFileSync(path.join(CLAUDE_DIR, 'sessions', n), 'utf8'));
      if (d.sessionId && d.status) out.set(d.sessionId, d.status);
    } catch { /* being rewritten; next tick */ }
  }
  return out;
}

function statusFor({ s, sig, hook, now, cfg, live }) {
  const st = statusFromTranscript({ s, sig, hook, now, cfg });
  // A message the transcript reader mistook for a human turn would otherwise
  // spin forever; Claude Code saying the session is idle settles it.
  if (st.status === 'working' && live === 'idle' && !sig.spinner) {
    const idleMs = now - (s ? s.lastEventAt : now);
    return { status: idleMs > cfg.idleAfterMin * 60000 ? 'idle' : 'yourturn', detail: null };
  }
  return st;
}

function statusFromTranscript({ s, sig, hook, now, cfg }) {
  if (hook && hook.event === 'SessionEnd') return { status: 'exited', detail: null };
  if (!s) {
    // A brand-new session has no transcript yet, but its trust prompt is
    // already on screen and already needs an answer.
    if (sig.permission) return { status: 'permission', detail: null };
    return { status: sig.spinner ? 'working' : 'unknown', detail: null };
  }

  const pending = s.pending;
  const staleMs = pending.length ? now - Math.max(...pending.map((p) => p.at || now)) : 0;

  // A hook-reported notification outranks everything until the turn moves on.
  if (hook && hook.event === 'Notification' && hook.at > s.lastEventAt - 2000) {
    return { status: 'permission', detail: hook.message || 'needs your input' };
  }
  if (pending.length) {
    // A tool_use with no tool_result and a quiet pane means Claude is parked on
    // a permission prompt, not working.
    if (staleMs > 6000 && sig.permission) return { status: 'permission', detail: pending[0].name };
    return { status: 'working', detail: null };
  }
  if (sig.permission) return { status: 'permission', detail: null };
  if (s.lastHumanAt > s.lastAssistantAt) return { status: 'working', detail: null };
  if (sig.spinner) return { status: 'working', detail: null };

  const idleMs = now - s.lastEventAt;
  if (idleMs > cfg.idleAfterMin * 60000) return { status: 'idle', detail: null };
  return { status: 'yourturn', detail: null };
}

function activityOf(s, status) {
  if (!s) return null;
  if (status === 'working' && s.pending.length) {
    const p = s.pending[s.pending.length - 1];
    return { kind: 'tool', name: p.name, arg: p.arg, at: p.at };
  }
  if (status === 'working') return { kind: 'thinking', name: 'thinking', arg: '', at: s.lastEventAt };
  return null;
}

/** Trim the activity feed to what a rail can show, keeping overview.json small. */
function compactFeed(recent) {
  if (!recent || !recent.length) return [];
  return recent.slice(-12).map((e) => (e.kind === 'tool'
    ? { k: 't', n: e.name, a: (e.arg || '').slice(0, 80), d: e.done, e: e.error, at: e.at }
    : { k: e.kind === 'ask' ? 'a' : 's', t: (e.text || '').replace(/\s+/g, ' ').slice(0, 160), at: e.at }));
}

export function collect(prev, hooks, cfg) {
  const now = Date.now();
  const panes = listPanes();
  const sessions = [];

  const claudePids = new Map();
  const claudePanes = panes.filter((p) => {
    if (p.isRail || p.dead) return false;
    const pid = CLAUDE_COMMANDS.has(p.command) ? p.panePid : claudePidOf(p.panePid);
    if (!pid) return false;
    claudePids.set(p.paneId, pid);
    return true;
  });
  const railWindows = new Set(panes.filter((p) => p.isRail).map((p) => p.windowId));
  const bound = resolveAll(claudePanes, hooks, prev);

  // Pane captures are the only per-tick cost that scales, so budget them:
  // ambiguous panes first, then whatever is on screen.
  const needsCapture = new Set();
  const pre = new Map();
  for (const p of claudePanes) {
    const b = bound.get(p.paneId);
    const file = b ? b.file : null;
    const s = file ? summarize(file) : null;
    pre.set(p.paneId, { file, s });
    const pending = s ? s.pending : [];
    const stale = pending.length && now - Math.max(...pending.map((x) => x.at || now)) > 6000;
    const quiet = s && !pending.length && now - s.lastEventAt > 4000 && now - s.lastEventAt < cfg.idleAfterMin * 60000;
    if (stale || quiet || !s) needsCapture.add(p.paneId);
  }
  let budget = 8;
  for (const p of claudePanes) {
    if (budget <= 0) break;
    if (!needsCapture.has(p.paneId) && p.paneActive) { needsCapture.add(p.paneId); budget -= 1; }
  }

  const live = liveStatuses();
  for (const p of claudePanes) {
    const { file, s } = pre.get(p.paneId);
    const how = bound.get(p.paneId)?.how || 'none';
    const sig = needsCapture.has(p.paneId) ? paneSignal(p.paneId) : { permission: false, spinner: false };
    const hook = hooks.bySession.get(s && s.sessionId ? s.sessionId : '__none__') || hooks.byPane.get(p.paneId) || null;
    const { status, detail } = statusFor({ s, sig, hook, now, cfg, live: s ? live.get(s.sessionId) : null });

    const key = p.paneId;
    const before = prev.get(key);
    const changedAt = before && before.status === status ? before.statusAt : now;
    const seenAt = p.paneActive && p.windowActive ? now : (before ? before.seenAt : 0);

    sessions.push({
      key,
      paneId: p.paneId,
      windowId: p.windowId,
      windowIndex: p.windowIndex,
      windowName: p.windowName,
      hasRail: railWindows.has(p.windowId),
      tmuxSession: p.session,
      focused: p.paneActive && p.windowActive,
      windowActive: p.windowActive,
      pid: p.panePid,
      cwd: p.cwd,
      project: path.basename(p.cwd || '') || '/',
      branch: s && s.gitBranch && s.gitBranch !== 'HEAD' ? s.gitBranch : null,
      sessionId: s ? s.sessionId : null,
      transcript: file,
      title: (s && (s.name || s.title)) || usefulTitle(p.title) || p.windowName || 'session',
      // The explicit name (-n / /rename) is deliberate; the AI title is derived.
      sessionName: (s && s.name) || null,
      aiTitle: (s && s.title) || null,
      // Identity is exact only when a hook told us; otherwise it is inferred.
      // Identity is exact only when a hook told us; otherwise it is inferred.
      identified: how,
      model: s ? s.model : null,
      account: accountFor(claudePids.get(p.paneId)).email,
      // Where that account keeps its plan usage, so the rail can break the
      // limit bars down per account when more than one is signed in.
      accountConfig: accountFor(claudePids.get(p.paneId)).config,
      permissionMode: s ? s.permissionMode : null,
      status,
      statusDetail: detail,
      statusAt: changedAt,
      sinceMs: now - changedAt,
      activity: activityOf(s, status),
      agents: s ? s.pendingAgents : 0,
      toolsThisTurn: s ? s.toolsThisTurn : 0,
      turnStartAt: s ? s.lastTurnStartAt : null,
      lastEventAt: s ? s.lastEventAt : 0,
      contextTokens: s ? s.contextTokens : 0,
      lastPrompt: s ? s.lastPrompt : null,
      recent: s ? compactFeed(s.recent) : [],
      lastAssistant: s ? s.lastAssistantText : null,
      seenAt,
      // "Something you have not looked at happened here."
      unread: (status === 'yourturn' || status === 'permission') && changedAt > (seenAt || 0),
      rank: RANK[status] ?? 0,
    });
  }

  sessions.sort((a, b) => (a.tmuxSession || '').localeCompare(b.tmuxSession || '') || a.windowIndex - b.windowIndex);

  const counts = { total: sessions.length, working: 0, yourturn: 0, permission: 0, idle: 0, unknown: 0, exited: 0 };
  for (const s of sessions) counts[s.status] = (counts[s.status] || 0) + 1;
  counts.needsYou = counts.permission + counts.yourturn;

  const rails = panes.filter((p) => p.isRail).map((p) => ({ windowId: p.windowId, paneId: p.paneId }));
  return { at: now, sessions, counts, rails };
}
