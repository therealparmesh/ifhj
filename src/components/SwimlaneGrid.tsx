import { Box, Text } from "ink";

import type { Issue } from "../jira";
import type { Lane, SwimCursor } from "../swimlanes";
import { cursorVisualIndex, visualRows } from "../swimlanes";
import {
  assigneeColor,
  bg,
  fg,
  initials,
  stickyScroll,
  theme,
  truncate,
  typeColor,
  typeGlyph,
} from "../ui";

/**
 * Compact swimlane grid. Unlike the flat board's 3-line rich cards, cards
 * here are a single line so multiple lanes fit a terminal. Renders a fixed
 * `height` window of visual rows (lane titles + card rows), scrolled to keep
 * the cursor visible. `scrollRef` holds the sticky scroll anchor across
 * renders (owned by the parent so it survives re-renders).
 */
export function SwimlaneGrid({
  lanes,
  cursor,
  colWindowStart,
  visibleColCount,
  width,
  height,
  matchSet,
  busyKeys,
  scrollRef,
}: {
  lanes: Lane[];
  cursor: SwimCursor;
  colWindowStart: number;
  visibleColCount: number;
  width: number;
  height: number;
  matchSet: Set<string>;
  /** Keys with a board-repositioning write in flight — rendered as loading. */
  busyKeys: ReadonlySet<string>;
  scrollRef: { current: number };
}) {
  const colEnd = colWindowStart + visibleColCount;
  // Layout is scoped to the visible column window: lanes with no cards in
  // these columns don't render (no empty bands), and row counts reflect only
  // what's on-screen — so scroll math matches exactly what's painted.
  const rows = visualRows(lanes, colWindowStart, colEnd);
  const cursorIdx = cursorVisualIndex(lanes, cursor, colWindowStart, colEnd);
  const scroll = stickyScroll(rows.length, height, cursorIdx, scrollRef.current);
  scrollRef.current = scroll;
  const visible = rows.slice(scroll, scroll + height);
  // Per-column cell width inside the grid. Two leading cells (gutter + bar)
  // are drawn per card, so budget the rest for text.
  const gap = 1;
  const colWidth = Math.max(
    12,
    Math.floor((width - gap * (visibleColCount - 1)) / Math.max(1, visibleColCount)),
  );

  return (
    <Box flexDirection="column" width={width} height={height}>
      {visible.map((vr, i) => {
        const key = `${scroll + i}`;
        if (vr.kind === "title") {
          const lane = lanes[vr.lane]!;
          const isCursorLane = vr.lane === cursor.lane;
          return (
            <Box key={key} width={width}>
              <Text color={isCursorLane ? theme.accent : theme.accentAlt} bold>
                {truncate(`▸ ${lane.name}`, Math.max(4, width - 8))}
              </Text>
              <Text color={theme.muted}> ({lane.count})</Text>
            </Box>
          );
        }
        const lane = lanes[vr.lane]!;
        return (
          <Box key={key} flexDirection="row" width={width}>
            {lane.columns.slice(colWindowStart, colEnd).map((col, vi) => {
              const ci = colWindowStart + vi;
              const issue = col.issues[vr.row];
              const selected =
                vr.lane === cursor.lane && ci === cursor.col && vr.row === cursor.row;
              return (
                <Box
                  key={ci}
                  width={colWidth}
                  marginRight={vi === visibleColCount - 1 ? 0 : gap}
                  flexDirection="row"
                >
                  {issue ? (
                    <CompactCard
                      issue={issue}
                      width={colWidth}
                      selected={selected}
                      isMatch={matchSet.has(issue.key)}
                      busy={busyKeys.has(issue.key)}
                    />
                  ) : (
                    <Text> </Text>
                  )}
                </Box>
              );
            })}
          </Box>
        );
      })}
    </Box>
  );
}

/**
 * One-line card: type glyph, key, summary, assignee initials. Selection uses
 * `inverse` on text cells (not a bg fill) to match the flat board's paint
 * behaviour; search matches get the match bg when not selected.
 */
function CompactCard({
  issue,
  width,
  selected,
  isMatch,
  busy,
}: {
  issue: Issue;
  width: number;
  selected: boolean;
  isMatch: boolean;
  busy: boolean;
}) {
  const accent = typeColor(issue.issueType);
  const badge = initials(issue.assignee);
  const matchBgProps = bg(!selected && isMatch ? theme.matchBg : undefined);
  // Layout: "▌" bar (1) + space (1) + glyph (1) + space (1) + key + space +
  // summary … + badge (right). Reserve 3 for the trailing badge + space.
  const bodyBudget = Math.max(4, width - 4 - 3);
  // Selection always wins the highlight (inverse + fg text), even while busy,
  // so navigating never drops the highlight off an updating row. Busy shows via
  // the ◴ glyph, the "updating…" label, and the warning bar; a busy row that
  // isn't selected dims to muted.
  const text = busy ? `${issue.key} updating…` : `${issue.key} ${issue.summary}`;
  const barColor = busy ? theme.warning : selected ? theme.accent : accent;
  const glyphColor = selected ? theme.fg : busy ? theme.warning : accent;
  const bodyColor = selected ? theme.fg : busy ? theme.muted : theme.fgDim;
  return (
    <>
      <Text color={barColor}>▌</Text>
      <Text {...fg(glyphColor)} inverse={selected} {...matchBgProps}>
        {" "}
        {busy ? "◴" : typeGlyph(issue.issueType)}{" "}
      </Text>
      <Text {...fg(bodyColor)} bold={selected} inverse={selected} wrap="truncate" {...matchBgProps}>
        {truncate(text, bodyBudget)}
      </Text>
      <Text
        {...fg(selected ? theme.fg : busy ? theme.muted : assigneeColor(issue.assignee))}
        bold
        inverse={selected}
        {...matchBgProps}
      >
        {" "}
        {badge}
      </Text>
    </>
  );
}
