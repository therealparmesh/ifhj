import { Box, Text } from "ink";
import { useEffect, useState } from "react";

import { theme } from "../ui";

/**
 * Thin indeterminate progress line — a bright block sweeps left→right across a
 * dim track. Shown while background work is in flight (board reloads, swimlane
 * fetch, detail refreshes). Occupies exactly one row so it never shifts layout;
 * render it in a fixed-height slot and swap in a blank line when idle.
 */
export function ProgressBar({ width, active }: { width: number; active: boolean }) {
  // Advance a phase counter on a timer only while active — an idle bar does no
  // work and holds no interval.
  const [phase, setPhase] = useState(0);
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setPhase((p) => p + 1), 90);
    return () => clearInterval(t);
  }, [active]);

  const w = Math.max(1, width);
  if (!active) return <Text> </Text>;

  // A chunk of `span` cells bounces across the track. Triangle-wave position so
  // it sweeps out and back without a jump at the wrap.
  const span = Math.max(3, Math.floor(w / 6));
  const travel = Math.max(1, w - span);
  const cycle = travel * 2;
  const t = phase % cycle;
  const start = t <= travel ? t : cycle - t;

  let bar = "";
  for (let i = 0; i < w; i++) bar += i >= start && i < start + span ? "━" : "─";
  return (
    <Box>
      <Text color={theme.divider}>{bar.slice(0, start)}</Text>
      <Text color={theme.accent}>{bar.slice(start, start + span)}</Text>
      <Text color={theme.divider}>{bar.slice(start + span)}</Text>
    </Box>
  );
}
