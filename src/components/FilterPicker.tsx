import { Box, Text } from "ink";
import { useEffect, useMemo, useRef, useState } from "react";

import { useDimensions } from "../hooks";
import { useInput } from "../input";
import { useSelectionIndex } from "../selection";
import { clamp, fg, stickyScroll, theme, truncate } from "../ui";
import { Hint } from "./Hint";
import { LoadingLine } from "./LoadingLine";
import { TextInput } from "./TextInput";

type FilterItem = { id: string; label: string; hint?: string | undefined };

type CommonProps = {
  title: string;
  items: FilterItem[];
  placeholder?: string;
  onPick: (id: string) => void;
  onCancel: () => void;
  onClear?: () => void;
  currentId?: string;
  borderColor?: string;
  submitLabel?: string;
  busy?: boolean;
  busyLabel?: string;
};

type LocalProps = CommonProps & {
  onQueryChange?: never;
  itemsQuery?: never;
  loading?: never;
  error?: never;
  onRetry?: never;
};

type RemoteProps = CommonProps & {
  onQueryChange: (query: string) => void;
  /** Query that produced both `items` and `error`. */
  itemsQuery: string;
  loading?: boolean;
  error?: string;
  onRetry?: (query: string) => void;
};

type Props = LocalProps | RemoteProps;

function filterItems(items: FilterItem[], query: string): FilterItem[] {
  const lower = query.toLowerCase().trim();
  if (!lower) return items;
  return items.filter(
    (item) =>
      item.label.toLowerCase().includes(lower) ||
      (item.hint ?? "").toLowerCase().includes(lower) ||
      item.id.toLowerCase().includes(lower),
  );
}

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
  itemsQuery,
  error,
  onRetry,
  onPick,
  onCancel,
  onClear,
  currentId,
  borderColor,
  submitLabel = "select",
  busy = false,
  busyLabel = "Working…",
}: Props) {
  const { cols: termCols, rows: termRows } = useDimensions();
  // Padding, borders, title, input, indicators, and footer need 14 rows.
  const maxPickerRows = Math.max(1, Math.min(15, termRows - 14));
  const innerWidth = Math.max(1, termCols - 6);
  const [q, setQ] = useState("");
  const queryRef = useRef("");
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
  const [idx, setIdx, getIdx] = useSelectionIndex(initialIdx);
  /**
   * Scroll anchor lives in a ref, not useState. The actual scroll value is
   * derived from cursor + anchor every render (see below), so cursor and
   * scroll can never disagree on a frame. Seeded so `currentId` deep in the
   * list doesn't flash the wrong window.
   */
  const scrollRef = useRef(initialIdx >= maxPickerRows ? initialIdx - maxPickerRows + 1 : 0);

  const remote = onQueryChange !== undefined;
  const resultsMatch = !remote || itemsQuery === q;
  const ready = !busy && (!remote || (resultsMatch && !loading));
  // Async caller owns filtering, but its items are usable only for their query.
  const filtered = useMemo(() => {
    if (remote) return resultsMatch && !loading ? items : [];
    return filterItems(items, q);
  }, [items, q, remote, resultsMatch, loading]);

  /**
   * Notify remote owners once for each committed query. Callback identity
   * changes do not repeat a request for an unchanged query.
   */
  const latestQueryChange = useRef(onQueryChange);
  useEffect(() => {
    latestQueryChange.current = onQueryChange;
  }, [onQueryChange]);
  useEffect(() => {
    latestQueryChange.current?.(q);
  }, [q]);

  const submitLocked = useRef(false);
  const busyRef = useRef(busy);
  busyRef.current = busy;
  useEffect(() => {
    if (!busy) submitLocked.current = false;
  }, [busy]);

  const updateQuery = (next: string) => {
    if (busyRef.current || submitLocked.current) return false;
    queryRef.current = next;
    setQ(next);
    setIdx(0);
    scrollRef.current = 0;
    return true;
  };

  const currentItems = (query: string): FilterItem[] => {
    if (!remote) return filterItems(items, query);
    if (itemsQuery !== query || loading || error) return [];
    return items;
  };

  const move = (delta: number) => {
    if (busyRef.current || submitLocked.current) return;
    const available = currentItems(queryRef.current);
    if (available.length === 0) return;
    const last = available.length - 1;
    setIdx((current) => clamp(clamp(current, 0, last) + delta, 0, last));
  };

  const lockSubmit = (action: () => void) => {
    if (busyRef.current || submitLocked.current) return;
    submitLocked.current = true;
    action();
    queueMicrotask(() => {
      if (!busyRef.current) submitLocked.current = false;
    });
  };

  useInput(
    (input, key) => {
      if (busyRef.current && key.escape) {
        onCancel();
        return;
      }
      if (onClear && !busyRef.current && key.ctrl && input === "x") {
        lockSubmit(onClear);
      }
    },
    { isActive: busy || !!onClear },
  );

  // Sticky scroll: only shift when cursor hits an edge. Pure derivation at
  // render time — no useEffect, no setState cycle. `cursor` is the single
  // source of truth for the row being highlighted / submitted. `idx` is
  // just the underlying state; it can briefly exceed `filtered.length`
  // after a filter narrows the list, and `cursor` absorbs that via clamp.
  const cursor = clamp(idx, 0, Math.max(0, filtered.length - 1));
  const scroll = stickyScroll(filtered.length, maxPickerRows, cursor, scrollRef.current);
  scrollRef.current = scroll;

  const accent = borderColor ?? theme.accent;
  return (
    <Box flexDirection="column" padding={2} borderStyle="round" borderColor={accent}>
      <Box width={innerWidth} height={1} overflow="hidden">
        <Text color={accent} bold wrap="truncate">
          {truncate(title, innerWidth)}
        </Text>
      </Box>
      <Box marginTop={1} width={innerWidth} height={1} overflow="hidden">
        <Text color={theme.muted}>› </Text>
        <TextInput
          value={q}
          placeholder={placeholder ?? "Type to filter…"}
          width={Math.max(1, innerWidth - 2)}
          isActive={!busy}
          onChange={updateQuery}
          onUpArrow={() => move(-1)}
          onDownArrow={() => move(1)}
          onPageUp={() => move(-maxPickerRows)}
          onPageDown={() => move(maxPickerRows)}
          onSubmit={(latestQuery) => {
            if (busyRef.current || submitLocked.current) return;
            if (remote && (itemsQuery !== latestQuery || loading)) return;
            if (remote && error) {
              if (onRetry) lockSubmit(() => onRetry(latestQuery));
              return;
            }
            const submitted = currentItems(latestQuery);
            const item = submitted[clamp(getIdx(), 0, Math.max(0, submitted.length - 1))];
            if (item) lockSubmit(() => onPick(item.id));
          }}
          onCancel={onCancel}
        />
      </Box>
      <Box marginTop={1} flexDirection="column">
        {busy ? (
          <Box width={innerWidth} height={1} overflow="hidden">
            <LoadingLine label={truncate(busyLabel, Math.max(1, innerWidth - 2))} />
          </Box>
        ) : remote && (!resultsMatch || loading) ? (
          <LoadingLine label="Searching…" />
        ) : remote && error ? (
          <>
            <Box width={innerWidth} height={1} overflow="hidden">
              <Text color={theme.error} wrap="truncate">
                {truncate(error, innerWidth)}
              </Text>
            </Box>
            <Box width={innerWidth} height={1} overflow="hidden">
              <Text color={theme.muted} wrap="truncate">
                {onRetry
                  ? "Press Enter to retry or edit the filter."
                  : "Edit the filter or press Esc to cancel."}
              </Text>
            </Box>
          </>
        ) : filtered.length === 0 ? (
          <>
            <Box width={innerWidth} height={1} overflow="hidden">
              <Text color={theme.muted} wrap="truncate">
                {q.trim() ? "No matches." : "No options are available."}
              </Text>
            </Box>
            <Box width={innerWidth} height={1} overflow="hidden">
              <Text color={theme.muted} wrap="truncate">
                Change the filter or press Esc to cancel.
              </Text>
            </Box>
          </>
        ) : (
          <PickerRows
            filtered={filtered}
            idx={cursor}
            scroll={scroll}
            maxRows={maxPickerRows}
            width={innerWidth}
            {...(currentId ? { currentId } : {})}
          />
        )}
      </Box>
      <Box marginTop={1} width={innerWidth} height={1} overflow="hidden">
        {ready && !error && filtered.length > 0 ? (
          <>
            <Hint k="↑↓" label="nav" />
            <Hint k="PgUp/PgDn" label="page" />
            <Hint k="⏎" label={submitLabel} />
          </>
        ) : ready && error && onRetry ? (
          <Hint k="⏎" label="retry" />
        ) : null}
        {!busy && onClear ? <Hint k="⌃x" label="clear" /> : null}
        <Hint k="esc" label="cancel" />
      </Box>
    </Box>
  );
}

