import { Box, Text } from "ink";

import type { BoardColumn, Issue } from "../jira";
import {
  assigneeColor,
  bg,
  fg,
  formatPoints,
  initials,
  theme,
  truncate,
  typeColor,
  typeGlyph,
} from "../ui";

export type Column = BoardColumn & { issues: Issue[] };

/**
 * Single kanban column: header (name + count + optional WIP + optional
 * point sum), optional ▲/▼ hidden-count indicators, and the visible card
 * slice.
 */
export function ColumnView({
  column,
  width,
  marginRight,
  isActive,
  activeRow,
  scroll,
  cardsVisible,
  matchSet,
  busyKeys,
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
  /** Keys with a board-repositioning write in flight — rendered as loading. */
  busyKeys: ReadonlySet<string>;
  colIdx: number;
}) {
  const visible = column.issues.slice(scroll, scroll + cardsVisible);
  const hiddenAbove = scroll;
  const hiddenBelow = Math.max(0, column.issues.length - (scroll + cardsVisible));
  const pointSum = column.issues.reduce((a, i) => a + (i.storyPoints ?? 0), 0);
  const overWip = column.max !== undefined && column.issues.length > column.max;
  const countText =
    column.max !== undefined
      ? `${column.issues.length}/${column.max}`
      : String(column.issues.length);
  const countColor = overWip ? theme.error : theme.muted;
  return (
    <Box
      width={width}
      marginRight={marginRight}
      flexDirection="column"
      borderStyle="round"
      borderColor={isActive ? theme.accent : theme.divider}
    >
      <Box paddingX={1} justifyContent="space-between">
        <Text color={isActive ? theme.accent : theme.fgDim} bold>
          {truncate(column.name.toUpperCase(), Math.max(4, width - 14))}
        </Text>
        <Box>
          {pointSum > 0 ? <Text color={theme.muted}>{formatPoints(pointSum)}p · </Text> : null}
          <Text color={countColor} bold={overWip}>
            {countText}
          </Text>
        </Box>
      </Box>
      {hiddenAbove > 0 ? (
        <Box paddingX={1}>
          <Text color={theme.muted}>^ {hiddenAbove} more</Text>
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
              busy={busyKeys.has(issue.key)}
            />
          ))
        )}
      </Box>
      {hiddenBelow > 0 ? (
        <Box paddingX={1}>
          <Text color={theme.muted}>v {hiddenBelow} more</Text>
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
  const glyph = direction === "left" ? " <" : "> ";
  return (
    <Box width={2} flexDirection="column" justifyContent="center">
      <Text color={active ? theme.accent : theme.divider}>{active ? glyph : "  "}</Text>
    </Box>
  );
}

/**
 * Single kanban card. `innerWidth` is the width of the content column —
 * to the right of the left color bar.
 */
function Card({
  issue,
  innerWidth,
  selected,
  isMatch,
  busy,
}: {
  issue: Issue;
  innerWidth: number;
  selected: boolean;
  isMatch: boolean;
  busy: boolean;
}) {
  const accent = typeColor(issue.issueType);
  // Mid-update: bar goes warning-colored, glyph becomes a spinner, and the
  // whole card dims to muted so it reads as "in flight, don't touch".
  const bar = busy ? theme.warning : selected ? theme.accent : accent;
  const badge = initials(issue.assignee);
  const badgeColor = assigneeColor(issue.assignee);
  // Reserve 4 cells on the header row for the initials badge.
  const keyMaxLen = Math.max(4, innerWidth - 4);
  const meta = busy
    ? "updating…"
    : [issue.assignee ?? "Unassigned", issue.priority, issue.epicKey].filter(Boolean).join(" · ");
  // Only search-match rows get a painted background; selection uses
  // `inverse` on text cells only so icons/badges keep their meaning.
  const matchBgProps = bg(!selected && isMatch ? theme.matchBg : undefined);
  const keyColor = busy ? theme.muted : selected ? theme.fg : theme.fgDim;
  const summaryColor = busy ? theme.muted : selected ? theme.fg : theme.fgDim;
  const glyphColor = busy ? theme.warning : selected ? theme.fg : accent;
  const summaryText = truncate(issue.summary, Math.max(4, innerWidth));
  const metaText = truncate(meta, Math.max(4, innerWidth));
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
            <Text {...fg(glyphColor)} inverse={selected && !busy} {...matchBgProps}>
              {busy ? "◴" : typeGlyph(issue.issueType)}{" "}
            </Text>
            <Text
              {...fg(keyColor)}
              bold={selected && !busy}
              inverse={selected && !busy}
              {...matchBgProps}
            >
              {truncate(issue.key, keyMaxLen)}
            </Text>
          </Box>
          <Text
            {...fg(busy ? theme.muted : selected ? theme.fg : badgeColor)}
            bold
            inverse={selected && !busy}
            {...matchBgProps}
          >
            {badge}
          </Text>
        </Box>
        <Text
          {...fg(summaryColor)}
          bold={selected && !busy}
          inverse={selected && !busy}
          {...matchBgProps}
        >
          {summaryText}
        </Text>
        <Text
          {...fg(busy ? theme.warning : selected ? theme.fg : theme.muted)}
          inverse={selected && !busy}
          {...matchBgProps}
        >
          {metaText}
        </Text>
      </Box>
    </Box>
  );
}
