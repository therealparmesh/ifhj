import type { Issue } from "./jira";

export type TimelineZoom = "days" | "weeks" | "months";
export type TimelineCalendar = { center: number; preferredMonthDay: number | null };
type TimelineGroup = "scheduled" | "diagnostic" | "unscheduled";

export type TimelineRow = {
  issue: Issue;
  start: number | null;
  due: number | null;
  group: TimelineGroup;
  label: string;
};

export type TimelineBucket = { start: number; end: number; label: string };
type TimelineLayout = { labelWidth: number; cellWidth: number; bucketCount: number };

const DAY_MS = 86_400_000;
const MIN_DAY = -719_162; // 0001-01-01
const MAX_DAY = 2_932_896; // 9999-12-31
const MONTH_COUNT = 12 * 9_999;

function parseDateOnly(value: string | undefined): number | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith("0000-")) return null;
  const time = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(time)) return null;
  const date = new Date(time);
  if (date.toISOString().slice(0, 10) !== value) return null;
  const day = Math.floor(time / DAY_MS);
  return day >= MIN_DAY && day <= MAX_DAY ? day : null;
}

export function formatDateOnly(day: number): string {
  return new Date(clampDay(day) * DAY_MS).toISOString().slice(0, 10);
}

export function localToday(now: Date): number {
  return parseDateOnly(
    `${String(now.getFullYear()).padStart(4, "0")}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`,
  )!;
}

export function buildTimelineRows(issues: Issue[]): TimelineRow[] {
  return issues
    .map((issue): TimelineRow => {
      const parsedStart = parseDateOnly(issue.startDate);
      const parsedDue = parseDateOnly(issue.dueDate);
      const start = issue.startDateState ? null : parsedStart;
      const due = issue.dueDateState ? null : parsedDue;
      const invalidStart =
        issue.startDateState === "invalid" ||
        (!issue.startDateState && issue.startDate !== undefined && parsedStart === null);
      const invalidDue =
        issue.dueDateState === "invalid" ||
        (!issue.dueDateState && issue.dueDate !== undefined && parsedDue === null);
      const reversed = start !== null && due !== null && start > due;
      const diagnostic = invalidStart || invalidDue || reversed || !!issue.startDateState;
      const group: TimelineGroup = diagnostic
        ? "diagnostic"
        : start !== null || due !== null
          ? "scheduled"
          : "unscheduled";

      let label: string;
      if (reversed) label = `Reversed range: Start ${issue.startDate}; Due ${issue.dueDate}`;
      else if (invalidStart && invalidDue)
        label = `${invalidDateLabel("Start", issue.startDate)}; ${invalidDateLabel("Due", issue.dueDate)}`;
      else if (invalidStart)
        label = `${invalidDateLabel("Start", issue.startDate)}${due !== null ? `; Due ${issue.dueDate}` : ""}`;
      else if (invalidDue)
        label = `${
          issue.startDateState
            ? `Start ${issue.startDateState}; `
            : start !== null
              ? `Start ${issue.startDate}; `
              : ""
        }${invalidDateLabel("Due", issue.dueDate)}`;
      else if (start !== null && due !== null)
        label =
          start === due
            ? `Start and Due ${issue.startDate}`
            : `Start ${issue.startDate}; Due ${issue.dueDate}`;
      else if (start !== null) label = `Start only: ${issue.startDate}`;
      else if (due !== null) {
        const state = issue.startDateState ? `; Start ${issue.startDateState}` : "";
        label = `Due only: ${issue.dueDate}${state}`;
      } else if (issue.startDateState) label = `Start ${issue.startDateState}; no Due date`;
      else label = "Unscheduled";

      // Reversed endpoints are not independent points. Other diagnostic rows
      // keep the one endpoint that is still known and safe to plot.
      return {
        issue,
        start: reversed ? null : start,
        due: reversed ? null : due,
        group,
        label,
      };
    })
    .toSorted((a, b) => {
      const order: Record<TimelineGroup, number> = { scheduled: 0, diagnostic: 1, unscheduled: 2 };
      const aDate = a.start ?? a.due ?? Number.MAX_SAFE_INTEGER;
      const bDate = b.start ?? b.due ?? Number.MAX_SAFE_INTEGER;
      return (
        order[a.group] - order[b.group] || aDate - bDate || a.issue.key.localeCompare(b.issue.key)
      );
    });
}

export function focusTimelineRow(row: TimelineRow, anchor: number): number | null {
  if (row.start !== null && row.due !== null) return Math.max(row.start, Math.min(row.due, anchor));
  return row.start ?? row.due;
}

export function initialTimelineDay(
  rows: TimelineRow[],
  selectedKey: string | null,
  today: number,
): number {
  const selected = rows.find((row) => row.issue.key === selectedKey);
  const selectedDay = selected ? focusTimelineRow(selected, today) : null;
  if (selectedDay !== null) return selectedDay;

  const dated = rows
    .map((row) => ({ row, day: focusTimelineRow(row, today) }))
    .filter((item): item is { row: TimelineRow; day: number } => item.day !== null);
  if (dated.length === 0) return today;
  return dated.toSorted(
    (a, b) =>
      Math.abs(a.day - today) - Math.abs(b.day - today) ||
      a.day - b.day ||
      a.row.issue.key.localeCompare(b.row.issue.key),
  )[0]!.day;
}

