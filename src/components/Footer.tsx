import { Box, Text } from "ink";

import type { Issue } from "../jira";
import { fg, theme, truncate, typeColor } from "../ui";
import { Hint } from "./Hint";
import { TextInput } from "./TextInput";

type FooterProps = {
  currentIssue: Issue | null;
  termCols: number;
  mode: "normal" | "search";
  query: string;
  matches: number;
  matchIdx: number;
  filterCount: number;
  /** Board defines swimlanes → show the `s` toggle hint. */
  hasSwimlanes: boolean;
  /** Swimlane view currently active → label the toggle "flat" instead. */
  swimActive: boolean;
  searchBuffer: string;
  onSearchChange: (v: string) => void;
  onSearchSubmit: (v: string) => void;
  onSearchCancel: () => void;
};

export function Footer({
  currentIssue,
  termCols,
  mode,
  query,
  matches,
  matchIdx,
  filterCount,
  hasSwimlanes,
  swimActive,
  searchBuffer,
  onSearchChange,
  onSearchSubmit,
  onSearchCancel,
}: FooterProps) {
  return (
    <Box flexDirection="column" paddingX={1}>
      <Box>
        <Text color={theme.divider}>{"─".repeat(Math.max(0, termCols - 2))}</Text>
      </Box>

      {currentIssue ? (
        <Box>
          <Text color={theme.accent} bold>
            {currentIssue.key}
          </Text>
          <Text color={theme.muted}> · </Text>
          <Text color={typeColor(currentIssue.issueType)}>{currentIssue.issueType}</Text>
          <Text color={theme.muted}> · </Text>
          <Text {...fg(theme.fg)}>
            {truncate(currentIssue.summary, Math.max(10, termCols - currentIssue.key.length - 20))}
          </Text>
        </Box>
      ) : (
        <Text color={theme.muted}>no issue selected</Text>
      )}

      {mode === "search" ? (
        <Box flexDirection="column">
          <Box marginTop={0}>
            <Text color={theme.warning} bold>
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
        // Hints are ordered navigation → current-card actions → board-wide →
        // global/meta, and each conditional group only shows when its keys are
        // actually live, so the bar never advertises a no-op.
        <Box flexWrap="wrap">
          <Hint k="↑↓←→/hjkl" label="nav" />
          {currentIssue ? (
            <>
              <Hint k="⏎" label="actions" />
              <Hint k="v" label="view" />
              <Hint k="t" label="transition" />
              <Hint k="< >" label="± col" />
              <Hint k="[ ]" label="rank" />
              <Hint k="m" label="move" />
              <Hint k="i" label="assign me" />
              <Hint k="y" label="yank" />
            </>
          ) : null}
          <Hint k="c" label="create" />
          <Hint k="a" label="quick add" />
          <Hint k="/" label="search" />
          {query ? (
            <Hint
              k="n N"
              label={matches === 0 ? "no matches" : `match ${matchIdx + 1}/${matches}`}
            />
          ) : null}
          <Hint k="f" label="filter" />
          {filterCount > 0 ? <Hint k="F" label="clear filters" /> : null}
          {hasSwimlanes ? <Hint k="s" label={swimActive ? "flat view" : "swimlanes"} /> : null}
          <Hint k="R" label="open" />
          <Hint k="r" label="refresh" />
          <Hint k="?" label="help" />
          <Hint k="q" label="quit" />
        </Box>
      )}
    </Box>
  );
}
