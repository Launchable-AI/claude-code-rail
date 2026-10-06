import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { summarize } from '../src/transcript.js';

function transcript(lines) {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ccr-')), 's.jsonl');
  fs.writeFileSync(f, lines.map((l) => JSON.stringify({ sessionId: 's', ...l })).join('\n') + '\n');
  return f;
}

const reply = { type: 'assistant', timestamp: '2026-10-01T10:00:00Z', message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } };

test('injected task notifications and meta records are not human turns', () => {
  const s = summarize(transcript([
    reply,
    { type: 'user', timestamp: '2026-10-01T10:05:00Z', message: { role: 'user', content: '<task-notification>\n<fork-source>forked</fork-source>' } },
    { type: 'user', timestamp: '2026-10-01T10:06:00Z', isMeta: true, message: { role: 'user', content: 'The user named this session "x".' } },
    { type: 'user', timestamp: '2026-10-01T10:07:00Z', message: { role: 'user', content: '<bash-input>ls</bash-input>' } },
  ]));
  assert.ok(s.lastHumanAt <= s.lastAssistantAt);
});

test('a typed prompt after the last reply still counts', () => {
  const s = summarize(transcript([
    reply,
    { type: 'user', timestamp: '2026-10-01T10:05:00Z', promptSource: 'typed', message: { role: 'user', content: 'go' } },
  ]));
  assert.ok(s.lastHumanAt > s.lastAssistantAt);
});
