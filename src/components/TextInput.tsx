import { Box, Text, useInput } from "ink";
import { useRef, useState } from "react";

import { graphemes } from "../text";
import { fg, theme, truncate } from "../ui";

/**
 * Always used in controlled mode. Refs advance the cursor and latest emitted
 * value between Ink events that arrive before the parent rerenders.
 */
type Props = {
  value: string;
  placeholder?: string;
  onChange: (v: string) => void;
  onSubmit?: (v: string) => void;
  onCancel?: () => void;
  onUpArrow?: () => void;
  onDownArrow?: () => void;
  isActive?: boolean;
  /** Display width in terminal cells. The controlled value remains unmodified. */
  width?: number;
};

function prevWordBoundary(s: string, from: number): number {
  let i = from;
  while (i > 0 && /\s/.test(s[i - 1]!)) i--;
  while (i > 0 && !/\s/.test(s[i - 1]!)) i--;
  return i;
}

function nextWordBoundary(s: string, from: number): number {
  let i = from;
  while (i < s.length && /\s/.test(s[i]!)) i++;
  while (i < s.length && !/\s/.test(s[i]!)) i++;
  return i;
}

function characterBoundaries(s: string): number[] {
  const boundaries = Array.from(graphemes(s), ({ index }) => index);
  boundaries.push(s.length);
  return boundaries;
}

function prevCharacterBoundary(s: string, from: number): number {
  return characterBoundaries(s).findLast((i) => i < from) ?? 0;
}

function nextCharacterBoundary(s: string, from: number): number {
  return characterBoundaries(s).find((i) => i > from) ?? s.length;
}

function characterBoundaryAtOrBefore(s: string, from: number): number {
  return characterBoundaries(s).findLast((i) => i <= from) ?? 0;
}

