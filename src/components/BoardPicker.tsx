import { Box, Text, useInput } from "ink";
import { useEffect, useMemo, useRef, useState } from "react";

import type { JiraConfig } from "../config";
import { useDimensions } from "../hooks";
import { type Board, listBoards } from "../jira";
import { bg, clamp, errorMessage, theme, truncate } from "../ui";
import { TextInput } from "./TextInput";

type Props = {
  cfg: JiraConfig;
  onPick: (b: Board) => void;
  onQuit: () => void;
};

export function BoardPicker({ cfg, onPick, onQuit }: Props) {
  const [boards, setBoards] = useState<Board[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  // Scroll is derived from the cursor at render time via a ref anchor. No
  // useState for scroll means cursor/scroll can't disagree on a frame.
  const scrollRef = useRef(0);
  const { cols, rows } = useDimensions();

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const list = await listBoards(cfg);
        // Jira sometimes returns dupes across pages — dedupe by id.
        const seen = new Set<number>();
        const unique: Board[] = [];
        for (const b of list) {
          if (seen.has(b.id)) continue;
          seen.add(b.id);
          unique.push(b);
        }
        if (!cancelled) setBoards(unique);
      } catch (e) {
        if (!cancelled) setError(errorMessage(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [cfg]);

  const filtered = useMemo(() => {
    if (!boards) return [];
    const q = query.toLowerCase().trim();
    if (!q) return boards;
    return boards.filter(
      (b) =>
        b.name.toLowerCase().includes(q) ||
        (b.projectKey ?? "").toLowerCase().includes(q) ||
        (b.projectName ?? "").toLowerCase().includes(q) ||
        b.type.toLowerCase().includes(q),
    );
  }, [boards, query]);

  const viewportHeight = Math.max(5, rows - 8);

  useEffect(() => {
    setIndex(0);
    scrollRef.current = 0;
  }, [query]);

  /**
   * PgUp/PgDn only — text entry, arrow nav, and esc-to-quit live inside
   * <TextInput/>.
   */
  useInput((_input, key) => {
    if (key.pageUp) setIndex((i) => clamp(i - viewportHeight, 0, Math.max(0, filtered.length - 1)));
    else if (key.pageDown)
      setIndex((i) => clamp(i + viewportHeight, 0, Math.max(0, filtered.length - 1)));
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
          <Text color={theme.info}>◴ </Text>
          <Text color={theme.muted}>loading boards…</Text>
        </Box>
      </Box>
    );
  }

  // Pure derived scroll: anchor in ref, shift only when cursor hits an edge.
  const cursor = clamp(index, 0, Math.max(0, filtered.length - 1));
  let scroll = scrollRef.current;
  const ceiling = Math.max(0, filtered.length - viewportHeight);
  if (scroll > ceiling) scroll = ceiling;
  if (cursor < scroll) scroll = cursor;
  else if (cursor >= scroll + viewportHeight) scroll = cursor - viewportHeight + 1;
  if (scroll < 0) scroll = 0;
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
          onUpArrow={() => setIndex((i) => clamp(i - 1, 0, Math.max(0, filtered.length - 1)))}
          onDownArrow={() => setIndex((i) => clamp(i + 1, 0, Math.max(0, filtered.length - 1)))}
          onSubmit={() => {
            const b = filtered[index];
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
                  <Text
                    color={selected ? theme.accent : theme.muted}
                    {...bg(selected ? theme.selectedBg : undefined)}
                  >
                    {selected ? "> " : "  "}
                  </Text>
                  <Text
                    color={selected ? theme.selectedFg : theme.fgDim}
                    bold={selected}
                    {...bg(selected ? theme.selectedBg : undefined)}
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
