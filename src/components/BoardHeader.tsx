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
  colIndex,
  colCount,
  assigneeFilter,
  query,
  matches,
  matchIdx,
}: {
  boardName: string;
  projectKey: string;
  visibleIssueCount: number;
  totalIssueCount: number;
  colIndex: number;
  colCount: number;
  assigneeFilter: string | null;
  query: string;
  matches: number;
  matchIdx: number;
}) {
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
          {assigneeFilter ? ` / ${totalIssueCount}` : ""} issues
        </Text>
        {colCount > 0 ? (
          <Text color={theme.muted}>
            {"  "}
            col {colIndex + 1}/{colCount}
          </Text>
        ) : null}
        {assigneeFilter ? (
          <>
            <Text color={theme.muted}>{"  "}</Text>
            <Text color={theme.cyan}>
              {assigneeFilter === "Unassigned" ? assigneeFilter : `@${assigneeFilter}`}
            </Text>
            <Text color={theme.muted}> (A clear)</Text>
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
