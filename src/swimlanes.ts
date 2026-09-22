import type { BoardColumn, BoardSwimlanes, Issue, SwimlaneStrategy } from "./jira";
export type LaneColumn = BoardColumn & { issues: Issue[] };
export type Lane = { id: string; name: string; columns: LaneColumn[]; count: number };

/** A cell in the swimlane grid the cursor can occupy. */
export type SwimCursor = { lane: number; col: number; row: number };

const UNASSIGNED = "Unassigned";
const NO_EPIC = "No Epic";
const NO_TYPE = "No Type";
const NO_PARENT = "No Parent";

/** Epoch millis of an ISO timestamp for recency sort; missing/unparseable
 *  sorts oldest. Parsed (not string-compared) because Jira timestamps carry
 *  varying UTC offsets, so lexicographic order would be wrong across them. */
function updatedMs(issue: Issue): number {
  const t = Date.parse(issue.updated);
  return Number.isNaN(t) ? 0 : t;
}

/**
 * Partition issues into board columns by status. Issues whose status maps to
 * no column are dropped (they're not shown on the board — same as Jira).
 *
 * Issues arrive in Jira rank order, which is what active columns keep. But a
 * finished-work column (every issue done-category — no name matching, so it
 * works whatever the column is called: "Done", "Merged", "Completed", …)
 * ranks arbitrarily; there we sort newest-updated first so the freshest
 * completed work is on top instead of buried under stale rank.
 */
export function buildColumns(colDefs: BoardColumn[], issues: Issue[]): LaneColumn[] {
  const cols: LaneColumn[] = colDefs.map((c) => ({ ...c, issues: [] }));
  const statusToCol = new Map<string, number>();
  cols.forEach((c, i) => c.statusIds.forEach((s) => statusToCol.set(s, i)));
  for (const issue of issues) {
    const idx = statusToCol.get(issue.statusId);
    if (idx !== undefined) cols[idx]!.issues.push(issue);
  }
  for (const col of cols) {
    if (col.issues.length > 1 && col.issues.every((i) => i.statusCategory === "done")) {
      col.issues = col.issues.toSorted((a, b) => updatedMs(b) - updatedMs(a));
    }
  }
  return cols;
}

/** The field-derived lane an issue belongs to, for non-custom strategies. */
function fieldLane(issue: Issue, strategy: SwimlaneStrategy): { id: string; name: string } {
  switch (strategy) {
    case "assignee": {
      const n = issue.assignee ?? UNASSIGNED;
      return { id: n, name: n };
    }
    case "epic": {
      const e = issue.epicKey ?? NO_EPIC;
      return { id: e, name: e };
    }
    case "issueType": {
      const t = issue.issueType || NO_TYPE;
      return { id: t, name: t };
    }
    case "parentChild": {
      // Issue carries no distinct parent beyond the epic/parent link, so we
      // group by that — the closest the board payload lets us get.
      const p = issue.epicKey ?? NO_PARENT;
      return { id: p, name: p };
    }
    default:
      return { id: "", name: "" };
  }
}

/** Sentinel "none of the above" lanes sort last; everything else A→Z. */
function laneNameSort(a: string, b: string): number {
  const sentinels = new Set([UNASSIGNED, NO_EPIC, NO_TYPE, NO_PARENT]);
  const sa = sentinels.has(a);
  const sb = sentinels.has(b);
  if (sa !== sb) return sa ? 1 : -1;
  return a.localeCompare(b);
}

/** Build a lane from its issue bucket. `count` is the number of *visible*
 *  cards (issues that land in a column) — an issue in a status outside the
 *  board's columns isn't shown, so it doesn't count toward the band. */
function makeLane(id: string, name: string, colDefs: BoardColumn[], bucketIssues: Issue[]): Lane {
  const columns = buildColumns(colDefs, bucketIssues);
  const count = columns.reduce((n, c) => n + c.issues.length, 0);
  return { id, name, columns, count };
}

/**
 * Group issues into ordered lanes. `custom` uses the server-evaluated
 * membership in `sw.laneByKey` and preserves the server's lane order (with
 * unmatched issues falling to the default lane). Field strategies derive
 * lanes from issue fields, sorted with sentinel lanes last. Lanes with no
 * *visible* cards are dropped — a terminal has no room for empty bands, and
 * Jira hides them too (an issue whose status maps to no column isn't shown).
 */
