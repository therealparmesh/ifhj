/**
 * Synthwave '84 palette (Robb Owen) — out of the box. Jira, but neon.
 * https://github.com/robb0wen/synthwave-vscode — lifted from the canonical
 * theme JSON and README. Every hex below maps to a real token/chrome color
 * from the theme, not a fan interpretation.
 */
export const theme = {
  // Chrome / surfaces
  bg: "#262335", // editor.background
  bgPanel: "#241b2f", // sideBar / statusBar / tab group
  bgDeep: "#171520", // activityBar (darkest chrome)

  // Foreground text
  fg: "#f9f9fa", // generic off-white
  fgDim: "#b6b1b1", // punctuation / separators
  muted: "#848bbd", // comments

  // Accents — the neon core palette
  pink: "#ff7edb", // variables, the signature Synthwave hot pink
  cyan: "#36f9f6", // functions
  ok: "#72f1b8", // mint (tags, control keywords)
  warn: "#fede5d", // keywords
  orange: "#f97e72", // cursor / badge — the signature coral
  err: "#fe4450", // language keywords (red)
  /**
   * lavender — not a canonical token, but the only readable Synthwave purple
   * for foreground text (Epics, parent links).
   */
  violet: "#b893ce",

  // Derived roles
  accent: "#ff7edb", // alias for pink — the focus/selection color
  accentDim: "#2a2139", // input / dropdown bg — good for filled selection rows
  matchBg: "#463465", // menu violet — subtle highlight for search matches
};

export const typeColors: Record<string, string> = {
  Bug: theme.err,
  Story: theme.ok,
  Task: theme.cyan,
  Epic: theme.violet,
  "Sub-task": theme.muted,
  Subtask: theme.muted,
  Spike: theme.warn,
};

export function typeGlyph(type: string): string {
  const t = type.toLowerCase();
  if (t.includes("bug")) return "■";
  if (t.includes("epic")) return "◆";
  if (t.includes("story")) return "●";
  if (t.includes("sub")) return "▸";
  if (t.includes("spike")) return "◇";
  return "▪";
}

export function truncate(s: string, n: number): string {
  if (n <= 0) return "";
  return s.length <= n ? s : s.slice(0, Math.max(0, n - 1)) + "…";
}

export function initials(name: string | undefined | null): string {
  if (!name) return "—";
  const parts = name
    .trim()
    .split(/\s+/)
    .filter((p) => p.length > 0);
  if (parts.length === 0) return "—";
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts.at(-1)![0]!).toUpperCase();
}

const ASSIGNEE_PALETTE = [
  theme.pink,
  theme.cyan,
  theme.ok,
  theme.warn,
  theme.orange,
  theme.violet,
  theme.err,
  theme.fg,
];

export function assigneeColor(name: string | undefined | null): string {
  if (!name) return theme.muted;
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return ASSIGNEE_PALETTE[h % ASSIGNEE_PALETTE.length]!;
}

export function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

export function bg(color: string | undefined): { backgroundColor: string } | Record<string, never> {
  return color ? { backgroundColor: color } : {};
}

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export async function openInBrowser(url: string): Promise<void> {
  const platform = process.platform;
  const cmd =
    platform === "darwin"
      ? ["open", url]
      : platform === "win32"
        ? ["cmd", "/c", "start", "", url]
        : ["xdg-open", url];
  const proc = Bun.spawn(cmd, { stdio: ["ignore", "ignore", "ignore"] });
  await proc.exited;
  if (proc.exitCode !== 0)
    throw new Error(`failed to open browser (${cmd[0]} exit ${proc.exitCode})`);
}
