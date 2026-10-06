import fs from 'node:fs';
import os from 'node:os';

// The machine the sessions are running on: how busy its CPUs are, how much
// memory is spoken for, how full its disk is. Read from the OS each time,
// never cached on disk -- it is cheap, and every rail reads the same machine.

function cpuTimes() {
  let idle = 0;
  let total = 0;
  for (const c of os.cpus()) {
    const t = c.times;
    idle += t.idle;
    total += t.user + t.nice + t.sys + t.idle + t.irq;
  }
  return { idle, total };
}

/**
 * CPU is a rate, so it needs two readings; the first call primes the sampler
 * and returns null rather than a since-boot average that would read as "idle".
 */
export function cpuSampler() {
  let prev = cpuTimes();
  return () => {
    const cur = cpuTimes();
    const dTotal = cur.total - prev.total;
    const dIdle = cur.idle - prev.idle;
    prev = cur;
    if (dTotal <= 0) return null;
    return Math.max(0, Math.min(100, Math.round(100 * (1 - dIdle / dTotal))));
  };
}

/**
 * Memory in use, counting page cache as free: on Linux MemAvailable is the
 * kernel's own estimate of what a new process could get, where os.freemem()
 * would report a busy box as nearly full just because it caches files.
 */
export function memPercent(meminfo = null) {
  let text = meminfo;
  if (text == null) {
    try { text = fs.readFileSync('/proc/meminfo', 'utf8'); } catch { text = ''; }
  }
  const kb = (k) => {
    const m = new RegExp('^' + k + ':\\s+(\\d+)', 'm').exec(text);
    return m ? Number(m[1]) : null;
  };
  const total = kb('MemTotal');
  const avail = kb('MemAvailable');
  if (total && avail != null) return Math.round(100 * (1 - avail / total));
  return Math.round(100 * (1 - os.freemem() / os.totalmem()));
}

/** How full the filesystem holding `dir` is, as df reports it (blocks a user can get). */
export function diskPercent(dir = '/') {
  try {
    const s = fs.statfsSync(dir);
    const used = s.blocks - s.bfree;
    const denom = used + s.bavail;
    return denom > 0 ? Math.round((100 * used) / denom) : null;
  } catch {
    return null;
  }
}
