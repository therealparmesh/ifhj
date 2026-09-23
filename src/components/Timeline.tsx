import { Box, Text } from "ink";

import { normalizeText } from "../text";
import {
  type TimelineBucket,
  type TimelineRow,
  type TimelineZoom,
  formatDateOnly,
  timelineLayout,
  timelineBuckets,
} from "../timeline";
import { bg, fg, theme, truncate } from "../ui";

export function Timeline({
  rows,
  selectedKey,
  center,
  zoom,
  today,
  width,
  height,
  scroll,
  matches,
  pendingKeys,
  datesConfirmed,
  notice,
}: {
  rows: TimelineRow[];
  selectedKey: string | null;
  center: number;
  zoom: TimelineZoom;
  today: number;
  width: number;
  height: number;
  scroll: number;
  matches: ReadonlySet<string>;
  pendingKeys: ReadonlySet<string>;
  datesConfirmed: boolean;
  notice: string;
}) {
  const { labelWidth, cellWidth, bucketCount } = timelineLayout(width, zoom);
  const buckets = timelineBuckets(center, zoom, bucketCount);
  const chartWidth = buckets.length * cellWidth;
  const visibleRows = Math.max(1, height - 7);
  const visible = rows.slice(scroll, scroll + visibleRows);
  const first = buckets[0]!;
  const last = buckets.at(-1)!;
  const todayColumn = bucketIndex(buckets, today);
  const title = `Timeline · ${zoom[0]!.toUpperCase()}${zoom.slice(1)}`;
  const range = `${formatDateOnly(first.start)} to ${formatDateOnly(last.end)}`;
  const titleWidth = Math.max(1, width - Bun.stringWidth(range) - 1);
  const todayPosition = todayColumn >= 0 ? todayColumn * cellWidth + Math.floor(cellWidth / 2) : -1;
  const ruler = Array<string>(chartWidth).fill(" ");
  if (todayPosition >= 0) ruler[todayPosition] = "^";
  else ruler[today < first.start ? 0 : chartWidth - 1] = today < first.start ? "<" : ">";
  const todayLabel =
    todayColumn >= 0
      ? `Today ${formatDateOnly(today)}`
      : `Today is ${today < first.start ? "left" : "right"}`;

  return (
    <Box flexDirection="column" width={width} height={height}>
      <Box width={width}>
        <Text color={theme.accent} bold>
          {padCells(truncate(title, titleWidth), titleWidth)}
        </Text>
        <Text color={theme.muted}>{range}</Text>
      </Box>
      <Box>
        <Text color={theme.muted}>{" ".repeat(labelWidth)}</Text>
        <Text color={theme.muted}>{axisLabels(buckets, zoom, cellWidth)}</Text>
      </Box>
      <Box>
        <Text color={theme.muted}>{padCells("Issue", labelWidth)}</Text>
        <Text color={theme.divider}>{"-".repeat(chartWidth)}</Text>
      </Box>
      <Box>
        <Text color={theme.warning}>{padCells(todayLabel, labelWidth)}</Text>
        <Text color={theme.warning}>{ruler.join("")}</Text>
      </Box>
      <Text color={theme.muted} wrap="truncate">
        {`S Start  D Due  = range  </> clipped  ! problem  ~ pending  ? ${datesConfirmed ? "unscheduled" : "unconfirmed"}`}
      </Text>
      <Text color={theme.muted} wrap="truncate">
        {truncate(notice, width)}
      </Text>
      <Box flexDirection="column" height={visibleRows}>
        {visible.map((row) => {
          const selected = row.issue.key === selectedKey;
          const pending = pendingKeys.has(row.issue.key);
          const matchProps = bg(
            !selected && matches.has(row.issue.key) ? theme.matchBg : undefined,
          );
          const marker = pending
            ? "~"
            : { scheduled: " ", diagnostic: "!", unscheduled: "?" }[row.group];
          const body = normalizeText(`${row.issue.key} ${row.issue.summary}`);
          const text = truncate(`${marker}${body}`, labelWidth);
          return (
            <Box key={row.issue.key} width={width}>
              <Text
                {...fg(
                  selected
                    ? theme.fg
                    : pending
                      ? theme.warning
                      : row.group === "diagnostic"
                        ? theme.error
                        : theme.fgDim,
                )}
                inverse={selected}
                bold={selected}
                {...matchProps}
              >
                {padCells(text, labelWidth)}
              </Text>
              <Text
                {...fg(selected ? theme.fg : pending ? theme.warning : theme.accentAlt)}
                inverse={selected}
                {...matchProps}
              >
                {plotRow(row, buckets, cellWidth, chartWidth, datesConfirmed)}
              </Text>
            </Box>
          );
        })}
      </Box>
      <Text color={theme.muted} wrap="truncate">
        {scroll > 0 ? `^ ${scroll} earlier rows  ` : ""}
        {scroll + visibleRows < rows.length
          ? `v ${rows.length - scroll - visibleRows} later rows`
          : ""}
      </Text>
    </Box>
  );
}

function bucketIndex(buckets: TimelineBucket[], day: number): number {
  return buckets.findIndex((bucket) => day >= bucket.start && day <= bucket.end);
}

function axisLabels(buckets: TimelineBucket[], zoom: TimelineZoom, width: number): string {
  const chartWidth = buckets.length * width;
  const chars = Array<string>(chartWidth).fill(" ");
  const step = zoom === "days" ? 4 : 3;
  for (let index = 0; index < buckets.length; index += step) {
    const label = zoom === "months" ? buckets[index]!.label : buckets[index]!.label.slice(5);
    const offset = index * width;
    if (offset + label.length > chars.length) continue;
    chars.splice(offset, label.length, ...label);
  }
  return chars.join("");
}

function plotRow(
  row: TimelineRow,
  buckets: TimelineBucket[],
  width: number,
  chartWidth: number,
  datesConfirmed: boolean,
): string {
  const first = buckets[0]!.start;
  const last = buckets.at(-1)!.end;
  const chars = buckets.map((bucket) => {
    let mark = " ";
    if (row.start !== null && row.due !== null) {
      if (row.start <= bucket.end && row.due >= bucket.start) mark = "=";
    } else {
      const point = row.start ?? row.due;
      if (point !== null && point >= bucket.start && point <= bucket.end)
        mark = row.start !== null ? "S" : "D";
    }
    return mark.repeat(width);
  });
  const low = row.start ?? row.due;
  const high = row.due ?? row.start;
  if (low !== null && low < first) chars[0] = `<${chars[0]!.slice(1)}`;
  if (high !== null && high > last) chars[chars.length - 1] = `${chars.at(-1)!.slice(0, -1)}>`;
  const plot = chars.join("");
  if (low !== null) return plot;
  const status = !datesConfirmed && row.group === "unscheduled" ? "Dates unconfirmed" : row.label;
  return padCells(truncate(normalizeText(status), chartWidth), chartWidth);
}

function padCells(value: string, width: number): string {
  return value + " ".repeat(Math.max(0, width - Bun.stringWidth(value)));
}
