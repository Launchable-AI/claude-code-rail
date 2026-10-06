import fs from 'node:fs';
import path from 'node:path';
import { HOOK_DIR, STATE_DIR, readJSON, writeJSON } from './paths.js';

const SPOOL = path.join(STATE_DIR, 'spool');
const STORE = path.join(HOOK_DIR, 'index.json');

// Events that mean "this session is now blocked on the human".
const NEEDS_YOU = new Set(['Notification']);

export function emptyIndex() {
  return { byPane: new Map(), bySession: new Map() };
}

function toIndex(records) {
  const idx = emptyIndex();
  for (const r of Object.values(records)) {
    if (r.session_id) idx.bySession.set(r.session_id, r);
    if (r.paneId) idx.byPane.set(r.paneId, r);
  }
  return idx;
}

export function loadIndex() {
  const records = readJSON(STORE, {}) || {};
  return { records, index: toIndex(records) };
}

function short(tool, input) {
  if (!input) return '';
  return String(input.description || input.file_path || input.command || input.pattern || input.query || '').slice(0, 80);
}

/** Drain the spool directory and fold events into the per-session index. */
export function drain(records) {
  let names;
  try { names = fs.readdirSync(SPOOL); } catch { return { records, index: toIndex(records), changed: false }; }
  const files = names.filter((n) => n.endsWith('.evt')).sort();
  let changed = false;

  for (const n of files) {
    const full = path.join(SPOOL, n);
    let raw;
    try { raw = fs.readFileSync(full, 'utf8'); } catch { continue; }
    try { fs.unlinkSync(full); } catch { /* another drainer got it */ }

    const nl1 = raw.indexOf('\n');
    const nl2 = raw.indexOf('\n', nl1 + 1);
    if (nl1 < 0 || nl2 < 0) continue;
    const event = raw.slice(0, nl1).trim();
    const paneId = raw.slice(nl1 + 1, nl2).trim() || null;
    let payload;
    try { payload = JSON.parse(raw.slice(nl2 + 1)); } catch { continue; }

    const sid = payload.session_id;
    if (!sid) continue;
    const at = Number(n.split('-')[0]) / 1e6 || Date.now();
    const prev = records[sid] || {};
    const rec = {
      ...prev,
      session_id: sid,
      paneId: paneId || prev.paneId || null,
      transcript_path: payload.transcript_path || prev.transcript_path || null,
      cwd: payload.cwd || prev.cwd || null,
      permission_mode: payload.permission_mode || prev.permission_mode || null,
      event,
      at,
    };

    switch (event) {
      case 'SessionStart': rec.startedAt = at; rec.ended = false; break;
      case 'SessionEnd': rec.ended = true; break;
      case 'UserPromptSubmit': rec.turnStartAt = at; rec.tool = null; rec.needsYou = false; rec.toolCount = 0; break;
      case 'PreToolUse': rec.tool = { name: payload.tool_name, arg: short(payload.tool_name, payload.tool_input), at }; break;
      case 'PostToolUse': rec.tool = null; rec.toolCount = (rec.toolCount || 0) + 1; break;
      case 'Notification': rec.needsYou = true; rec.message = payload.message || null; break;
      case 'Stop': rec.needsYou = false; rec.tool = null; rec.lastAssistant = payload.last_assistant_message || null; break;
      default: break;
    }
    records[sid] = rec;
    changed = true;
  }

  // A pane can only host one session; the newest SessionStart wins.
  if (changed) {
    const byPane = new Map();
    for (const r of Object.values(records)) {
      if (!r.paneId || r.ended) continue;
      const cur = byPane.get(r.paneId);
      if (!cur || (r.startedAt || r.at) > (cur.startedAt || cur.at)) byPane.set(r.paneId, r);
    }
    for (const r of Object.values(records)) {
      if (r.paneId && byPane.get(r.paneId) !== r) r.paneId = null;
    }
    // Forget sessions that ended over a day ago.
    const cutoff = Date.now() - 24 * 3600 * 1000;
    for (const [k, r] of Object.entries(records)) if (r.ended && r.at < cutoff) delete records[k];
    try { writeJSON(STORE, records); } catch { /* best effort */ }
  }

  return { records, index: toIndex(records), changed };
}

export { NEEDS_YOU };
