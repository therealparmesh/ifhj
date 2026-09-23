import { Box, Text } from "ink";
import { useEffect, useRef } from "react";

import { useDimensions } from "../hooks";
import { useInput } from "../input";
import { useSelectionIndex } from "../selection";
import { clamp, fg, stickyScroll, theme, truncate } from "../ui";
import { Hint } from "./Hint";
import { LoadingLine } from "./LoadingLine";

/**
 * Windowed vertical picker for fixed lists. No filtering — see FilterPicker
 * for the searchable variant.
 */
export function ListPicker({
  title,
  items,
  onPick,
  onCancel,
  submitLabel = "select",
  busy = false,
  busyLabel = "Working…",
}: {
  title: string;
  items: { id: string; label: string }[];
  onPick: (id: string) => void;
  onCancel: () => void;
  submitLabel?: string;
  busy?: boolean;
  busyLabel?: string;
}) {
  const { cols, rows } = useDimensions();
  const innerWidth = Math.max(1, cols - 6);
  // Borders, padding, title, margins, and footer consume ten rows. Reserve two
  // more for the optional above/below indicators.
  const maxRows = Math.max(1, rows - 12);
  const [idx, setIdx, getIdx] = useSelectionIndex();
  const scrollRef = useRef(0);
  const submitLocked = useRef(false);
  const busyRef = useRef(busy);
  busyRef.current = busy;

  const lastIndex = Math.max(0, items.length - 1);
  const cursor = clamp(idx, 0, lastIndex);
  const scroll = stickyScroll(items.length, maxRows, cursor, scrollRef.current);
  scrollRef.current = scroll;
  const end = Math.min(items.length, scroll + maxRows);

  useEffect(() => {
    if (!busy) submitLocked.current = false;
  }, [busy]);

  const move = (next: number | ((current: number) => number)) => {
    setIdx((current) => {
      const safe = clamp(current, 0, lastIndex);
      return clamp(typeof next === "function" ? next(safe) : next, 0, lastIndex);
    });
  };

  const submit = () => {
    const item = items[clamp(getIdx(), 0, lastIndex)];
    if (!item) return;
    submitLocked.current = true;
    onPick(item.id);
    queueMicrotask(() => {
      if (!busyRef.current) submitLocked.current = false;
    });
  };

  useInput((input, key) => {
    if (key.escape) return onCancel();
    if (busyRef.current || submitLocked.current || items.length === 0) return;
    if (key.home) move(0);
    else if (key.end) move(lastIndex);
    else if (key.pageUp) move((current) => current - maxRows);
    else if (key.pageDown) move((current) => current + maxRows);
    else if (key.upArrow || input === "k") move((current) => current - 1);
    else if (key.downArrow || input === "j") move((current) => current + 1);
    else if (key.return) submit();
  });

  return (
    <Box flexDirection="column" padding={2} borderStyle="round" borderColor={theme.accent}>
      <Box width={innerWidth} height={1} overflow="hidden">
        <Text color={theme.accent} bold wrap="truncate">
          {truncate(title, innerWidth)}
        </Text>
      </Box>
      <Box flexDirection="column" marginTop={1}>
        {busy ? (
          <Box width={innerWidth} height={1} overflow="hidden">
            <LoadingLine label={truncate(busyLabel, Math.max(1, innerWidth - 2))} />
          </Box>
        ) : items.length === 0 ? (
          <Box width={innerWidth} height={1} overflow="hidden">
            <Text color={theme.muted} wrap="truncate">
              No options are available.
            </Text>
          </Box>
        ) : (
          <>
            {scroll > 0 ? <Text color={theme.muted}>^ {scroll} above</Text> : null}
            {items.slice(scroll, end).map((item, visibleIndex) => {
              const absolute = scroll + visibleIndex;
              const selected = absolute === cursor;
              return (
                <Box key={item.id} width={innerWidth} height={1} overflow="hidden">
                  <Text color={selected ? theme.accent : theme.muted}>
                    {selected ? "> " : "  "}
                  </Text>
                  <Text
                    {...fg(selected ? theme.fg : theme.fgDim)}
                    bold={selected}
                    inverse={selected}
                    wrap="truncate"
                  >
                    {truncate(item.label, Math.max(1, innerWidth - 2))}
                  </Text>
                </Box>
              );
            })}
            {end < items.length ? (
              <Text color={theme.muted}>v {items.length - end} below</Text>
            ) : null}
          </>
        )}
      </Box>
      <Box marginTop={1} width={innerWidth} height={1} overflow="hidden">
        {!busy && items.length > 0 ? (
          <>
            <Hint k="↑↓" label="nav" />
            <Hint k="Home/End" label="ends" />
            <Hint k="PgUp/PgDn" label="page" />
            <Hint k="⏎" label={submitLabel} />
          </>
        ) : null}
        <Hint k="esc" label="cancel" />
      </Box>
    </Box>
  );
}