/**
 * Windowed row slice with ASCII hidden-count indicators so terminal width is
 * stable across fonts. Selected rows use a pointer, accent, bold, and inverse.
 */
function PickerRows({
  filtered,
  idx,
  scroll,
  maxRows,
  width,
  currentId,
}: {
  filtered: FilterItem[];
  idx: number;
  scroll: number;
  maxRows: number;
  width: number;
  currentId?: string;
}) {
  const end = Math.min(filtered.length, scroll + maxRows);
  const hiddenAbove = scroll;
  const hiddenBelow = filtered.length - end;
  return (
    <>
      {hiddenAbove > 0 ? <Text color={theme.muted}> ^ {hiddenAbove} more above</Text> : null}
      {filtered.slice(scroll, end).map((it, i) => {
        const absolute = scroll + i;
        const selected = absolute === idx;
        const activeText = it.id === currentId ? " (active)" : "";
        const available = Math.max(1, width - 2 - Bun.stringWidth(activeText));
        const hintWidth = it.hint
          ? Math.min(Bun.stringWidth(it.hint) + 1, Math.floor(available / 2))
          : 0;
        const hintText = hintWidth > 1 ? ` ${truncate(it.hint!, hintWidth - 1)}` : "";
        const labelText = truncate(it.label, Math.max(1, available - Bun.stringWidth(hintText)));
        return (
          <Box key={it.id} width={width} height={1} overflow="hidden">
            <Text color={selected ? theme.accent : theme.muted}>{selected ? "> " : "  "}</Text>
            <Text
              {...fg(selected ? theme.fg : theme.fgDim)}
              bold={selected}
              inverse={selected}
              wrap="truncate"
            >
              {labelText}
            </Text>
            {hintText ? <Text color={theme.muted}>{hintText}</Text> : null}
            {activeText ? <Text color={theme.accent}>{activeText}</Text> : null}
          </Box>
        );
      })}
      {hiddenBelow > 0 ? <Text color={theme.muted}> v {hiddenBelow} more below</Text> : null}
    </>
  );
}
