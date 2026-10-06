import fs from 'node:fs';
import path from 'node:path';
import { HOME, PROJECTS_DIR, projectDirFor } from './paths.js';

function homeRelative(cwd) {
  const rel = path.relative(HOME, cwd);
  return !rel || rel.startsWith('..') ? cwd : rel;
}

// On first sight of a transcript we bootstrap from at most this many trailing
// bytes; after that we only ever read the bytes appended since the last tick.
const BOOTSTRAP_BYTES = 512 * 1024;

// Slash-command echoes and injected context arrive as `user` entries too.
const SYNTHETIC = /^<(local-command|command-name|command-message|command-args|system-reminder|user-prompt-submit-hook|task-notification|fork-source|bash-input|bash-stdout|bash-stderr)/;

const readers = new Map(); // file -> reader state

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((b) => b.type === 'text').map((b) => b.text || '').join('\n');
}

function shortArg(name, input) {
  if (!input || typeof input !== 'object') return '';
  const pick = (...keys) => { for (const k of keys) if (input[k]) return String(input[k]); return ''; };
  switch (name) {
    case 'Bash': return pick('description', 'command');
    case 'Read': case 'Edit': case 'Write': case 'NotebookEdit':
      return path.basename(pick('file_path') || '');
    case 'Grep': case 'Glob': return pick('pattern');
    case 'Agent': case 'Task': return pick('description', 'subagent_type');
    case 'WebFetch': { const u = pick('url'); try { return new URL(u).hostname; } catch { return u; } }
    case 'WebSearch': return pick('query');
    case 'Skill': return pick('skill');
    default: return pick('description', 'query', 'pattern', 'command', 'prompt');
  }
}

function newReader() {
  return {
    offset: 0,
    partial: '',
    openMain: new Map(),
    openSide: new Map(),
    s: {
      sessionId: null, title: null, lastPrompt: null, lastAssistantText: null,
      model: null, cwd: null, gitBranch: null, version: null, permissionMode: null,
      name: null, contextTokens: 0, lastEventAt: 0, lastAssistantAt: 0, lastHumanAt: 0,
      lastTurnStartAt: null, toolsThisTurn: 0, turns: 0, bootstrapped: false,
    },
    recent: [],   // rolling feed of what just happened, for the rail's detail view
  };
}

const RECENT_CAP = 24;

function push(r, entry) {
  r.recent.push(entry);
  if (r.recent.length > RECENT_CAP) r.recent.splice(0, r.recent.length - RECENT_CAP);
  return entry;
}

function fold(r, o) {
  const s = r.s;
  const type = o.type;
  if (o.sessionId) s.sessionId = o.sessionId;
  if (o.cwd) s.cwd = o.cwd;
  if (o.gitBranch) s.gitBranch = o.gitBranch;
  if (o.version) s.version = o.version;
  if (o.permissionMode) s.permissionMode = o.permissionMode;
  if (type === 'ai-title' && o.aiTitle) s.title = o.aiTitle;
  // A named session (-n / /rename) is what Claude Code puts in the terminal
  // title, so it is also what a pane title can be matched against.
  if (type === 'agent-name' && o.agentName) s.name = o.agentName;
  if (type === 'custom-title' && o.customTitle) s.name = o.customTitle;
  if (type === 'last-prompt' && o.lastPrompt) s.lastPrompt = o.lastPrompt;

  const side = o.isSidechain === true;
  const open = side ? r.openSide : r.openMain;
  const msg = o.message || {};
  const ts = o.timestamp ? Date.parse(o.timestamp) : null;
  if (ts && ts > s.lastEventAt) s.lastEventAt = ts;

  if (type === 'assistant') {
    if (!side) {
      if (msg.model) s.model = msg.model;
      const u = msg.usage;
      if (u) {
        const total = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
        if (total) s.contextTokens = total;
      }
      if (ts) s.lastAssistantAt = Math.max(s.lastAssistantAt, ts);
      const t = textOf(msg.content);
      if (t.trim()) {
        s.lastAssistantText = t.trim();
        push(r, { kind: 'say', text: t.trim().slice(0, 400), at: ts });
      }
    }
    if (Array.isArray(msg.content)) {
      for (const b of msg.content) {
        if (b.type !== 'tool_use') continue;
        // The same object goes into both, so completing it updates the feed.
        const entry = { kind: 'tool', name: b.name, arg: shortArg(b.name, b.input), at: ts, done: false, error: false, side };
        open.set(b.id, entry);
        if (!side) { s.toolsThisTurn += 1; push(r, entry); }
      }
    }
  } else if (type === 'user') {
    if (Array.isArray(msg.content)) {
      for (const b of msg.content) {
        if (b.type !== 'tool_result' || !b.tool_use_id) continue;
        const entry = open.get(b.tool_use_id);
        if (entry) { entry.done = true; entry.error = b.is_error === true; }
        open.delete(b.tool_use_id);
      }
    }
    // A real human turn restarts the clock. `userType` is always 'external',
    // so origin/promptSource are the only reliable discriminators.
    const carriesResult = Array.isArray(msg.content) && msg.content.some((b) => b.type === 'tool_result');
    // isMeta marks context Claude Code injected (a /rename note, a reminder).
    const isHuman = !side && !carriesResult && !o.isMeta && (
      (o.origin && o.origin.kind === 'human')
      || o.promptSource === 'typed'
      || (typeof msg.content === 'string' && !SYNTHETIC.test(msg.content.trimStart()))
    );
    if (isHuman && ts) {
      s.lastTurnStartAt = ts;
      s.lastHumanAt = Math.max(s.lastHumanAt, ts);
      s.toolsThisTurn = 0;
      s.turns += 1;
      const t = textOf(msg.content);
      if (t.trim()) {
        s.lastPrompt = t.trim();
        push(r, { kind: 'ask', text: t.trim().slice(0, 400), at: ts });
      }
    }
  }
}

