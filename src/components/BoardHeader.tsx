import { Box, Text } from "ink";

import { formatPoints, theme } from "../ui";

/**
 * Top-of-screen status line: board name, project, issue count, active
 * column, assignee filter badge, and a committed-search summary on the right.
 */
export function BoardHeader({
  boardName,
  projectKey,
  visibleIssueCount,
  totalIssueCount,
  visiblePointSum,
  colIndex,
  colCount,
  filterCount,
  swimlaneLabel,
  query,
  matches,
  matchIdx,
}: {
  boardName: string;
  projectKey: string;
  visibleIssueCount: number;
  totalIssueCount: number;
  /** Sum of story points across currently-visible issues. Hidden when 0. */
  visiblePointSum: number;
  colIndex: number;
  colCount: number;
  filterCount: number;
  /** When the swimlane view is active, the grouping's label (e.g. "custom",
   *  "assignee"). Absent/empty ⇒ flat board, no badge. */
  swimlaneLabel?: string;
  query: string;
  matches: number;
  matchIdx: number;
}) {
  const pointText = formatPoints(visiblePointSum);
  return (
    <Box paddingX={1} justifyContent="space-between">
      <Box>
        <Text color={theme.accent} bold>
          ▎{boardName}
        </Text>
        <Text color={theme.muted}> · {projectKey}</Text>
        <Text color={theme.muted}>
          {" "}
          · {visibleIssueCount}
          {filterCount > 0 ? ` / ${totalIssueCount}` : ""} issues
        </Text>
        {visiblePointSum > 0 ? <Text color={theme.muted}> · {pointText}p</Text> : null}
        {colCount > 0 ? (
          <Text color={theme.muted}>
            {"  "}
            col {colIndex + 1}/{colCount}
          </Text>
        ) : null}
        {filterCount > 0 ? (
          <>
            <Text color={theme.muted}>{"  "}</Text>
            <Text color={theme.info}>
              {filterCount} filter{filterCount > 1 ? "s" : ""}
            </Text>
            <Text color={theme.muted}> (F clear)</Text>
          </>
        ) : null}
        {swimlaneLabel ? (
          <>
            <Text color={theme.muted}>{"  "}</Text>
            <Text color={theme.accentAlt}>≡ {swimlaneLabel} lanes</Text>
          </>
        ) : null}
      </Box>
      <Box>
        {query ? (
          <>
            <Text color={theme.warning}>/{query}</Text>
            <Text color={theme.muted}>
              {"  "}
              {matches === 0 ? "no matches" : `${matchIdx + 1}/${matches}`}
            </Text>
          </>
        ) : (
          <Text color={theme.muted}>? help</Text>
        )}
      </Box>
    </Box>
  );
}
