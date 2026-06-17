// Minimal ANSI escape stripper so kernel tracebacks (which arrive colorized)
// render legibly as plain text in Phase 1. Full ANSI-color rendering of
// tracebacks is a Phase 2 nicety.
//
// Matches CSI SGR color sequences: ESC "[" <params> "m".
const ANSI_CSI = /\x1b\[[0-9;]*m/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_CSI, "");
}
