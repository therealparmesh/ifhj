/**
 * Theme contract. Values are either hex strings (opinionated palettes like
 * Synthwave) or named ANSI colors (e.g. "cyan", "gray") that Ink passes
 * through to the terminal — letting the user's own terminal palette decide
 * how they render. "Terminal show-through" for surface backgrounds comes
 * from components choosing not to paint `backgroundColor`, not from theme
 * values being undefined — every slot holds a concrete color.
 */
export type Theme = {
  bg: string;
  bgPanel: string;
  bgDeep: string;
  fg: string;
  fgDim: string;
  muted: string;
  pink: string;
  cyan: string;
  ok: string;
  warn: string;
  orange: string;
  err: string;
  violet: string;
  accent: string;
  accentDim: string;
  matchBg: string;
};

/**
 * Synthwave '84 palette (Robb Owen) — out of the box. Jira, but neon.
 * https://github.com/robb0wen/synthwave-vscode — lifted from the canonical
 * theme JSON and README. Every hex below maps to a real token/chrome color
 * from the theme, not a fan interpretation.
 */
export const synthwaveTheme: Theme = {
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
  // lavender — not a canonical token, but the only readable Synthwave
  // purple for foreground text (Epics, parent links).
  violet: "#b893ce",

  // Derived roles
  accent: "#ff7edb", // alias for pink — the focus/selection color
  accentDim: "#2a2139", // input / dropdown bg — good for filled selection rows
  matchBg: "#463465", // menu violet — subtle highlight for search matches
};

/**
 * Terminal theme — defers to the user's terminal palette via named ANSI
 * colors (Ink emits e.g. \e[36m for "cyan"). The same binary looks correct
 * on a dark terminal (Dracula, Synthwave, tomorrow-night) and a light one
 * (Solarized Light, GitHub Light) without the app knowing which is which.
 *
 * `accentDim` is overloaded (used as both a subtle background for selected
 * rows and as a foreground for dividers/inactive borders) — we map both to
 * "gray" (ANSI bright-black). Not ideal, but readable.
 *
 * `bg`/`bgPanel`/`bgDeep` are unused as backgrounds in the current code
 * path (components don't paint surface chrome); `bg` is used once as a
 * foreground for inverted-cursor contrast, where "black" is the right call
 * regardless of terminal background — the cursor itself sits on a bright
 * accent color.
 */
export const terminalTheme: Theme = {
  bg: "black",
  bgPanel: "black",
  bgDeep: "black",
  fg: "white",
  fgDim: "gray",
  muted: "gray",
  pink: "magenta",
  cyan: "cyan",
  ok: "green",
  warn: "yellow",
  orange: "yellow",
  err: "red",
  violet: "magenta",
  accent: "magenta",
  accentDim: "gray",
  matchBg: "yellow",
};

export type ThemeName = "synthwave" | "terminal";

const THEMES: Record<ThemeName, Theme> = {
  synthwave: synthwaveTheme,
  terminal: terminalTheme,
};

export let theme: Theme = synthwaveTheme;

export function setTheme(name: ThemeName): void {
  theme = THEMES[name];
}

export function typeColor(type: string): string {
  switch (type) {
    case "Bug":
      return theme.err;
    case "Story":
      return theme.ok;
    case "Task":
      return theme.cyan;
    case "Epic":
      return theme.violet;
    case "Sub-task":
    case "Subtask":
      return theme.muted;
    case "Spike":
      return theme.warn;
    default:
      return theme.fg;
  }
}

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

function assigneePalette(): readonly string[] {
  return [
    theme.pink,
    theme.cyan,
    theme.ok,
    theme.warn,
    theme.orange,
    theme.violet,
    theme.err,
    theme.fg,
  ];
}

export function assigneeColor(name: string | undefined | null): string {
  if (!name) return theme.muted;
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  const palette = assigneePalette();
  return palette[h % palette.length]!;
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

export async function copyToClipboard(text: string): Promise<void> {
  const platform = process.platform;
  const cmd =
    platform === "darwin"
      ? ["pbcopy"]
      : platform === "win32"
        ? ["clip.exe"]
        : ["xclip", "-selection", "clipboard"];
  const proc = Bun.spawn(cmd, { stdin: "pipe" });
  proc.stdin.write(text);
  proc.stdin.end();
  await proc.exited;
  if (proc.exitCode !== 0) throw new Error(`clipboard failed (exit ${proc.exitCode})`);
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
