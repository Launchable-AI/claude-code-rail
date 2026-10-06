const ESC = String.fromCharCode(27);
const CSI = ESC + '[';

export const alt = { on: CSI + '?1049h', off: CSI + '?1049l' };
export const cursor = { hide: CSI + '?25l', show: CSI + '?25h', home: CSI + 'H' };
// Colour-scheme notifications: the terminal (tmux >= 3.6 relays them) sends
// ESC [ ? 997 ; 1|2 n whenever it switches dark/light; 996n asks for it now.
export const themeReports = { on: CSI + '?2031h' + CSI + '?996n', off: CSI + '?2031l' };
export const clearBelow = CSI + 'J';
// Normal tracking + SGR extended coordinates (so columns/rows past 223 work).
export const mouse = {
  on: CSI + '?1000h' + CSI + '?1006h',
  off: CSI + '?1006l' + CSI + '?1000l',
};
export const clearLine = CSI + 'K';

export const fg = (n) => CSI + '38;5;' + n + 'm';
export const bg = (n) => CSI + '48;5;' + n + 'm';
export const bold = CSI + '1m';
export const dim = CSI + '2m';
export const reset = CSI + '0m';
export const at = (row, col = 1) => CSI + row + ';' + col + 'H';

const ANSI_RE = new RegExp(ESC + '\\[[0-9;?]*[a-zA-Z]', 'g');

const WIDE = [
  [0x1100, 0x115f], [0x2e80, 0xa4cf], [0xac00, 0xd7a3], [0xf900, 0xfaff],
  [0xfe30, 0xfe6f], [0xff00, 0xff60], [0xffe0, 0xffe6],
  [0x1f300, 0x1f64f], [0x1f900, 0x1f9ff], [0x20000, 0x3fffd],
];

function charWidth(cp) {
  if (cp === 0x200d || (cp >= 0xfe00 && cp <= 0xfe0f)) return 0; // ZWJ / variation selectors
  for (const [a, b] of WIDE) if (cp >= a && cp <= b) return 2;
  return 1;
}

export function stripAnsi(s) {
  return String(s).replace(ANSI_RE, '');
}

/** Display width in terminal cells, ignoring escape sequences. */
export function width(s) {
  let w = 0;
  for (const ch of stripAnsi(s)) w += charWidth(ch.codePointAt(0));
  return w;
}

/** Truncate to `max` cells, appending an ellipsis when it does not fit. */
export function truncate(s, max) {
  if (max <= 0) return '';
  if (width(s) <= max) return String(s);
  let out = '';
  let w = 0;
  for (const ch of String(s)) {
    const cw = charWidth(ch.codePointAt(0));
    if (w + cw > max - 1) break;
    out += ch;
    w += cw;
  }
  return out + '…';
}

/** Pad (or clip) a plain string to exactly `n` cells. */
export function fit(s, n) {
  const t = truncate(s, n);
  return t + ' '.repeat(Math.max(0, n - width(t)));
}

/**
 * Clamp a *styled* string to `max` cells, passing escape sequences through
 * without counting them. A line that reaches the pane's last column wraps, so
 * every rendered row goes through this.
 */
export function clampAnsi(s, max) {
  const str = String(s);
  let out = '';
  let w = 0;
  let i = 0;
  while (i < str.length) {
    if (str[i] === ESC) {
      const m = /^\[[0-9;?]*[a-zA-Z]/.exec(str.slice(i + 1));
      if (m) { out += str.slice(i, i + 1 + m[0].length); i += 1 + m[0].length; continue; }
      i += 1;
      continue;
    }
    const cp = str.codePointAt(i);
    const ch = String.fromCodePoint(cp);
    const cw = charWidth(cp);
    if (w + cw > max) break;
    out += ch;
    w += cw;
    i += ch.length;
  }
  return out;
}

const BEL = String.fromCharCode(7);

/**
 * Ask the terminal for its own background colour (OSC 11) and decide whether it
 * is light or dark. Terminals that support it answer within a few ms; ones that
 * do not answer nothing at all, so this resolves to null on a short timeout
 * rather than hanging. Inside tmux the query is relayed to the attached client.
 *
 * Must run before raw-mode key handling is installed, or the reply is parsed as
 * keystrokes.
 */
export function probeBackground(timeoutMs = 150) {
  return new Promise((resolve) => {
    const inp = process.stdin;
    if (!inp.isTTY || !process.stdout.isTTY) return resolve(null);
    let buf = '';
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      inp.off('data', onData);
      resolve(v);
    };
    const onData = (d) => {
      buf += d.toString('latin1');
      // rgb:RRRR/GGGG/BBBB, or rgb:RR/GG/BB on terminals that answer short.
      const m = /rgb:([0-9a-fA-F]+)\/([0-9a-fA-F]+)\/([0-9a-fA-F]+)/.exec(buf);
      if (!m) return;
      const chan = (h) => parseInt(h.slice(0, 2).padEnd(2, h.slice(-1)), 16) / 255;
      const lin = (v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
      const [r, g, b] = [m[1], m[2], m[3]].map((h) => lin(chan(h)));
      const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      finish(lum > 0.4 ? 'light' : 'dark');
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    try { inp.setRawMode(true); } catch { return finish(null); }
    inp.on('data', onData);
    inp.resume();
    process.stdout.write(ESC + ']11;?' + BEL);
    // Raw mode is left ON deliberately. The caller is about to set it up for
    // real, and a deferred restore here would race that and land AFTER it --
    // switching raw mode back off under a running TUI, which kills every key
    // and makes the terminal echo mouse reports onto the screen.
  });
}
