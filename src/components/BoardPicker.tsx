import { Box, Text, useInput } from "ink";
import { useEffect, useMemo, useState } from "react";

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
  const [scroll, setScroll] = useState(0);
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
    if (index < scroll) setScroll(index);
    else if (index >= scroll + viewportHeight) setScroll(index - viewportHeight + 1);
  }, [index, scroll, viewportHeight]);

  useEffect(() => {
    setIndex(0);
    setScroll(0);
  }, [query]);

  // PgUp/PgDn only — text entry, arrow nav, and esc-to-quit live inside
  // <TextInput/>.
  useInput((_input, key) => {
    if (key.pageUp) setIndex((i) => clamp(i - viewportHeight, 0, Math.max(0, filtered.length - 1)));
    else if (key.pageDown)
      setIndex((i) => clamp(i + viewportHeight, 0, Math.max(0, filtered.length - 1)));
  });

  if (error) {
    return (
      <Box flexDirection="column" padding={1}>
        <Text color={theme.err}>Error loading boards:</Text>
        <Text color={theme.fg}>{error}</Text>
        <Box marginTop={1}>
          <Text color={theme.muted}>press esc or ⌃c to quit</Text>
        </Box>
      </Box>
    );
  }

  if (!boards) {
    return (
      <Box padding={1}>
        <Text color={theme.accent}>◴ </Text>
        <Text color={theme.fg}>loading boards…</Text>
      </Box>
    );
  }

  const visible = filtered.slice(scroll, scroll + viewportHeight);
  const rowWidth = cols - 4;

  return (
    <Box flexDirection="column" padding={1}>
      <Box>
        <Text color={theme.accent} bold>
          ▎JIRA{" "}
        </Text>
        <Text color={theme.fgDim}>— pick a board</Text>
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
            {scroll > 0 ? <Text color={theme.muted}> ▲ {scroll} more above</Text> : null}
            {visible.map((b, i) => {
              const absolute = scroll + i;
              const selected = absolute === index;
              const label = truncate(
                `${b.name}  ${b.projectKey ? `[${b.projectKey}]` : ""}  ${b.type}`,
                Math.max(10, rowWidth - 2),
              );
              return (
                <Box key={b.id}>
                  <Text color={selected ? theme.accent : theme.muted}>
                    {selected ? "▶ " : "  "}
                  </Text>
                  <Text
                    color={selected ? theme.fg : theme.fgDim}
                    bold={selected}
                    {...bg(selected ? theme.accentDim : undefined)}
                  >
                    {label}
                  </Text>
                </Box>
              );
            })}
            {filtered.length > scroll + viewportHeight ? (
              <Text color={theme.muted}>
                {"  "}▼ {filtered.length - scroll - viewportHeight} more below
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
