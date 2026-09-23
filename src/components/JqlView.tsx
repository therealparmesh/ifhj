import { Box, Text } from "ink";
import { useCallback, useEffect, useRef, useState } from "react";

import type { JiraConfig } from "../config";
import { useDimensions } from "../hooks";
import { JQL_SEARCH_LIMIT, type IssueSearchResult, searchByJql } from "../jira";
import { useSelectionIndex } from "../selection";
import { clamp, errorMessage, fg, stickyScroll, theme, truncate } from "../ui";
import { ErrorMessage } from "./ErrorMessage";
import { Hint } from "./Hint";
import { LoadingLine } from "./LoadingLine";
import { TextInput } from "./TextInput";

export function JqlView({
  cfg,
  onPick,
  onCancel,
  dimensions,
}: {
  cfg: JiraConfig;
  onPick: (key: string) => void;
  onCancel: () => void;
  dimensions?: { cols: number; rows: number };
}) {
  const measured = useDimensions();
  const { cols, rows } = dimensions ?? measured;
  const [jql, setJql] = useState("");
  const [results, setResults] = useState<IssueSearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [, setIdx, getIdx] = useSelectionIndex();
  const [searched, setSearched] = useState(false);
  // Invalidated by every edit, newer submit, cancel, and unmount.
  const searchSeq = useRef(0);
  const invalidateSearch = useCallback(() => {
    searchSeq.current++;
  }, []);

  useEffect(() => invalidateSearch, [invalidateSearch]);

  const cursor = clamp(getIdx(), 0, Math.max(0, results.length - 1));

  const innerHeight = Math.max(1, rows - 6);
  // Title (1), input with top margin (2), and footer with top margin (2).
  const resultHeight = Math.max(1, innerHeight - 5);

  return (
    <Box
      flexDirection="column"
      width={cols}
      height={rows}
      padding={2}
      borderStyle="round"
      borderColor={theme.accent}
    >
      <Text color={theme.accent} bold>
        JQL query
      </Text>
      <Box marginTop={1}>
        <Text color={theme.muted}>› </Text>
        <TextInput
          value={jql}
          placeholder="For example, assignee = currentUser() AND sprint in openSprints()"
          width={Math.max(1, cols - 8)}
          onChange={(v) => {
            invalidateSearch();
            setJql(v);
            setLoading(false);
            setError(null);
            setResults([]);
            setSearched(false);
          }}
          onSubmit={async (latestJql) => {
            const query = latestJql.trim();
            const selected =
              latestJql === jql
                ? results[clamp(getIdx(), 0, Math.max(0, results.length - 1))]
                : undefined;
            if (selected && !loading) {
              onPick(selected.key);
              return;
            }
            if (!query) return;
            const seq = ++searchSeq.current;
            setLoading(true);
            setSearched(true);
            setError(null);
            setResults([]);
            try {
              const r = await searchByJql(cfg, query);
              if (seq !== searchSeq.current) return;
              setResults(r);
              setIdx(0);
            } catch (e) {
              if (seq !== searchSeq.current) return;
              setError(errorMessage(e));
              setResults([]);
            } finally {
              if (seq === searchSeq.current) setLoading(false);
            }
          }}
          onUpArrow={() => setIdx(clamp(getIdx() - 1, 0, Math.max(0, results.length - 1)))}
          onDownArrow={() => setIdx(clamp(getIdx() + 1, 0, Math.max(0, results.length - 1)))}
          onCancel={() => {
            invalidateSearch();
            onCancel();
          }}
        />
      </Box>
      {error ? (
        <Box marginTop={1} width={Math.max(1, cols - 6)}>
          <ErrorMessage message={error} width={Math.max(1, cols - 6)} rows={3} />
        </Box>
      ) : null}
      {loading ? (
        <Box marginTop={1}>
          <LoadingLine label="Searching…" />
        </Box>
      ) : results.length > 0 ? (
        <JqlResults results={results} idx={cursor} cols={cols} height={resultHeight} />
      ) : searched && !error ? (
        <Box marginTop={1}>
          <Text color={theme.muted}>No issues match this JQL.</Text>
        </Box>
      ) : jql.trim() === "" ? (
        <Box marginTop={1}>
          <Text color={theme.muted}>Type a JQL query and press Enter.</Text>
        </Box>
      ) : null}
      <Box marginTop={1}>
        <Hint k="⏎" label={results.length > 0 ? "open" : error ? "retry" : "search"} />
        <Hint k="esc" label="close" />
        <Text color={theme.muted}> up to {JQL_SEARCH_LIMIT} results</Text>
      </Box>
    </Box>
  );
}

function JqlResults({
  results,
  idx,
  cols,
  height,
}: {
  results: IssueSearchResult[];
  idx: number;
  cols: number;
  height: number;
}) {
  // The top margin, count, and both possible indicators consume four rows.
  const contentHeight = Math.max(1, height - 1);
  const maxVisible = Math.max(1, contentHeight - 3);
  // Scroll is derived from the cursor every render via a ref anchor — no
  // separate useState, so cursor and scroll can never disagree on a frame.
  const scrollRef = useRef(0);

  const cursor = clamp(idx, 0, Math.max(0, results.length - 1));

  const scroll = stickyScroll(results.length, maxVisible, cursor, scrollRef.current);
  scrollRef.current = scroll;

  const visible = results.slice(scroll, scroll + maxVisible);
  return (
    <Box flexDirection="column" marginTop={1} height={contentHeight} overflow="hidden">
      <Text color={theme.muted}>
        {results.length} result{results.length === 1 ? "" : "s"}
      </Text>
      {scroll > 0 ? <Text color={theme.muted}> ^ {scroll} more</Text> : null}
      {visible.map((r, i) => {
        const abs = scroll + i;
        const sel = abs === cursor;
        const typeWidth = Bun.stringWidth(r.issueType) + 1;
        const titleWidth = Math.max(1, cols - 6 - 2 - Bun.stringWidth(r.key) - 3 - typeWidth);
        return (
          <Box key={r.key} width={Math.max(1, cols - 6)} height={1} overflow="hidden">
            <Text color={sel ? theme.accent : theme.muted}>{sel ? "> " : "  "}</Text>
            <Text color={sel ? theme.accent : theme.fgDim} bold={sel}>
              {r.key}
            </Text>
            <Text color={theme.muted}> · </Text>
            <Text {...fg(sel ? theme.fg : theme.fgDim)}>{truncate(r.summary, titleWidth)}</Text>
            <Text color={theme.muted}> {r.issueType}</Text>
          </Box>
        );
      })}
      {results.length > scroll + maxVisible ? (
        <Text color={theme.muted}> v {results.length - scroll - maxVisible} more</Text>
      ) : null}
    </Box>
  );
}
