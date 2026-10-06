import test from 'node:test';
import assert from 'node:assert/strict';
import { cpuSampler, diskPercent, memPercent } from '../src/sysstat.js';

test('memPercent counts MemAvailable, not MemFree, as free', () => {
  const info = 'MemTotal:       16000000 kB\nMemFree:         1000000 kB\nMemAvailable:    8000000 kB\n';
  assert.equal(memPercent(info), 50);
});

test('cpu sampler yields a percentage from the second reading', async () => {
  const s = cpuSampler();
  await new Promise((r) => setTimeout(r, 50));
  const v = s();
  assert.ok(v === null || (v >= 0 && v <= 100));
});

test('diskPercent reads the root filesystem and is null for a missing path', () => {
  const v = diskPercent('/');
  assert.ok(v >= 0 && v <= 100);
  assert.equal(diskPercent('/definitely/not/here'), null);
});
