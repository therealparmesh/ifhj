import { Box, Text } from "ink";

import type { Issue } from "../jira";
import { normalizeText } from "../text";
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
  timelineActive: boolean;
  searchBuffer: string;
  onSearchChange: (v: string) => void;
  onSearchSubmit: (v: string) => void;
  onSearchCancel: () => void;
  emptyMessage?: string | undefined;
  dateSummary?: string | undefined;
};

type FooterHintState = Pick<
  FooterProps,
  | "filterCount"
  | "hasSwimlanes"
  | "swimActive"
  | "timelineActive"
  | "query"
  | "matches"
  | "matchIdx"
> & { hasIssue: boolean };

function normalHints(state: FooterHintState): { k: string; label: string }[] {
  if (state.timelineActive) {
    return [
      { k: "↑↓/jk", label: "rows" },
      { k: "←→/hl", label: "pan" },
      { k: "+/-", label: "zoom" },
      { k: "0/.", label: "today/issue" },
      ...(state.hasIssue
        ? [
            { k: "⏎", label: "actions" },
            { k: "v", label: "view" },
            { k: "t", label: "transition" },
            { k: "m", label: "move" },
          ]
        : []),
      { k: "esc/T", label: "board" },
      { k: "/", label: "highlight" },
      ...(state.query
        ? [
            {
              k: "n N",
              label: state.matches === 0 ? "no matches" : `${state.matchIdx + 1}/${state.matches}`,
            },
          ]
        : []),
      { k: "f", label: "filter" },
      ...(state.filterCount > 0 ? [{ k: "F", label: "clear filters" }] : []),
      ...(state.hasSwimlanes ? [{ k: "s", label: "swimlanes" }] : []),
      { k: "c", label: "create" },
      { k: "R", label: "quick open" },
      { k: "r", label: "refresh" },
      { k: "?", label: "help" },
      { k: "q", label: "boards" },
    ];
  }
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
    { k: "T", label: "timeline" },
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
  return 2 + lines + (state.timelineActive && state.hasIssue ? 1 : 0);
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
  timelineActive,
  searchBuffer,
  onSearchChange,
  onSearchSubmit,
  onSearchCancel,
  emptyMessage,
  dateSummary,
}: FooterProps) {
  const contentWidth = Math.max(1, termCols - 2);
  const keyText = currentIssue
    ? truncate(normalizeText(currentIssue.key), Math.min(18, contentWidth))
    : "";
  const typeText = currentIssue
    ? truncate(normalizeText(currentIssue.issueType), Math.min(24, contentWidth))
    : "";
  const titleWidth = Math.max(
    1,
    contentWidth - Bun.stringWidth(keyText) - Bun.stringWidth(typeText) - 6,
  );
  const titleText = currentIssue ? truncate(normalizeText(currentIssue.summary), titleWidth) : "";
  return (
    <Box flexDirection="column" paddingX={1}>
      <Box>
        <Text color={theme.divider}>{"─".repeat(Math.max(0, termCols - 2))}</Text>
      </Box>

      {currentIssue ? (
        <Box width={contentWidth}>
          <Text color={theme.accent} bold>
            {keyText}
          </Text>
          <Text color={theme.muted}> · </Text>
          <Text color={typeColor(currentIssue.issueType)}>{typeText}</Text>
          <Text color={theme.muted}> · </Text>
          <Text {...fg(theme.fg)}>{titleText}</Text>
        </Box>
      ) : (
        <Text color={theme.muted}>{emptyMessage ?? "No issue selected."}</Text>
      )}

      {mode === "normal" && currentIssue && dateSummary ? (
        <Text color={theme.muted} wrap="truncate">
          {truncate(normalizeText(dateSummary), Math.max(1, termCols - 2))}
        </Text>
      ) : null}

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
            timelineActive,
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
