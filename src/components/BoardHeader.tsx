import { Box, Text } from "ink";

import { normalizeText } from "../text";
import { type EstimateDisplay, formatEstimate, theme, truncate } from "../ui";

/** One bounded board status row. */
export function BoardHeader({
  boardName,
  projectKey,
  visibleIssueCount,
  totalIssueCount,
  visiblePointSum,
  estimateDisplay,
  colIndex,
  colCount,
  filterCount,
  swimlaneLabel,
  timelineActive,
  query,
  matches,
  matchIdx,
  termCols,
}: {
  boardName: string;
  projectKey: string;
  visibleIssueCount: number;
  totalIssueCount: number;
  visiblePointSum: number;
  estimateDisplay: EstimateDisplay;
  colIndex: number;
  colCount: number;
  filterCount: number;
  swimlaneLabel?: string;
  timelineActive?: boolean;
  query: string;
  matches: number;
  matchIdx: number;
  termCols: number;
}) {
  const estimate =
    visiblePointSum > 0 ? ` · ${formatEstimate(visiblePointSum, estimateDisplay)}` : "";
  const count = `${visibleIssueCount}${filterCount > 0 ? `/${totalIssueCount}` : ""} issues`;
  const filters = filterCount > 0 ? ` · ${filterCount} filter${filterCount === 1 ? "" : "s"}` : "";
  const view = timelineActive
    ? "Timeline"
    : swimlaneLabel
      ? `${swimlaneLabel} lanes`
      : colCount > 0
        ? `col ${colIndex + 1}/${colCount}`
        : "board";
  const left = normalizeText(
    `${view} · ${count}${filters}${estimate} · ${boardName}${projectKey ? ` · ${projectKey}` : ""}`,
  );
  const match = matches === 0 ? "no matches" : `${matchIdx + 1}/${matches}`;
  const right = query ? `${match} · /${normalizeText(query)}` : "? help";
  const width = Math.max(1, termCols - 2);
  const rightWidth = Math.min(Math.floor(width * 0.4), Bun.stringWidth(right));
  const leftWidth = Math.max(1, width - rightWidth - (rightWidth > 0 ? 1 : 0));

  return (
    <Box paddingX={1} width={termCols}>
      <Text color={theme.accent} bold wrap="truncate">
        {pad(truncate(`▎${left}`, leftWidth), leftWidth)}
      </Text>
      {rightWidth > 0 ? (
        <Text color={query ? theme.warning : theme.muted} wrap="truncate">
          {" "}
          {truncate(right, rightWidth)}
        </Text>
      ) : null}
    </Box>
  );
}

function pad(value: string, width: number): string {
  return value + " ".repeat(Math.max(0, width - Bun.stringWidth(value)));
}