export function buildLanes(colDefs: BoardColumn[], issues: Issue[], sw: BoardSwimlanes): Lane[] {
  if (sw.strategy === "none") {
    return [makeLane("__all__", "", colDefs, issues)];
  }

  // Bucket issues by lane id, preserving input (rank) order within each.
  const bucket = new Map<string, Issue[]>();
  const add = (id: string, issue: Issue) => {
    const arr = bucket.get(id);
    if (arr) arr.push(issue);
    else bucket.set(id, [issue]);
  };

  if (sw.strategy === "custom") {
    for (const issue of issues) {
      const laneId = sw.laneByKey[issue.key] ?? sw.defaultLaneId;
      if (laneId !== undefined) add(laneId, issue);
    }
    // Emit in the server's declared lane order, dropping empty bands.
    return sw.lanes
      .map((def) => makeLane(def.id, def.name, colDefs, bucket.get(def.id) ?? []))
      .filter((l) => l.count > 0);
  }

  // Field strategy: derive lane identity per issue, then sort lane names.
  const names = new Map<string, string>(); // id → display name
  for (const issue of issues) {
    const { id, name } = fieldLane(issue, sw.strategy);
    names.set(id, name);
    add(id, issue);
  }
  return [...bucket.keys()]
    .toSorted((a, b) => laneNameSort(names.get(a) ?? a, names.get(b) ?? b))
    .map((id) => makeLane(id, names.get(id) ?? id, colDefs, bucket.get(id)!))
    .filter((l) => l.count > 0);
}

/**
 * A lane's rendered height = its tallest column *within the visible column
 * window* `[colStart, colEnd)`. Windowing matters: a lane whose cards all
 * sit in an off-window column contributes zero rows, so it isn't drawn as an
 * empty band. Defaults span every column (whole-lane height).
 */
function laneHeight(lane: Lane, colStart = 0, colEnd = lane.columns.length): number {
  let h = 0;
  const end = Math.min(colEnd, lane.columns.length);
  for (let c = Math.max(0, colStart); c < end; c++) {
    h = Math.max(h, lane.columns[c]!.issues.length);
  }
  return h;
}

/**
 * A visual row is one terminal line in the scrollable region: either a lane
 * title band or a card-row (one compact card per column at that index).
 * Nameless lanes (the flat fallback) emit no title row. Lanes with no cards
 * in the visible column window are skipped entirely — no empty bands.
 * `vr.lane` always indexes the full `lanes` array so the grid can look up the
 * lane directly.
 */
export type VisualRow =
  | { kind: "title"; lane: number }
  | { kind: "cards"; lane: number; row: number };

export function visualRows(
  lanes: Lane[],
  colStart = 0,
  colEnd = Number.MAX_SAFE_INTEGER,
): VisualRow[] {
  const rows: VisualRow[] = [];
  lanes.forEach((lane, li) => {
    const h = laneHeight(lane, colStart, colEnd);
    if (h === 0) return; // no visible cards in this window — hide the band
    if (lane.name) rows.push({ kind: "title", lane: li });
    for (let r = 0; r < h; r++) rows.push({ kind: "cards", lane: li, row: r });
  });
  return rows;
}

/**
 * Terminal-line index of the cursor's card-row within the windowed visual-row
 * list. Must walk the same lanes `visualRows` emits (skipping window-empty
 * ones) so scroll math lines up. The cursor lane always has ≥1 visible card
 * (the cursor's own column is inside the window), so it's never skipped.
 */
export function cursorVisualIndex(
  lanes: Lane[],
  cursor: SwimCursor,
  colStart = 0,
  colEnd = Number.MAX_SAFE_INTEGER,
): number {
  let idx = 0;
  for (let li = 0; li < lanes.length; li++) {
    const h = laneHeight(lanes[li]!, colStart, colEnd);
    if (li === cursor.lane) {
      if (h === 0) return idx;
      return idx + (lanes[li]!.name ? 1 : 0) + Math.min(cursor.row, h - 1);
    }
    if (h === 0) continue;
    idx += (lanes[li]!.name ? 1 : 0) + h;
  }
  return idx;
}

/**
 * Move the cursor by `dRow` card steps and/or `dCol` column steps. Magnitudes
 * are honored (PageUp/Down pass `±cardsVisible`). Returns a new cursor.
 *
 * Vertical: within a lane's column, then spilling across lane boundaries —
 * past the bottom of a column → top of the next lane's same column, and vice
 * versa. Horizontal: moves to the nearest column *that has a card in the
 * current lane*, skipping empty columns. That's both nicer (no dead steps)
 * and load-bearing: the visible column window is centred on the cursor's
 * column, so guaranteeing the cursor-column holds a card guarantees the lane
 * renders — the cursor can never strand on a lane hidden by windowing.
 */
