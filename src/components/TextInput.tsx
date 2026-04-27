import { Box, Text, useInput } from "ink";
import { useEffect, useState } from "react";

import { fg, theme } from "../ui";

/**
 * Always used in controlled mode — the caller owns `value` and updates it
 * through `onChange`. The only local state is the cursor position.
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

export function TextInput({
  value,
  placeholder,
  onChange,
  onSubmit,
  onCancel,
  onUpArrow,
  onDownArrow,
  isActive = true,
}: Props) {
  const [cursor, setCursor] = useState(value.length);

  // Clamp the cursor if the controlled value shrinks below the cursor index.
  useEffect(() => {
    if (cursor > value.length) setCursor(value.length);
  }, [value, cursor]);

  const setValue = (v: string, nextCursor: number) => {
    setCursor(Math.max(0, Math.min(v.length, nextCursor)));
    onChange(v);
  };

  useInput(
    (input, key) => {
      if (key.escape) {
        onCancel?.();
        return;
      }
      if (key.return) {
        onSubmit?.(value);
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
        setCursor((c) => (wordSkip ? prevWordBoundary(value, c) : Math.max(0, c - 1)));
        return;
      }
      if (key.rightArrow) {
        setCursor((c) => (wordSkip ? nextWordBoundary(value, c) : Math.min(value.length, c + 1)));
        return;
      }

      // Readline-style bindings
      if (key.ctrl && input === "a") return setCursor(0);
      if (key.ctrl && input === "e") return setCursor(value.length);
      if (key.ctrl && input === "b") return setCursor((c) => Math.max(0, c - 1));
      if (key.ctrl && input === "f") return setCursor((c) => Math.min(value.length, c + 1));
      if (key.ctrl && input === "u") return setValue(value.slice(cursor), 0);
      if (key.ctrl && input === "k") return setValue(value.slice(0, cursor), cursor);
      if (key.ctrl && input === "w") {
        const p = prevWordBoundary(value, cursor);
        setValue(value.slice(0, p) + value.slice(cursor), p);
        return;
      }
      // Alt+b / Alt+f — word skip via meta-letter (terminals often send ESC+letter)
      if (key.meta && input === "b") return setCursor((c) => prevWordBoundary(value, c));
      if (key.meta && input === "f") return setCursor((c) => nextWordBoundary(value, c));
      if (key.meta && (input === "\x7f" || key.backspace)) {
        const p = prevWordBoundary(value, cursor);
        setValue(value.slice(0, p) + value.slice(cursor), p);
        return;
      }
      if (key.meta && input === "d") {
        const n = nextWordBoundary(value, cursor);
        setValue(value.slice(0, cursor) + value.slice(n), cursor);
        return;
      }

      if (key.backspace) {
        if (cursor === 0) return;
        setValue(value.slice(0, cursor - 1) + value.slice(cursor), cursor - 1);
        return;
      }
      if (key.delete) {
        if (cursor >= value.length) return;
        setValue(value.slice(0, cursor) + value.slice(cursor + 1), cursor);
        return;
      }

      if (key.ctrl || key.meta) return;

      if (input && !key.tab && !key.pageUp && !key.pageDown) {
        // Intentionally strip ASCII control chars from keyboard input.
        // oxlint-disable-next-line no-control-regex
        const cleaned = input.replaceAll(/[\x00-\x1f\x7f]/g, "");
        if (cleaned) {
          const next = value.slice(0, cursor) + cleaned + value.slice(cursor);
          setValue(next, cursor + cleaned.length);
        }
      }
    },
    { isActive },
  );

  const showPlaceholder = value.length === 0 && placeholder;

  if (showPlaceholder) {
    return (
      <Box>
        <Text color={theme.muted}>{placeholder}</Text>
        {isActive ? <Text color={theme.accent}>▍</Text> : null}
      </Box>
    );
  }

  // Render with an inline cursor by inverting the char at `cursor`.
  const before = value.slice(0, cursor);
  const at = value.slice(cursor, cursor + 1);
  const after = value.slice(cursor + 1);

  return (
    <Box>
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
