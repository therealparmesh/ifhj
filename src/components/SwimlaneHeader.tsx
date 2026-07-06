import { Box, Text } from "ink";

import type { LaneColumn } from "../swimlanes";
import { theme, truncate } from "../ui";

/**
 * Sticky column-header row for the swimlane view — the lane bands below don't
 * repeat column names, so this shows them once at the top (as Jira's board
 * does). `activeCol` is the cursor's column, highlighted.
 */
export function SwimlaneHeader({
  columns,
  colWindowStart,
  visibleColCount,
  activeCol,
  width,
}: {
  columns: LaneColumn[];
  colWindowStart: number;
  visibleColCount: number;
  activeCol: number;
  width: number;
}) {
  const gap = 1;
  const colWidth = Math.max(
    12,
    Math.floor((width - gap * (visibleColCount - 1)) / Math.max(1, visibleColCount)),
  );
  const visible = columns.slice(colWindowStart, colWindowStart + visibleColCount);
  return (
    <Box flexDirection="row" width={width}>
      {visible.map((col, vi) => {
        const ci = colWindowStart + vi;
        const isActive = ci === activeCol;
        const overWip = col.max !== undefined && col.issues.length > col.max;
        const count =
          col.max !== undefined ? `${col.issues.length}/${col.max}` : String(col.issues.length);
        return (
          <Box
            key={ci}
            width={colWidth}
            marginRight={vi === visibleColCount - 1 ? 0 : gap}
            justifyContent="space-between"
          >
            <Text color={isActive ? theme.accent : theme.fgDim} bold>
              {truncate(col.name.toUpperCase(), Math.max(4, colWidth - 6))}
            </Text>
            <Text color={overWip ? theme.error : theme.muted} bold={overWip}>
              {count}
            </Text>
          </Box>
        );
      })}
    </Box>
  );
}
