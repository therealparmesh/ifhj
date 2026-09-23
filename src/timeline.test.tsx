import { afterEach, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { PassThrough } from "node:stream";

import { render } from "ink";

import { BoardHeader } from "./components/BoardHeader";
import { Footer, footerRowCount } from "./components/Footer";
import { Timeline } from "./components/Timeline";
import type { Issue } from "./jira";
import { createTerminal, isolatedEnv, makeTempDir, runScript } from "./test/utils";

const apps: ReturnType<typeof render>[] = [];
const columnsDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "columns");
const rowsDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "rows");

afterEach(() => {
  for (const app of apps.splice(0)) app.unmount();
  if (columnsDescriptor) Object.defineProperty(process.stdout, "columns", columnsDescriptor);
  else delete (process.stdout as unknown as Record<string, unknown>)["columns"];
  if (rowsDescriptor) Object.defineProperty(process.stdout, "rows", rowsDescriptor);
  else delete (process.stdout as unknown as Record<string, unknown>)["rows"];
});

function trackApp(app: ReturnType<typeof render>): ReturnType<typeof render> {
  apps.push(app);
  return app;
}

function unmount(app: ReturnType<typeof render>): void {
  app.unmount();
  apps.splice(apps.indexOf(app), 1);
}
import {
  buildTimelineRows,
  focusTimelineRow,
  formatDateOnly,
  initialTimelineDay,
  panTimeline,
  timelineLayout,
  timelineBuckets,
  zoomTimeline,
} from "./timeline";

function issue(key: string, dates: Partial<Issue> = {}): Issue {
  return {
    id: Number(key.split("-").at(-1)) || 1,
    key,
    summary: `Summary ${key}`,
    description: "",
    statusId: "1",
    statusName: "To Do",
    statusCategory: "new",
    updated: "2026-01-01T00:00:00Z",
    issueType: "Task",
    labels: [],
    ...dates,
  };
}

function dateDay(value: string): number {
  return buildTimelineRows([issue("DATE-1", { dueDate: value })])[0]!.due!;
}

const calendar = (value: string) => ({ center: dateDay(value), preferredMonthDay: null });

