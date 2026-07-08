import { Text } from "ink";

import { theme } from "../ui";

/**
 * The one loading indicator for static (non-animated) waits — the `◴` glyph
 * plus a label, in the accent color. Every "loading…"/"searching…" surface
 * renders this so the glyph, color, and spacing are identical everywhere.
 * (The animated sweep for background reloads is a separate thing, ProgressBar.)
 */
export function LoadingLine({ label }: { label: string }) {
  return <Text color={theme.accent}>◴ {label}</Text>;
}
