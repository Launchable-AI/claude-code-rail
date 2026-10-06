import path from 'node:path';
import { CLAUDE_DIR, HOME, USAGE, readJSON, writeJSON } from './paths.js';

// Claude Code asks the API for your plan windows only when a session opens
// /usage -- never as it works -- and it treats its own cached answer as expired
// after an hour. A rail that reads nothing but that cache is therefore exactly
// as fresh as the last time you looked, which is not what a status view is for.
//
// With `pollUsage` on, the collector asks the same endpoint /usage asks, using
// the OAuth token Claude Code has already stored. Strictly read-only: we never
// refresh, rewrite or transmit the token anywhere but to Anthropic, and an
// expired one is a poll we skip rather than one we try to fix -- the next
// Claude Code session refreshes it. The endpoint is undocumented, so every
// failure here is silent and falls back to Claude Code's own cache.

const MAIN_CONFIG = path.join(HOME, '.claude.json');
const ENDPOINT = '/api/oauth/usage';
const OAUTH_BETA = 'oauth-2025-04-20';

function apiBase() {
  const b = process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com';
  return b.replace(/\/+$/, '');
}

/** The credentials file belonging to a config file: one pair per account. */
function credentialsFor(configFile) {
  const f = configFile || MAIN_CONFIG;
  return f === MAIN_CONFIG
    ? path.join(CLAUDE_DIR, '.credentials.json')
    : path.join(path.dirname(f), '.credentials.json');
}

/**
 * The account's live OAuth token, or null when there is nothing usable: no
 * file (a keychain-backed macOS install), no OAuth (an API key), or a token
 * that has expired.
 */
function tokenFor(configFile) {
  const j = readJSON(credentialsFor(configFile), null);
  const o = j && j.claudeAiOauth;
  if (!o || typeof o.accessToken !== 'string' || !o.accessToken) return null;
  if (o.expiresAt && Number(o.expiresAt) <= Date.now()) return null;
  return o.accessToken;
}

/** What cc-rail has polled, per config file. Absent until the first poll. */
export function polledUsage() {
  const s = readJSON(USAGE, {}) || {};
  return s.accounts || {};
}

/**
 * Refresh each account's plan windows. Answers are stored per config file in
 * the same shape Claude Code caches, so a reader can treat both sources alike
 * and simply take the newer. A failure keeps the last good answer and records
 * why, for `cc-rail doctor`.
 */
export async function pollUsage(configFiles, { timeoutMs = 5000 } = {}) {
  const files = [...new Set((configFiles && configFiles.length ? configFiles : [null])
    .map((f) => f || MAIN_CONFIG))];
  const state = readJSON(USAGE, {}) || {};
  const accounts = state.accounts || {};
  let changed = false;

  for (const file of files) {
    const rec = accounts[file] || {};
    accounts[file] = rec;
    const fail = (why) => { rec.error = why; rec.errorAt = Date.now(); changed = true; };

    const token = tokenFor(file);
    if (!token) { fail('no usable oauth token'); continue; }
    try {
      const res = await fetch(apiBase() + ENDPOINT, {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'anthropic-beta': OAUTH_BETA,
        },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) { fail(`http ${res.status}`); continue; }
      const body = await res.json();
      // The response body is the utilization object itself.
      if (!body || typeof body !== 'object') { fail('unexpected response'); continue; }
      rec.fetchedAtMs = Date.now();
      rec.utilization = body;
      delete rec.error;
      delete rec.errorAt;
      changed = true;
    } catch (err) {
      fail(String((err && err.message) || err).slice(0, 80));
    }
  }

  if (changed) {
    try { writeJSON(USAGE, { at: Date.now(), accounts }); } catch { /* next poll retries */ }
  }
  return accounts;
}