describe("Timeline date and ordering policy", () => {
  test("uses strict supported date-only values across leap and calendar boundaries", () => {
    const leap = dateDay("2024-02-29");
    expect(formatDateOnly(leap + 1)).toBe("2024-03-01");
    for (const invalid of ["2023-02-29", "0000-01-01", "2024-02-29T23:00:00-08:00"]) {
      expect(buildTimelineRows([issue("DATE-1", { dueDate: invalid })])[0]).toMatchObject({
        due: null,
        group: "diagnostic",
      });
    }
    expect(formatDateOnly(dateDay("0001-01-01"))).toBe("0001-01-01");
    expect(formatDateOnly(dateDay("9999-12-31"))).toBe("9999-12-31");
  });

  test("sorts valid schedules first, then diagnostics, then confirmed unscheduled rows", () => {
    const rows = buildTimelineRows([
      issue("P-9"),
      issue("P-8", { startDate: "bad", dueDate: "also-bad" }),
      issue("P-7", { startDate: "2020-01-01", dueDate: "2026-03-01", startDateState: "ambiguous" }),
      issue("P-6", { startDate: "2026-01-01", dueDate: "2025-01-01" }),
      issue("P-2", { dueDate: "2026-04-01" }),
      issue("P-1", { startDate: "2026-03-01", dueDate: "2026-03-03" }),
    ]);
    expect(rows.map((row) => [row.issue.key, row.group])).toEqual([
      ["P-1", "scheduled"],
      ["P-2", "scheduled"],
      ["P-7", "diagnostic"],
      ["P-6", "diagnostic"],
      ["P-8", "diagnostic"],
      ["P-9", "unscheduled"],
    ]);
    expect(rows.find((row) => row.issue.key === "P-8")?.label).toContain("Invalid Start");
    expect(rows.find((row) => row.issue.key === "P-8")?.label).toContain("Invalid Due");
    expect(rows.find((row) => row.issue.key === "P-6")).toMatchObject({ start: null, due: null });
    expect(rows.find((row) => row.issue.key === "P-7")).toMatchObject({
      start: null,
      due: dateDay("2026-03-01"),
    });
    const invalidStates = buildTimelineRows([
      issue("P-10", { startDateState: "invalid", dueDate: "2026-03-05" }),
      issue("P-11", { startDate: "2026-03-04", dueDateState: "invalid" }),
    ]);
    expect(invalidStates.find((row) => row.issue.key === "P-10")).toMatchObject({
      start: null,
      due: dateDay("2026-03-05"),
      group: "diagnostic",
      label: "Invalid Start date; Due 2026-03-05",
    });
    expect(invalidStates.find((row) => row.issue.key === "P-11")).toMatchObject({
      start: dateDay("2026-03-04"),
      due: null,
      group: "diagnostic",
      label: "Start 2026-03-04; Invalid Due date",
    });
  });

  test("focuses a spanning interval at Today and otherwise uses the nearest valid schedule", () => {
    const today = dateDay("2026-05-10");
    const spanning = buildTimelineRows([
      issue("P-1", { startDate: "2020-01-01", dueDate: "2030-01-01" }),
    ])[0]!;
    expect(focusTimelineRow(spanning, today)).toBe(today);
    expect(initialTimelineDay([spanning], null, today)).toBe(today);
    const rows = buildTimelineRows([
      issue("P-2", { startDate: "2026-05-20", dueDate: "2026-05-22" }),
      issue("P-3", { dueDate: "2026-05-12", startDateState: "unavailable" }),
      issue("P-4"),
    ]);
    expect(formatDateOnly(initialTimelineDay(rows, "P-4", today))).toBe("2026-05-12");
    expect(formatDateOnly(initialTimelineDay(rows, "P-3", today))).toBe("2026-05-12");
    const historicalDue = buildTimelineRows([
      issue("P-1"),
      issue("P-2", { dueDate: "1999-01-01", startDateState: "unavailable" }),
    ]);
    expect(formatDateOnly(initialTimelineDay(historicalDue, "P-1", today))).toBe("1999-01-01");
  });

  test("keeps month lengths and Monday week alignment at both supported bounds", () => {
    expect(formatDateOnly(panTimeline(calendar("2024-03-31"), "months", -1).center)).toBe(
      "2024-02-29",
    );
    const months = timelineBuckets(dateDay("2024-03-15"), "months", 3);
    expect(months.map((bucket) => formatDateOnly(bucket.end))).toEqual([
      "2024-02-29",
      "2024-03-31",
      "2024-04-30",
    ]);
    for (const center of ["0001-01-01", "9999-12-31"]) {
      const weeks = timelineBuckets(dateDay(center), "weeks", 3);
      expect(weeks.map((bucket) => new Date(bucket.start * 86_400_000).getUTCDay())).toEqual([
        1, 1, 1,
      ]);
      expect(formatDateOnly(weeks[0]!.start) >= "0001-01-01").toBe(true);
      expect(formatDateOnly(weeks.at(-1)!.end) <= "9999-12-31").toBe(true);
      for (const zoom of ["days", "months"] as const) {
        const buckets = timelineBuckets(dateDay(center), zoom, 3);
        expect(formatDateOnly(buckets[0]!.start) >= "0001-01-01").toBe(true);
        expect(formatDateOnly(buckets.at(-1)!.end) <= "9999-12-31").toBe(true);
      }
    }
    const weekCapacity = timelineLayout(78, "weeks").bucketCount;
    const monthCapacity = timelineLayout(78, "months").bucketCount;
    expect(weekCapacity).toBe(16);
    expect(
      formatDateOnly(panTimeline(calendar("2024-02-29"), "weeks", 1, weekCapacity).center),
    ).toBe("2024-03-07");
    expect(
      formatDateOnly(panTimeline(calendar("2024-03-31"), "months", -1, monthCapacity).center),
    ).toBe("2024-02-29");
    const retainedCenter = panTimeline(calendar("2024-02-29"), "weeks", 1, weekCapacity).center;
    for (const zoom of ["days", "weeks"] as const) {
      const window = timelineBuckets(retainedCenter, zoom, timelineLayout(78, zoom).bucketCount);
      expect(
        window.some((bucket) => retainedCenter >= bucket.start && retainedCenter <= bucket.end),
      ).toBe(true);
    }
  });

  test("moves each resolved visible window by one bucket near the upper bound", () => {
    const max = dateDay("9999-12-31");
    for (const zoom of ["days", "weeks", "months"] as const) {
      const before = timelineBuckets(max, zoom, 3);
      const after = timelineBuckets(
        panTimeline({ center: max, preferredMonthDay: null }, zoom, -1, 3).center,
        zoom,
        3,
      );
      if (zoom === "days") expect(before[0]!.start - after[0]!.start).toBe(1);
      else if (zoom === "weeks") expect(before[0]!.start - after[0]!.start).toBe(7);
      else expect(formatDateOnly(after[0]!.start)).toBe("9999-09-01");
    }
    const leap = timelineBuckets(dateDay("2024-03-31"), "months", 3);
    const previous = timelineBuckets(
      panTimeline(calendar("2024-03-31"), "months", -1, 3).center,
      "months",
      3,
    );
    expect(formatDateOnly(leap[0]!.start)).toBe("2024-02-01");
    expect(formatDateOnly(previous[0]!.start)).toBe("2024-01-01");
  });

  test("retains a preferred month day and stabilizes zoom at clamped visible centers", () => {
    const capacity = timelineLayout(78, "months").bucketCount;
    const february = panTimeline(calendar("2023-01-31"), "months", 1, capacity);
    const january = panTimeline(february, "months", -1, capacity);
    expect(formatDateOnly(february.center)).toBe("2023-02-28");
    expect(formatDateOnly(january.center)).toBe("2023-01-31");
    expect(january.preferredMonthDay).toBe(31);
    expect(formatDateOnly(panTimeline(calendar("2024-01-31"), "months", 1, capacity).center)).toBe(
      "2024-02-29",
    );

    const upper = zoomTimeline(calendar("9999-12-31"), "months", 78);
    const lower = zoomTimeline(calendar("0001-01-01"), "months", 78);
    const normal = zoomTimeline(calendar("2026-09-23"), "months", 78);
    expect(formatDateOnly(upper.center)).toBe("9999-05-31");
    expect(formatDateOnly(lower.center)).toBe("0001-09-01");
    expect(formatDateOnly(normal.center)).toBe("2026-09-23");
    const weeks = timelineBuckets(upper.center, "weeks", timelineLayout(78, "weeks").bucketCount);
    expect(weeks.some((bucket) => upper.center >= bucket.start && upper.center <= bucket.end)).toBe(
      true,
    );
  });
});