export function TextInput({
  value,
  placeholder,
  onChange,
  onSubmit,
  onCancel,
  onUpArrow,
  onDownArrow,
  isActive = true,
  width,
}: Props) {
  const cursor = useRef(value.length);
  const currentValue = useRef(value);
  const [, rerender] = useState(0);
  currentValue.current = value;
  cursor.current = characterBoundaryAtOrBefore(value, Math.min(cursor.current, value.length));

  const moveCursor = (next: number) => {
    const safe = characterBoundaryAtOrBefore(
      currentValue.current,
      Math.max(0, Math.min(currentValue.current.length, next)),
    );
    if (safe === cursor.current) return;
    cursor.current = safe;
    rerender((version) => version + 1);
  };

  const setValue = (v: string, nextCursor: number) => {
    currentValue.current = v;
    cursor.current = characterBoundaryAtOrBefore(v, Math.max(0, Math.min(v.length, nextCursor)));
    rerender((version) => version + 1);
    onChange(v);
  };

  useInput(
    (input, key) => {
      const current = currentValue.current;
      const safeCursor = cursor.current;
      if (key.escape) {
        onCancel?.();
        return;
      }
      if (key.return) {
        onSubmit?.(current);
        return;
      }
      if (key.upArrow) {
        onUpArrow?.();
        return;
      }
      if (key.downArrow) {
        onDownArrow?.();
        return;
      }

      // Word skip: ctrl/alt/meta + arrow
      const wordSkip = key.ctrl || key.meta;

      if (key.leftArrow) {
        moveCursor(
          wordSkip
            ? prevWordBoundary(current, safeCursor)
            : prevCharacterBoundary(current, safeCursor),
        );
        return;
      }
      if (key.rightArrow) {
        moveCursor(
          wordSkip
            ? nextWordBoundary(current, safeCursor)
            : nextCharacterBoundary(current, safeCursor),
        );
        return;
      }

      // Readline-style bindings
      if (key.ctrl && input === "a") return moveCursor(0);
      if (key.ctrl && input === "e") return moveCursor(current.length);
      if (key.ctrl && input === "b") return moveCursor(prevCharacterBoundary(current, safeCursor));
      if (key.ctrl && input === "f") return moveCursor(nextCharacterBoundary(current, safeCursor));
      if (key.ctrl && input === "u") return setValue(current.slice(safeCursor), 0);
      if (key.ctrl && input === "k") return setValue(current.slice(0, safeCursor), safeCursor);
      if (key.ctrl && input === "w") {
        const p = prevWordBoundary(current, safeCursor);
        setValue(current.slice(0, p) + current.slice(safeCursor), p);
        return;
      }
      // Alt+b / Alt+f — word skip via meta-letter (terminals often send ESC+letter)
      if (key.meta && input === "b") return moveCursor(prevWordBoundary(current, safeCursor));
      if (key.meta && input === "f") return moveCursor(nextWordBoundary(current, safeCursor));
      if (key.meta && (input === "\x7f" || key.backspace)) {
        const p = prevWordBoundary(current, safeCursor);
        setValue(current.slice(0, p) + current.slice(safeCursor), p);
        return;
      }
      if (key.meta && input === "d") {
        const n = nextWordBoundary(current, safeCursor);
        setValue(current.slice(0, safeCursor) + current.slice(n), safeCursor);
        return;
      }

      if (key.backspace) {
        if (safeCursor === 0) return;
        const previous = prevCharacterBoundary(current, safeCursor);
        setValue(current.slice(0, previous) + current.slice(safeCursor), previous);
        return;
      }
      if (key.delete) {
        if (safeCursor >= current.length) return;
        setValue(
          current.slice(0, safeCursor) + current.slice(nextCharacterBoundary(current, safeCursor)),
          safeCursor,
        );
        return;
      }

      if (key.ctrl || key.meta) return;

      if (input && !key.tab && !key.pageUp && !key.pageDown) {
        // Intentionally strip ASCII control chars from keyboard input.
        // oxlint-disable-next-line no-control-regex
        const cleaned = input.replaceAll(/[\x00-\x1f\x7f]/g, "");
        if (cleaned) {
          const next = current.slice(0, safeCursor) + cleaned + current.slice(safeCursor);
          setValue(next, safeCursor + cleaned.length);
        }
      }
    },
    { isActive },
  );

  const showPlaceholder = value.length === 0 && placeholder;

  if (showPlaceholder) {
    const placeholderWidth = width === undefined ? undefined : Math.max(0, width - 1);
    return (
      <Box {...(width === undefined ? {} : { width, height: 1, overflow: "hidden" as const })}>
        <Text color={theme.muted} {...(width === undefined ? {} : { wrap: "truncate" as const })}>
          {placeholderWidth === undefined ? placeholder : truncate(placeholder, placeholderWidth)}
        </Text>
        {isActive ? <Text color={theme.accent}>▍</Text> : null}
      </Box>
    );
  }

  const { before, at, after } = inputViewport(value, cursor.current, width);

  return (
    <Box {...(width === undefined ? {} : { width, height: 1, overflow: "hidden" as const })}>
      <Text {...fg(theme.fg)}>{before}</Text>
      {isActive ? (
        at.length > 0 ? (
          <Text color={theme.accent} inverse>
            {at}
          </Text>
        ) : (
          <Text color={theme.accent}>▍</Text>
        )
      ) : (
        <Text {...fg(theme.fg)}>{at}</Text>
      )}
      <Text {...fg(theme.fg)}>{after}</Text>
    </Box>
  );
}

function inputViewport(value: string, cursor: number, width: number | undefined) {
  const nextCursor = nextCharacterBoundary(value, cursor);
  const at = value.slice(cursor, nextCursor);
  if (width === undefined) {
    return { before: value.slice(0, cursor), at, after: value.slice(nextCursor) };
  }

  let remaining = Math.max(0, width - (at ? Bun.stringWidth(at) : 1));
  let before = "";
  const previous = Array.from(graphemes(value.slice(0, cursor)), ({ segment }) => segment);
  for (let index = previous.length - 1; index >= 0; index--) {
    const segment = previous[index]!;
    const segmentWidth = Bun.stringWidth(segment);
    if (segmentWidth > remaining) break;
    before = segment + before;
    remaining -= segmentWidth;
  }

  let after = "";
  for (const { segment } of graphemes(value.slice(nextCursor))) {
    const segmentWidth = Bun.stringWidth(segment);
    if (segmentWidth > remaining) break;
    after += segment;
    remaining -= segmentWidth;
  }
  return { before, at, after };
}
