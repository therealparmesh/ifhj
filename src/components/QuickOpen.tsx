import { Box, Text } from "ink";
import { useCallback, useEffect, useRef, useState } from "react";

import type { RecentIssue } from "../cache";
import type { JiraConfig } from "../config";
import { useDimensions } from "../hooks";
import { ISSUE_SEARCH_LIMIT, type IssueSearchResult, searchIssues } from "../jira";
import { useSelectionIndex } from "../selection";
import { clamp, errorMessage, fg, stickyScroll, theme, truncate } from "../ui";
import { ErrorMessage, errorMessageHeight } from "./ErrorMessage";
import { Hint } from "./Hint";
import { TextInput } from "./TextInput";

/**
 * Quick-open finder (opened with `R`). Empty query → the recently-visited
 * issues. Once you type, the list splits: matching recents up top, a
 * separator, then a live global search (every project) below — with anything
 * already shown in the recents section filtered out of the global half so
 * nothing repeats. Arrow keys move through both sections as one flat list;
 * enter opens the focused issue.
 */

// One selectable row plus non-selectable header/separator rows, flattened into
// a single list the cursor walks. `sep` rows are skipped by navigation.
type Row =
  | { kind: "sep"; label: string }
  | { kind: "issue"; key: string; summary: string; issueType?: string }
  | { kind: "retry" };

type SearchState = {
  query: string;
  status: "idle" | "loading" | "done" | "error";
  results: IssueSearchResult[];
  error?: string;
};

function normalizeQuery(query: string): string {
  return query.trim().toLowerCase();
}

function matchingRecents(recents: RecentIssue[], query: string): RecentIssue[] {
  if (!query) return recents;
  return recents.filter(
    (recent) =>
      recent.key.toLowerCase().includes(query) || recent.summary.toLowerCase().includes(query),
  );
}

function buildRows(recents: RecentIssue[], query: string, search: SearchState): Row[] {
  const matchedRecents = matchingRecents(recents, query);
  const rows: Row[] = [];
  if (matchedRecents.length > 0) {
    rows.push({ kind: "sep", label: "Recent" });
    for (const recent of matchedRecents) {
      rows.push({ kind: "issue", key: recent.key, summary: recent.summary });
    }
  }
  if (!query) return rows;

  const current = search.query === query;
  const results = current ? search.results : [];
  const recentKeys = new Set(matchedRecents.map((recent) => recent.key));
  const globalResults = results.filter((result) => !recentKeys.has(result.key));
  const status = current ? search.status : "loading";
  const label =
    status === "loading"
      ? "All issues · Searching…"
      : status === "error"
        ? "All issues · Search failed"
        : globalResults.length === 0
          ? "All issues · No matches"
          : "All issues";
  rows.push({ kind: "sep", label });
  if (status === "error") rows.push({ kind: "retry" });
  for (const result of globalResults) {
    rows.push({
      kind: "issue",
      key: result.key,
      summary: result.summary,
      issueType: result.issueType,
    });
  }
  return rows;
}