export function moveCursor(lanes: Lane[], cur: SwimCursor, dRow: number, dCol: number): SwimCursor {
  if (lanes.length === 0) return cur;
  let { lane, col, row } = cur;
  lane = clampIdx(lane, lanes.length);

  if (dCol !== 0) {
    const cols = lanes[lane]!.columns;
    const step = dCol > 0 ? 1 : -1;
    // Seek the nearest column in `step` direction with a card in this lane.
    for (let c = col + step; c >= 0 && c < cols.length; c += step) {
      if ((cols[c]?.issues.length ?? 0) > 0) {
        col = c;
        row = clampRow(lanes, lane, col, row);
        return { lane, col, row };
      }
    }
    return { lane, col, row }; // no populated column that way — stay put
  }

  const stepRow = dRow > 0 ? 1 : -1;
  for (let n = Math.abs(dRow); n > 0; n--) {
    const next = stepRowOnce(lanes, { lane, col, row }, stepRow);
    if (next.lane === lane && next.row === row) break; // hit the far edge
    lane = next.lane;
    row = next.row;
  }
  return { lane, col, row };
}

/** One vertical step with lane spill. Returns the same cursor at the edges. */
function stepRowOnce(lanes: Lane[], cur: SwimCursor, dir: 1 | -1): SwimCursor {
  const { lane, col, row } = cur;
  if (dir > 0) {
    const colLen = lanes[lane]!.columns[col]?.issues.length ?? 0;
    if (row + 1 < colLen) return { lane, col, row: row + 1 };
    for (let li = lane + 1; li < lanes.length; li++) {
      if ((lanes[li]!.columns[col]?.issues.length ?? 0) > 0) return { lane: li, col, row: 0 };
    }
    return cur;
  }
  if (row > 0) return { lane, col, row: row - 1 };
  for (let li = lane - 1; li >= 0; li--) {
    const len = lanes[li]!.columns[col]?.issues.length ?? 0;
    if (len > 0) return { lane: li, col, row: len - 1 };
  }
  return cur;
}

function clampIdx(i: number, len: number): number {
  if (len <= 0) return 0;
  return Math.max(0, Math.min(len - 1, i));
}

function clampRow(lanes: Lane[], lane: number, col: number, row: number): number {
  const len = lanes[lane]?.columns[col]?.issues.length ?? 0;
  return Math.max(0, Math.min(Math.max(0, len - 1), row));
}

/**
 * A cursor pointing at a real card in `lane`, preferring `preferredCol` and
 * otherwise the nearest populated column (searching right, then left). Used
 * when jumping to a lane (g/G) or seeding the cursor on swim-view entry — the
 * navigation invariant is that the cursor always sits on a card, never a blank
 * cell, so downstream actions never see a null selection. Falls back to
 * `{lane, col: preferredCol, row: 0}` for a lane with no visible cards (which
 * buildLanes drops anyway, so this is only reached transiently).
 */
export function snapToCard(lanes: Lane[], lane: number, preferredCol: number): SwimCursor {
  const li = clampIdx(lane, lanes.length);
  const cols = lanes[li]?.columns ?? [];
  const has = (c: number) => (cols[c]?.issues.length ?? 0) > 0;
  if (has(preferredCol)) return { lane: li, col: preferredCol, row: 0 };
  for (let d = 1; d < cols.length; d++) {
    if (has(preferredCol + d)) return { lane: li, col: preferredCol + d, row: 0 };
    if (has(preferredCol - d)) return { lane: li, col: preferredCol - d, row: 0 };
  }
  return { lane: li, col: preferredCol, row: 0 };
}

/** Keep a cursor on a real card after filtering or reloading changes its lane. */
export function reconcileCursor(lanes: Lane[], cursor: SwimCursor): SwimCursor {
  if (lanes.length === 0) return cursor;
  const lane = clampIdx(cursor.lane, lanes.length);
  const columns = lanes[lane]!.columns;
  const col = clampIdx(cursor.col, columns.length);
  const issueCount = columns[col]?.issues.length ?? 0;
  if (issueCount === 0) return snapToCard(lanes, lane, col);
  return { lane, col, row: clampIdx(cursor.row, issueCount) };
}

/** Find a cursor pointing at `key`, or null. Used to follow a card post-reload. */
export function findCursor(lanes: Lane[], key: string): SwimCursor | null {
  for (let li = 0; li < lanes.length; li++) {
    const cols = lanes[li]!.columns;
    for (let ci = 0; ci < cols.length; ci++) {
      const ri = cols[ci]!.issues.findIndex((i) => i.key === key);
      if (ri !== -1) return { lane: li, col: ci, row: ri };
    }
  }
  return null;
}
