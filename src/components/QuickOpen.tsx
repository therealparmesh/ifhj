import { Box, Text } from "ink";
import { useCallback, useEffect, useRef, useState } from "react";

import type { RecentIssue } from "../cache";
import type { JiraConfig } from "../config";
import { useDimensions } from "../hooks";
import { type IssueSearchResult, searchIssues } from "../jira";
import { clamp, fg, stickyScroll, theme, truncate } from "../ui";
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
  | { kind: "issue"; key: string; summary: string; issueType?: string };

type SearchState = {
  query: string;
  status: "idle" | "loading" | "done" | "error";
  results: IssueSearchResult[];
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
    rows.push({ kind: "sep", label: "recent" });
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
      ? "all issues · searching…"
      : status === "error"
        ? "all issues · search failed"
        : globalResults.length === 0
          ? "all issues · no matches"
          : "all issues";
  rows.push({ kind: "sep", label });
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
}: {
  cfg: JiraConfig;
  recents: RecentIssue[];
  onPick: (key: string) => void;
  onCancel: () => void;
}) {
  const { rows: termRows } = useDimensions();
  const [q, setQ] = useState("");
  const [idx, setIdx] = useState(0);
  const [search, setSearch] = useState<SearchState>({ query: "", status: "idle", results: [] });
  const scrollRef = useRef(0);
  // Sequence-guard so a slow global search that resolves after a newer
  // keystroke (or after cancel) can't overwrite fresher results.
  const searchSeq = useRef(0);

  const query = normalizeQuery(q);
  const invalidateSearch = useCallback((seq: number) => {
    if (searchSeq.current === seq) searchSeq.current++;
  }, []);

  // Each debounced request and its rendered results carry the same normalized
  // query, so old results cannot become selectable under new input.
  useEffect(() => {
    if (!query) {
      searchSeq.current++;
      setSearch({ query: "", status: "idle", results: [] });
      return;
    }
    const seq = ++searchSeq.current;
    setSearch({ query, status: "loading", results: [] });
    const t = setTimeout(async () => {
      try {
        const results = await searchIssues(cfg, query);
        if (seq === searchSeq.current) setSearch({ query, status: "done", results });
      } catch {
        // Surface failure in the section label rather than passing it off as
        // "no matches" — a network error and an empty result look different.
        if (seq === searchSeq.current) {
          setSearch({ query, status: "error", results: [] });
        }
      }
    }, 200);
    return () => {
      clearTimeout(t);
      invalidateSearch(seq);
    };
  }, [query, cfg, invalidateSearch]);

  // Build the flat row list: recents section (filtered by query when typing),
  // then — once typing — the global-search section with recents already shown
  // removed so nothing repeats.
  const rows = buildRows(recents, query, search);

  // Selectable indices only (skip separators) — navigation snaps between them.
  const pickable = rows.flatMap((r, i) => (r.kind === "issue" ? [i] : []));
  // `idx` is an index into `pickable`; clamp it as the list changes under us.
  const sel = clamp(idx, 0, Math.max(0, pickable.length - 1));
  const cursorRow = pickable[sel] ?? -1;

  const maxVisible = Math.max(5, termRows - 9);
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
    <Box flexDirection="column" padding={2} borderStyle="round" borderColor={theme.accent}>
      <Text color={theme.accent} bold>
        quick open
      </Text>
      <Box marginTop={1}>
        <Text color={theme.muted}>› </Text>
        <TextInput
          value={q}
          placeholder="issue key or summary — recent issues shown by default…"
          onChange={(v) => {
            setQ(v);
            setIdx(0);
          }}
          onUpArrow={() => setIdx(clamp(sel - 1, 0, Math.max(0, pickable.length - 1)))}
          onDownArrow={() => setIdx(clamp(sel + 1, 0, Math.max(0, pickable.length - 1)))}
          onSubmit={(submittedValue) => {
            const submittedQuery = normalizeQuery(submittedValue);
            const submittedRows = buildRows(recents, submittedQuery, search);
            const submittedPickable = submittedRows.filter(
              (row): row is Extract<Row, { kind: "issue" }> => row.kind === "issue",
            );
            const submittedCursor =
              submittedQuery === query
                ? clamp(idx, 0, Math.max(0, submittedPickable.length - 1))
                : 0;
            const row = submittedPickable[submittedCursor];
            if (row?.kind === "issue") onPick(row.key);
          }}
          onCancel={() => {
            searchSeq.current++;
            onCancel();
          }}
        />
      </Box>

      <Box marginTop={1} flexDirection="column">
        {/* rows is only empty with no query (no recents) — a typed query always
            has at least the "all issues" separator, whose label carries the
            no-matches state. */}
        {rows.length === 0 ? (
          <Text color={theme.muted}>no recent issues — type to search</Text>
        ) : (
          <>
            {scroll > 0 ? <Text color={theme.muted}> ^ {scroll} more</Text> : null}
            {visible.map((row, i) => {
              const abs = scroll + i;
              if (row.kind === "sep") {
                return (
                  <Text key={`sep-${abs}`} color={theme.accentAlt} bold>
                    {row.label}
                  </Text>
                );
              }
              const selected = abs === cursorRow;
              return (
                <Box key={row.key}>
                  <Text color={selected ? theme.accent : theme.muted}>
                    {selected ? "> " : "  "}
                  </Text>
                  <Text color={selected ? theme.accent : theme.fgDim} bold={selected}>
                    {row.key}
                  </Text>
                  <Text color={theme.muted}> · </Text>
                  <Text {...fg(selected ? theme.fg : theme.fgDim)}>
                    {truncate(row.summary, 60)}
                  </Text>
                  {row.issueType ? <Text color={theme.muted}> {row.issueType}</Text> : null}
                </Box>
              );
            })}
            {hiddenBelow > 0 ? <Text color={theme.muted}> v {hiddenBelow} more</Text> : null}
          </>
        )}
      </Box>

      <Box marginTop={1}>
        <Hint k="↑↓" label="nav" />
        <Hint k="⏎" label="open" />
        <Hint k="esc" label="cancel" />
      </Box>
    </Box>
  );
}
