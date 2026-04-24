import { Box, Text } from "ink";

import type { Issue } from "../jira";
import { theme, truncate, typeColors } from "../ui";
import { Hint } from "./Hint";
import { TextInput } from "./TextInput";

export type Tone = "ok" | "err" | "info";
export type FlashStatus = { text: string; tone: Tone };

function statusColor(tone: Tone): string {
  if (tone === "ok") return theme.ok;
  if (tone === "err") return theme.err;
  return theme.cyan;
}

type FooterProps = {
  currentIssue: Issue | null;
  termCols: number;
  status: FlashStatus | null;
  mode: "normal" | "search";
  query: string;
  matches: number;
  matchIdx: number;
  filterCount: number;
  searchBuffer: string;
  onSearchChange: (v: string) => void;
  onSearchSubmit: (v: string) => void;
  onSearchCancel: () => void;
};

export function Footer({
  currentIssue,
  termCols,
  status,
  mode,
  query,
  matches,
  matchIdx,
  filterCount,
  searchBuffer,
  onSearchChange,
  onSearchSubmit,
  onSearchCancel,
}: FooterProps) {
  return (
    <Box flexDirection="column" paddingX={1}>
      <Box>
        <Text color={theme.accentDim}>{"─".repeat(Math.max(0, termCols - 2))}</Text>
      </Box>

      {currentIssue ? (
        <Box>
          <Text color={theme.pink} bold>
            {currentIssue.key}
          </Text>
          <Text color={theme.muted}> · </Text>
          <Text color={typeColors[currentIssue.issueType] ?? theme.fg}>
            {currentIssue.issueType}
          </Text>
          <Text color={theme.muted}> · </Text>
          <Text color={theme.fg}>
            {truncate(currentIssue.summary, Math.max(10, termCols - currentIssue.key.length - 20))}
          </Text>
        </Box>
      ) : (
        <Text color={theme.muted}>no issue selected</Text>
      )}

      {mode === "search" ? (
        <Box flexDirection="column">
          <Box marginTop={0}>
            <Text color={theme.warn} bold>
              /{" "}
            </Text>
            <TextInput
              value={searchBuffer}
              placeholder="filter by key, summary, assignee…"
              onChange={onSearchChange}
              onSubmit={onSearchSubmit}
              onCancel={onSearchCancel}
            />
            <Text color={theme.muted}>
              {"   "}
              {searchBuffer.trim()
                ? matches === 0
                  ? "no matches"
                  : `${matches} match${matches === 1 ? "" : "es"}`
                : ""}
            </Text>
          </Box>
          <Box>
            <Hint k="⏎" label="apply" />
            <Hint k="esc" label="cancel" />
          </Box>
        </Box>
      ) : (
        /**
         * Compact hint strip — high-traffic keys only, `?` opens the full
         * reference. Conditional hints surface only when actionable.
         */
        <Box flexWrap="wrap">
          <Hint k="↑↓←→/hjkl" label="nav" />
          <Hint k="⏎" label="actions" />
          <Hint k="v" label="view" />
          <Hint k="t" label="transition" />
          <Hint k="m" label="move" />
          <Hint k="i" label="assign me" />
          <Hint k="c" label="create" />
          <Hint k="/" label="search" />
          <Hint k="f" label="filter" />
          {query ? (
            <Hint
              k="n N"
              label={matches === 0 ? "no matches" : `match ${matchIdx + 1}/${matches}`}
            />
          ) : null}
          {filterCount > 0 ? <Hint k="F" label="clear filters" /> : null}
          <Hint k="r" label="refresh" />
          <Hint k="?" label="help" />
          <Hint k="q" label="quit" />
        </Box>
      )}

      {status ? (
        <Box>
          <Text color={statusColor(status.tone)}>● {status.text}</Text>
        </Box>
      ) : null}
    </Box>
  );
}
