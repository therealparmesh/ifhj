import { Box, Text } from "ink";
import { useCallback, useEffect, useRef, useState } from "react";

import { normalizeMessage, theme, truncate } from "../ui";
import { ErrorMessage, errorMessageHeight } from "./ErrorMessage";

type Tone = "ok" | "err" | "info";

export type Toast = { id: number; text: string; tone: Tone };

const INFO_TTL_MS = 3500;
const MAX_TOASTS = 3;

export function boundedToasts(toasts: Toast[]): Toast[] {
  if (toasts.length <= MAX_TOASTS) return toasts;
  const chosen = new Set<Toast>();
  for (const toast of toasts.toReversed()) {
    if (toast.tone === "err" && chosen.size < MAX_TOASTS) chosen.add(toast);
  }
  for (const toast of toasts.toReversed()) {
    if (chosen.size === MAX_TOASTS) break;
    chosen.add(toast);
  }
  return toasts.filter((toast) => chosen.has(toast));
}

export function useToasts() {
  const seq = useRef(0);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());
  const mounted = useRef(true);

  const flash = useCallback((text: string, tone: Tone = "info") => {
    if (!mounted.current) return;
    const id = ++seq.current;
    if (tone === "err") process.stderr.write("\x07");
    const normalized = normalizeMessage(text);
    const toast = { id, text: normalized, tone };
    if (tone !== "err") {
      const timer = setTimeout(() => {
        setToasts((prev) => prev.filter((t) => t.id !== id));
        timers.current.delete(id);
      }, INFO_TTL_MS);
      timers.current.set(id, timer);
    }
    setToasts((prev) => {
      const candidates = [...prev, toast];
      const next = boundedToasts(candidates);
      const retained = new Set(next);
      for (const candidate of candidates) {
        if (retained.has(candidate)) continue;
        const discardedTimer = timers.current.get(candidate.id);
        if (discardedTimer) clearTimeout(discardedTimer);
        timers.current.delete(candidate.id);
      }
      return next;
    });
  }, []);
  const dismiss = useCallback(() => {
    if (!mounted.current) return;
    for (const timer of timers.current.values()) clearTimeout(timer);
    timers.current.clear();
    setToasts([]);
  }, []);

  useEffect(() => {
    mounted.current = true;
    const timerMap = timers.current;
    return () => {
      mounted.current = false;
      for (const t of timerMap.values()) clearTimeout(t);
      timerMap.clear();
    };
  }, []);

  return { toasts, flash, dismiss };
}

function toneStyle(tone: Tone): { color: string; glyph: string } {
  if (tone === "ok") return { color: theme.success, glyph: "✓" };
  return { color: theme.info, glyph: "·" };
}

function toastParts(toasts: Toast[]) {
  const visible = boundedToasts(toasts);
  const errors = visible.filter((toast) => toast.tone === "err");
  return {
    errors,
    notices: visible.filter((toast) => toast.tone !== "err"),
    combinedError: errors.map((toast, index) => `${index + 1}. ${toast.text}`).join("  "),
  };
}

export function ToastStack({
  toasts,
  maxWidth,
  onDismiss,
}: {
  toasts: Toast[];
  maxWidth: number;
  onDismiss?: (() => void) | undefined;
}) {
  const { errors, notices, combinedError } = toastParts(toasts);
  if (errors.length === 0 && notices.length === 0) return null;
  return (
    <Box flexDirection="column" alignItems="flex-end" paddingX={1} width={maxWidth}>
      {notices.map((t, index) => {
        const { color, glyph } = toneStyle(t.tone);
        return (
          <Text key={`${t.id}-${index}`} color={color} wrap="truncate">
            {truncate(`${glyph} ${t.text}`, Math.max(1, maxWidth - 2))}
          </Text>
        );
      })}
      {combinedError ? (
        <ErrorMessage
          key={errors.map((toast) => toast.id).join("-")}
          message={`✗ ${combinedError}`}
          width={maxWidth - 2}
          onDismiss={onDismiss}
        />
      ) : null}
    </Box>
  );
}

export function toastRowCount(toasts: Toast[], maxWidth: number, dismissible = false): number {
  const width = Math.max(1, maxWidth - 2);
  const { notices, combinedError } = toastParts(toasts);
  return (
    notices.length +
    (combinedError ? errorMessageHeight(`x ${combinedError}`, width, 2, dismissible) : 0)
  );
}
