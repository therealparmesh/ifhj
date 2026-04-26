import { Box, Text } from "ink";

import { theme } from "../ui";

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
  query: string;
  matches: number;
  matchIdx: number;
}) {
  const pointText = Number.isInteger(visiblePointSum)
    ? String(visiblePointSum)
    : visiblePointSum.toFixed(1);
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
            <Text color={theme.cyan}>
              {filterCount} filter{filterCount > 1 ? "s" : ""}
            </Text>
            <Text color={theme.muted}> (F clear)</Text>
          </>
        ) : null}
      </Box>
      <Box>
        {query ? (
          <>
            <Text color={theme.warn}>/{query}</Text>
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
