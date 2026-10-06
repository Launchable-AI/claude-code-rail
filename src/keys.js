const ESC = String.fromCharCode(27);
const CTRL_C = String.fromCharCode(3);
const BEL = String.fromCharCode(7);
const BACKSPACE = String.fromCharCode(8);
const DEL = String.fromCharCode(127);

const ARROWS = { A: 'up', B: 'down', C: 'right', D: 'left', H: 'home', F: 'end' };

// SGR mouse report: ESC [ < button ; col ; row (M press | m release)
const SGR_MOUSE = /^\[<(\d+);(\d+);(\d+)([Mm])/;

// Theme report (mode 2031 / DSR 996): ESC [ ? 997 ; 1 n is dark, 2 is light.
const THEME_REPORT = /^\[\?997;([12])n/;

/** Decode a raw stdin chunk into logical key names. */
export function decodeKeys(buf) {
  const s = buf.toString('utf8');
  const keys = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === CTRL_C) { keys.push('ctrl-c'); i += 1; continue; }
    if (c === '\r' || c === '\n') { keys.push('enter'); i += 1; continue; }
    if (c === '\t') { keys.push('tab'); i += 1; continue; }
    if (c === BACKSPACE || c === DEL) { keys.push('backspace'); i += 1; continue; }
    if (c === ESC) {
      const a = s[i + 1];
      const b = s[i + 2];
      if ((a === '[' || a === 'O') && ARROWS[b]) { keys.push(ARROWS[b]); i += 3; continue; }
      if (a === '[' && b === '<') {
        const m = SGR_MOUSE.exec(s.slice(i + 1));
        if (m) {
          const raw = Number(m[1]);
          keys.push({
            type: 'mouse',
            button: raw & 3,
            wheel: raw & 64 ? (raw & 1 ? 'down' : 'up') : null,
            x: Number(m[2]),
            y: Number(m[3]),
            press: m[4] === 'M',
          });
          i += 1 + m[0].length;
          continue;
        }
      }
      if (a === '[' && b === '?') {
        const m = THEME_REPORT.exec(s.slice(i + 1));
        if (m) {
          keys.push({ type: 'theme', value: m[1] === '1' ? 'dark' : 'light' });
          i += 1 + m[0].length;
          continue;
        }
      }
      if (a === ']') {
        // OSC: a terminal reply (e.g. a late answer to our background query).
        // Runs to BEL or ST; decoding it as keys would fire real commands.
        let j = i + 2;
        while (j < s.length && s[j] !== BEL && !(s[j] === ESC && s[j + 1] === '\\')) j += 1;
        i = j + (s[j] === ESC ? 2 : 1);
        continue;
      }
      if (a === '[') { // swallow any other CSI sequence rather than emit junk
        let j = i + 2;
        while (j < s.length && !/[a-zA-Z~]/.test(s[j])) j += 1;
        i = j + 1;
        continue;
      }
      keys.push('escape');
      i += 1;
      continue;
    }
    if (c < ' ') { i += 1; continue; } // ignore other control bytes
    keys.push(c);
    i += 1;
  }
  return keys;
}
