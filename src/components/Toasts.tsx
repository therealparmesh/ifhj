import { Box, Text } from "ink";
import { useCallback, useEffect, useRef, useState } from "react";

import { theme, truncate } from "../ui";

export type Tone = "ok" | "err" | "info";

type Toast = { id: number; text: string; tone: Tone };

const TTL_MS = 3500;
const MAX_TOASTS = 4;

export function useToasts() {
  const seq = useRef(0);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const flash = useCallback((text: string, tone: Tone = "info") => {
    const id = ++seq.current;
    if (tone === "err") process.stderr.write("\x07");
    setToasts((prev) => [...prev.slice(-(MAX_TOASTS - 1)), { id, text, tone }]);
    const timer = setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
      timers.current.delete(id);
    }, TTL_MS);
    timers.current.set(id, timer);
  }, []);

  useEffect(
    () => () => {
      for (const t of timers.current.values()) clearTimeout(t);
    },
    [],
  );

  return { toasts, flash };
}

function toneStyle(tone: Tone): { color: string; glyph: string } {
  if (tone === "ok") return { color: theme.ok, glyph: "✓" };
  if (tone === "err") return { color: theme.err, glyph: "✗" };
  return { color: theme.cyan, glyph: "·" };
}

export function ToastStack({ toasts, maxWidth }: { toasts: Toast[]; maxWidth: number }) {
  if (toasts.length === 0) return null;
  return (
    <Box flexDirection="column" alignItems="flex-end" paddingX={1}>
      {toasts.map((t) => {
        const { color, glyph } = toneStyle(t.tone);
        return (
          <Text key={t.id} color={color} bold={t.tone === "err"}>
            {glyph} {truncate(t.text, Math.max(10, maxWidth - 4))}
          </Text>
        );
      })}
    </Box>
  );
}
