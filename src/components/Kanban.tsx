import { Box, Text } from "ink";

import type { BoardColumn, Issue } from "../jira";
import { assigneeColor, bg, initials, theme, truncate, typeColors, typeGlyph } from "../ui";

export type Column = BoardColumn & { issues: Issue[] };

// Single kanban column: header (name + count), optional ▲/▼ hidden-count
// indicators, and the visible card slice.
export function ColumnView({
  column,
  width,
  marginRight,
  isActive,
  activeRow,
  scroll,
  cardsVisible,
  matchSet,
  colIdx,
}: {
  column: Column;
  width: number;
  marginRight: number;
  isActive: boolean;
  activeRow: number;
  scroll: number;
  cardsVisible: number;
  matchSet: Set<string>;
  colIdx: number;
}) {
  const visible = column.issues.slice(scroll, scroll + cardsVisible);
  const hiddenAbove = scroll;
  const hiddenBelow = Math.max(0, column.issues.length - (scroll + cardsVisible));
  return (
    <Box
      width={width}
      marginRight={marginRight}
      flexDirection="column"
      borderStyle="round"
      borderColor={isActive ? theme.accent : theme.accentDim}
    >
      <Box paddingX={1} justifyContent="space-between">
        <Text color={isActive ? theme.accent : theme.fgDim} bold>
          {truncate(column.name.toUpperCase(), width - 8)}
        </Text>
        <Text color={theme.muted}>{column.issues.length}</Text>
      </Box>
      {hiddenAbove > 0 ? (
        <Box paddingX={1}>
          <Text color={theme.muted}>▲ {hiddenAbove} more</Text>
        </Box>
      ) : null}
      <Box flexDirection="column" flexGrow={1}>
        {visible.length === 0 ? (
          <Box paddingX={1}>
            <Text color={theme.muted}>—</Text>
          </Box>
        ) : (
          visible.map((issue, i) => (
            <Card
              key={issue.key}
              issue={issue}
              innerWidth={width - 4}
              selected={isActive && scroll + i === activeRow}
              isMatch={matchSet.has(`${colIdx}:${scroll + i}`)}
            />
          ))
        )}
      </Box>
      {hiddenBelow > 0 ? (
        <Box paddingX={1}>
          <Text color={theme.muted}>▼ {hiddenBelow} more</Text>
        </Box>
      ) : null}
    </Box>
  );
}

// Side arrow — dims to near-invisible when there's nothing to page to.
export function PagingArrow({
  direction,
  active,
}: {
  direction: "left" | "right";
  active: boolean;
}) {
  const glyph = direction === "left" ? " ◀" : "▶ ";
  return (
    <Box width={2} flexDirection="column" justifyContent="center">
      <Text color={active ? theme.accent : theme.accentDim}>{active ? glyph : "  "}</Text>
    </Box>
  );
}

// Single kanban card. `innerWidth` is the width of the content column —
// to the right of the left color bar.
function Card({
  issue,
  innerWidth,
  selected,
  isMatch,
}: {
  issue: Issue;
  innerWidth: number;
  selected: boolean;
  isMatch: boolean;
}) {
  const accent = typeColors[issue.issueType] ?? theme.fg;
  const bar = selected ? theme.accent : accent;
  const badge = initials(issue.assignee);
  const badgeColor = assigneeColor(issue.assignee);
  // Reserve 4 cells on the header row for the initials badge.
  const keyMaxLen = Math.max(4, innerWidth - 4);
  const meta = [issue.assignee ?? "Unassigned", issue.priority, issue.epicKey]
    .filter(Boolean)
    .join(" · ");
  // Selected wins over match for the row background.
  const rowBg = selected ? theme.accentDim : isMatch ? theme.matchBg : undefined;
  // Pad summary + meta so the bg fills evenly — otherwise the highlight is
  // ragged on shorter lines.
  const summaryText = truncate(issue.summary, Math.max(4, innerWidth)).padEnd(innerWidth);
  const metaText = truncate(meta, Math.max(4, innerWidth)).padEnd(innerWidth);
  return (
    <Box flexDirection="row" marginBottom={1} paddingLeft={1} paddingRight={1}>
      {/* Left color bar — 3 rows to match the card body. */}
      <Box flexDirection="column" marginRight={1}>
        <Text color={bar}>▌</Text>
        <Text color={bar}>▌</Text>
        <Text color={bar}>▌</Text>
      </Box>
      <Box flexDirection="column" flexGrow={1}>
        <Box justifyContent="space-between">
          <Box>
            <Text color={accent} {...bg(rowBg)}>
              {typeGlyph(issue.issueType)}{" "}
            </Text>
            <Text color={selected ? theme.accent : theme.fgDim} bold={selected} {...bg(rowBg)}>
              {truncate(issue.key, keyMaxLen)}
            </Text>
          </Box>
          <Text color={badgeColor} bold {...bg(rowBg)}>
            {badge}
          </Text>
        </Box>
        <Text color={selected ? theme.fg : theme.fgDim} bold={selected} {...bg(rowBg)}>
          {summaryText}
        </Text>
        <Text color={selected ? theme.fgDim : theme.muted} {...bg(rowBg)}>
          {metaText}
        </Text>
      </Box>
    </Box>
  );
}
