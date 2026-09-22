import { Box, Text } from "ink";
import { useCallback, useEffect, useRef, useState } from "react";

import type { JiraConfig } from "../config";
import { useDimensions } from "../hooks";
import { type IssueSearchResult, searchByJql } from "../jira";
import { clamp, errorMessage, fg, stickyScroll, theme, truncate } from "../ui";
import { Hint } from "./Hint";
import { LoadingLine } from "./LoadingLine";
import { TextInput } from "./TextInput";

export function JqlView({
  cfg,
  onPick,
  onCancel,
}: {
  cfg: JiraConfig;
  onPick: (key: string) => void;
  onCancel: () => void;
}) {
  const [jql, setJql] = useState("");
  const [results, setResults] = useState<IssueSearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [idx, setIdx] = useState(0);
  // Invalidated by every edit, newer submit, cancel, and unmount.
  const searchSeq = useRef(0);
  const invalidateSearch = useCallback(() => {
    searchSeq.current++;
  }, []);

  useEffect(() => invalidateSearch, [invalidateSearch]);

  const cursor = clamp(idx, 0, Math.max(0, results.length - 1));

  return (
    <Box flexDirection="column" padding={2} borderStyle="round" borderColor={theme.warning}>
      <Text color={theme.warning} bold>
        JQL query
      </Text>
      <Box marginTop={1}>
        <Text color={theme.muted}>› </Text>
        <TextInput
          value={jql}
          placeholder="e.g. assignee = currentUser() AND sprint in openSprints()"
          onChange={(v) => {
            invalidateSearch();
            setJql(v);
            setLoading(false);
            setError(null);
            setResults([]);
          }}
          onSubmit={async (latestJql) => {
            const query = latestJql.trim();
            const selected = latestJql === jql ? results[cursor] : undefined;
            if (selected && !loading) {
              onPick(selected.key);
              return;
            }
            if (!query) return;
            const seq = ++searchSeq.current;
            setLoading(true);
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
          onUpArrow={() => setIdx(clamp(cursor - 1, 0, Math.max(0, results.length - 1)))}
          onDownArrow={() => setIdx(clamp(cursor + 1, 0, Math.max(0, results.length - 1)))}
          onCancel={() => {
            invalidateSearch();
            onCancel();
          }}
        />
      </Box>
      {error ? (
        <Box marginTop={1}>
          <Text color={theme.error}>{error}</Text>
        </Box>
      ) : null}
      {loading ? (
        <Box marginTop={1}>
          <LoadingLine label="searching…" />
        </Box>
      ) : results.length > 0 ? (
        <JqlResults results={results} idx={cursor} />
      ) : jql.trim() === "" ? (
        <Box marginTop={1}>
          <Text color={theme.muted}>type a JQL query and press ⏎</Text>
        </Box>
      ) : null}
      <Box marginTop={1}>
        <Hint k="⏎" label={results.length > 0 ? "open" : "search"} />
        <Hint k="esc" label="close" />
      </Box>
    </Box>
  );
}

function JqlResults({ results, idx }: { results: IssueSearchResult[]; idx: number }) {
  const { rows } = useDimensions();
  const maxVisible = Math.max(5, rows - 12);
  // Scroll is derived from the cursor every render via a ref anchor — no
  // separate useState, so cursor and scroll can never disagree on a frame.
  const scrollRef = useRef(0);

  const cursor = clamp(idx, 0, Math.max(0, results.length - 1));

  const scroll = stickyScroll(results.length, maxVisible, cursor, scrollRef.current);
  scrollRef.current = scroll;

  const visible = results.slice(scroll, scroll + maxVisible);
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color={theme.muted}>
        {results.length} result{results.length === 1 ? "" : "s"}
      </Text>
      {scroll > 0 ? <Text color={theme.muted}> ^ {scroll} more</Text> : null}
      {visible.map((r, i) => {
        const abs = scroll + i;
        const sel = abs === cursor;
        return (
          <Box key={r.key}>
            <Text color={sel ? theme.accent : theme.muted}>{sel ? "> " : "  "}</Text>
            <Text color={sel ? theme.accent : theme.fgDim} bold={sel}>
              {r.key}
            </Text>
            <Text color={theme.muted}> · </Text>
            <Text {...fg(sel ? theme.fg : theme.fgDim)}>{truncate(r.summary, 60)}</Text>
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
