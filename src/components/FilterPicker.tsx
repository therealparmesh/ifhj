import { Box, Text, useInput } from "ink";
import { useEffect, useMemo, useRef, useState } from "react";

import { clamp, theme } from "../ui";
import { Hint } from "./Hint";
import { TextInput } from "./TextInput";

type FilterItem = { id: string; label: string; hint?: string | undefined };

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
   * Scroll anchor lives in a ref, not useState. The actual scroll value is
   * derived from cursor + anchor every render (see below), so cursor and
   * scroll can never disagree on a frame. Seeded so `currentId` deep in the
   * list doesn't flash the wrong window.
   */
  const scrollRef = useRef(initialIdx >= MAX_PICKER_ROWS ? initialIdx - MAX_PICKER_ROWS + 1 : 0);

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

  // Sticky scroll: only shift when cursor hits an edge. Pure derivation at
  // render time — no useEffect, no setState cycle. `cursor` is the single
  // source of truth for the row being highlighted / submitted. `idx` is
  // just the underlying state; it can briefly exceed `filtered.length`
  // after a filter narrows the list, and `cursor` absorbs that via clamp.
  const cursor = clamp(idx, 0, Math.max(0, filtered.length - 1));
  let scroll = scrollRef.current;
  const ceiling = Math.max(0, filtered.length - MAX_PICKER_ROWS);
  if (scroll > ceiling) scroll = ceiling;
  if (cursor < scroll) scroll = cursor;
  else if (cursor >= scroll + MAX_PICKER_ROWS) scroll = cursor - MAX_PICKER_ROWS + 1;
  if (scroll < 0) scroll = 0;
  scrollRef.current = scroll;

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
          onUpArrow={() => setIdx(clamp(cursor - 1, 0, Math.max(0, filtered.length - 1)))}
          onDownArrow={() => setIdx(clamp(cursor + 1, 0, Math.max(0, filtered.length - 1)))}
          onSubmit={() => {
            // Visible items may be stale for the current query — don't submit.
            if (loading) return;
            const it = filtered[cursor];
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
            idx={cursor}
            scroll={scroll}
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
 * Windowed row slice with ^/v hidden-count indicators. All glyphs are
 * ASCII so string-width and the terminal agree on column counts — the
 * old ▶/▲/▼ are east-asian ambiguous-width and caused inconsistent
 * paints. Selection is `>` + accent color + bold (no bg), because an
 * asymmetric backgroundColor between selected and unselected rows is
 * where Ink's row diff left partial-paint artifacts on fast nav.
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
      {hiddenAbove > 0 ? <Text color={theme.muted}> ^ {hiddenAbove} more above</Text> : null}
      {filtered.slice(scroll, end).map((it, i) => {
        const absolute = scroll + i;
        const selected = absolute === idx;
        return (
          <Box key={it.id}>
            <Text color={selected ? theme.accent : theme.muted}>{selected ? "> " : "  "}</Text>
            <Text color={selected ? theme.accent : theme.fgDim} bold={selected}>
              {it.label}
            </Text>
            {it.hint ? <Text color={theme.muted}> {it.hint}</Text> : null}
            {it.id === currentId ? <Text color={theme.warn}> (active)</Text> : null}
          </Box>
        );
      })}
      {hiddenBelow > 0 ? <Text color={theme.muted}> v {hiddenBelow} more below</Text> : null}
    </>
  );
}
