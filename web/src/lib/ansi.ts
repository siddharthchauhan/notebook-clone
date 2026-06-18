// ANSI handling for kernel output. Tracebacks arrive colorized with ANSI SGR
// escape sequences; `ansiToHtml` renders them as colored spans, while
// `stripAnsi` (used where plain text is wanted, e.g. the inspect panel) removes
// them. Matches CSI SGR sequences: ESC "[" <params> "m".
const ANSI_CSI = /\x1b\[[0-9;]*m/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_CSI, "");
}

// Standard and bright 16-color palette (VS Code dark-ish theme).
const STD = [
  "#000000", "#cd3131", "#0dbc79", "#e5e510",
  "#2472c8", "#bc3fbc", "#11a8cd", "#e5e5e5",
];
const BRIGHT = [
  "#666666", "#f14c4c", "#23d18b", "#f5f543",
  "#3b8eea", "#d670d6", "#29b8db", "#ffffff",
];

const rgb = (r: number, g: number, b: number) => `rgb(${r},${g},${b})`;

function color256(n: number): string {
  if (n < 8) return STD[n];
  if (n < 16) return BRIGHT[n - 8];
  if (n < 232) {
    const c = n - 16;
    const v = (x: number) => (x ? 55 + x * 40 : 0);
    return rgb(v(Math.floor(c / 36)), v(Math.floor((c % 36) / 6)), v(c % 6));
  }
  const g = 8 + (n - 232) * 10;
  return rgb(g, g, g);
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Convert ANSI SGR-colored text to safe HTML (foreground color + bold). All
// literal text is HTML-escaped; only our own <span> tags are emitted.
export function ansiToHtml(input: string): string {
  const re = /\x1b\[([0-9;]*)m/g;
  let out = "";
  let last = 0;
  let fg: string | null = null;
  let bold = false;
  let m: RegExpExecArray | null;

  const emit = (text: string) => {
    if (!text) return;
    const safe = escapeHtml(text);
    if (!fg && !bold) {
      out += safe;
      return;
    }
    const styles = [];
    if (fg) styles.push(`color:${fg}`);
    if (bold) styles.push("font-weight:bold");
    out += `<span style="${styles.join(";")}">${safe}</span>`;
  };

  while ((m = re.exec(input)) !== null) {
    emit(input.slice(last, m.index));
    last = re.lastIndex;
    const codes = m[1] === "" ? [0] : m[1].split(";").map(Number);
    for (let i = 0; i < codes.length; i++) {
      const c = codes[i];
      if (c === 0) {
        fg = null;
        bold = false;
      } else if (c === 1) {
        bold = true;
      } else if (c === 22) {
        bold = false;
      } else if (c >= 30 && c <= 37) {
        fg = STD[c - 30];
      } else if (c >= 90 && c <= 97) {
        fg = BRIGHT[c - 90];
      } else if (c === 39) {
        fg = null;
      } else if (c === 38) {
        if (codes[i + 1] === 5) {
          fg = color256(codes[i + 2]);
          i += 2;
        } else if (codes[i + 1] === 2) {
          fg = rgb(codes[i + 2], codes[i + 3], codes[i + 4]);
          i += 4;
        }
      }
    }
  }
  emit(input.slice(last));
  return out;
}
