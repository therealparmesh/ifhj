import { Box, Text } from "ink";
import { useEffect, useRef, useState } from "react";

import type { JiraConfig } from "../config";
import { useDimensions } from "../hooks";
import { type IssueSearchResult, searchIssues } from "../jira";
import { clamp, fg, stickyScroll, theme, truncate } from "../ui";
import { Hint } from "./Hint";
import { TextInput } from "./TextInput";

export type RecentIssue = { key: string; summary: string };

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
  const [results, setResults] = useState<IssueSearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const scrollRef = useRef(0);
  // Sequence-guard so a slow global search that resolves after a newer
  // keystroke (or after cancel) can't overwrite fresher results.
  const searchSeq = useRef(0);

  const query = q.trim().toLowerCase();

  // Debounced global search — only once the user has typed. The callback is
  // reached through refs so the timer depends only on `q`, not on every parent
  // rerender (which would restart it and re-fire the same query).
  useEffect(() => {
    if (!query) {
      // Bump the seq so any in-flight search from a prior keystroke can't
      // apply its result after the query was cleared.
      searchSeq.current++;
      setResults([]);
      setLoading(false);
      return;
    }
    const seq = ++searchSeq.current;
    setLoading(true);
    const t = setTimeout(async () => {
      try {
        const r = await searchIssues(cfg, q.trim());
        if (seq === searchSeq.current) setResults(r);
      } catch {
        if (seq === searchSeq.current) setResults([]);
      } finally {
        if (seq === searchSeq.current) setLoading(false);
      }
    }, 200);
    return () => clearTimeout(t);
  }, [q, query, cfg]);

  // Build the flat row list: recents section (filtered by query when typing),
  // then — once typing — the global-search section with recents already shown
  // removed so nothing repeats.
  const matchedRecents = query
    ? recents.filter(
        (r) => r.key.toLowerCase().includes(query) || r.summary.toLowerCase().includes(query),
      )
    : recents;

  const rows: Row[] = [];
  if (matchedRecents.length > 0) {
    rows.push({ kind: "sep", label: "recent" });
    for (const r of matchedRecents) rows.push({ kind: "issue", key: r.key, summary: r.summary });
  }
  if (query) {
    const recentKeys = new Set(matchedRecents.map((r) => r.key));
    const globalResults = results.filter((r) => !recentKeys.has(r.key));
    // The separator carries the section's state (searching / empty / count) so
    // a zero-result search reads clearly instead of showing a bare header.
    const label = loading
      ? "all issues · searching…"
      : globalResults.length === 0
        ? "all issues · no matches"
        : "all issues";
    rows.push({ kind: "sep", label });
    for (const r of globalResults)
      rows.push({ kind: "issue", key: r.key, summary: r.summary, issueType: r.issueType });
  }

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
          onSubmit={() => {
            const row = rows[cursorRow];
            if (row?.kind === "issue") onPick(row.key);
          }}
          onCancel={onCancel}
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
