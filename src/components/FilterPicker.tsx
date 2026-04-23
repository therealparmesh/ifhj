import { Box, Text, useInput } from "ink";
import { useEffect, useMemo, useRef, useState } from "react";

import { bg, clamp, theme } from "../ui";
import { Hint } from "./Hint";
import { TextInput } from "./TextInput";

type FilterItem = { id: string; label: string; hint?: string };

// Keep the picker compact — beyond this the user should filter instead.
const MAX_PICKER_ROWS = 15;

/**
 * Filterable picker. Items are either supplied up-front (small lists like
 * issue types) or lazy-loaded per keystroke (async search). Esc cancels,
 * enter picks.
 */
export function FilterPicker({
  title,
  items,
  loading,
  placeholder,
  onQueryChange,
  debounceMs = 180,
  onPick,
  onCancel,
  onClear,
  currentId,
  borderColor,
}: {
  title: string;
  items: FilterItem[];
  loading?: boolean;
  placeholder?: string;
  /**
   * If provided, the picker treats `items` as server-supplied and debounces
   * keystrokes before calling back. Otherwise it filters locally.
   */
  onQueryChange?: (q: string) => void;
  debounceMs?: number;
  onPick: (id: string) => void;
  onCancel: () => void;
  // Optional "clear current" hotkey (⌃x), used by e.g. the assignee filter.
  onClear?: () => void;
  // ID of the currently-active selection (marks the row with "active").
  currentId?: string;
  borderColor?: string;
}) {
  const [q, setQ] = useState("");
  /**
   * Seed the cursor onto the current selection so reopening a picker for a
   * field that's already set doesn't land on row 0.
   */
  const initialIdx = currentId
    ? Math.max(
        0,
        items.findIndex((it) => it.id === currentId),
      )
    : 0;
  const [idx, setIdx] = useState(initialIdx);
  /**
   * Seed scroll too, otherwise there's a one-frame flash of the wrong window
   * when `currentId` sits deep in the list.
   */
  const [scroll, setScroll] = useState(() =>
    initialIdx >= MAX_PICKER_ROWS ? initialIdx - MAX_PICKER_ROWS + 1 : 0,
  );

  // Async caller owns filtering — pass items through. Otherwise filter locally.
  const filtered = useMemo(() => {
    if (onQueryChange) return items;
    const lower = q.toLowerCase().trim();
    if (!lower) return items;
    return items.filter(
      (it) =>
        it.label.toLowerCase().includes(lower) ||
        (it.hint ?? "").toLowerCase().includes(lower) ||
        it.id.toLowerCase().includes(lower),
    );
  }, [items, q, onQueryChange]);

  useEffect(() => {
    setIdx((i) => Math.min(i, Math.max(0, filtered.length - 1)));
  }, [filtered]);

  /**
   * Sticky scroll: only shift the window when the cursor hits an edge.
   * Avoids the jittery center-on-cursor behavior where one keystroke
   * snaps the list by half the viewport.
   */
  useEffect(() => {
    setScroll((s) => {
      if (idx < s) return idx;
      if (idx >= s + MAX_PICKER_ROWS) return idx - MAX_PICKER_ROWS + 1;
      // Pull back if the list shrank past where we were scrolled.
      const maxStart = Math.max(0, filtered.length - MAX_PICKER_ROWS);
      if (s > maxStart) return maxStart;
      return s;
    });
  }, [idx, filtered.length]);

  /**
   * Debounce keystrokes when the caller owns filtering. The callback goes
   * through a ref so the timer effect depends only on `q` / `debounceMs` —
   * otherwise every parent rerender restarts the timer and fires a
   * duplicate request for the same query.
   */
  const latestQueryChange = useRef(onQueryChange);
  useEffect(() => {
    latestQueryChange.current = onQueryChange;
  }, [onQueryChange]);
  useEffect(() => {
    if (!latestQueryChange.current) return;
    const t = setTimeout(() => latestQueryChange.current?.(q), debounceMs);
    return () => clearTimeout(t);
  }, [q, debounceMs]);

  useInput(
    (input, key) => {
      if (onClear && key.ctrl && input === "x") onClear();
    },
    { isActive: !!onClear },
  );

  const accent = borderColor ?? theme.pink;
  return (
    <Box flexDirection="column" padding={2} borderStyle="round" borderColor={accent}>
      <Text color={accent} bold>
        {title}
      </Text>
      <Box marginTop={1}>
        <Text color={theme.muted}>› </Text>
        <TextInput
          value={q}
          placeholder={placeholder ?? "type to filter…"}
          onChange={setQ}
          onUpArrow={() => setIdx((i) => clamp(i - 1, 0, Math.max(0, filtered.length - 1)))}
          onDownArrow={() => setIdx((i) => clamp(i + 1, 0, Math.max(0, filtered.length - 1)))}
          onSubmit={() => {
            // Visible items may be stale for the current query — don't submit.
            if (loading) return;
            const it = filtered[idx];
            if (it) onPick(it.id);
          }}
          onCancel={onCancel}
        />
      </Box>
      <Box marginTop={1} flexDirection="column">
        {loading ? (
          <Text color={theme.accent}>◴ searching…</Text>
        ) : filtered.length === 0 ? (
          <Text color={theme.muted}>no matches</Text>
        ) : (
          <PickerRows
            filtered={filtered}
            idx={idx}
            scroll={Math.min(scroll, Math.max(0, filtered.length - MAX_PICKER_ROWS))}
            {...(currentId ? { currentId } : {})}
          />
        )}
      </Box>
      <Box marginTop={1}>
        <Hint k="↑↓" label="nav" />
        <Hint k="⏎" label="pick" />
        {onClear ? <Hint k="⌃x" label="clear" /> : null}
        <Hint k="esc" label="cancel" />
      </Box>
    </Box>
  );
}

/**
 * Windowed row slice with ▲/▼ hidden-count indicators. Split out to keep
 * the FilterPicker body readable.
 */
function PickerRows({
  filtered,
  idx,
  scroll,
  currentId,
}: {
  filtered: FilterItem[];
  idx: number;
  scroll: number;
  currentId?: string;
}) {
  const end = Math.min(filtered.length, scroll + MAX_PICKER_ROWS);
  const hiddenAbove = scroll;
  const hiddenBelow = filtered.length - end;
  return (
    <>
      {hiddenAbove > 0 ? <Text color={theme.muted}> ▲ {hiddenAbove} more above</Text> : null}
      {filtered.slice(scroll, end).map((it, i) => {
        const absolute = scroll + i;
        const selected = absolute === idx;
        return (
          <Box key={it.id}>
            <Text color={selected ? theme.accent : theme.muted}>{selected ? "▶ " : "  "}</Text>
            <Text
              color={selected ? theme.fg : theme.fgDim}
              bold={selected}
              {...bg(selected ? theme.accentDim : undefined)}
            >
              {it.label}
            </Text>
            {it.hint ? <Text color={theme.muted}> {it.hint}</Text> : null}
            {it.id === currentId ? <Text color={theme.warn}> (active)</Text> : null}
          </Box>
        );
      })}
      {hiddenBelow > 0 ? <Text color={theme.muted}> ▼ {hiddenBelow} more below</Text> : null}
    </>
  );
}
