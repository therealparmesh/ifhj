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
  emptyMessage?: string | undefined;
};

type FooterHintState = Pick<
  FooterProps,
  "filterCount" | "hasSwimlanes" | "swimActive" | "query" | "matches" | "matchIdx"
> & { hasIssue: boolean };

function normalHints(state: FooterHintState): { k: string; label: string }[] {
  return [
    { k: "↑↓←→/hjkl", label: "nav" },
    ...(state.hasIssue
      ? [
          { k: "⏎", label: "actions" },
          { k: "v", label: "view" },
          { k: "t", label: "transition" },
          { k: "< >", label: "move col" },
          { k: "[ ]", label: "rank" },
          { k: "m", label: "move" },
          { k: "i", label: "assign me" },
          { k: "y", label: "copy key" },
        ]
      : []),
    { k: "c", label: "create" },
    { k: "a", label: "quick add" },
    { k: "/", label: "highlight" },
    ...(state.query
      ? [
          {
            k: "n N",
            label:
              state.matches === 0 ? "no matches" : `match ${state.matchIdx + 1}/${state.matches}`,
          },
        ]
      : []),
    { k: "f", label: "filter" },
    ...(state.filterCount > 0 ? [{ k: "F", label: "clear filters" }] : []),
    ...(state.hasSwimlanes
      ? [{ k: "s", label: state.swimActive ? "flat view" : "swimlanes" }]
      : []),
    { k: "R", label: "quick open" },
    { k: "r", label: "refresh" },
    { k: "?", label: "help" },
    { k: "q", label: "boards" },
  ];
}

export function footerRowCount(
  termCols: number,
  mode: FooterProps["mode"],
  state: FooterHintState,
): number {
  if (mode === "search") return 4;
  const width = Math.max(1, termCols - 2);
  let lines = 1;
  let used = 0;
  for (const hint of normalHints(state)) {
    const itemWidth = Bun.stringWidth(hint.k) + Bun.stringWidth(hint.label) + 3;
    if (used > 0 && used + itemWidth > width) {
      lines++;
      used = 0;
    }
    used += itemWidth;
  }
  return 2 + lines;
}

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
  emptyMessage,
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
            {truncate(
              currentIssue.summary,
              Math.max(
                0,
                termCols -
                  Bun.stringWidth(currentIssue.key) -
                  Bun.stringWidth(currentIssue.issueType) -
                  8,
              ),
            )}
          </Text>
        </Box>
      ) : (
        <Text color={theme.muted}>{emptyMessage ?? "No issue selected."}</Text>
      )}

      {mode === "search" ? (
        <Box flexDirection="column">
          <Box>
            <Text color={theme.warning} bold>
              /{" "}
            </Text>
            <TextInput
              value={searchBuffer}
              placeholder="highlight by key, title, or assignee…"
              width={Math.max(1, termCols - 34)}
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
          {normalHints({
            hasIssue: currentIssue !== null,
            filterCount,
            hasSwimlanes,
            swimActive,
            query,
            matches,
            matchIdx,
          }).map((hint) => (
            <Hint key={`${hint.k}-${hint.label}`} k={hint.k} label={hint.label} />
          ))}
        </Box>
      )}
    </Box>
  );
}
