import { Box, Text, useInput } from "ink";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  type RecentIssue,
  readBoardCache,
  readRecents,
  writeBoardCache,
  writeRecents,
} from "../cache";
import type { JiraConfig } from "../config";
import { editInNeovim, editorLabel } from "../editor";
import { useDimensions, useLoading } from "../hooks";
import {
  type BoardConfig,
  type BoardSwimlanes,
  type Issue,
  type IssueLinkType,
  type IssueType,
  type JiraUser,
  type Transition,
  type EditableFieldValue,
  assignIssueToMe,
  createIssue,
  getAssignableUsers,
  getBoardConfig,
  getBoardSwimlanes,
  rankIssue,
  getBoardIssues,
  getIssueLinkTypes,
  getIssueStatusId,
  getIssueTypes,
  getTransitions,
  transitionIssue,
  updateDescription,
  updateSummary,
} from "../jira";
import {
  type Lane,
  type SwimCursor,
  buildColumns,
  buildLanes,
  findCursor,
  moveCursor,
  snapToCard,
} from "../swimlanes";
import { clamp, copyToClipboard, errorMessage, openInBrowser, stickyScroll, theme } from "../ui";
import { BoardHeader } from "./BoardHeader";
import { CreateWizard } from "./CreateWizard";
import { FilterPicker } from "./FilterPicker";
import { FilterPickerModal } from "./FilterPickerModal";
import { Footer } from "./Footer";
import { HelpModal } from "./HelpModal";
import { IssueDetailModal } from "./IssueDetailModal";
import { JqlView } from "./JqlView";
import { ColumnView, PagingArrow } from "./Kanban";
import { ListPicker } from "./ListPicker";
import { LoadingLine } from "./LoadingLine";
import { NvimBanner } from "./NvimBanner";
import { ProgressBar } from "./ProgressBar";
import { QuickAddModal } from "./QuickAddModal";
import { QuickOpen } from "./QuickOpen";
import { SwimlaneGrid } from "./SwimlaneGrid";
import { SwimlaneHeader } from "./SwimlaneHeader";
import { TitleEditModal } from "./TitleEditModal";
import { ToastStack, useToasts } from "./Toasts";
import { TransitionScreenModal } from "./TransitionScreenModal";

type Board = { id: number; name: string };

type Props = {
  cfg: JiraConfig;
  board: Board;
  maxColumns: number;
  onExit: () => void;
};

type Modal =
  | { kind: "none" }
  | { kind: "help" }
  | { kind: "search" }
  | { kind: "card-action" }
  | { kind: "move-picker"; issueKey?: string }
  | { kind: "transition-picker"; transitions: Transition[]; issueKey: string }
  | { kind: "transition-screen"; transition: Transition; issueKey: string; targetColIdx?: number }
  | { kind: "filter-menu" }
  | { kind: "filter-assignee"; names: string[] }
  | { kind: "filter-type"; types: string[] }
  | { kind: "filter-sprint"; sprints: string[] }
  | { kind: "filter-label"; labels: string[] }
  | { kind: "filter-epic"; epics: string[] }
  | { kind: "create"; types: IssueType[]; linkTypes: IssueLinkType[]; parentKey?: string }
  | { kind: "quick-add"; colIdx: number; typeName: string; value: string }
  | { kind: "detail"; issueKey: string }
  | { kind: "title-edit"; issueKey: string; current: string }
  | { kind: "nvim" }
  | { kind: "quick-open" }
  | { kind: "jql" };

type Filters = {
  assignee: string | null;
  type: string | null;
  sprint: string | null;
  label: string | null;
  epic: string | null;
};

const EMPTY_FILTERS: Filters = {
  assignee: null,
  type: null,
  sprint: null,
  label: null,
  epic: null,
};

function activeFilterCount(f: Filters): number {
  return Object.values(f).filter(Boolean).length;
}

/** Human label for the active swimlane grouping, shown in the header. */
function swimlaneStrategyLabel(strategy: BoardSwimlanes["strategy"] | undefined): string {
  switch (strategy) {
    case "custom":
      return "custom";
    case "assignee":
      return "assignee";
    case "epic":
      return "epic";
    case "issueType":
      return "issue type";
    case "parentChild":
      return "parent";
    default:
      return "";
  }
}

type CellRef = { col: number; row: number };

/** Does an issue match the search query? `q` must already be lowercased.
 *  Shared by the flat board's cell matches and the swimlane key matches. */
function issueMatches(issue: Issue, q: string): boolean {
  return (
    issue.summary.toLowerCase().includes(q) ||
    issue.key.toLowerCase().includes(q) ||
    (issue.assignee ?? "").toLowerCase().includes(q)
  );
}

