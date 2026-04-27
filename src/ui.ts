/**
 * Theme contract — a semantic palette, not a literal one. Slots describe
 * *roles* (error, accent, divider) rather than aesthetics (pink, violet),
 * so a theme author can map each role to whatever concrete color fits their
 * palette. `fg` is optional: when unset, components emit no color code and
 * the terminal's own default foreground shows through — which is the only
 * way to be readable on *both* light and dark terminals using a single
 * binary.
 */
export type Theme = {
  // ─── Surfaces ───────────────────────────────────────────────────
  bg: string; // used as a foreground for inverted-cursor contrast, so must be concrete
  bgPanel: string;
  bgDeep: string;

  // ─── Text tones ─────────────────────────────────────────────────
  fg: string | undefined; // primary text — undefined ⇒ terminal default
  fgDim: string; // secondary text
  muted: string; // tertiary text (comments, hints)

  // ─── Status ─────────────────────────────────────────────────────
  error: string;
  success: string;
  warning: string;
  info: string;

  // ─── Interaction ────────────────────────────────────────────────
  accent: string; // primary focus / selection color
  accentAlt: string; // secondary accent (Epics, parent links, alt headings)
  selectedBg: string; // painted background for the selected row
  matchBg: string; // search-match background
  divider: string; // thin lines, inactive borders

  // ─── Assignee palette ───────────────────────────────────────────
  // Ordered array of visually distinct colors for deterministic badge
  // coloring. Order matters (hash → index); individual slots don't carry
  // meaning.
  palette: readonly string[];
};

/**
 * Synthwave '84 palette (Robb Owen) — out of the box. Jira, but neon.
 * https://github.com/robb0wen/synthwave-vscode — canonical hex values from
 * the VSCode theme, mapped to semantic slots.
 */
export const synthwaveTheme: Theme = {
  // Chrome / surfaces
  bg: "#262335", // editor.background
  bgPanel: "#241b2f", // sideBar / statusBar / tab group
  bgDeep: "#171520", // activityBar (darkest chrome)

  // Text
  fg: "#f9f9fa", // generic off-white
  fgDim: "#b6b1b1", // punctuation / separators
  muted: "#848bbd", // comments

  // Status
  error: "#fe4450", // language keywords (red)
  success: "#72f1b8", // mint (tags, control keywords)
  warning: "#fede5d", // keywords
  info: "#36f9f6", // functions (cyan)

  // Interaction
  accent: "#ff7edb", // variables, the signature Synthwave hot pink
  // lavender — not a canonical Synthwave token, but the only readable
  // purple for foreground text (Epics, parent links).
  accentAlt: "#b893ce",
  selectedBg: "#2a2139", // muted violet — enough contrast against bg to read as selection
  matchBg: "#463465", // menu violet — subtle highlight for search matches
  divider: "#2a2139", // muted violet — reads as thin lines

  // 6 visually distinct colors, signature Synthwave flair
  palette: ["#ff7edb", "#36f9f6", "#72f1b8", "#fede5d", "#f97e72", "#b893ce"],
};

/**
 * Terminal theme — defers to the user's terminal palette via named ANSI
 * colors (Ink emits e.g. \e[36m for "cyan"). `fg` is `undefined` so primary
 * text uses the terminal's own default foreground, guaranteeing readability
 * on both dark and light terminal themes.
 *
 * `bg` stays concrete ("black") because it's used as a foreground for the
 * inverted cursor (dark-text-on-bright-accent), where black is a safe
 * contrast pick on any background the cursor itself sits on.
 */
export const terminalTheme: Theme = {
  bg: "black",
  bgPanel: "black",
  bgDeep: "black",

  fg: undefined, // terminal default — readable on both light and dark
  fgDim: "gray",
  muted: "gray",

  error: "red",
  success: "green",
  warning: "yellow",
  info: "cyan",

  accent: "magenta",
  accentAlt: "blue",
  selectedBg: "blue",
  matchBg: "yellow",
  divider: "gray",

  palette: [
    "red",
    "green",
    "yellow",
    "blue",
    "magenta",
    "cyan",
    "redBright",
    "greenBright",
    "yellowBright",
    "blueBright",
    "magentaBright",
    "cyanBright",
  ],
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
      return theme.error;
    case "Story":
      return theme.success;
    case "Task":
      return theme.info;
    case "Epic":
      return theme.accentAlt;
    case "Sub-task":
    case "Subtask":
      return theme.muted;
    case "Spike":
      return theme.warning;
    default:
      return theme.fgDim;
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

export function assigneeColor(name: string | undefined | null): string {
  if (!name) return theme.muted;
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return theme.palette[h % theme.palette.length]!;
}

export function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

// Spread helper that lets callers omit the `color` prop entirely when a
// theme slot is undefined. Ink's <Text> treats an unset color prop as "emit
// no color code," which is what lets the terminal default show through.
export function fg(color: string | undefined): { color: string } | Record<string, never> {
  return color ? { color } : {};
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
