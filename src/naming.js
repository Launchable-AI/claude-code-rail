const MAX = 18;

function clean(s) {
  return String(s).replace(/\s+/g, ' ').trim().slice(0, MAX + 4);
}

/**
 * A window name for a session. An explicit name (-n or /rename) is the user's
 * own word for the session and is used as-is; an AI title is derived, so it
 * gets kebab-cased and cut at a word boundary to fit a status bar.
 */
export function windowNameFor(session) {
  if (session.sessionName) return clean(session.sessionName);
  const source = session.aiTitle || session.title || '';
  const words = source.toLowerCase().replace(/[^a-z0-9\s-]+/g, ' ').split(/\s+/).filter(Boolean);
  let out = '';
  for (const w of words) {
    const next = out ? out + '-' + w : w;
    if (out && next.length > MAX) break;
    out = next;
    if (out.length >= MAX) break;
  }
  return out || 'claude';
}

/** The pane a session lives in, as a number, so ids sort by age not by string. */
function paneAge(session) {
  const n = Number(String(session.paneId || '').replace('%', ''));
  return Number.isFinite(n) ? n : Number.MAX_SAFE_INTEGER;
}

/**
 * One window, one name. Two sessions in a window each want the window called
 * something different, and honouring both means renaming it twice a tick for
 * as long as they both live -- the name flickers and neither is ever right.
 * So it takes the name of whichever session opened the window and says how
 * many others are in there with it: `sms-rollout +1`.
 */
export function windowNameForWindow(sessions) {
  const ordered = [...sessions].sort((a, b) => paneAge(a) - paneAge(b));
  const base = windowNameFor(ordered[0]);
  if (ordered.length < 2) return base;
  const tag = '+' + (ordered.length - 1);
  const room = MAX + 4 - tag.length - 1;
  return base.slice(0, room).replace(/-+$/, '') + ' ' + tag;
}

import os from 'node:os';
import path from 'node:path';

const HOSTNAME = os.hostname().toLowerCase();
const GENERIC = new Set(['bash', 'zsh', 'sh', 'fish', 'node', 'claude', 'tmux', 'shell', '']);

/**
 * Is this window name one nobody chose? tmux's own default (the command), the
 * hostname, or the cwd's basename all carry no information about the session.
 * A name the user picked is left alone.
 */
export function isGenericWindowName(name, session) {
  const n = String(name || '').trim().toLowerCase();
  if (GENERIC.has(n)) return true;
  if (n === HOSTNAME) return true;
  if (session && session.cwd && n === path.basename(session.cwd).toLowerCase()) return true;
  return false;
}
