import { describe, expect, test } from "bun:test";

import type { BoardColumn, Issue } from "./jira";
import { buildColumns, buildLanes, moveCursor, reconcileCursor, visualRows } from "./swimlanes";

const columns: BoardColumn[] = [
  { name: "To Do", statusIds: ["1"] },
  { name: "Doing", statusIds: ["2"] },
  { name: "Done", statusIds: ["3"] },
];

function issue(key: string, statusId: string, extra: Partial<Issue> = {}): Issue {
  return {
    key,
    id: Number(key.split("-").at(-1)),
    summary: key,
    description: "",
    statusId,
    statusName: "",
    statusCategory: "new",
    updated: "",
    issueType: "Task",
    labels: [],
    ...extra,
  };
}

describe("swimlane layout", () => {
  test("keeps rank order in active columns and sorts completed work by parsed update time", () => {
    const built = buildColumns(columns, [
      issue("P-1", "1", { updated: "2026-06-01T00:00:00-04:00" }),
      issue("P-2", "1", { updated: "2026-07-01T00:00:00-04:00" }),
      issue("P-3", "3", { statusCategory: "done", updated: "2026-01-01T00:30:00+02:00" }),
      issue("P-4", "3", { statusCategory: "done", updated: "2026-01-01T00:00:00-01:00" }),
    ]);

    expect(built[0]?.issues.map((item) => item.key)).toEqual(["P-1", "P-2"]);
    expect(built[2]?.issues.map((item) => item.key)).toEqual(["P-4", "P-3"]);
  });

  test("keeps rank order when a column mixes active and completed statuses", () => {
    const built = buildColumns(columns, [
      issue("P-1", "3", { statusCategory: "done", updated: "2026-01-01T00:00:00Z" }),
      issue("P-2", "3", {
        statusCategory: "indeterminate",
        updated: "2026-12-01T00:00:00Z",
      }),
    ]);

    expect(built[2]?.issues.map((item) => item.key)).toEqual(["P-1", "P-2"]);
  });

  test("preserves custom lane order and hides lanes outside the visible column window", () => {
    const lanes = buildLanes(columns, [issue("P-1", "1"), issue("P-2", "3")], {
      strategy: "custom",
      lanes: [
        { id: "todo", name: "Todo only" },
        { id: "done", name: "Done only" },
      ],
      laneByKey: { "P-1": "todo", "P-2": "done" },
    });

    expect(lanes.map((lane) => lane.name)).toEqual(["Todo only", "Done only"]);
    expect(visualRows(lanes, 0, 1)).toEqual([
      { kind: "title", lane: 0 },
      { kind: "cards", lane: 0, row: 0 },
    ]);
  });

  test("drops custom lanes whose issues all have off-board statuses", () => {
    const lanes = buildLanes(columns, [issue("P-9", "outside")], {
      strategy: "custom",
      lanes: [{ id: "default", name: "Everything else" }],
      laneByKey: {},
      defaultLaneId: "default",
    });

    expect(lanes).toEqual([]);
  });

  test("repairs a cursor when filtering empties its selected column", () => {
    const lanes = buildLanes(columns, [issue("P-1", "1"), issue("P-2", "3")], {
      strategy: "none",
      lanes: [],
      laneByKey: {},
    });

    expect(reconcileCursor(lanes, { lane: 0, col: 1, row: 8 })).toEqual({
      lane: 0,
      col: 2,
      row: 0,
    });
    expect(moveCursor(lanes, { lane: 0, col: 0, row: 0 }, 0, 1)).toEqual({
      lane: 0,
      col: 2,
      row: 0,
    });
  });

  test("pages through cards and spills vertically across populated lanes", () => {
    const tall = buildLanes(
      columns,
      [1, 2, 3, 4, 5].map((id) => issue(`P-${id}`, "1")),
      { strategy: "none", lanes: [], laneByKey: {} },
    );
    expect(moveCursor(tall, { lane: 0, col: 0, row: 0 }, 3, 0)).toEqual({
      lane: 0,
      col: 0,
      row: 3,
    });
    expect(moveCursor(tall, { lane: 0, col: 0, row: 3 }, 99, 0).row).toBe(4);

    const lanes = buildLanes(
      columns,
      [issue("P-6", "1", { assignee: "Ada" }), issue("P-7", "1", { assignee: "Bob" })],
      { strategy: "assignee", lanes: [], laneByKey: {} },
    );
    expect(moveCursor(lanes, { lane: 0, col: 0, row: 0 }, 1, 0)).toEqual({
      lane: 1,
      col: 0,
      row: 0,
    });
    expect(moveCursor(lanes, { lane: 1, col: 0, row: 0 }, -1, 0)).toEqual({
      lane: 0,
      col: 0,
      row: 0,
    });
  });
});
