import { Box, Text, useInput } from "ink";
import { useRef, useState } from "react";

import type { JiraConfig } from "../config";
import { useDimensions } from "../hooks";
import { type IssueSearchResult, searchByJql } from "../jira";
import { clamp, errorMessage, theme, truncate } from "../ui";
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
  const submitted = useRef(false);

  useInput(
    (_input, key) => {
      if (key.escape) onCancel();
    },
    { isActive: !submitted.current },
  );

  return (
    <Box flexDirection="column" padding={2} borderStyle="round" borderColor={theme.warn}>
      <Text color={theme.warn} bold>
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
            submitted.current = true;
            setLoading(true);
            setError(null);
            try {
              const r = await searchByJql(cfg, jql.trim());
              setResults(r);
              setIdx(0);
            } catch (e) {
              setError(errorMessage(e));
              setResults([]);
            } finally {
              setLoading(false);
              submitted.current = false;
            }
          }}
          onCancel={onCancel}
        />
      </Box>
      {error ? (
        <Box marginTop={1}>
          <Text color={theme.err}>{error}</Text>
        </Box>
      ) : null}
      {loading ? (
        <Box marginTop={1}>
          <Text color={theme.accent}>◴ searching…</Text>
        </Box>
      ) : results.length > 0 ? (
        <JqlResults results={results} idx={idx} setIdx={setIdx} onPick={onPick} />
      ) : submitted.current ? null : jql.trim() ? null : (
        <Box marginTop={1}>
          <Text color={theme.muted}>type a JQL query and press ⏎</Text>
        </Box>
      )}
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

  useInput((input, key) => {
    if (key.upArrow || input === "k") setIdx(clamp(idx - 1, 0, results.length - 1));
    else if (key.downArrow || input === "j") setIdx(clamp(idx + 1, 0, results.length - 1));
    else if (key.return) {
      const r = results[idx];
      if (r) onPick(r.key);
    }
  });

  const cursor = clamp(idx, 0, Math.max(0, results.length - 1));
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
      {scroll > 0 ? <Text color={theme.muted}> ▲ {scroll} more</Text> : null}
      {visible.map((r, i) => {
        const abs = scroll + i;
        const sel = abs === cursor;
        return (
          <Box key={r.key}>
            <Text color={sel ? theme.accent : theme.muted}>{sel ? "▶ " : "  "}</Text>
            <Text color={sel ? theme.pink : theme.fgDim} bold={sel}>
              {r.key}
            </Text>
            <Text color={theme.muted}> · </Text>
            <Text color={sel ? theme.fg : theme.fgDim}>{truncate(r.summary, 60)}</Text>
            <Text color={theme.muted}> {r.issueType}</Text>
          </Box>
        );
      })}
      {results.length > scroll + maxVisible ? (
        <Text color={theme.muted}> ▼ {results.length - scroll - maxVisible} more</Text>
      ) : null}
    </Box>
  );
}