export function QuickOpen({
  cfg,
  recents,
  onPick,
  onCancel,
  dimensions,
}: {
  cfg: JiraConfig;
  recents: RecentIssue[];
  onPick: (key: string) => void;
  onCancel: () => void;
  dimensions?: { cols: number; rows: number };
}) {
  const measured = useDimensions();
  const { cols: termCols, rows: termRows } = dimensions ?? measured;
  const [q, setQ] = useState("");
  const [, setIdx, getIdx] = useSelectionIndex();
  const queryRef = useRef("");
  const selectionQueryRef = useRef("");
  const [retryAttempt, setRetryAttempt] = useState(0);
  const [search, setSearch] = useState<SearchState>({ query: "", status: "idle", results: [] });
  const searchRef = useRef(search);
  searchRef.current = search;
  const updateSearch = useCallback((next: SearchState) => {
    searchRef.current = next;
    setSearch(next);
  }, []);
  const scrollRef = useRef(0);
  // Sequence-guard so a slow global search that resolves after a newer
  // keystroke (or after cancel) can't overwrite fresher results.
  const searchSeq = useRef(0);

  const query = normalizeQuery(q);
  const changeQuery = (value: string) => {
    const normalized = normalizeQuery(value);
    queryRef.current = normalized;
    selectionQueryRef.current = normalized;
    setIdx(0);
    scrollRef.current = 0;
    setQ(value);
  };
  const moveSelection = (delta: number) => {
    const currentRows = buildRows(recents, queryRef.current, searchRef.current);
    const selectable = currentRows.filter((row) => row.kind !== "sep");
    selectionQueryRef.current = queryRef.current;
    setIdx(clamp(getIdx() + delta, 0, Math.max(0, selectable.length - 1)));
  };
  const invalidateSearch = useCallback((seq: number) => {
    if (searchSeq.current === seq) searchSeq.current++;
  }, []);

  // Each debounced request and its rendered results carry the same normalized
  // query, so old results cannot become selectable under new input.
  useEffect(() => {
    if (!query) {
      searchSeq.current++;
      updateSearch({ query: "", status: "idle", results: [] });
      return;
    }
    const seq = ++searchSeq.current;
    updateSearch({ query, status: "loading", results: [] });
    const t = setTimeout(async () => {
      try {
        const results = await searchIssues(cfg, query);
        if (seq === searchSeq.current) updateSearch({ query, status: "done", results });
      } catch (error) {
        // Surface failure in the section label rather than passing it off as
        // "no matches" — a network error and an empty result look different.
        if (seq === searchSeq.current) {
          updateSearch({ query, status: "error", results: [], error: errorMessage(error) });
        }
      }
    }, 200);
    return () => {
      clearTimeout(t);
      invalidateSearch(seq);
    };
  }, [query, cfg, invalidateSearch, retryAttempt, updateSearch]);

  // Build the flat row list: recents section (filtered by query when typing),
  // then — once typing — the global-search section with recents already shown
  // removed so nothing repeats.
  const rows = buildRows(recents, query, search);

  // Selectable indices only (skip separators) — navigation snaps between them.
  const pickable = rows.flatMap((row, index) => (row.kind === "sep" ? [] : [index]));
  // `idx` is an index into `pickable`; clamp it as the list changes under us.
  const sel = clamp(getIdx(), 0, Math.max(0, pickable.length - 1));
  const cursorRow = pickable[sel] ?? -1;

  const innerHeight = Math.max(1, termRows - 6);
  // Title (1), input with top margin (2), list top margin (1), footer with
  // top margin (2), and both possible list indicators (2).
  const errorRows =
    search.status === "error" && search.error
      ? 1 + errorMessageHeight(search.error, Math.max(1, termCols - 6), 2)
      : 0;
  const listHeight = Math.max(1, innerHeight - 6 - errorRows);
  const maxVisible = Math.max(1, listHeight - 2);
  const scroll = stickyScroll(
    rows.length,
    maxVisible,
    cursorRow < 0 ? 0 : cursorRow,
    scrollRef.current,
  );
  scrollRef.current = scroll;
  const visible = rows.slice(scroll, scroll + maxVisible);

  // Arrows / enter / esc are owned by the always-focused TextInput below
  // (via onUpArrow/onDownArrow/onSubmit/onCancel) — no separate useInput here,
  // so each key fires exactly once.

  const hiddenBelow = rows.length - Math.min(rows.length, scroll + maxVisible);

  return (
    <Box
      flexDirection="column"
      width={termCols}
      height={termRows}
      padding={2}
      borderStyle="round"
      borderColor={theme.accent}
    >
      <Text color={theme.accent} bold>
        Quick open
      </Text>
      <Box marginTop={1}>
        <Text color={theme.muted}>› </Text>
        <TextInput
          value={q}
          placeholder="issue key or title — recent issues shown by default…"
          width={Math.max(1, termCols - 8)}
          onChange={changeQuery}
          onUpArrow={() => moveSelection(-1)}
          onDownArrow={() => moveSelection(1)}
          onSubmit={(submittedValue) => {
            const submittedQuery = normalizeQuery(submittedValue);
            const submittedRows = buildRows(recents, submittedQuery, searchRef.current);
            const submittedPickable = submittedRows.filter((row) => row.kind !== "sep");
            const submittedCursor =
              selectionQueryRef.current === submittedQuery
                ? clamp(getIdx(), 0, Math.max(0, submittedPickable.length - 1))
                : 0;
            const row = submittedPickable[submittedCursor];
            if (row?.kind === "issue") onPick(row.key);
            else if (row?.kind === "retry" && submittedQuery === queryRef.current)
              setRetryAttempt((attempt) => attempt + 1);
          }}
          onCancel={() => {
            searchSeq.current++;
            onCancel();
          }}
        />
      </Box>

      <Box marginTop={1} flexDirection="column" height={listHeight} overflow="hidden">
        {/* rows is only empty with no query (no recents) — a typed query always
            has at least the "all issues" separator, whose label carries the
            no-matches state. */}
        {rows.length === 0 ? (
          <Text color={theme.muted}>No recent issues. Type to search.</Text>
        ) : (
          <>
            {scroll > 0 ? <Text color={theme.muted}> ^ {scroll} more</Text> : null}
            {visible.map((row, i) => {
              const abs = scroll + i;
              if (row.kind === "sep") {
                return (
                  <Text key={`sep-${abs}`} color={theme.accentAlt} bold>
                    {truncate(row.label, Math.max(1, termCols - 6))}
                  </Text>
                );
              }
              const selected = abs === cursorRow;
              if (row.kind === "retry") {
                return (
                  <Box key={`retry-${abs}`}>
                    <Text color={selected ? theme.accent : theme.muted} bold={selected}>
                      {selected ? "> " : "  "}Retry server search
                    </Text>
                  </Box>
                );
              }
              const typeWidth = row.issueType ? Bun.stringWidth(row.issueType) + 1 : 0;
              const titleWidth = Math.max(
                1,
                termCols - 6 - 2 - Bun.stringWidth(row.key) - 3 - typeWidth,
              );
              return (
                <Box key={row.key} width={Math.max(1, termCols - 6)} height={1} overflow="hidden">
                  <Text color={selected ? theme.accent : theme.muted}>
                    {selected ? "> " : "  "}
                  </Text>
                  <Text color={selected ? theme.accent : theme.fgDim} bold={selected}>
                    {row.key}
                  </Text>
                  <Text color={theme.muted}> · </Text>
                  <Text {...fg(selected ? theme.fg : theme.fgDim)}>
                    {truncate(row.summary, titleWidth)}
                  </Text>
                  {row.issueType ? <Text color={theme.muted}> {row.issueType}</Text> : null}
                </Box>
              );
            })}
            {hiddenBelow > 0 ? <Text color={theme.muted}> v {hiddenBelow} more</Text> : null}
          </>
        )}
      </Box>

      {search.status === "error" && search.error ? (
        <Box marginTop={1} width={Math.max(1, termCols - 6)}>
          <ErrorMessage message={search.error} width={Math.max(1, termCols - 6)} rows={2} />
        </Box>
      ) : null}

      <Box marginTop={1}>
        <Hint k="↑↓" label="nav" />
        <Hint k="⏎" label={rows[cursorRow]?.kind === "retry" ? "retry" : "open"} />
        <Hint k="esc" label="cancel" />
        <Text color={theme.muted}> up to {ISSUE_SEARCH_LIMIT} server results</Text>
      </Box>
    </Box>
  );
}
