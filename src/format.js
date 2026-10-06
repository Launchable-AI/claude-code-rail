/** Compact, glanceable durations: 8s, 4m, 1h20m, 3d. */
export function dur(ms) {
  if (!ms || ms < 0) return '';
  const s = Math.floor(ms / 1000);
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm';
  const h = Math.floor(m / 60);
  if (h < 24) return h + 'h' + (m % 60 ? (m % 60) + 'm' : '');
  return Math.floor(h / 24) + 'd';
}

export function tokens(n) {
  if (!n) return '';
  if (n < 1000) return String(n);
  if (n < 1000000) return Math.round(n / 1000) + 'k';
  return (n / 1000000).toFixed(1) + 'M';
}

export function modelShort(m) {
  if (!m) return '';
  return String(m)
    .replace(/^claude-/, '')
    .replace(/-(\d{8})$/, '')
    .replace(/-latest$/, '');
}

/** Greedy wrap to a column width; returns an array of lines. */
export function wrap(text, w, maxLines = 99) {
  const out = [];
  for (const para of String(text || '').split('\n')) {
    let line = '';
    for (const word of para.split(/\s+/).filter(Boolean)) {
      if (!line) { line = word.slice(0, w); continue; }
      if (line.length + 1 + word.length <= w) line += ' ' + word;
      else { out.push(line); line = word.slice(0, w); }
      if (out.length >= maxLines) return out.slice(0, maxLines);
    }
    if (line) out.push(line);
    if (out.length >= maxLines) return out.slice(0, maxLines);
  }
  return out.slice(0, maxLines);
}