export function BoardView({ cfg, board, maxColumns, onExit }: Props) {
  const { cols: termCols, rows: termRows } = useDimensions();

  // Server state
  const [conf, setConf] = useState<BoardConfig | null>(null);
  const [issues, setIssues] = useState<Issue[]>([]);
  const [swimlanes, setSwimlanes] = useState<BoardSwimlanes | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Cursor / scroll state. Per-column scroll offsets live in a ref, not
  // useState — they're derived from each column's active row at render time
  // so cursor and scroll can't disagree on a frame. (See scrollFor below.)
  const [activeCol, setActiveCol] = useState(0);
  const [activeRows, setActiveRows] = useState<number[]>([]);
  const scrollsRef = useRef<number[]>([]);

  // Swimlane view. Off by default (flat board); toggled with `s` only when
  // the board actually has swimlanes. Has its own {lane,col,row} cursor and
  // sticky scroll anchor, distinct from the flat board's per-column state.
  const [swimView, setSwimView] = useState(false);
  const [swimCursor, setSwimCursor] = useState<SwimCursor>({ lane: 0, col: 0, row: 0 });
  const swimScrollRef = useRef(0);

  // UI state
  const { toasts, flash } = useToasts();
  // Background-work indicator. `track` wraps any async load so the thin
  // progress line under the header animates while it's in flight — reloads,
  // the swimlane fetch, and one-off actions that don't own a modal spinner.
  const { busy, track } = useLoading();
  const [query, setQuery] = useState("");
  const [matchIdx, setMatchIdx] = useState(0);
  const [modal, setModal] = useState<Modal>({ kind: "none" });
  const [searchBuffer, setSearchBuffer] = useState("");
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);

  // Link & issue types don't change for the life of the board — fetch once, reuse.
  const metaCache = useRef<{ types: IssueType[]; linkTypes: IssueLinkType[] } | null>(null);
  // Assignable-users cache for @-completion in the editor, shared across every
  // edit path that shells out on this board — including the detail modal, which
  // takes `ensureUsers` as a prop rather than fetching its own copy.
  const usersRef = useRef<JiraUser[] | null>(null);
  // First load is fatal; reload failures just flash a toast.
  const hasLoadedOnce = useRef(false);
  // After a transition, follow the moved card to its new column on reload.
  const pendingFocusKey = useRef<string | null>(null);
  const [recents, setRecents] = useState<RecentIssue[]>([]);

  // Push a card to the front of the MRU recents list (deduped, capped at 20)
  // and persist it, so quick-open (`R`) starts populated across sessions.
  // Called both when opening a card's detail and after any successful
  // operation on it — anything you touch is "recent". Reads the summary from
  // whatever's currently loaded, falling back to the key.
  const touchRecent = useCallback(
    (key: string, summaryOverride?: string) => {
      setRecents((prev) => {
        // Prefer an explicit summary (freshly-created cards aren't in `issues`
        // yet), then the loaded card, then a prior recents entry, then the key.
        const summary =
          summaryOverride ??
          issues.find((i) => i.key === key)?.summary ??
          prev.find((r) => r.key === key)?.summary ??
          key;
        const next = [{ key, summary }, ...prev.filter((r) => r.key !== key)].slice(0, 20);
        void writeRecents(cfg, board.id, next);
        return next;
      });
    },
    [issues, cfg, board.id],
  );

  // Keys of issues with a board-repositioning mutation in flight (a transition
  // or rerank POST + the reload that follows). Such cards render with a
  // spinner and reject further actions until the write settles, so the user
  // can't stack conflicting moves or act on a card that's mid-flight.
  const [busyKeys, setBusyKeys] = useState<ReadonlySet<string>>(new Set());
  const markBusy = useCallback((key: string, on: boolean) => {
    setBusyKeys((prev) => {
      if (on === prev.has(key)) return prev;
      const next = new Set(prev);
      if (on) next.add(key);
      else next.delete(key);
      return next;
    });
  }, []);

  // Optimistic move overlay: key → { from, to } status ids. Applied at render
  // time (see `displayIssues`) so a card jumps to its target column the instant
  // the move starts, before the POST resolves. Cleared on POST failure (card
  // snaps back) or — on success — once refetched data shows the write took
  // effect (the reconcile effect below). `from` lets reconcile detect success
  // even when a workflow post-function redirects the card to a status other
  // than the predicted `to`.
  type PendingMove = { from: string; to: string };
  const [pendingMove, setPendingMove] = useState<ReadonlyMap<string, PendingMove>>(new Map());
  const startPending = useCallback((key: string, from: string, to: string) => {
    setPendingMove((prev) => {
      const cur = prev.get(key);
      if (cur && cur.from === from && cur.to === to) return prev;
      const next = new Map(prev);
      next.set(key, { from, to });
      return next;
    });
  }, []);
  const clearPending = useCallback((key: string) => {
    setPendingMove((prev) => {
      if (!prev.has(key)) return prev;
      const next = new Map(prev);
      next.delete(key);
      return next;
    });
  }, []);

  // A card is "pending" — rendered in the loading style and blocked from
  // further actions — if it has a write in flight (busyKeys: rerank, or a
  // transition's lookup phase) OR an optimistic move overlay (pendingMove).
  // Both the grids and the action guard read this union, so the two mechanisms
  // never disagree about whether a card is settling.
  const pendingKeys = useMemo((): ReadonlySet<string> => {
    if (pendingMove.size === 0) return busyKeys;
    const s = new Set(busyKeys);
    for (const k of pendingMove.keys()) s.add(k);
    return s;
  }, [busyKeys, pendingMove]);

  const setActiveRowAt = useCallback((col: number, row: number) => {
    setActiveRows((prev) => {
      const arr = prev.slice();
      arr[col] = row;
      return arr;
    });
  }, []);
  const closeModal = useCallback(() => setModal({ kind: "none" }), []);

  const filteredIssues = useMemo(() => {
    let list = issues;
    if (filters.assignee)
      list = list.filter((i) => (i.assignee ?? "Unassigned") === filters.assignee);
    if (filters.type) list = list.filter((i) => i.issueType === filters.type);
    if (filters.sprint) list = list.filter((i) => i.sprintName === filters.sprint);
    if (filters.label) list = list.filter((i) => i.labels.includes(filters.label!));
    if (filters.epic) list = list.filter((i) => i.epicKey === filters.epic);
    return list;
  }, [issues, filters]);
  // Overlay optimistic moves: a card with a pending move is shown under its
  // target status (so it renders in the destination column) until the real
  // data catches up. Everything downstream — columns, lanes, cursor — sees the
  // card already moved, so the whole board reflects it with no special-casing.
  const displayIssues = useMemo(() => {
    if (pendingMove.size === 0) return filteredIssues;
    return filteredIssues.map((i) => {
      const pm = pendingMove.get(i.key);
      return pm && pm.to !== i.statusId ? { ...i, statusId: pm.to } : i;
    });
  }, [filteredIssues, pendingMove]);
  const columns = useMemo(
    () => (conf ? buildColumns(conf.columns, displayIssues) : []),
    [conf, displayIssues],
  );

  // Grouped lanes for the swimlane view — same filtered issues, bucketed by
  // the board's strategy. Only meaningful when `swimlanes` is present.
  const lanes: Lane[] = useMemo(
    () => (conf && swimlanes ? buildLanes(conf.columns, displayIssues, swimlanes) : []),
    [conf, swimlanes, displayIssues],
  );
  const hasSwimlanes = !!swimlanes && swimlanes.strategy !== "none";

  // The cursor's column, wherever the cursor currently lives — the flat
  // board's `activeCol`, or the swimlane cursor's column in swim view. Every
  // column-based action (transition ±, move, paging) reads this so it works
  // in both views.
  const effectiveCol = swimView ? swimCursor.col : activeCol;

  const filterOptions = useMemo(() => {
    const assignees = new Set<string>();
    const types = new Set<string>();
    const sprints = new Set<string>();
    const labels = new Set<string>();
    const epics = new Set<string>();
    for (const i of issues) {
      assignees.add(i.assignee ?? "Unassigned");
      types.add(i.issueType);
      if (i.sprintName) sprints.add(i.sprintName);
      for (const l of i.labels) labels.add(l);
      if (i.epicKey) epics.add(i.epicKey);
    }
    const sortSet = (s: Set<string>) => Array.from(s).toSorted((a, b) => a.localeCompare(b));
    return {
      assignees: Array.from(assignees).toSorted((a, b) => {
        if (a === "Unassigned") return -1;
        if (b === "Unassigned") return 1;
        return a.localeCompare(b);
      }),
      types: sortSet(types),
      sprints: sortSet(sprints),
      labels: sortSet(labels),
      epics: sortSet(epics),
    };
  }, [issues]);

  const applyBoardData = useCallback((c: BoardConfig, is: Issue[]) => {
    setConf(c);
    setIssues(is);
    setActiveRows((prev) => c.columns.map((_, i) => prev[i] ?? 0));
    scrollsRef.current = c.columns.map((_, i) => scrollsRef.current[i] ?? 0);
  }, []);

  // Reconcile optimistic moves against real data: drop a card's overlay once a
  // refetch shows the write took effect — its real status has left `from`
  // (reached `to`, or wherever a workflow post-function redirected it). This is
  // what makes a *successful* move stick without a snap: the overlay dissolves
  // only when reality confirms the move, so it never flickers to a stale status
  // between the POST and the refetch, and once dropped the card renders at its
  // true status. A failed move clears its own overlay in the catch.
  //
  // Clearing is reload-driven, not timer-driven — no polling. In the rare case
  // Jira's board read lags the write (returns the old status just after the
  // POST), the card simply stays in its target column, in the pending style,
  // until the next reload (any other move, rerank, or `r`) confirms it. The
  // data is already correct; only the "settling" cue lingers.
  useEffect(() => {
    if (pendingMove.size === 0) return;
    const status = new Map(issues.map((i) => [i.key, i.statusId]));
    setPendingMove((prev) => {
      let next: Map<string, PendingMove> | null = null;
      for (const [key, pm] of prev) {
        const real = status.get(key);
        // Gone from the board, or moved off its origin status → move landed.
        if (real === undefined || real !== pm.from) {
          next ??= new Map(prev);
          next.delete(key);
        }
      }
      return next ?? prev;
    });
  }, [issues, pendingMove]);

  const load = useCallback(async () => {
    setLoadError(null);
    if (!hasLoadedOnce.current) {
      const cached = await readBoardCache(cfg, board.id);
      if (cached) {
        applyBoardData(cached.config, cached.issues);
        hasLoadedOnce.current = true;
      }
    }
    // One `track` wrapper around the whole sequence so the progress line stays
    // lit continuously — the config+issues fetch and the slower swimlane fetch
    // run back to back, and a per-call wrapper would blink the bar off between.
    try {
      await track(
        (async () => {
          const [c, is] = await Promise.all([
            getBoardConfig(cfg, board.id),
            getBoardIssues(cfg, board.id),
          ]);
          // Filter-based boards (created from a saved filter, or spanning
          // several projects) have no `location`, so the config endpoint gives
          // no project key. Fall back to the prefix of the first issue key
          // (PROJ-123 → PROJ) so project-scoped actions — create, quick-add,
          // @-mention users — still work on single-project filter boards
          // instead of hitting `.../undefined`.
          if (!c.projectKey) {
            const derived = is[0]?.key.split("-")[0];
            if (derived) c.projectKey = derived;
          }
          applyBoardData(c, is);
          hasLoadedOnce.current = true;
          void writeBoardCache(cfg, board.id, c, is);
          // Swimlane layout comes from a separate (internal) endpoint and needs
          // the issue id→key map to resolve custom-lane membership. Non-fatal:
          // it self-degrades to strategy "none", so the flat board is
          // unaffected if it fails.
          const idToKey = new Map(is.map((i) => [i.id, i.key]));
          setSwimlanes(await getBoardSwimlanes(cfg, board.id, idToKey));
        })(),
      );
    } catch (e) {
      const msg = errorMessage(e);
      if (hasLoadedOnce.current) flash(msg, "err");
      else setLoadError(msg);
    }
  }, [cfg, board.id, flash, applyBoardData, track]);

  useEffect(() => {
    void load();
  }, [load]);

  // Load persisted quick-open recents once per board.
  useEffect(() => {
    readRecents(cfg, board.id).then(setRecents);
  }, [cfg, board.id]);

  /**
   * Coalesced background reload. Rapid optimistic moves would otherwise each
   * fire a full board refetch; instead, if a reload is already running a caller
   * just sets a "rerun once more when you're done" flag and returns, so a burst
   * of N moves collapses to at most one in-flight reload plus one trailing
   * catch-up — never N stacked refetches, and it always ends on fresh data.
   * (Optimistic overlays keep each card in place until its own reload confirms
   * it, so a caller returning early never drops a move.)
   */
  const reloading = useRef(false);
  const reloadAgain = useRef(false);
  const coalescedReload = useCallback(async () => {
    if (reloading.current) {
      reloadAgain.current = true;
      return;
    }
    reloading.current = true;
    try {
      do {
        reloadAgain.current = false;
        await load();
      } while (reloadAgain.current);
    } finally {
      reloading.current = false;
    }
  }, [load]);

  /**
   * While the search bar is open, highlights should track what the user is
   * typing. Otherwise they track the committed query.
   */
  const liveQuery = modal.kind === "search" ? searchBuffer : query;
  const matches = useMemo(() => {
    if (!liveQuery.trim()) return [] as CellRef[];
    const q = liveQuery.toLowerCase();
    const out: CellRef[] = [];
    columns.forEach((c, ci) => {
      c.issues.forEach((issue, ri) => {
        if (issueMatches(issue, q)) out.push({ col: ci, row: ri });
      });
    });
    return out;
  }, [columns, liveQuery]);

  const matchSet = useMemo(() => new Set(matches.map((m) => `${m.col}:${m.row}`)), [matches]);
  // The swimlane grid highlights matches by issue key (its cells aren't the
  // flat board's col:row). Same query, keyed differently.
  const swimMatchSet = useMemo(() => {
    if (!liveQuery.trim()) return new Set<string>();
    const q = liveQuery.toLowerCase();
    return new Set(filteredIssues.filter((i) => issueMatches(i, q)).map((i) => i.key));
  }, [filteredIssues, liveQuery]);

  // Without this clamp the footer reads "4/2" after matches shrink.
  useEffect(() => {
    if (matchIdx >= matches.length) setMatchIdx(0);
  }, [matches, matchIdx]);

  // Move whichever cursor is live to a matched flat cell. In swim view we
  // resolve the matched issue's key to its lane position (matches are indexed
  // against the flat `columns`, but the swim cursor lives in `lanes`); if that
  // issue sits in an off-board / dropped lane, we leave the cursor put.
  const focusMatch = useCallback(
    (m: CellRef) => {
      if (swimView) {
        const key = columns[m.col]?.issues[m.row]?.key;
        const sc = key ? findCursor(lanes, key) : null;
        if (sc) setSwimCursor(sc);
        return;
      }
      setActiveCol(m.col);
      setActiveRowAt(m.col, m.row);
    },
    [swimView, columns, lanes, setActiveRowAt],
  );

  const jumpToFirstMatch = useCallback(() => {
    const first = matches[0];
    if (!first) return false;
    focusMatch(first);
    return true;
  }, [matches, focusMatch]);

  const commitQuery = useCallback(
    (q: string) => {
      setQuery(q);
      setMatchIdx(0);
      if (!q.trim()) return;
      if (!jumpToFirstMatch()) flash("no matches", "info");
    },
    [jumpToFirstMatch, flash],
  );

  const jumpToMatch = useCallback(
    (delta: number) => {
      if (matches.length === 0) {
        flash(query.trim() ? "no matches" : "no active search", "info");
        return;
      }
      const next = (((matchIdx + delta) % matches.length) + matches.length) % matches.length;
      setMatchIdx(next);
      focusMatch(matches[next]!);
    },
    [matches, matchIdx, flash, query, focusMatch],
  );

  // Layout math — columns beyond `maxColumns` require ←/→ paging. Header +
  // progress + grid + footer sum to termRows-1, leaving one free row that fits
  // a single toast. The board box is a fixed termRows tall, so a *stack* of
  // toasts would overflow and Ink would clip all but the first — the grid
  // yields a row for each toast beyond the first. One toast (the common case)
  // costs nothing; the shrink is transient and reverts when they clear.
  const footerRows = modal.kind === "search" ? 5 : 3;
  const columnHeight = Math.max(6, termRows - 3 - footerRows - Math.max(0, toasts.length - 1));
  const columnInnerHeight = columnHeight - 2; // minus border top/bottom
  const perCardLines = 5; // card = 3 content + 1 spacer + 1 (border-ish) handled via marginBottom
  const cardsVisible = Math.max(1, Math.floor(columnInnerHeight / perCardLines));
  // The swimlane grid draws single-line rows in this many terminal lines (the
  // SwimlaneHeader + divider take 2 of the columnHeight rows). PageUp/Down in
  // swim view pages by this, not `cardsVisible` (which is a flat rich-card
  // count and would under-page badly).
  const swimVisibleRows = Math.max(3, columnHeight - 2);

  const visibleColCount = Math.min(maxColumns, columns.length);
  const colWindowStart = Math.max(
    0,
    Math.min(columns.length - visibleColCount, effectiveCol - Math.floor(visibleColCount / 2)),
  );
  const colWindowEnd = colWindowStart + visibleColCount;
  const hasColsLeft = colWindowStart > 0;
  const hasColsRight = colWindowEnd < columns.length;

  /**
   * Clamp each column's active row into bounds when a column's issue list
   * shrinks (e.g. toggling the assignee filter) so the cursor doesn't sit
   * past the last card. Column *count* never changes — buildColumns always
   * maps every colDef — only the per-column issue lists grow and shrink.
   */
  useEffect(() => {
    if (columns.length === 0) return;
    setActiveRows((prev) => {
      let changed = false;
      const arr = prev.slice();
      columns.forEach((c, i) => {
        const max = Math.max(0, c.issues.length - 1);
        const cur = arr[i] ?? 0;
        if (cur > max) {
          arr[i] = max;
          changed = true;
        }
      });
      return changed ? arr : prev;
    });
  }, [columns]);

  /**
   * Keep the swimlane cursor in bounds when lanes change under it (filter
   * toggle, reload, or a card leaving a now-empty lane that gets dropped).
   * Clamps lane → col → row in order; snapping to the nearest valid cell.
   */
  useEffect(() => {
    if (!swimView || lanes.length === 0) return;
    setSwimCursor((c) => {
      const lane = Math.min(c.lane, lanes.length - 1);
      const cols = lanes[lane]!.columns;
      const col = Math.min(c.col, Math.max(0, cols.length - 1));
      const rowMax = Math.max(0, (cols[col]?.issues.length ?? 0) - 1);
      const row = Math.min(c.row, rowMax);
      if (lane === c.lane && col === c.col && row === c.row) return c;
      return { lane, col, row };
    });
  }, [lanes, swimView]);

  /**
   * Per-column scroll is derived at render from activeRow + a ref anchor.
   * Pure function — same inputs produce same output, no useState cycle.
   * Only shifts when the cursor would leave the viewport.
   */
  const scrollFor = (colIdx: number, issueCount: number): number => {
    const cursor = clamp(activeRows[colIdx] ?? 0, 0, Math.max(0, issueCount - 1));
    const scroll = stickyScroll(issueCount, cardsVisible, cursor, scrollsRef.current[colIdx] ?? 0);
    scrollsRef.current[colIdx] = scroll;
    return scroll;
  };

  const currentIssue: Issue | null = useMemo(() => {
    if (swimView) {
      const lane = lanes[swimCursor.lane];
      return lane?.columns[swimCursor.col]?.issues[swimCursor.row] ?? null;
    }
    const col = columns[activeCol];
    if (!col) return null;
    return col.issues[activeRows[activeCol] ?? 0] ?? null;
  }, [swimView, lanes, swimCursor, columns, activeCol, activeRows]);

  /**
   * Execute a transition POST, following the card to its new column. If
   * the workflow attaches a required-fields screen (`requiredFields` is
   * non-empty), open the TransitionScreenModal instead and let its
   * submit handler call back here. `targetColIdx` is threaded through
   * purely so we can snap `activeCol` to the destination after a card
   * transitions across columns — unrelated to the POST itself.
   */
  const commitTransition = useCallback(
    async (
      issueKey: string,
      transition: Transition,
      opts: { targetColIdx?: number; fields?: Record<string, EditableFieldValue> } = {},
    ) => {
      if (transition.requiredFields.length > 0 && !opts.fields) {
        setModal({
          kind: "transition-screen",
          transition,
          issueKey,
          ...(opts.targetColIdx !== undefined ? { targetColIdx: opts.targetColIdx } : {}),
        });
        return;
      }
      // Optimistic overlay: the card jumps to the target status immediately
      // (rendered in "pending" style via pendingKeys) and the cursor follows
      // it there, so the move feels instant. `from` is the card's current
      // status — kept so reconcile can tell the write landed even if a workflow
      // post-function redirects the card to a status other than the predicted
      // target. Overlay only when the move is a real, on-board reposition:
      //   - `targetColIdx` is set → the target status maps to a visible column
      //     (so the overlaid card actually lands somewhere, not vanishes);
      //   - the target differs from the current status (not a self-loop);
      //   - the current status is resolvable.
      // Otherwise skip the overlay and just POST + reload — `busyKeys` still
      // marks the card pending. This covers picker transitions to a status
      // that isn't a column on this board (targetColIdx undefined), which would
      // otherwise make the card disappear until the refetch.
      const from = issues.find((i) => i.key === issueKey)?.statusId;
      const optimistic =
        opts.targetColIdx !== undefined && from !== undefined && from !== transition.toStatusId;
      if (optimistic) {
        // The overlay lives until reconcile confirms the write — not until this
        // callback returns — so the pending style persists correctly even when
        // the reload was coalesced into another move's.
        startPending(issueKey, from, transition.toStatusId);
      } else {
        markBusy(issueKey, true);
      }
      if (opts.targetColIdx !== undefined) {
        setActiveCol(opts.targetColIdx);
        setSwimCursor((c) => ({ ...c, col: opts.targetColIdx! }));
      }
      pendingFocusKey.current = issueKey;
      try {
        await transitionIssue(cfg, issueKey, transition.id, opts.fields);
        flash(`${issueKey} → ${transition.name}`, "ok");
        touchRecent(issueKey);
        await coalescedReload();
      } catch (e) {
        if (optimistic) clearPending(issueKey);
        pendingFocusKey.current = null;
        flash(errorMessage(e), "err");
      } finally {
        if (!optimistic) markBusy(issueKey, false);
      }
    },
    [cfg, issues, flash, coalescedReload, markBusy, startPending, clearPending, touchRecent],
  );

  const moveToColumn = useCallback(
    async (targetColIdx: number, issueOverride?: Issue) => {
      const issue = issueOverride ?? currentIssue;
      if (!issue || !conf) return;
      if (targetColIdx < 0 || targetColIdx >= conf.columns.length) return;
      // Per-card guard (not a global lock): a card already settling can't be
      // re-moved, but other cards move freely and concurrently. That's what
      // makes fast multi-card moves work without stacking transitions on one
      // card or racing its focus snap.
      if (pendingKeys.has(issue.key)) {
        flash(`${issue.key} is updating…`, "info");
        return;
      }
      // markBusy covers the transition-lookup phase, before the optimistic
      // overlay exists; commitTransition's startPending takes over as the
      // pending signal the moment we POST.
      markBusy(issue.key, true);
      const targetCol = conf.columns[targetColIdx]!;
      try {
        const trs = await getTransitions(cfg, issue.key);
        const candidates = trs.filter((t) => targetCol.statusIds.includes(t.toStatusId));
        if (candidates.length === 0) {
          flash(`no transition to ${targetCol.name}`, "err");
          return;
        }
        // Moving a card to a column should feel like a drag-and-drop, not a
        // quiz: don't stop to ask which transition when several land in the
        // same column. Auto-pick one — preferring a path with no required-
        // fields screen so the move stays frictionless — and let
        // commitTransition surface the screen only if that's the only path.
        const chosen = candidates.find((t) => t.requiredFields.length === 0) ?? candidates[0]!;
        await commitTransition(issue.key, chosen, { targetColIdx });
      } catch (e) {
        flash(errorMessage(e), "err");
      } finally {
        // Release the lookup-phase flag. On the POST path the overlay is now
        // the pending signal (dropped by reconcile); on the no-candidate,
        // required-fields-screen, or error paths this is the only flag to
        // clear, so the card doesn't stay stuck.
        markBusy(issue.key, false);
      }
    },
    [currentIssue, conf, cfg, flash, commitTransition, markBusy, pendingKeys],
  );

  /**
   * After a reload, snap the cursor to wherever the tracked card ended up —
   * activeRows for the flat board, and the {lane,col,row} cursor for the
   * swimlane view (a transition can move a card between lanes too). Only
   * clear the marker once we actually find the card — pre-reload column
   * changes (e.g. toggling a filter mid-flight) shouldn't consume it.
   */
  useEffect(() => {
    const key = pendingFocusKey.current;
    if (!key) return;
    if (swimView) {
      const sc = findCursor(lanes, key);
      if (sc) {
        setSwimCursor(sc);
        pendingFocusKey.current = null;
      }
      return;
    }
    for (let ci = 0; ci < columns.length; ci++) {
      const col = columns[ci]!;
      const ri = col.issues.findIndex((i) => i.key === key);
      if (ri !== -1) {
        setActiveCol(ci);
        setActiveRowAt(ci, ri);
        pendingFocusKey.current = null;
        return;
      }
    }
  }, [columns, lanes, swimView, setActiveRowAt]);

  const doTransition = useCallback(
    async (direction: 1 | -1) => {
      if (!conf) return;
      const targetColIdx = effectiveCol + direction;
      if (targetColIdx < 0 || targetColIdx >= conf.columns.length) {
        flash("no column in that direction", "info");
        return;
      }
      await moveToColumn(targetColIdx);
    },
    [conf, effectiveCol, flash, moveToColumn],
  );

  const doEditSummary = useCallback(() => {
    const issue = currentIssue;
    if (!issue) return;
    setModal({ kind: "title-edit", issueKey: issue.key, current: issue.summary });
  }, [currentIssue]);

  /**
   * Lazy-hydrate the project's assignable users. Handed to `editInNeovim`
   * so the editor's `@` completion menu can offer real teammates. Fetch
   * failure isn't fatal — we just open the editor without the menu.
   */
  const ensureUsers = useCallback(async (): Promise<JiraUser[]> => {
    if (!conf) return [];
    try {
      if (!usersRef.current) {
        usersRef.current = await getAssignableUsers(cfg, conf.projectKey);
      }
      return usersRef.current;
    } catch {
      return [];
    }
  }, [cfg, conf]);

  // Pre-warm the assignable-users list as soon as the board's project is
  // known, so the first `@`-mention edit opens the editor instantly instead of
  // blocking on this fetch behind the "editing…" banner. Cached in usersRef,
  // so the edit paths (board + detail modal) reuse it. Fire-and-forget.
  useEffect(() => {
    if (conf) void ensureUsers();
  }, [conf, ensureUsers]);

  const doEditDescription = useCallback(async () => {
    const issue = currentIssue;
    if (!issue) return;
    setModal({ kind: "nvim" });
    try {
      const mentionUsers = await ensureUsers();
      const raw = await editInNeovim(issue.description, `${issue.key}-desc.md`, { mentionUsers });
      setModal({ kind: "none" });
      if (raw.trim() === issue.description.trim()) {
        flash("no change", "info");
        return;
      }
      await updateDescription(cfg, issue.key, raw);
      flash(`${issue.key} description updated`, "ok");
      touchRecent(issue.key);
      await load();
    } catch (e) {
      setModal({ kind: "none" });
      flash(errorMessage(e), "err");
    }
  }, [currentIssue, cfg, flash, load, ensureUsers, touchRecent]);

  const doAssignToMe = useCallback(async () => {
    const issue = currentIssue;
    if (!issue) {
      flash("no issue selected", "info");
      return;
    }
    try {
      await track(assignIssueToMe(cfg, issue.key));
      flash(`${issue.key} assigned to you`, "ok");
      touchRecent(issue.key);
      await load();
    } catch (e) {
      flash(errorMessage(e), "err");
    }
  }, [currentIssue, cfg, flash, load, track, touchRecent]);

  const doFuzzyTransition = useCallback(async () => {
    const issue = currentIssue;
    if (!issue) {
      flash("no issue selected", "info");
      return;
    }
    try {
      const trs = await track(getTransitions(cfg, issue.key));
      if (trs.length === 0) {
        flash("no transitions available", "info");
        return;
      }
      setModal({ kind: "transition-picker", transitions: trs, issueKey: issue.key });
    } catch (e) {
      flash(errorMessage(e), "err");
    }
  }, [currentIssue, cfg, flash, track]);

  const doRerank = useCallback(
    async (direction: -1 | 1) => {
      // Rerank relative to the visual neighbor in the same column. In swim
      // view that's within the current lane's column; on the flat board it's
      // the active column. Reordering is global rank, so the neighbor's key
      // is all Jira needs.
      const col = swimView ? lanes[swimCursor.lane]?.columns[swimCursor.col] : columns[activeCol];
      const row = swimView ? swimCursor.row : (activeRows[activeCol] ?? 0);
      if (!col) return;
      const issue = col.issues[row];
      if (!issue) return;
      const targetRow = row + direction;
      if (targetRow < 0 || targetRow >= col.issues.length) {
        flash("already at the edge", "info");
        return;
      }
      const neighbor = col.issues[targetRow]!;
      if (pendingKeys.has(issue.key)) {
        flash(`${issue.key} is updating…`, "info");
        return;
      }
      markBusy(issue.key, true);
      try {
        await rankIssue(
          cfg,
          issue.key,
          direction === -1 ? { before: neighbor.key } : { after: neighbor.key },
        );
        pendingFocusKey.current = issue.key;
        flash(`${issue.key} reranked ${direction === -1 ? "up" : "down"}`, "ok");
        touchRecent(issue.key);
        await coalescedReload();
      } catch (e) {
        flash(errorMessage(e), "err");
      } finally {
        markBusy(issue.key, false);
      }
    },
    [
      swimView,
      lanes,
      swimCursor,
      columns,
      activeCol,
      activeRows,
      cfg,
      flash,
      coalescedReload,
      pendingKeys,
      markBusy,
      touchRecent,
    ],
  );

  const openDetailForKey = useCallback(
    (key: string, summary?: string) => {
      touchRecent(key, summary);
      setModal({ kind: "detail", issueKey: key });
    },
    [touchRecent],
  );

  const openDetail = useCallback(() => {
    const issue = currentIssue;
    if (!issue) {
      flash("no issue selected", "info");
      return;
    }
    openDetailForKey(issue.key);
  }, [currentIssue, flash, openDetailForKey]);

  const openIssueInBrowser = useCallback(async () => {
    const issue = currentIssue;
    if (!issue) {
      flash("no issue selected", "info");
      return;
    }
    try {
      await openInBrowser(`${cfg.server}/browse/${issue.key}`);
      flash(`opened ${issue.key} in browser`, "ok");
    } catch (e) {
      flash(errorMessage(e), "err");
    }
  }, [currentIssue, cfg.server, flash]);

  const openBoardInBrowser = useCallback(async () => {
    if (!conf) return;
    try {
      /**
       * Team-managed / next-gen URL. Classic projects use
       * /secure/RapidBoard.jspa?rapidView=… — Jira usually redirects anyway.
       */
      await openInBrowser(
        `${cfg.server}/jira/software/projects/${conf.projectKey}/boards/${board.id}`,
      );
      flash(`opened board in browser`, "ok");
    } catch (e) {
      flash(errorMessage(e), "err");
    }
  }, [cfg.server, conf, board.id, flash]);

  /**
   * Hydrate (and memoize) the issue-type + link-type catalog. Both are
   * board-lifetime constants, so one fetch covers every caller that needs
   * them: `c` (full wizard) and the subtask path out of the detail modal.
   */
  const ensureMeta = useCallback(async (): Promise<{
    types: IssueType[];
    linkTypes: IssueLinkType[];
  }> => {
    if (!conf) throw new Error("board config not loaded");
    // Filter/multi-project boards with no issues yet expose no project key, so
    // there's nothing to scope a create against — fail with a clear message
    // rather than POSTing to `.../undefined`.
    if (!conf.projectKey) throw new Error("no project on this board — can't create issues here");
    if (!metaCache.current) {
      const [types, linkTypes] = await track(
        Promise.all([getIssueTypes(cfg, conf.projectKey), getIssueLinkTypes(cfg)]),
      );
      metaCache.current = { types: types.filter((t) => !t.subtask), linkTypes };
    }
    return metaCache.current;
  }, [cfg, conf, track]);

  const startCreate = useCallback(async () => {
    if (!conf) return;
    try {
      const { types, linkTypes } = await ensureMeta();
      if (types.length === 0) {
        flash("no creatable issue types", "err");
        return;
      }
      setModal({ kind: "create", types, linkTypes });
    } catch (e) {
      flash(errorMessage(e), "err");
    }
  }, [conf, ensureMeta, flash]);

  /**
   * Quick-add is `c` minus the wizard — just a title, landing in whatever
   * column the cursor was on. Type defaults to the first non-subtask Jira
   * returns (typically Story/Task). `colIdx` is captured at open-time so
   * the user can move the cursor while typing without the target drifting.
   */
  const startQuickAdd = useCallback(async () => {
    if (!conf) return;
    try {
      const { types } = await ensureMeta();
      const defaultType = types[0];
      if (!defaultType) {
        flash("no creatable issue types", "err");
        return;
      }
      setModal({ kind: "quick-add", colIdx: effectiveCol, typeName: defaultType.name, value: "" });
    } catch (e) {
      flash(errorMessage(e), "err");
    }
  }, [conf, ensureMeta, effectiveCol, flash]);

  const submitQuickAdd = useCallback(
    async (colIdx: number, typeName: string, title: string) => {
      if (!conf) return;
      const trimmed = title.trim();
      if (!trimmed) {
        flash("title empty, not created", "info");
        closeModal();
        return;
      }
      const targetCol = conf.columns[colIdx];
      if (!targetCol) {
        closeModal();
        return;
      }
      closeModal();
      try {
        const created = await createIssue(cfg, conf.projectKey, typeName, trimmed, "");
        // Jira drops the issue into the workflow's initial status, which
        // usually isn't where the cursor was. Transition if it's not already
        // in the target column; soft-fail if the workflow blocks the jump.
        const statusId = await getIssueStatusId(cfg, created.key);
        let landed = targetCol.statusIds.includes(statusId);
        if (!landed) {
          const trs = await getTransitions(cfg, created.key);
          const hop = trs.find((t) => targetCol.statusIds.includes(t.toStatusId));
          if (hop) {
            await transitionIssue(cfg, created.key, hop.id);
            landed = true;
          }
        }
        setActiveCol(colIdx);
        setSwimCursor((c) => ({ ...c, col: colIdx }));
        pendingFocusKey.current = created.key;
        flash(
          landed
            ? `created ${created.key} in ${targetCol.name}`
            : `created ${created.key} (couldn't move to ${targetCol.name})`,
          landed ? "ok" : "info",
        );
        touchRecent(created.key, trimmed);
        await load();
      } catch (e) {
        flash(errorMessage(e), "err");
      }
    },
    [cfg, conf, flash, load, closeModal, touchRecent],
  );

  // Nudge the cursor within the active column / across columns.
  const nudgeRow = useCallback(
    (delta: number) => {
      setActiveRows((prev) => {
        const arr = prev.slice();
        const col = columns[activeCol];
        if (!col) return arr;
        arr[activeCol] = clamp(
          (arr[activeCol] ?? 0) + delta,
          0,
          Math.max(0, col.issues.length - 1),
        );
        return arr;
      });
    },
    [columns, activeCol],
  );
  const nudgeCol = useCallback(
    (delta: number) => {
      setActiveCol((c) => clamp(c + delta, 0, Math.max(0, columns.length - 1)));
    },
    [columns.length],
  );

  // Swimlane cursor movement — delegates the spill-across-lanes logic to the
  // pure `moveCursor` in swimlanes.ts. dRow steps within/between lanes; dCol
  // moves across columns, clamping the row into the new column.
  const swimMove = useCallback(
    (dRow: number, dCol: number) => {
      setSwimCursor((c) => moveCursor(lanes, c, dRow, dCol));
    },
    [lanes],
  );

  useInput(
    (input, key) => {
      // Global
      if (key.ctrl && input === "c") return onExit();
      if (input === "q") return onExit();
      if (input === "?") return setModal({ kind: "help" });

      // Navigation — swim view uses the lane cursor, flat board the columns.
      if (swimView) {
        if (key.leftArrow || input === "h") return swimMove(0, -1);
        if (key.rightArrow || input === "l") return swimMove(0, 1);
        if (key.upArrow || input === "k") return swimMove(-1, 0);
        if (key.downArrow || input === "j") return swimMove(1, 0);
        if (key.pageUp) return swimMove(-swimVisibleRows, 0);
        if (key.pageDown) return swimMove(swimVisibleRows, 0);
        // g/G fall through to the shared handlers below (no-op-safe in swim).
      } else {
        if (key.leftArrow || input === "h") return nudgeCol(-1);
        if (key.rightArrow || input === "l") return nudgeCol(1);
        if (key.upArrow || input === "k") return nudgeRow(-1);
        if (key.downArrow || input === "j") return nudgeRow(1);
        if (input === "g") {
          setActiveRowAt(activeCol, 0);
          return;
        }
        if (input === "G") {
          const col = columns[activeCol];
          if (col) setActiveRowAt(activeCol, Math.max(0, col.issues.length - 1));
          return;
        }
        if (key.pageUp) return nudgeRow(-cardsVisible);
        if (key.pageDown) return nudgeRow(cardsVisible);
      }

      // g / G — jump to the first / last lane (swim) or column top/bottom
      // (flat, handled above). snapToCard lands on a populated cell (preferring
      // the current column) so the cursor never strands on an empty cell in a
      // lane that doesn't have a card in that column.
      if (swimView && input === "g") return setSwimCursor((c) => snapToCard(lanes, 0, c.col));
      if (swimView && input === "G")
        return setSwimCursor((c) => snapToCard(lanes, lanes.length - 1, c.col));

      // Block mutating actions on a card that's mid-update (a transition or
      // rerank in flight, or an optimistic move still settling). Read-only
      // actions (view, yank, open, refresh) and navigation stay live so the
      // user can look around while it settles.
      if (currentIssue && pendingKeys.has(currentIssue.key)) {
        const mutating =
          key.return ||
          input === "e" ||
          input === "E" ||
          input === "m" ||
          input === "[" ||
          input === "]" ||
          input === "<" ||
          input === ">" ||
          input === "t" ||
          input === "i";
        if (mutating) {
          flash(`${currentIssue.key} is updating…`, "info");
          return;
        }
      }

      // Actions on current card
      if (key.return) {
        if (currentIssue) setModal({ kind: "card-action" });
        return;
      }
      if (input === "v") return void openDetail();
      if (input === "e") return void doEditSummary();
      if (input === "E") return void doEditDescription();
      if (input === "o") return void openIssueInBrowser();
      if (input === "m") {
        if (!currentIssue) return flash("no issue selected", "info");
        setModal({ kind: "move-picker" });
        return;
      }
      // Rerank uses [ / ] — plain brackets transmit reliably on every
      // terminal. Ctrl+, / Ctrl+. used to do this, but most emulators can't
      // send those and downgrade them to plain , / . — which were aliased to
      // the transition below, so a "reorder" keystroke silently fired a
      // destructive cross-column move. Transitions keep < / > (printable
      // ASCII, always delivered); the , / . aliases are gone.
      if (input === "[") return void doRerank(-1);
      if (input === "]") return void doRerank(1);
      if (input === "<") return void doTransition(-1);
      if (input === ">") return void doTransition(1);
      if (input === "t") return void doFuzzyTransition();
      if (input === "i") return void doAssignToMe();
      if (input === "y") {
        if (!currentIssue) return flash("no issue selected", "info");
        copyToClipboard(currentIssue.key)
          .then(() => flash(`copied ${currentIssue.key}`, "ok"))
          .catch((e) => flash(errorMessage(e), "err"));
        return;
      }
      if (input === "Y") {
        if (!currentIssue) return flash("no issue selected", "info");
        const url = `${cfg.server}/browse/${currentIssue.key}`;
        copyToClipboard(url)
          .then(() => flash(`copied URL`, "ok"))
          .catch((e) => flash(errorMessage(e), "err"));
        return;
      }

      // Board-wide
      if (input === "O") return void openBoardInBrowser();
      if (input === "c") return void startCreate();
      if (input === "a") return void startQuickAdd();
      if (input === "r") {
        void load();
        flash("refreshing…", "info");
        return;
      }

      // Search + match cycling
      if (input === "/") {
        setSearchBuffer(query);
        setModal({ kind: "search" });
        return;
      }
      if (input === "n") return jumpToMatch(1);
      if (input === "N") return jumpToMatch(-1);

      // Quick-open finder: opens on recently-visited issues; typing searches
      // every project globally.
      if (input === "R") return setModal({ kind: "quick-open" });

      // JQL
      if (input === "J") {
        setModal({ kind: "jql" });
        return;
      }

      // Filters
      if (input === "f") {
        setModal({ kind: "filter-menu" });
        return;
      }
      if (input === "F") {
        if (activeFilterCount(filters) > 0) {
          setFilters(EMPTY_FILTERS);
          flash("all filters cleared", "ok");
        } else {
          flash("no filters active", "info");
        }
        return;
      }
      // Swimlanes: toggle the grouped lane view. Only available when the
      // board actually defines swimlanes (custom JQL lanes or a field
      // strategy) — otherwise there's nothing to group by.
      if (input === "s") {
        if (!hasSwimlanes) {
          flash("no swimlanes configured on this board", "info");
          return;
        }
        setSwimView((v) => {
          const next = !v;
          if (next) {
            // Entering swim view: seed the cursor on the current issue if it
            // exists in a lane, else the first populated cell (snapToCard keeps
            // us off an empty cell when lane 0 has no card in this column).
            const seed = currentIssue ? findCursor(lanes, currentIssue.key) : null;
            setSwimCursor(seed ?? snapToCard(lanes, 0, effectiveCol));
            swimScrollRef.current = 0;
          } else if (currentIssue) {
            // Leaving swim view: carry the column back to the flat board.
            setActiveCol(swimCursor.col);
          }
          return next;
        });
        return;
      }
    },
    { isActive: modal.kind === "none" },
  );

  if (!conf) {
    /**
     * First-load states only — spinner or fatal error. Once `conf` lands,
     * reload errors surface as a toast so the grid stays up. Title
     * column matches the board-picker's layout so the app doesn't feel
     * shifty between screens.
     */
    if (loadError) {
      return (
        <Box flexDirection="column" padding={1}>
          <Box>
            <Text color={theme.accent} bold>
              ifhj{" "}
            </Text>
            <Text color={theme.muted}>— {board.name}</Text>
          </Box>
          <Box marginTop={1}>
            <Text color={theme.error}>{loadError}</Text>
          </Box>
          <Box marginTop={1}>
            <Text color={theme.muted}>press q to go back</Text>
          </Box>
        </Box>
      );
    }
    return (
      <Box flexDirection="column" padding={1}>
        <Box>
          <Text color={theme.accent} bold>
            ifhj{" "}
          </Text>
          <Text color={theme.muted}>— {board.name}</Text>
        </Box>
        <Box marginTop={1}>
          <LoadingLine label="loading board…" />
        </Box>
      </Box>
    );
  }

  // Modal overlays. Each branch is a discrete, full-screen-ish component.
  if (modal.kind === "nvim") return <NvimBanner />;
  if (modal.kind === "help") return <HelpModal onClose={closeModal} />;
  if (modal.kind === "card-action" && currentIssue) {
    return (
      <ListPicker
        title={`${currentIssue.key} · ${currentIssue.summary.slice(0, 60)}`}
        items={[
          { id: "detail", label: "view details" },
          { id: "title", label: "edit title" },
          { id: "desc", label: `edit description (${editorLabel()})` },
          { id: "transition", label: "transition to status…" },
          { id: "move", label: "move to column…" },
          { id: "assign-me", label: "assign to me" },
          { id: "open", label: "open in browser" },
        ]}
        onCancel={closeModal}
        onPick={(id) => {
          closeModal();
          if (id === "detail") void openDetail();
          else if (id === "title") void doEditSummary();
          else if (id === "desc") void doEditDescription();
          else if (id === "transition") void doFuzzyTransition();
          else if (id === "move") setModal({ kind: "move-picker" });
          else if (id === "assign-me") void doAssignToMe();
          else if (id === "open") void openIssueInBrowser();
        }}
      />
    );
  }
  if (modal.kind === "move-picker") {
    // Explicit issueKey (e.g. from detail modal after a just-created card)
    // must resolve against the fresh issues list — falling back to
    // currentIssue would silently move the wrong card.
    const targetIssue = modal.issueKey
      ? issues.find((i) => i.key === modal.issueKey)
      : currentIssue;
    if (targetIssue) {
      const currentColIdx = conf.columns.findIndex((c) =>
        c.statusIds.includes(targetIssue.statusId),
      );
      return (
        <FilterPicker
          title={`move ${targetIssue.key} to…`}
          items={conf.columns.map((c, i) => ({ id: String(i), label: c.name }))}
          {...(currentColIdx >= 0 ? { currentId: String(currentColIdx) } : {})}
          onCancel={closeModal}
          onPick={(id) => {
            closeModal();
            const idx = Number(id);
            const col = conf.columns[idx];
            if (!col) return;
            if (col.statusIds.includes(targetIssue.statusId)) {
              flash("already in that column", "info");
              return;
            }
            void moveToColumn(idx, targetIssue);
          }}
        />
      );
    }
    // Issue not in the current issues list yet — likely a just-created card
    // mid-reload. Render the picker in a loading state; it resolves on its
    // own once issues update, and esc still cancels via FilterPicker.
    return (
      <FilterPicker
        title={`move ${modal.issueKey ?? "issue"} to…`}
        items={[]}
        loading
        onCancel={closeModal}
        onPick={() => {}}
      />
    );
  }
  if (modal.kind === "quick-add") {
    const colName = conf.columns[modal.colIdx]?.name ?? "column";
    return (
      <QuickAddModal
        colName={colName}
        typeName={modal.typeName}
        value={modal.value}
        onChange={(v) => setModal({ ...modal, value: v })}
        onSubmit={(val) => void submitQuickAdd(modal.colIdx, modal.typeName, val)}
        onCancel={closeModal}
      />
    );
  }
  if (modal.kind === "title-edit") {
    const editKey = modal.issueKey;
    return (
      <TitleEditModal
        issueKey={editKey}
        value={modal.current}
        onChange={(v) => setModal({ ...modal, current: v })}
        onSubmit={async (val) => {
          const next = val.trim();
          if (!next) {
            flash("summary empty, not saved", "info");
            closeModal();
            return;
          }
          closeModal();
          try {
            await updateSummary(cfg, editKey, next);
            flash(`${editKey} title updated`, "ok");
            touchRecent(editKey);
            await load();
          } catch (e) {
            flash(errorMessage(e), "err");
          }
        }}
        onCancel={closeModal}
      />
    );
  }
  if (modal.kind === "detail") {
    return (
      <IssueDetailModal
        cfg={cfg}
        projectKey={conf.projectKey}
        issueKey={modal.issueKey}
        ensureUsers={ensureUsers}
        onClose={closeModal}
        onMove={() => setModal({ kind: "move-picker", issueKey: modal.issueKey })}
        onTransition={async () => {
          const key = modal.issueKey;
          try {
            const trs = await track(getTransitions(cfg, key));
            if (trs.length === 0) {
              flash("no transitions available", "info");
              return;
            }
            setModal({ kind: "transition-picker", transitions: trs, issueKey: key });
          } catch (e) {
            flash(errorMessage(e), "err");
          }
        }}
        onCreateSubtask={(parentKey) => {
          closeModal();
          void (async () => {
            try {
              const { types, linkTypes } = await ensureMeta();
              setModal({ kind: "create", types, linkTypes, parentKey });
            } catch (e) {
              flash(errorMessage(e), "err");
            }
          })();
        }}
        onRefresh={() => void load()}
      />
    );
  }
  if (modal.kind === "transition-picker") {
    const pickerKey = modal.issueKey;
    const trs = modal.transitions;
    return (
      <ListPicker
        title={`transition ${pickerKey}`}
        items={trs.map((t) => ({ id: t.id, label: t.name }))}
        onCancel={closeModal}
        onPick={(id) => {
          const tr = trs.find((t) => t.id === id);
          if (!tr) {
            closeModal();
            return;
          }
          // Close this picker first so the gate's setModal (for a required-
          // fields screen) isn't racing against us. If there's no screen,
          // commitTransition runs through to POST with no modal up.
          const targetIdx = conf.columns.findIndex((c) => c.statusIds.includes(tr.toStatusId));
          closeModal();
          void commitTransition(pickerKey, tr, targetIdx !== -1 ? { targetColIdx: targetIdx } : {});
        }}
      />
    );
  }
  if (modal.kind === "transition-screen") {
    const screenKey = modal.issueKey;
    const screenTr = modal.transition;
    const screenTargetIdx = modal.targetColIdx;
    return (
      <TransitionScreenModal
        cfg={cfg}
        projectKey={conf.projectKey}
        issueKey={screenKey}
        transition={screenTr}
        onCancel={closeModal}
        onSubmit={(fields) => {
          closeModal();
          void commitTransition(
            screenKey,
            screenTr,
            screenTargetIdx !== undefined ? { targetColIdx: screenTargetIdx, fields } : { fields },
          );
        }}
      />
    );
  }
  if (modal.kind === "filter-menu") {
    const count = activeFilterCount(filters);
    const items = [
      { id: "assignee", label: `assignee${filters.assignee ? ` · ${filters.assignee}` : ""}` },
      { id: "type", label: `issue type${filters.type ? ` · ${filters.type}` : ""}` },
      { id: "sprint", label: `sprint${filters.sprint ? ` · ${filters.sprint}` : ""}` },
      { id: "label", label: `label${filters.label ? ` · ${filters.label}` : ""}` },
      { id: "epic", label: `epic${filters.epic ? ` · ${filters.epic}` : ""}` },
      ...(count > 0 ? [{ id: "clear", label: "clear all filters" }] : []),
    ];
    return (
      <ListPicker
        title={`filters${count > 0 ? ` (${count} active)` : ""}`}
        items={items}
        onPick={(id) => {
          if (id === "clear") {
            setFilters(EMPTY_FILTERS);
            closeModal();
            flash("all filters cleared", "ok");
          } else if (id === "assignee") {
            setModal({ kind: "filter-assignee", names: filterOptions.assignees });
          } else if (id === "type") {
            setModal({ kind: "filter-type", types: filterOptions.types });
          } else if (id === "sprint") {
            if (filterOptions.sprints.length === 0) {
              flash("no sprints found", "info");
              return;
            }
            setModal({ kind: "filter-sprint", sprints: filterOptions.sprints });
          } else if (id === "label") {
            if (filterOptions.labels.length === 0) {
              flash("no labels found", "info");
              return;
            }
            setModal({ kind: "filter-label", labels: filterOptions.labels });
          } else if (id === "epic") {
            if (filterOptions.epics.length === 0) {
              flash("no epics found", "info");
              return;
            }
            setModal({ kind: "filter-epic", epics: filterOptions.epics });
          }
        }}
        onCancel={closeModal}
      />
    );
  }
  if (
    modal.kind === "filter-assignee" ||
    modal.kind === "filter-type" ||
    modal.kind === "filter-sprint" ||
    modal.kind === "filter-label" ||
    modal.kind === "filter-epic"
  ) {
    const spec: {
      key: keyof Filters;
      label: string;
      items: string[];
    } =
      modal.kind === "filter-assignee"
        ? { key: "assignee", label: "assignee", items: modal.names }
        : modal.kind === "filter-type"
          ? { key: "type", label: "issue type", items: modal.types }
          : modal.kind === "filter-sprint"
            ? { key: "sprint", label: "sprint", items: modal.sprints }
            : modal.kind === "filter-label"
              ? { key: "label", label: "label", items: modal.labels }
              : { key: "epic", label: "epic", items: modal.epics };
    return (
      <FilterPickerModal
        label={spec.label}
        items={spec.items}
        currentId={filters[spec.key]}
        onPick={(id) => {
          setFilters((f) => ({ ...f, [spec.key]: id }));
          closeModal();
          flash(`${spec.label}: ${id}`, "ok");
        }}
        onClear={() => {
          setFilters((f) => ({ ...f, [spec.key]: null }));
          closeModal();
          flash(`${spec.label} filter cleared`, "ok");
        }}
        onCancel={() => setModal({ kind: "filter-menu" })}
      />
    );
  }
  if (modal.kind === "quick-open") {
    return (
      <QuickOpen
        cfg={cfg}
        recents={recents}
        onPick={(key) => {
          closeModal();
          openDetailForKey(key);
        }}
        onCancel={closeModal}
      />
    );
  }
  if (modal.kind === "jql") {
    return (
      <JqlView
        cfg={cfg}
        onPick={(key) => {
          closeModal();
          openDetailForKey(key);
        }}
        onCancel={closeModal}
      />
    );
  }
  if (modal.kind === "create") {
    return (
      <CreateWizard
        cfg={cfg}
        projectKey={conf.projectKey}
        types={modal.types}
        linkTypes={modal.linkTypes}
        defaultParent={modal.parentKey}
        ensureUsers={ensureUsers}
        onCancel={closeModal}
        onDone={({ key, title, linkSummary }) => {
          const headline = `created ${key}: ${title}`;
          flash(linkSummary ? `${headline} · ${linkSummary}` : headline, "ok");
          pendingFocusKey.current = key;
          // Reload in the background so the new card shows up on the board
          // beneath the detail view — the user closes detail and lands on it.
          void load();
          void openDetailForKey(key, title);
        }}
        onError={(msg) => {
          flash(msg, "err");
          closeModal();
        }}
      />
    );
  }

  // Main kanban view.
  const gap = 1;
  const arrowChannel = 2;
  const gridWidth = termCols - arrowChannel * 2;
  const colWidth = Math.max(
    18,
    Math.floor((gridWidth - gap * (visibleColCount - 1)) / Math.max(1, visibleColCount)),
  );
  const visibleCols = columns.slice(colWindowStart, colWindowEnd);

  return (
    <Box flexDirection="column" width={termCols} height={termRows}>
      <BoardHeader
        boardName={conf.name}
        projectKey={conf.projectKey}
        visibleIssueCount={filteredIssues.length}
        totalIssueCount={issues.length}
        visiblePointSum={filteredIssues.reduce((a, i) => a + (i.storyPoints ?? 0), 0)}
        colIndex={effectiveCol}
        colCount={columns.length}
        filterCount={activeFilterCount(filters)}
        {...(swimView ? { swimlaneLabel: swimlaneStrategyLabel(swimlanes?.strategy) } : {})}
        query={modal.kind === "search" ? "" : query}
        matches={matches.length}
        matchIdx={matchIdx}
      />

      <Box paddingX={1}>
        <ProgressBar width={Math.max(1, termCols - 2)} active={busy} />
      </Box>

      {swimView ? (
        <Box flexDirection="column" height={columnHeight}>
          <Box flexDirection="row">
            <PagingArrow direction="left" active={hasColsLeft} />
            <Box flexDirection="column" width={gridWidth}>
              <SwimlaneHeader
                columns={columns}
                colWindowStart={colWindowStart}
                visibleColCount={visibleColCount}
                activeCol={swimCursor.col}
                width={gridWidth}
              />
              <Box>
                <Text color={theme.divider}>{"─".repeat(Math.max(0, gridWidth))}</Text>
              </Box>
              <SwimlaneGrid
                lanes={lanes}
                cursor={swimCursor}
                colWindowStart={colWindowStart}
                visibleColCount={visibleColCount}
                width={gridWidth}
                height={swimVisibleRows}
                matchSet={swimMatchSet}
                busyKeys={pendingKeys}
                scrollRef={swimScrollRef}
              />
            </Box>
            <PagingArrow direction="right" active={hasColsRight} />
          </Box>
        </Box>
      ) : (
        <Box flexDirection="row" height={columnHeight}>
          <PagingArrow direction="left" active={hasColsLeft} />
          <Box flexDirection="row" width={gridWidth}>
            {visibleCols.map((col, vi) => {
              const ci = colWindowStart + vi;
              return (
                <ColumnView
                  key={col.name + ci}
                  column={col}
                  width={colWidth}
                  marginRight={vi === visibleCols.length - 1 ? 0 : gap}
                  isActive={ci === activeCol}
                  activeRow={activeRows[ci] ?? 0}
                  scroll={scrollFor(ci, col.issues.length)}
                  cardsVisible={cardsVisible}
                  matchSet={matchSet}
                  busyKeys={pendingKeys}
                  colIdx={ci}
                />
              );
            })}
          </Box>
          <PagingArrow direction="right" active={hasColsRight} />
        </Box>
      )}

      <Footer
        currentIssue={currentIssue}
        termCols={termCols}
        mode={modal.kind === "search" ? "search" : "normal"}
        query={query}
        matches={matches.length}
        matchIdx={matchIdx}
        filterCount={activeFilterCount(filters)}
        hasSwimlanes={hasSwimlanes}
        swimActive={swimView}
        searchBuffer={searchBuffer}
        onSearchChange={setSearchBuffer}
        onSearchSubmit={(q) => {
          commitQuery(q);
          closeModal();
        }}
        onSearchCancel={() => {
          closeModal();
        }}
      />
      <ToastStack toasts={toasts} maxWidth={termCols} />
    </Box>
  );
}