test("local Today follows real timezone calendar dates without changing Jira day arithmetic", async () => {
  const home = await makeTempDir("timeline-timezones");
  const timelineUrl = new URL("./timeline.ts", import.meta.url).href;
  try {
    const values = [];
    for (const TZ of ["America/New_York", "Asia/Tokyo"]) {
      const result = await runScript(
        `const { localToday, formatDateOnly } = await import(${JSON.stringify(timelineUrl)}); console.log(formatDateOnly(localToday(new Date("2024-03-10T04:30:00Z"))));`,
        isolatedEnv(home, { TZ }),
      );
      expect(result.exitCode, result.stderr).toBe(0);
      values.push(result.stdout.trim());
    }
    expect(values).toEqual(["2024-03-09", "2024-03-10"]);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

async function renderTimeline(
  columns: number,
  rows: number,
  issues: Issue[],
  options: { center?: number; today?: number; zoom?: "days" | "weeks" | "months" } = {},
) {
  Object.defineProperty(process.stdout, "columns", { value: columns, configurable: true });
  Object.defineProperty(process.stdout, "rows", { value: rows, configurable: true });
  const terminal = createTerminal(columns, rows);
  const timelineRows = buildTimelineRows(issues);
  const today = options.today ?? dateDay("2024-02-15");
  const app = trackApp(
    render(
      <Timeline
        rows={timelineRows}
        selectedKey={timelineRows[0]?.issue.key ?? null}
        center={options.center ?? today}
        zoom={options.zoom ?? "weeks"}
        today={today}
        width={columns}
        height={rows}
        scroll={0}
        matches={new Set(["P-WIDE"])}
        pendingKeys={new Set(["P-PENDING"])}
        datesConfirmed
        notice="Timeline does not edit dates."
      />,
      {
        interactive: true,
        stdin: terminal.stdin as unknown as typeof process.stdin,
        stdout: terminal.stdout as unknown as typeof process.stdout,
        stderr: new PassThrough() as unknown as typeof process.stderr,
        exitOnCtrlC: false,
        patchConsole: false,
        debug: true,
      },
    ),
  );
  await app.waitUntilRenderFlush();
  return { app, output: Bun.stripANSI(terminal.output()).replace(/\n$/, "") };
}

test("keeps month labels clear and shows an independent off-window Today direction", async () => {
  const { app, output } = await renderTimeline(80, 24, [], {
    center: dateDay("1990-06-15"),
    today: dateDay("2024-02-15"),
    zoom: "months",
  });
  expect(output.split("\n")[1]).toMatch(/1990-\d{2}/);
  const ruler = output.split("\n").find((line) => line.includes("Today is right"));
  expect(ruler).toContain(">");
  unmount(app);
});

for (const [columns, rows] of [
  [80, 24],
  [120, 40],
] as const) {
  test(`renders useful bounded rows, sparse ticks, Today, and real clipping at ${columns}x${rows}`, async () => {
    const { app, output } = await renderTimeline(columns, rows, [
      issue("P-OLD", {
        summary: "Starts before the window",
        startDate: "1990-01-01",
        dueDate: "2024-02-16",
      }),
      issue("P-POINT", { summary: "Same day", startDate: "2024-02-15", dueDate: "2024-02-15" }),
      issue("P-START", { summary: "Start marker", startDate: "2024-02-16" }),
      issue("P-DUE", { summary: "Due marker", dueDate: "2024-02-17" }),
      issue("P-PENDING", { summary: "Pending row", dueDate: "2024-02-18" }),
      issue("P-FUTURE", { summary: "Due after the window", dueDate: "2090-01-01" }),
      issue("P-WIDE", {
        summary: "wide 界界\nsecond line",
        startDate: "坏坏\nvalue",
        dueDate: "also-bad",
      }),
      issue("P-NONE", { summary: "No confirmed dates" }),
    ]);
    const lines = output.split("\n");
    const line = (key: string) => lines.find((candidate) => candidate.includes(key)) ?? "";
    expect(lines.length).toBeLessThanOrEqual(rows);
    expect(Math.max(...lines.map((value) => Bun.stringWidth(value)))).toBeLessThanOrEqual(columns);
    const axis = lines[1] ?? "";
    expect(axis).toMatch(/\d{2}-\d{2}/);
    expect(axis).toContain("02-19");
    expect(axis).not.toMatch(/\d{2}-$/);
    expect(lines.find((value) => value.includes("Today 2024-02-15"))).toContain("^");
    expect(line("P-OLD").slice(line("P-OLD").indexOf("P-OLD"))).toContain("<");
    expect(line("P-FUTURE").slice(line("P-FUTURE").indexOf("P-FUTURE"))).toContain(">");
    expect(line("P-POINT")).toContain("=");
    expect(line("P-START").slice(32)).toContain("S");
    expect(line("P-DUE").slice(32)).toContain("D");
    expect(line("P-WIDE")).toContain("Invalid Start");
    expect(output).toContain("~ pending");
    expect(output).toContain("? unscheduled");
    const keyColumn = (key: string) => {
      const row = line(key);
      return Bun.stringWidth(row.slice(0, row.indexOf(key)));
    };
    expect([
      keyColumn("P-OLD"),
      keyColumn("P-WIDE"),
      keyColumn("P-PENDING"),
      keyColumn("P-NONE"),
    ]).toEqual([1, 1, 1, 1]);
    unmount(app);
  });
}

test("bounds the integrated board header with long cell-width content", async () => {
  Object.defineProperty(process.stdout, "columns", { value: 80, configurable: true });
  const terminal = createTerminal(80, 24);
  const app = trackApp(
    render(
      <BoardHeader
        boardName={`Long 界 board ${"name".repeat(20)}`}
        projectKey="LONGPROJECT"
        visibleIssueCount={123}
        totalIssueCount={456}
        visiblePointSum={88}
        estimateDisplay="points"
        colIndex={2}
        colCount={9}
        filterCount={5}
        timelineActive
        query={`long 界 query ${"term".repeat(20)}`}
        matches={10}
        matchIdx={4}
        termCols={80}
      />,
      {
        interactive: true,
        stdin: terminal.stdin as unknown as typeof process.stdin,
        stdout: terminal.stdout as unknown as typeof process.stdout,
        stderr: new PassThrough() as unknown as typeof process.stderr,
        patchConsole: false,
        debug: true,
      },
    ),
  );
  await app.waitUntilRenderFlush();
  const output = Bun.stripANSI(terminal.output()).replace(/\n$/, "");
  expect(output.split("\n")).toHaveLength(1);
  expect(Bun.stringWidth(output)).toBeLessThanOrEqual(80);
  expect(output).toContain("Timeline");
  expect(output).toContain("5/10");
  unmount(app);
});

test("keeps a long Jira key and issue type inside the exact 80-column footer budget", async () => {
  const terminal = createTerminal(80, 24);
  const selected = issue("PROJECT-12345", {
    summary: "Readable selected title",
    issueType: "Long custom Jira issue type ".repeat(3),
  });
  const state = {
    hasIssue: true,
    filterCount: 1,
    hasSwimlanes: true,
    swimActive: false,
    timelineActive: true,
    query: "",
    matches: 0,
    matchIdx: 0,
  };
  const app = trackApp(
    render(
      <Footer
        currentIssue={selected}
        termCols={80}
        mode="normal"
        query=""
        matches={0}
        matchIdx={0}
        filterCount={1}
        hasSwimlanes
        swimActive={false}
        timelineActive
        searchBuffer=""
        onSearchChange={() => {}}
        onSearchSubmit={() => {}}
        onSearchCancel={() => {}}
        dateSummary="Due only: 2026-03-02; Start unavailable"
      />,
      {
        interactive: true,
        stdin: terminal.stdin as unknown as typeof process.stdin,
        stdout: terminal.stdout as unknown as typeof process.stdout,
        stderr: new PassThrough() as unknown as typeof process.stderr,
        exitOnCtrlC: false,
        patchConsole: false,
        debug: true,
      },
    ),
  );
  await app.waitUntilRenderFlush();
  const output = Bun.stripANSI(terminal.output()).replace(/\n$/, "");
  const lines = output.split("\n");
  expect(lines).toHaveLength(footerRowCount(80, "normal", state));
  expect(Math.max(...lines.map((line) => Bun.stringWidth(line)))).toBeLessThanOrEqual(80);
  expect(output).toContain("PROJECT-12345");
  expect(output).toContain("Readable selected title");
  expect(output).toContain("Due only: 2026-03-02; Start unavailable");
  expect(output).toContain("F clear filters");
  expect(output).toContain("s swimlanes");
  expect(output).toContain("R quick open");
  expect(output).toContain("q boards");
  expect(output).toContain("esc/T board");
  const ordinary = issue("PROJ-1", {
    summary: "This ordinary title keeps far more than thirty-two cells of useful context",
    issueType: "Task",
  });
  terminal.clearOutput();
  app.rerender(
    <Footer
      currentIssue={ordinary}
      termCols={80}
      mode="normal"
      query=""
      matches={0}
      matchIdx={0}
      filterCount={1}
      hasSwimlanes
      swimActive={false}
      timelineActive
      searchBuffer=""
      onSearchChange={() => {}}
      onSearchSubmit={() => {}}
      onSearchCancel={() => {}}
      dateSummary="Due only: 2026-03-02; Start unavailable"
    />,
  );
  await app.waitUntilRenderFlush();
  const ordinaryOutput = Bun.stripANSI(terminal.output()).replace(/\n$/, "");
  const ordinaryLines = ordinaryOutput.split("\n");
  expect(ordinaryLines).toHaveLength(footerRowCount(80, "normal", state));
  expect(Math.max(...ordinaryLines.map((line) => Bun.stringWidth(line)))).toBeLessThanOrEqual(80);
  expect(ordinaryOutput).toContain("more than thirty-two cells");
  unmount(app);
});
