import { Box, Text, useInput } from "ink";
import { useRef, useState } from "react";

import type { JiraConfig } from "../config";
import { useDimensions } from "../hooks";
import { type IssueSearchResult, searchByJql } from "../jira";
import { clamp, errorMessage, fg, theme, truncate } from "../ui";
import { Hint } from "./Hint";
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
  // Sequence-guard for in-flight queries. If the user submits, cancels,
  // and the old request resolves after, we ignore its result.
  const searchSeq = useRef(0);

  useInput((_input, key) => {
    // Esc always cancels, even during a query — the user shouldn't be
    // trapped by a hung network. The in-flight request's result is
    // discarded via the seq guard.
    if (key.escape) onCancel();
  });

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
            setJql(v);
            setError(null);
          }}
          onSubmit={async () => {
            if (!jql.trim()) return;
            const seq = ++searchSeq.current;
            setLoading(true);
            setError(null);
            try {
              const r = await searchByJql(cfg, jql.trim());
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
          onCancel={onCancel}
        />
      </Box>
      {error ? (
        <Box marginTop={1}>
          <Text color={theme.error}>{error}</Text>
        </Box>
      ) : null}
      {loading ? (
        <Box marginTop={1}>
          <Text color={theme.accent}>searching…</Text>
        </Box>
      ) : results.length > 0 ? (
        <JqlResults results={results} idx={idx} setIdx={setIdx} onPick={onPick} />
      ) : jql.trim() === "" ? (
        <Box marginTop={1}>
          <Text color={theme.muted}>type a JQL query and press ⏎</Text>
        </Box>
      ) : null}
      <Box marginTop={1}>
        <Hint k="⏎" label="search" />
        <Hint k="esc" label="close" />
      </Box>
    </Box>
  );
}

function JqlResults({
  results,
  idx,
  setIdx,
  onPick,
}: {
  results: IssueSearchResult[];
  idx: number;
  setIdx: (i: number) => void;
  onPick: (key: string) => void;
}) {
  const { rows } = useDimensions();
  const maxVisible = Math.max(5, rows - 12);
  // Scroll is derived from the cursor every render via a ref anchor — no
  // separate useState, so cursor and scroll can never disagree on a frame.
  const scrollRef = useRef(0);

  const cursor = clamp(idx, 0, Math.max(0, results.length - 1));

  useInput((input, key) => {
    if (key.upArrow || input === "k") setIdx(clamp(cursor - 1, 0, results.length - 1));
    else if (key.downArrow || input === "j") setIdx(clamp(cursor + 1, 0, results.length - 1));
    else if (key.return) {
      const r = results[cursor];
      if (r) onPick(r.key);
    }
  });
  let scroll = scrollRef.current;
  const ceiling = Math.max(0, results.length - maxVisible);
  if (scroll > ceiling) scroll = ceiling;
  if (cursor < scroll) scroll = cursor;
  else if (cursor >= scroll + maxVisible) scroll = cursor - maxVisible + 1;
  if (scroll < 0) scroll = 0;
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
