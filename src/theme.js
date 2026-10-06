// 256-colour palettes. The default follows the terminal's own background so the
// rail sits inside the user's tmux theme instead of fighting it.
//
// Both are built so every colour that carries text clears WCAG AA against its
// background, and the three-step hierarchy (text > muted > faint) is carried by
// the greys themselves rather than by the SGR "dim" attribute. dim is not
// measurable: terminals disagree about whether it applies to indexed colours at
// all, and where it does it halves contrast on top of an already recessive
// grey. That is what made the secondary rows unreadable. `soft` keeps the seam
// in case a palette ever wants it back.
const LIGHT = {
  text: 235, muted: 240, faint: 242, rule: 250,
  alert: 124, ready: 28, working: 25, idle: 243,
  // The selection band stays light with dark text: a dark band would need pale
  // status glyphs drawn on it, and those are the colours that must stay legible
  // against the page everywhere else.
  cursorFg: 17, cursorBg: 153, headFg: 238,
  soft: '',
};

const DARK = {
  text: 252, muted: 247, faint: 243, rule: 238,
  alert: 203, ready: 78, working: 75, idle: 245,
  cursorFg: 231, cursorBg: 24, headFg: 250,
  soft: '',
};

export const PALETTES = { light: LIGHT, dark: DARK };

/**
 * `probed` is what the terminal itself answered when asked for its background
 * (see probeBackground); it is the only signal that is actually about this
 * terminal, so it outranks everything but an explicit setting.
 *
 * When nothing answers, guess dark. Guessing wrong is bad either way, but a
 * light palette on a dark terminal is near-black on near-black -- the text
 * disappears completely -- and dark terminals are the common case.
 */
export function pickTheme(pref, probed = null) {
  const p = pref || process.env.CC_RAIL_THEME || 'auto';
  if (p === 'light') return LIGHT;
  if (p === 'dark') return DARK;
  if (probed === 'light') return LIGHT;
  if (probed === 'dark') return DARK;
  // COLORFGBG is "fg;bg"; a high bg index means a light background.
  const cfb = process.env.COLORFGBG;
  if (cfb) {
    const bg = Number(cfb.split(';').pop());
    if (Number.isFinite(bg)) return bg >= 7 ? LIGHT : DARK;
  }
  return DARK;
}

export const STATUS = {
  permission: { glyph: '!', label: 'needs you', key: 'alert' },
  yourturn: { glyph: '●', label: 'your turn', key: 'ready' },
  working: { glyph: null, label: 'working', key: 'working' },
  idle: { glyph: '·', label: 'idle', key: 'idle' },
  unknown: { glyph: '?', label: 'unknown', key: 'muted' },
  exited: { glyph: '×', label: 'exited', key: 'faint' },
};

export const FEED = { done: '✓', fail: '✗', say: '●', ask: '❯' };

export const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