export function timelineLayout(width: number, zoom: TimelineZoom): TimelineLayout {
  const labelWidth = Math.min(32, Math.max(23, Math.floor(width * 0.38)));
  const cellWidth = zoom === "days" ? 2 : 3;
  return {
    labelWidth,
    cellWidth,
    bucketCount: Math.max(1, Math.floor((width - labelWidth) / cellWidth)),
  };
}

export function panTimeline(
  calendar: TimelineCalendar,
  zoom: TimelineZoom,
  amount: number,
  bucketCount = 1,
): TimelineCalendar {
  const base = visibleCenter(calendar.center, zoom, bucketCount);
  if (zoom === "days") return { center: clampDay(base + amount), preferredMonthDay: null };
  if (zoom === "weeks") return { center: clampDay(base + amount * 7), preferredMonthDay: null };
  const date = new Date(base * DAY_MS);
  const preferredMonthDay = calendar.preferredMonthDay ?? date.getUTCDate();
  const targetIndex = Math.max(
    0,
    Math.min(MONTH_COUNT - 1, (date.getUTCFullYear() - 1) * 12 + date.getUTCMonth() + amount),
  );
  const start = monthStart(targetIndex);
  const end = targetIndex === MONTH_COUNT - 1 ? MAX_DAY : monthStart(targetIndex + 1) - 1;
  return {
    center: Math.min(end, start + preferredMonthDay - 1),
    preferredMonthDay,
  };
}

export function zoomTimeline(
  calendar: TimelineCalendar,
  zoom: TimelineZoom,
  width: number,
): TimelineCalendar {
  return {
    center: visibleCenter(calendar.center, zoom, timelineLayout(width, zoom).bucketCount),
    preferredMonthDay: calendar.preferredMonthDay,
  };
}

export function timelineBuckets(
  center: number,
  zoom: TimelineZoom,
  count: number,
): TimelineBucket[] {
  const size = Math.max(1, count);
  if (zoom === "months") return monthBuckets(center, size);
  const span = zoom === "days" ? 1 : 7;
  const date = new Date(clampDay(center) * DAY_MS);
  const aligned =
    zoom === "weeks" ? clampDay(center - ((date.getUTCDay() + 6) % 7)) : clampDay(center);
  const candidate = aligned - Math.floor(size / 2) * span;
  const maxAligned =
    zoom === "weeks" ? MAX_DAY - ((new Date(MAX_DAY * DAY_MS).getUTCDay() + 6) % 7) : MAX_DAY;
  const latestFirst = maxAligned - (size - 1) * span;
  const first = Math.max(MIN_DAY, Math.min(latestFirst, candidate));
  return Array.from({ length: size }, (_, index) => {
    const start = first + index * span;
    const end = Math.min(MAX_DAY, start + span - 1);
    return { start, end, label: formatDateOnly(start) };
  });
}

function monthBuckets(center: number, count: number): TimelineBucket[] {
  const centerDate = new Date(clampDay(center) * DAY_MS);
  const centerIndex = (centerDate.getUTCFullYear() - 1) * 12 + centerDate.getUTCMonth();
  const firstIndex = Math.max(
    0,
    Math.min(MONTH_COUNT - count, centerIndex - Math.floor(count / 2)),
  );
  return Array.from({ length: count }, (_, index) => {
    const monthIndex = firstIndex + index;
    const start = monthStart(monthIndex);
    const nextIndex = monthIndex + 1;
    const end = nextIndex >= MONTH_COUNT ? MAX_DAY : monthStart(nextIndex) - 1;
    return { start, end, label: formatDateOnly(start).slice(0, 7) };
  });
}

function monthStart(index: number): number {
  const year = Math.floor(index / 12) + 1;
  const month = (index % 12) + 1;
  return parseDateOnly(`${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-01`)!;
}

function dateValue(value: string | undefined): string {
  const normalized = Array.from(value ?? "missing", (char) => {
    const code = char.codePointAt(0) ?? 0;
    return code < 32 || code === 127 ? " " : char;
  })
    .join("")
    .trim();
  if (!normalized) return "empty";
  const chars = Array.from(normalized);
  let result = "";
  for (const char of chars) {
    if (Bun.stringWidth(`${result}${char}…`) > 12) return `${result}…`;
    result += char;
  }
  return result;
}

function invalidDateLabel(field: "Start" | "Due", value: string | undefined): string {
  return `Invalid ${field} date${value === undefined ? "" : `: ${dateValue(value)}`}`;
}

function visibleCenter(center: number, zoom: TimelineZoom, bucketCount: number): number {
  const buckets = timelineBuckets(center, zoom, bucketCount);
  const middle = buckets[Math.floor(buckets.length / 2)]!;
  return Math.max(middle.start, Math.min(middle.end, clampDay(center)));
}

function clampDay(day: number): number {
  return Math.max(MIN_DAY, Math.min(MAX_DAY, Math.trunc(day)));
}
