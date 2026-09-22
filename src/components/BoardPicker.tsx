import { Box, Text, useInput } from "ink";
import { useEffect, useMemo, useRef, useState } from "react";

import type { JiraConfig } from "../config";
import { useDimensions } from "../hooks";
import { type Board, listBoards } from "../jira";
import { clamp, errorMessage, fg, stickyScroll, theme, truncate } from "../ui";
import { LoadingLine } from "./LoadingLine";
import { TextInput } from "./TextInput";

type Props = {
  cfg: JiraConfig;
  onPick: (b: Board) => void;
  onQuit: () => void;
};

function filterBoards(boards: Board[], query: string): Board[] {
  const q = query.toLowerCase().trim();
  if (!q) return boards;
  return boards.filter(
    (board) =>
      board.name.toLowerCase().includes(q) ||
      (board.projectKey ?? "").toLowerCase().includes(q) ||
      (board.projectName ?? "").toLowerCase().includes(q) ||
      board.type.toLowerCase().includes(q),
  );
}

export function BoardPicker({ cfg, onPick, onQuit }: Props) {
  const [loaded, setLoaded] = useState<{
    cfg: JiraConfig;
    boards: Board[] | null;
    error: string | null;
  }>({ cfg, boards: null, error: null });
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  // Scroll is derived from the cursor at render time via a ref anchor. No
  // useState for scroll means cursor/scroll can't disagree on a frame.
  const scrollRef = useRef(0);
  const { cols, rows } = useDimensions();

  useEffect(() => {
    let cancelled = false;
    setLoaded({ cfg, boards: null, error: null });
    (async () => {
      try {
        const list = await listBoards(cfg);
        if (!cancelled) setLoaded({ cfg, boards: list, error: null });
      } catch (e) {
        if (!cancelled) setLoaded({ cfg, boards: null, error: errorMessage(e) });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [cfg]);

  const boards = loaded.cfg === cfg ? loaded.boards : null;
  const error = loaded.cfg === cfg ? loaded.error : null;

  const filtered = useMemo(() => filterBoards(boards ?? [], query), [boards, query]);

  const viewportHeight = Math.max(5, rows - 8);

  useEffect(() => {
    setIndex(0);
    scrollRef.current = 0;
  }, [query]);

  // `cursor` is the clamped, always-in-bounds view of `index` — the single
  // source of truth for which row is selected / submitted. Referenced by
  // both the PgUp/PgDn handler and the TextInput arrow handlers below.
  const cursor = clamp(index, 0, Math.max(0, filtered.length - 1));
  const clampedLen = Math.max(0, filtered.length - 1);

  /**
   * Page up/down is outside TextInput so the text field's own arrow keys
   * don't shadow them. Text entry, single-row arrows, and esc live inside
   * <TextInput/>.
   */
  useInput((_input, key) => {
    if (key.pageUp) setIndex(clamp(cursor - viewportHeight, 0, clampedLen));
    else if (key.pageDown) setIndex(clamp(cursor + viewportHeight, 0, clampedLen));
  });

  useInput(
    (_input, key) => {
      if (key.escape) onQuit();
    },
    { isActive: !!error },
  );

  if (error) {
    return (
      <Box flexDirection="column" padding={1}>
        <Text color={theme.accent} bold>
          ifhj
        </Text>
        <Box marginTop={1}>
          <Text color={theme.error}>{error}</Text>
        </Box>
        <Box marginTop={1}>
          <Text color={theme.muted}>press esc or ⌃c to quit</Text>
        </Box>
      </Box>
    );
  }

  if (!boards) {
    return (
      <Box flexDirection="column" padding={1}>
        <Text color={theme.accent} bold>
          ifhj
        </Text>
        <Box marginTop={1}>
          <LoadingLine label="loading boards…" />
        </Box>
      </Box>
    );
  }

  // Pure derived scroll: anchor in ref, shift only when cursor hits an edge.
  const scroll = stickyScroll(filtered.length, viewportHeight, cursor, scrollRef.current);
  scrollRef.current = scroll;

  const visible = filtered.slice(scroll, scroll + viewportHeight);
  const rowWidth = cols - 4;

  return (
    <Box flexDirection="column" padding={1}>
      <Box>
        <Text color={theme.accent} bold>
          ifhj{" "}
        </Text>
        <Text color={theme.muted}>— pick a board</Text>
      </Box>

      <Box marginTop={1}>
        <Text color={theme.muted}>search ▸ </Text>
        <TextInput
          value={query}
          placeholder="filter by name / key / type…"
          onChange={setQuery}
          onUpArrow={() => setIndex(clamp(cursor - 1, 0, clampedLen))}
          onDownArrow={() => setIndex(clamp(cursor + 1, 0, clampedLen))}
          onSubmit={(submittedQuery) => {
            const submitted = filterBoards(boards, submittedQuery);
            const submittedCursor =
              submittedQuery.trim().toLowerCase() === query.trim().toLowerCase()
                ? clamp(index, 0, Math.max(0, submitted.length - 1))
                : 0;
            const b = submitted[submittedCursor];
            if (b) onPick(b);
          }}
          onCancel={onQuit}
        />
      </Box>

      <Box marginTop={1} flexDirection="column">
        {filtered.length === 0 ? (
          <Text color={theme.muted}>no boards match</Text>
        ) : (
          <>
            {scroll > 0 ? <Text color={theme.muted}> ^ {scroll} more above</Text> : null}
            {visible.map((b, i) => {
              const absolute = scroll + i;
              const selected = absolute === cursor;
              const label = truncate(
                `${b.name}  ${b.projectKey ? `[${b.projectKey}]` : ""}  ${b.type}`,
                Math.max(10, rowWidth - 2),
              );
              return (
                <Box key={b.id}>
                  <Text color={selected ? theme.accent : theme.muted}>
                    {selected ? "> " : "  "}
                  </Text>
                  <Text
                    {...fg(selected ? theme.fg : theme.fgDim)}
                    bold={selected}
                    inverse={selected}
                  >
                    {label}
                  </Text>
                </Box>
              );
            })}
            {filtered.length > scroll + viewportHeight ? (
              <Text color={theme.muted}>
                {"  "}v {filtered.length - scroll - viewportHeight} more below
              </Text>
            ) : null}
          </>
        )}
      </Box>

      <Box marginTop={1}>
        <Text color={theme.muted}>
          {filtered.length} of {boards.length} · ↑↓ nav · ⏎ pick · esc quit
        </Text>
      </Box>
    </Box>
  );
}
