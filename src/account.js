import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { polledUsage } from './usage.js';

// Claude Code keeps two things in its config file that the rail wants and
// cannot get anywhere else: the plan-limit bars behind /usage, and which
// account a session is signed in as. Both are read-only for us.
const HOME = os.homedir();
const MAIN_CONFIG = path.join(HOME, '.claude.json');

const cache = new Map(); // config file -> { mtimeMs, size, data }

/** Parse a config file at most once per change. It is ~90KB and read every tick. */
function config(file) {
  let st;
  try { st = fs.statSync(file); } catch { cache.delete(file); return null; }
  const hit = cache.get(file);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.data;
  let data = null;
  try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { data = hit ? hit.data : null; }
  cache.set(file, { mtimeMs: st.mtimeMs, size: st.size, data });
  return data;
}

// ------------------------------------------------------------------ plan usage

const KIND_LABEL = { session: '5h', weekly_all: 'wk' };

function labelFor(l) {
  if (KIND_LABEL[l.kind]) return KIND_LABEL[l.kind];
  const m = l.scope && l.scope.model;
  if (m && m.display_name) return String(m.display_name).toLowerCase();
  const s = l.scope && l.scope.surface;
  if (s && s.display_name) return String(s.display_name).toLowerCase();
  return l.kind === 'weekly_scoped' ? 'wk*' : String(l.kind || '').slice(0, 6);
}

/**
 * The limit windows /usage draws: session (5h), weekly, and any scoped weekly
 * window such as Fable. Claude Code refreshes this whenever a session makes a
 * request, so it is fresh while anything is running and goes stale when idle.
 */
export function usageSnapshot(file = MAIN_CONFIG) {
  const key = file || MAIN_CONFIG;
  // Two possible readings of the same windows: the one Claude Code cached when
  // someone last opened /usage, and the one the collector polled itself if
  // `pollUsage` is on. Neither is authoritative, so take the newer.
  const j = config(key);
  const cc = j && j.cachedUsageUtilization;
  const mine = polledUsage()[key];
  const best = [cc, mine]
    .filter((r) => r && r.utilization)
    .sort((a, b) => (b.fetchedAtMs || 0) - (a.fetchedAtMs || 0))[0];
  const u = best && best.utilization;
  if (!u) return null;
  const at = best.fetchedAtMs || 0;

  // `limits` is the current, self-describing shape and the one /usage renders;
  // the flat five_hour/seven_day keys are the older fallback.
  let rows = [];
  if (Array.isArray(u.limits) && u.limits.length) {
    rows = u.limits
      .filter((l) => l && typeof l.percent === 'number')
      .map((l) => ({
        label: labelFor(l),
        pct: Math.round(l.percent),
        severity: l.severity || 'normal',
        resetsAt: l.resets_at ? Date.parse(l.resets_at) : null,
      }));
  } else {
    for (const [k, label] of [['five_hour', '5h'], ['seven_day', 'wk']]) {
      const w = u[k];
      if (!w || typeof w.utilization !== 'number') continue;
      rows.push({
        label,
        pct: Math.round(w.utilization),
        severity: 'normal',
        resetsAt: w.resets_at ? Date.parse(w.resets_at) : null,
      });
    }
  }
  if (!rows.length) return null;

  // Extra usage (credits) only matters once it is switched on.
  const x = u.extra_usage;
  if (x && x.is_enabled && typeof x.utilization === 'number') {
    rows.push({ label: 'credit', pct: Math.round(x.utilization), severity: x.severity || 'normal', resetsAt: null });
  }
  return { at, rows };
}

// -------------------------------------------------------------- which account

/** CLAUDE_CONFIG_DIR moves the whole config, and with it the signed-in account. */
function configDirOf(pid) {
  if (!pid) return null;
  let raw;
  try { raw = fs.readFileSync(`/proc/${pid}/environ`, 'utf8'); } catch { return null; }
  const env = {};
  for (const kv of raw.split('\0')) {
    const i = kv.indexOf('=');
    if (i > 0) env[kv.slice(0, i)] = kv.slice(i + 1);
  }
  return env;
}

const accounts = new Map(); // pid -> { at, info }
const ACCOUNT_TTL = 60000;  // a session cannot change account without restarting
const NO_ACCOUNT = { email: null, config: null };

/**
 * The account a session is signed in as, and the config file that account keeps
 * its plan usage in. Sessions only differ here when they were started with
 * their own CLAUDE_CONFIG_DIR or their own API key, so the answer is fixed for
 * the life of the process and worth caching hard.
 */
export function accountFor(pid) {
  if (!pid) return NO_ACCOUNT;
  const hit = accounts.get(pid);
  if (hit && Date.now() - hit.at < ACCOUNT_TTL) return hit.info;
  const env = configDirOf(pid);
  let info = NO_ACCOUNT;
  if (env) {
    if (env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN) {
      // Billed straight to a key: there is no plan window to report.
      info = { email: 'api key', config: null };
    } else {
      const file = env.CLAUDE_CONFIG_DIR ? path.join(env.CLAUDE_CONFIG_DIR, '.claude.json') : MAIN_CONFIG;
      const j = config(file);
      const email = j && j.oauthAccount && j.oauthAccount.emailAddress;
      info = { email: email ? String(email) : null, config: file };
    }
  }
  accounts.set(pid, { at: Date.now(), info });
  return info;
}

/** The part worth showing in a 34-column rail: the local part of the address. */
export function accountShort(a) {
  if (!a) return '';
  const i = a.indexOf('@');
  return i > 0 ? a.slice(0, i) : a;
}