/**
 * Incrementally fold a transcript into the facts the rail needs.
 * Sidechain (sub-agent) entries are tracked separately so a busy sub-agent is
 * never mistaken for the main thread's own work.
 */
export function summarize(file) {
  let st;
  try { st = fs.statSync(file); } catch { readers.delete(file); return null; }

  let r = readers.get(file);
  if (!r || st.size < r.offset) {           // first sight, or file replaced/truncated
    r = newReader();
    r.offset = Math.max(0, st.size - BOOTSTRAP_BYTES);
    r.skipFirstLine = r.offset > 0;
    readers.set(file, r);
  }
  if (st.size > r.offset) {
    const len = st.size - r.offset;
    let fd;
    try { fd = fs.openSync(file, 'r'); } catch { return snapshot(r, file, st); }
    try {
      const buf = Buffer.allocUnsafe(len);
      const read = fs.readSync(fd, buf, 0, len, r.offset);
      r.offset += read;
      let text = r.partial + buf.subarray(0, read).toString('utf8');
      const lines = text.split('\n');
      r.partial = lines.pop() ?? '';        // keep the incomplete trailing line
      if (r.skipFirstLine) { lines.shift(); r.skipFirstLine = false; }
      for (const l of lines) {
        if (!l) continue;
        let o; try { o = JSON.parse(l); } catch { continue; }
        fold(r, o);
      }
      r.s.bootstrapped = true;
    } finally { fs.closeSync(fd); }
  }
  return snapshot(r, file, st);
}

function snapshot(r, file, st) {
  const s = r.s;
  return {
    ...s,
    file,
    mtimeMs: st.mtimeMs,
    lastEventAt: Math.max(s.lastEventAt, st.mtimeMs),
    pending: [...r.openMain.values()],
    pendingAgents: r.openSide.size,
    recent: r.recent,
  };
}

/** Transcripts for a cwd, newest first. */
export function transcriptsFor(cwd, { maxAgeMs = null, limit = 40 } = {}) {
  const dir = projectDirFor(cwd);
  let names;
  try { names = fs.readdirSync(dir); } catch { return []; }
  const now = Date.now();
  const out = [];
  for (const n of names) {
    if (!n.endsWith('.jsonl')) continue;
    const file = path.join(dir, n);
    let st;
    try { st = fs.statSync(file); } catch { continue; }
    if (!st.isFile() || st.size === 0) continue;
    if (maxAgeMs && now - st.mtimeMs > maxAgeMs) continue;
    out.push({ file, id: n.slice(0, -6), mtimeMs: st.mtimeMs, size: st.size });
  }
  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out.slice(0, limit);
}

/** Recent sessions across every project, newest first (for the resume picker). */
export function recentSessions({ limit = 60 } = {}) {
  let dirs;
  try { dirs = fs.readdirSync(PROJECTS_DIR); } catch { return []; }
  const rows = [];
  for (const d of dirs) {
    const dir = path.join(PROJECTS_DIR, d);
    let names;
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const n of names) {
      if (!n.endsWith('.jsonl')) continue;
      const file = path.join(dir, n);
      let st;
      try { st = fs.statSync(file); } catch { continue; }
      if (!st.isFile() || st.size < 512) continue;
      rows.push({ file, id: n.slice(0, -6), mtimeMs: st.mtimeMs, size: st.size });
    }
  }
  rows.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return rows.slice(0, limit).map((r) => {
    const s = summarize(r.file);
    return {
      ...r,
      title: (s && (s.name || s.title)) || '(untitled)',
      cwd: (s && s.cwd) || null,
      // Relative to home, not just the basename: a worktree under ~/worktrees
      // and a directory inside a repo both read as unrelated top-level projects
      // when all you keep is the last segment.
      project: s && s.cwd ? homeRelative(s.cwd) : '',
      turns: s ? s.turns : 0,
    };
  });
}
