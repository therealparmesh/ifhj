import { Box, Text } from "ink";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

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
import { InputScope, useInput } from "../input";
import {
  type BoardConfig,
  type BoardSwimlanes,
  type EditableField,
  type Issue,
  type IssueLinkType,
  type IssueSearchResult,
  type IssueType,
  type Transition,
  type EditableFieldValue,
  assignIssueToMe,
  createIssue,
  getAssignableUsers,
  getBoardConfig,
  getBoardSwimlanes,
  getCreateFields,
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
  type LaneColumn,
  type SwimCursor,
  buildColumns,
  buildLanes,
  findCursor,
  moveCursor,
  reconcileCursor,
  snapToCard,
} from "../swimlanes";
import { clamp, copyToClipboard, errorMessage, openInBrowser, stickyScroll, theme } from "../ui";
import { BoardHeader } from "./BoardHeader";
import { createBoardUsersLoader, waitForMentionWarningDisplay } from "./boardUsers";
import { CreateWizard } from "./CreateWizard";
import { ErrorMessage } from "./ErrorMessage";
import { FilterPicker } from "./FilterPicker";
import { FilterPickerModal } from "./FilterPickerModal";
import { Footer, footerRowCount } from "./Footer";
import { HelpModal } from "./HelpModal";
import { Hint } from "./Hint";
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
import { ToastStack, toastRowCount, useToasts } from "./Toasts";
import { TransitionScreenModal } from "./TransitionScreenModal";

type Board = { id: number; name: string };

type Props = {
  cfg: JiraConfig;
  board: Board;
  maxColumns: number;
  onExit: () => void;
};

type DetailReturn = { kind: "board" } | { kind: "detail"; issueKey: string };
type MovePickerReturn = {
  kind: "move-picker";
  issue: Issue;
  returnTo: DetailReturn;
  busy?: boolean | undefined;
  error?: string | undefined;
  drafts?: Record<string, Record<string, EditableFieldValue>> | undefined;
};
type TransitionPickerReturn = {
  kind: "transition-picker";
  transitions: Transition[];
  issueKey: string;
  projectKey: string;
  returnTo: DetailReturn;
  drafts?: Record<string, Record<string, EditableFieldValue>> | undefined;
};
type Modal =
  | { kind: "none" }
  | { kind: "help" }
  | { kind: "search" }
  | { kind: "card-action"; issue: Issue }
  | MovePickerReturn
  | TransitionPickerReturn
  | {
      kind: "transition-screen";
      transition: Transition;
      issueKey: string;
      projectKey: string;
      targetColIdx?: number;
      returnTo: DetailReturn | TransitionPickerReturn | MovePickerReturn;
      initialValues?: Record<string, EditableFieldValue> | undefined;
      busy?: boolean | undefined;
      error?: string | undefined;
    }
  | { kind: "filter-menu" }
  | { kind: "filter-assignee"; names: string[] }
  | { kind: "filter-type"; types: string[] }
  | { kind: "filter-sprint"; sprints: string[] }
  | { kind: "filter-label"; labels: string[] }
  | { kind: "filter-epic"; epics: string[] }
  | {
      kind: "create";
      projectKey: string;
      types: IssueType[];
      linkTypes: IssueLinkType[];
      parent?: IssueSearchResult;
      initialType?: IssueType;
      returnTo: DetailReturn;
    }
  | {
      kind: "quick-add";
      colIdx: number;
      type: IssueType;
      value: string;
      busy?: boolean | undefined;
      error?: string | undefined;
    }
  | { kind: "detail"; issueKey: string }
  | {
      kind: "title-edit";
      issueKey: string;
      original: string;
      current: string;
      busy?: boolean | undefined;
      error?: string | undefined;
    }
  | {
      kind: "description-save";
      issue: Issue;
      draft: string;
      busy: boolean;
      error?: string | undefined;
    }
  | { kind: "nvim"; warning?: string | undefined }
  | { kind: "quick-open" }
  | { kind: "jql" };

function retainedDetailKey(modal: Modal): string | null {
  if (modal.kind === "detail") return modal.issueKey;
  if (
    modal.kind === "move-picker" ||
    modal.kind === "transition-picker" ||
    modal.kind === "transition-screen" ||
    modal.kind === "create"
  ) {
    return detailKeyFromReturn(modal.returnTo);
  }
  return null;
}

function isTransitionScreen(modal: Modal, issueKey: string, transitionId: string): boolean {
  return (
    modal.kind === "transition-screen" &&
    modal.issueKey === issueKey &&
    modal.transition.id === transitionId
  );
}

type Filters = {
  assignee: string | null;
  type: string | null;
  sprint: string | null;
  label: string | null;
  epic: string | null;
};

function detailKeyFromReturn(
  target: DetailReturn | TransitionPickerReturn | MovePickerReturn,
): string | null {
  if (target.kind === "detail") return target.issueKey;
  if (target.kind === "board") return null;
  return detailKeyFromReturn(target.returnTo);
}

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

function DescriptionSaveModal({
  issueKey,
  busy,
  error,
  onRetry,
  onEdit,
  onCancel,
}: {
  issueKey: string;
  busy: boolean;
  error?: string | undefined;
  onRetry: () => void;
  onEdit: () => void;
  onCancel: () => void;
}) {
  const { cols } = useDimensions();
  useInput((input, key) => {
    if (busy) return;
    if (key.escape) onCancel();
    else if (key.return) onRetry();
    else if (input === "E") onEdit();
  });
  return (
    <Box flexDirection="column" padding={2} borderStyle="round" borderColor={theme.accent}>
      <Text color={theme.accent} bold>
        Description · {issueKey}
      </Text>
      {busy ? <LoadingLine label="Saving description…" /> : null}
      {error ? <ErrorMessage message={error} width={Math.max(1, cols - 6)} /> : null}
      {!busy ? (
        <Box marginTop={1}>
          <Hint k="⏎" label="retry save" />
          <Hint k="E" label="edit draft" />
          <Hint k="esc" label="board" />
        </Box>
      ) : null}
    </Box>
  );
}

function needsMoreThanTitle(fields: EditableField[]): boolean {
  return fields.some(
    (field) =>
      field.required &&
      !field.hasDefaultValue &&
      field.id !== "project" &&
      field.id !== "issuetype" &&
      field.id !== "summary",
  );
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

function findMatches(columns: LaneColumn[], query: string): CellRef[] {
  if (!query.trim()) return [];
  const normalized = query.trim().toLowerCase();
  const matches: CellRef[] = [];
  columns.forEach((column, col) => {
    column.issues.forEach((issue, row) => {
      if (issueMatches(issue, normalized)) matches.push({ col, row });
    });
  });
  return matches;
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
  const [selectedIssueKey, setSelectedIssueKey] = useState<string | null>(null);
  const activeColRef = useRef(activeCol);
  const activeRowsRef = useRef(activeRows);
  activeColRef.current = activeCol;
  activeRowsRef.current = activeRows;
  const scrollsRef = useRef<number[]>([]);

  // Swimlane view. Off by default (flat board); toggled with `s` only when
  // the board actually has swimlanes. Has its own {lane,col,row} cursor and
  // sticky scroll anchor, distinct from the flat board's per-column state.
  const [swimView, setSwimView] = useState(false);
  const [swimCursor, setSwimCursor] = useState<SwimCursor>({ lane: 0, col: 0, row: 0 });
  const swimViewRef = useRef(swimView);
  const swimCursorRef = useRef(swimCursor);
  swimViewRef.current = swimView;
  swimCursorRef.current = swimCursor;
  const swimScrollRef = useRef(0);

  // UI state
  const { toasts, flash, dismiss } = useToasts();
  // Background-work indicator. `track` wraps any async load so the thin
  // progress line under the header animates while it's in flight — reloads,
  // the swimlane fetch, and one-off actions that don't own a modal spinner.
  const { busy, track } = useLoading();
  const [query, setQuery] = useState("");
  const [matchIdx, setMatchIdx] = useState(0);
  const queryRef = useRef(query);
  const matchIdxRef = useRef(matchIdx);
  queryRef.current = query;
  matchIdxRef.current = matchIdx;
  const [modal, setModal] = useState<Modal>({ kind: "none" });
  const modalRef = useRef<Modal>(modal);
  modalRef.current = modal;
  const modalLaunchSeq = useRef(0);
  const modalSubmitPending = useRef(false);
  const descriptionDrafts = useRef(new Map<string, string>());
  const descriptionWrites = useRef(new Set<string>());
  const [searchBuffer, setSearchBuffer] = useState("");
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);

  type BoardMeta = { types: IssueType[]; linkTypes: IssueLinkType[] };
  const metaCache = useRef<{ projectKey: string; value: Promise<BoardMeta> } | null>(null);
  // Assignable-users cache for @-completion in the editor, shared across every
  // edit path that shells out on this board — including the detail modal, which
  // takes `ensureUsers` as a prop rather than fetching its own copy.
  const usersLoader = useMemo(
    () => createBoardUsersLoader((projectKey) => getAssignableUsers(cfg, projectKey)),
    [cfg],
  );
  // First load is fatal; reload failures just flash a toast.
  const hasLoadedOnce = useRef(false);
  // After a transition, follow the moved card to its new column on reload.
  const pendingFocus = useRef<{ key: string; afterVersion: number } | null>(null);
  const boardDataVersion = useRef(0);
  const [recents, setRecents] = useState<RecentIssue[]>([]);
  const recentsTouched = useRef(false);
  const recentsLoaded = useRef(false);
  const loadSeq = useRef(0);
  const activeRef = useRef(false);
  const reloading = useRef(false);
  const reloadAgain = useRef(false);
  const reloadPromise = useRef<Promise<void> | null>(null);
  const dispose = useCallback(() => {
    activeRef.current = false;
    loadSeq.current++;
    modalLaunchSeq.current++;
    reloadAgain.current = false;
  }, []);

  // Push a card to the front of the MRU recents list (deduped, capped at 20)
  // and persist it, so quick-open (`R`) starts populated across sessions.
  // Called both when opening a card's detail and after any successful
  // operation on it — anything you touch is "recent". Reads the summary from
  // whatever's currently loaded, falling back to the key.
  const touchRecent = useCallback(
    (key: string, summaryOverride?: string) => {
      recentsTouched.current = true;
      setRecents((prev) => {
        // Prefer an explicit summary (freshly-created cards aren't in `issues`
        // yet), then the loaded card, then a prior recents entry, then the key.
        const summary =
          summaryOverride ??
          issues.find((i) => i.key === key)?.summary ??
          prev.find((r) => r.key === key)?.summary ??
          key;
        const next = [{ key, summary }, ...prev.filter((r) => r.key !== key)].slice(0, 20);
        if (recentsLoaded.current) void writeRecents(cfg, board.id, next);
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
  const rejectPending = useCallback(
    (issue: Issue): boolean => {
      if (!pendingKeys.has(issue.key)) return false;
      flash(`${issue.key} is updating…`, "info");
      return true;
    },
    [pendingKeys, flash],
  );

  const setActiveColumn = useCallback((col: number) => {
    activeColRef.current = col;
    setActiveCol(col);
  }, []);
  const setSwimPosition = useCallback((cursor: SwimCursor) => {
    swimCursorRef.current = cursor;
    setSwimCursor(cursor);
  }, []);
  const setActiveRowAt = useCallback((col: number, row: number) => {
    const arr = activeRowsRef.current.slice();
    arr[col] = row;
    activeRowsRef.current = arr;
    setActiveRows(arr);
  }, []);
  const showModal = useCallback((next: Modal) => {
    modalLaunchSeq.current++;
    setModal(next);
  }, []);
  const closeModal = useCallback(() => showModal({ kind: "none" }), [showModal]);
  const restore = useCallback(
    (target: DetailReturn | TransitionPickerReturn | MovePickerReturn) => {
      showModal(target.kind === "board" ? { kind: "none" } : target);
    },
    [showModal],
  );

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
    boardDataVersion.current++;
    setConf(c);
    setIssues(is);
    const rows = c.columns.map((_, i) => activeRowsRef.current[i] ?? 0);
    activeRowsRef.current = rows;
    setActiveRows(rows);
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
    if (!activeRef.current) return;
    const seq = ++loadSeq.current;
    const isCurrent = () => activeRef.current && seq === loadSeq.current;
    setLoadError(null);
    if (!hasLoadedOnce.current) {
      const cached = await readBoardCache(cfg, board.id);
      if (!isCurrent()) return;
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
          const c = await getBoardConfig(cfg, board.id);
          if (!isCurrent()) return;
          const is = await getBoardIssues(cfg, board.id, c.estimationFieldId);
          if (!isCurrent()) return;
          applyBoardData(c, is);
          hasLoadedOnce.current = true;
          void writeBoardCache(cfg, board.id, c, is);
          // Swimlane layout comes from a separate (internal) endpoint and needs
          // the issue id→key map to resolve custom-lane membership. Non-fatal:
          // it self-degrades to strategy "none", so the flat board is
          // unaffected if it fails.
          const idToKey = new Map(is.map((i) => [i.id, i.key]));
          const nextSwimlanes = await getBoardSwimlanes(cfg, board.id, idToKey);
          if (isCurrent()) setSwimlanes(nextSwimlanes);
        })(),
      );
    } catch (e) {
      if (!isCurrent()) return;
      const msg = errorMessage(e);
      if (hasLoadedOnce.current) flash(msg, "err");
      else setLoadError(msg);
    }
  }, [cfg, board.id, flash, applyBoardData, track]);

  useEffect(() => {
    activeRef.current = true;
    void load();
    return dispose;
  }, [load, dispose]);

  // Load persisted quick-open recents once per board.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const saved = await readRecents(cfg, board.id);
      if (cancelled) return;
      setRecents((current) => {
        const currentKeys = new Set(current.map((recent) => recent.key));
        const merged = [
          ...current,
          ...saved.filter((recent) => !currentKeys.has(recent.key)),
        ].slice(0, 20);
        recentsLoaded.current = true;
        if (recentsTouched.current) void writeRecents(cfg, board.id, merged);
        return merged;
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [cfg, board.id]);

  /**
   * Coalesced background reload. Rapid optimistic moves would otherwise each
   * fire a full board refetch; instead, if a reload is already running a caller
   * sets a "rerun once more when you're done" flag and joins it, so a burst
   * of N moves collapses to at most one in-flight reload plus one trailing
   * catch-up — never N stacked refetches, and it always ends on fresh data.
   * All callers wait through the trailing reload before releasing their card's
   * busy state.
   */
  const coalescedReload = useCallback(async () => {
    if (!activeRef.current) return;
    if (reloading.current) {
      reloadAgain.current = true;
      return reloadPromise.current;
    }
    reloading.current = true;
    const pending = (async () => {
      try {
        do {
          reloadAgain.current = false;
          await load();
        } while (activeRef.current && reloadAgain.current);
      } finally {
        reloading.current = false;
        reloadPromise.current = null;
      }
    })();
    reloadPromise.current = pending;
    return pending;
  }, [load]);

  /**
   * While the search bar is open, highlights should track what the user is
   * typing. Otherwise they track the committed query.
   */
  const liveQuery = modal.kind === "search" ? searchBuffer : query;
  const matches = useMemo(() => {
    return findMatches(columns, liveQuery);
  }, [columns, liveQuery]);

  const matchSet = useMemo(() => new Set(matches.map((m) => `${m.col}:${m.row}`)), [matches]);
  // The swimlane grid highlights matches by issue key (its cells aren't the
  // flat board's col:row). Same query, keyed differently.
  const swimMatchSet = useMemo(() => {
    if (!liveQuery.trim()) return new Set<string>();
    const q = liveQuery.trim().toLowerCase();
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
      if (swimViewRef.current) {
        const key = columns[m.col]?.issues[m.row]?.key;
        const sc = key ? findCursor(lanes, key) : null;
        if (sc) {
          setSwimPosition(sc);
          setSelectedIssueKey(key ?? null);
        }
        return;
      }
      setActiveColumn(m.col);
      setActiveRowAt(m.col, m.row);
      setSelectedIssueKey(columns[m.col]?.issues[m.row]?.key ?? null);
    },
    [columns, lanes, setActiveColumn, setActiveRowAt, setSwimPosition],
  );

  const commitQuery = useCallback(
    (q: string) => {
      const submittedMatches = findMatches(columns, q);
      queryRef.current = q;
      setQuery(q);
      matchIdxRef.current = 0;
      setMatchIdx(0);
      if (!q.trim()) return;
      const first = submittedMatches[0];
      if (first) focusMatch(first);
      else flash("No matches.", "info");
    },
    [columns, flash, focusMatch],
  );

  const jumpToMatch = useCallback(
    (delta: number) => {
      const currentMatches = findMatches(columns, queryRef.current);
      if (currentMatches.length === 0) {
        flash(queryRef.current.trim() ? "No matches." : "No active highlight.", "info");
        return;
      }
      const next =
        (((matchIdxRef.current + delta) % currentMatches.length) + currentMatches.length) %
        currentMatches.length;
      matchIdxRef.current = next;
      setMatchIdx(next);
      focusMatch(currentMatches[next]!);
    },
    [columns, flash, focusMatch],
  );

  // Layout math — columns beyond `maxColumns` require ←/→ paging. Header +
  // progress + grid + footer sum to termRows-1, leaving one free row that fits
  // a single toast. The board box is a fixed termRows tall, so a *stack* of
  // toasts would overflow and Ink would clip all but the first — the grid
  // yields a row for each toast beyond the first. One toast (the common case)
  // costs nothing; the shrink is transient and reverts when they clear.
  const footerRows = footerRowCount(termCols, modal.kind === "search" ? "search" : "normal", {
    hasIssue: displayIssues.length > 0,
    filterCount: activeFilterCount(filters),
    hasSwimlanes,
    swimActive: swimView,
    query,
    matches: matches.length,
    matchIdx,
  });
  const toastRows = toastRowCount(toasts, termCols, true);
  const columnHeight = Math.max(9, termRows - 3 - footerRows - toastRows);
  // Each card uses three content rows plus one margin row. Inside the column
  // border, reserve one row for the header and up to two scroll indicators.
  const columnInnerHeight = columnHeight - 2;
  const cardsVisible = Math.max(1, Math.floor((columnInnerHeight - 3) / 4));
  // The swimlane grid draws single-line rows in this many terminal lines (the
  // SwimlaneHeader + divider take 2 of the columnHeight rows). PageUp/Down in
  // swim view pages by this, not `cardsVisible` (which is a flat rich-card
  // count and would under-page badly).
  const swimVisibleRows = Math.max(3, columnHeight - 2);

  const gap = 1;
  const arrowChannel = 2;
  const gridWidth = termCols - arrowChannel * 2;
  const widthBound = Math.max(1, Math.floor((gridWidth + gap) / (18 + gap)));
  const visibleColCount = Math.min(maxColumns, widthBound, columns.length);
  const estimateDisplay = conf?.estimationFieldId === "timeoriginalestimate" ? "time" : "points";
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
   * past the last card. The active column is also clamped when a refreshed
   * board configuration changes the column count.
   */
  useEffect(() => {
    setActiveColumn(clamp(activeColRef.current, 0, Math.max(0, columns.length - 1)));
    if (columns.length === 0) return;
    let changed = false;
    const rows = activeRowsRef.current.slice();
    columns.forEach((column, index) => {
      const max = Math.max(0, column.issues.length - 1);
      const current = rows[index] ?? 0;
      if (current > max) {
        rows[index] = max;
        changed = true;
      }
    });
    if (changed) {
      activeRowsRef.current = rows;
      setActiveRows(rows);
    }
  }, [columns, setActiveColumn]);

  /**
   * Keep the swimlane cursor in bounds when lanes change under it (filter
   * toggle, reload, or a card leaving a now-empty lane that gets dropped).
   * Clamps lane → col → row in order; snapping to the nearest valid cell.
   */
  useEffect(() => {
    if (!swimView || lanes.length === 0) return;
    setSwimPosition(reconcileCursor(lanes, swimCursorRef.current));
  }, [lanes, swimView, setSwimPosition]);

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
  const currentIssueNow = useCallback((): Issue | null => {
    if (swimViewRef.current) {
      const cursor = swimCursorRef.current;
      return lanes[cursor.lane]?.columns[cursor.col]?.issues[cursor.row] ?? null;
    }
    const col = activeColRef.current;
    return columns[col]?.issues[activeRowsRef.current[col] ?? 0] ?? null;
  }, [columns, lanes]);

  useLayoutEffect(() => {
    if (displayIssues.length === 0) {
      setSelectedIssueKey(null);
      return;
    }
    if (selectedIssueKey) {
      if (swimViewRef.current) {
        const cursor = findCursor(lanes, selectedIssueKey);
        if (cursor) {
          setSwimPosition(cursor);
          return;
        }
      } else {
        for (let col = 0; col < columns.length; col++) {
          const row = columns[col]!.issues.findIndex((issue) => issue.key === selectedIssueKey);
          if (row >= 0) {
            setActiveColumn(col);
            setActiveRowAt(col, row);
            return;
          }
        }
      }
    }
    if (currentIssue) setSelectedIssueKey(currentIssue.key);
  }, [
    columns,
    lanes,
    displayIssues.length,
    swimView,
    selectedIssueKey,
    currentIssue,
    setActiveColumn,
    setActiveRowAt,
    setSwimPosition,
  ]);

  const projectForIssue = useCallback(
    (issueKey: string): string =>
      issues.find((issue) => issue.key === issueKey)?.projectKey ||
      issueKey.split("-")[0] ||
      conf?.projectKey ||
      "",
    [issues, conf],
  );

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
      opts: {
        targetColIdx?: number;
        fields?: Record<string, EditableFieldValue>;
        projectKey?: string;
        returnTo?: DetailReturn | TransitionPickerReturn | MovePickerReturn;
        initialValues?: Record<string, EditableFieldValue>;
        onError?: (message: string) => void;
      } = {},
    ): Promise<boolean> => {
      if (transition.requiredFields.length > 0 && !opts.fields) {
        showModal({
          kind: "transition-screen",
          transition,
          issueKey,
          projectKey: opts.projectKey || projectForIssue(issueKey),
          returnTo: opts.returnTo ?? { kind: "board" },
          initialValues: opts.initialValues,
          ...(opts.targetColIdx !== undefined ? { targetColIdx: opts.targetColIdx } : {}),
        });
        return false;
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
      const sourceColIdx = conf?.columns.findIndex((column) =>
        column.statusIds.includes(from ?? ""),
      );
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
        setActiveColumn(opts.targetColIdx);
        setSwimPosition({ ...swimCursorRef.current, col: opts.targetColIdx });
        setSelectedIssueKey(issueKey);
      }
      try {
        await transitionIssue(cfg, issueKey, transition.id, opts.fields);
        pendingFocus.current = { key: issueKey, afterVersion: boardDataVersion.current + 1 };
        flash(`${issueKey} → ${transition.name}`, "ok");
        touchRecent(issueKey);
        await coalescedReload();
        return true;
      } catch (e) {
        if (optimistic) {
          clearPending(issueKey);
          if (sourceColIdx !== undefined && sourceColIdx >= 0) {
            setActiveColumn(sourceColIdx);
            setSwimPosition({ ...swimCursorRef.current, col: sourceColIdx });
          }
        }
        if (pendingFocus.current?.key === issueKey) pendingFocus.current = null;
        const message = errorMessage(e);
        if (opts.onError) opts.onError(message);
        else flash(message, "err");
        return false;
      } finally {
        if (!optimistic) markBusy(issueKey, false);
      }
    },
    [
      cfg,
      conf,
      issues,
      flash,
      coalescedReload,
      markBusy,
      startPending,
      clearPending,
      touchRecent,
      projectForIssue,
      showModal,
      setActiveColumn,
      setSwimPosition,
    ],
  );

  const moveToColumn = useCallback(
    async (
      targetColIdx: number,
      issueOverride?: Issue,
      launchSeq?: number,
      returnTo: DetailReturn | MovePickerReturn = { kind: "board" },
      feedback?: {
        onReady?: (transition: Transition) => void;
        onError?: (message: string) => void;
      },
    ) => {
      const issue = issueOverride ?? currentIssueNow();
      if (!issue || !conf) return;
      if (targetColIdx < 0 || targetColIdx >= conf.columns.length) return;
      // Per-card guard (not a global lock): a card already settling can't be
      // re-moved, but other cards move freely and concurrently. That's what
      // makes fast multi-card moves work without stacking transitions on one
      // card or racing its focus snap.
      if (rejectPending(issue)) return;
      // markBusy covers the transition-lookup phase, before the optimistic
      // overlay exists; commitTransition's startPending takes over as the
      // pending signal the moment we POST.
      markBusy(issue.key, true);
      const targetCol = conf.columns[targetColIdx]!;
      try {
        const trs = await getTransitions(cfg, issue.key);
        if (launchSeq !== undefined && launchSeq !== modalLaunchSeq.current) return;
        const candidates = trs.filter((t) => targetCol.statusIds.includes(t.toStatusId));
        if (candidates.length === 0) {
          const message = `No transition to ${targetCol.name}.`;
          if (feedback?.onError) feedback.onError(message);
          else flash(message, "err");
          return;
        }
        // Moving a card to a column should feel like a drag-and-drop, not a
        // quiz: don't stop to ask which transition when several land in the
        // same column. Auto-pick one — preferring a path with no required-
        // fields screen so the move stays frictionless — and let
        // commitTransition surface the screen only if that's the only path.
        const chosen = candidates.find((t) => t.requiredFields.length === 0) ?? candidates[0]!;
        feedback?.onReady?.(chosen);
        await commitTransition(issue.key, chosen, {
          targetColIdx,
          projectKey: issue.projectKey || projectForIssue(issue.key),
          returnTo,
          ...(returnTo.kind === "move-picker" && returnTo.drafts?.[chosen.id]
            ? { initialValues: returnTo.drafts[chosen.id] }
            : {}),
        });
      } catch (e) {
        if (launchSeq === undefined || launchSeq === modalLaunchSeq.current) {
          const message = errorMessage(e);
          if (feedback?.onError) feedback.onError(message);
          else flash(message, "err");
        }
      } finally {
        // Release the lookup-phase flag. On the POST path the overlay is now
        // the pending signal (dropped by reconcile); on the no-candidate,
        // required-fields-screen, or error paths this is the only flag to
        // clear, so the card doesn't stay stuck.
        markBusy(issue.key, false);
      }
    },
    [currentIssueNow, conf, cfg, flash, commitTransition, markBusy, projectForIssue, rejectPending],
  );

  /**
   * After a reload, snap the cursor to wherever the tracked card ended up —
   * activeRows for the flat board, and the {lane,col,row} cursor for the
   * swimlane view (a transition can move a card between lanes too). Only
   * clear the marker once we actually find the card — pre-reload column
   * changes (e.g. toggling a filter mid-flight) shouldn't consume it.
   */
  useEffect(() => {
    const request = pendingFocus.current;
    if (!request || boardDataVersion.current < request.afterVersion) return;
    const { key } = request;
    if (swimView) {
      const sc = findCursor(lanes, key);
      if (sc) {
        setSwimPosition(sc);
        pendingFocus.current = null;
      }
      return;
    }
    for (let ci = 0; ci < columns.length; ci++) {
      const col = columns[ci]!;
      const ri = col.issues.findIndex((i) => i.key === key);
      if (ri !== -1) {
        setActiveColumn(ci);
        setActiveRowAt(ci, ri);
        setSelectedIssueKey(key);
        pendingFocus.current = null;
        return;
      }
    }
  }, [columns, lanes, swimView, setActiveColumn, setActiveRowAt, setSwimPosition]);

  const doTransition = useCallback(
    async (direction: 1 | -1) => {
      if (!conf) return;
      const sourceCol = swimViewRef.current ? swimCursorRef.current.col : activeColRef.current;
      const targetColIdx = sourceCol + direction;
      if (targetColIdx < 0 || targetColIdx >= conf.columns.length) {
        flash("No column in that direction.", "info");
        return;
      }
      await moveToColumn(targetColIdx);
    },
    [conf, flash, moveToColumn],
  );

  const doEditSummary = useCallback(
    (issueOverride?: Issue) => {
      const issue = issueOverride ?? currentIssueNow();
      if (!issue) return;
      showModal({
        kind: "title-edit",
        issueKey: issue.key,
        original: issue.summary,
        current: issue.summary,
      });
    },
    [currentIssueNow, showModal],
  );

  // Pre-warm the assignable-users list as soon as the board's project is
  // known, so the first `@`-mention edit opens the editor instantly instead of
  // blocking on this fetch behind the "editing…" banner. Cached by project,
  // so the edit paths (board + detail modal) reuse it. Fire-and-forget.
  useEffect(() => {
    if (conf?.projectKey) void usersLoader(conf.projectKey);
  }, [conf, usersLoader]);

  const saveBoardDescription = useCallback(
    async (issue: Issue, draft: string) => {
      if (descriptionWrites.current.has(issue.key)) return;
      descriptionWrites.current.add(issue.key);
      try {
        await updateDescription(cfg, issue.key, draft);
        descriptionDrafts.current.delete(issue.key);
        if (!activeRef.current) return;
        flash(`${issue.key} description updated.`, "ok");
        touchRecent(issue.key);
        if (
          modalRef.current.kind === "description-save" &&
          modalRef.current.issue.key === issue.key &&
          modalRef.current.draft === draft
        )
          closeModal();
        await load();
      } catch (error) {
        if (!activeRef.current) return;
        const message = `Description not saved: ${errorMessage(error)}. Your draft is kept.`;
        if (
          modalRef.current.kind === "description-save" &&
          modalRef.current.issue.key === issue.key &&
          modalRef.current.draft === draft
        )
          setModal({
            kind: "description-save",
            issue,
            draft,
            busy: false,
            error: message,
          });
        else flash(message, "err");
      } finally {
        descriptionWrites.current.delete(issue.key);
      }
    },
    [cfg, flash, touchRecent, closeModal, load],
  );

  const doEditDescription = useCallback(
    async (issueOverride?: Issue) => {
      const issue = issueOverride ?? currentIssueNow();
      if (!issue) return;
      showModal({ kind: "nvim" });
      const launchSeq = modalLaunchSeq.current;
      try {
        const mention = await usersLoader(issue.projectKey || projectForIssue(issue.key));
        if (launchSeq !== modalLaunchSeq.current) return;
        if (mention.warning) {
          setModal({ kind: "nvim", warning: mention.warning });
          await waitForMentionWarningDisplay(mention);
          if (launchSeq !== modalLaunchSeq.current) return;
        }
        const raw = await editInNeovim(
          descriptionDrafts.current.get(issue.key) ?? issue.description,
          `${issue.key}-desc.md`,
          {
            mentionUsers: mention.users,
          },
        );
        if (launchSeq !== modalLaunchSeq.current) return;
        if (mention.warning) flash(mention.warning, "info");
        if (raw.trim() === issue.description.trim()) {
          descriptionDrafts.current.delete(issue.key);
          flash("No description change.", "info");
          closeModal();
          return;
        }
        descriptionDrafts.current.set(issue.key, raw);
        showModal({ kind: "description-save", issue, draft: raw, busy: true });
        void saveBoardDescription(issue, raw);
      } catch (error) {
        if (launchSeq !== modalLaunchSeq.current) return;
        closeModal();
        const retry = descriptionDrafts.current.has(issue.key)
          ? " Press E to edit your draft."
          : "";
        flash(`Description not saved: ${errorMessage(error)}.${retry}`, "err");
      }
    },
    [
      currentIssueNow,
      flash,
      usersLoader,
      projectForIssue,
      showModal,
      closeModal,
      saveBoardDescription,
    ],
  );

  const doAssignToMe = useCallback(
    async (issueOverride?: Issue) => {
      const issue = issueOverride ?? currentIssueNow();
      if (!issue) {
        flash("No issue selected.", "info");
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
    },
    [currentIssueNow, cfg, flash, load, track, touchRecent],
  );

  const doFuzzyTransition = useCallback(
    async (issueOverride?: Issue) => {
      const issue = issueOverride ?? currentIssueNow();
      if (!issue) {
        flash("No issue selected.", "info");
        return;
      }
      const launchSeq = ++modalLaunchSeq.current;
      try {
        const trs = await track(getTransitions(cfg, issue.key));
        if (launchSeq !== modalLaunchSeq.current) return;
        if (trs.length === 0) {
          flash("No workflow transitions are available.", "info");
          return;
        }
        showModal({
          kind: "transition-picker",
          transitions: trs,
          issueKey: issue.key,
          projectKey: issue.projectKey || projectForIssue(issue.key),
          returnTo: { kind: "board" },
        });
      } catch (e) {
        if (launchSeq !== modalLaunchSeq.current) return;
        flash(errorMessage(e), "err");
      }
    },
    [currentIssueNow, cfg, flash, track, projectForIssue, showModal],
  );

  const doRerank = useCallback(
    async (direction: -1 | 1) => {
      // Rerank relative to the visual neighbor in the same column. In swim
      // view that's within the current lane's column; on the flat board it's
      // the active column. Reordering is global rank, so the neighbor's key
      // is all Jira needs.
      const cursor = swimCursorRef.current;
      const col = swimViewRef.current
        ? lanes[cursor.lane]?.columns[cursor.col]
        : columns[activeColRef.current];
      const row = swimViewRef.current
        ? cursor.row
        : (activeRowsRef.current[activeColRef.current] ?? 0);
      if (!col) return;
      const issue = col.issues[row];
      if (!issue) return;
      const targetRow = row + direction;
      if (targetRow < 0 || targetRow >= col.issues.length) {
        flash("Already at the edge.", "info");
        return;
      }
      const neighbor = col.issues[targetRow]!;
      if (rejectPending(issue)) return;
      markBusy(issue.key, true);
      try {
        await rankIssue(
          cfg,
          issue.key,
          direction === -1 ? { before: neighbor.key } : { after: neighbor.key },
        );
        pendingFocus.current = { key: issue.key, afterVersion: boardDataVersion.current + 1 };
        flash(`${issue.key} reranked ${direction === -1 ? "up" : "down"}`, "ok");
        touchRecent(issue.key);
        await coalescedReload();
      } catch (e) {
        flash(errorMessage(e), "err");
      } finally {
        markBusy(issue.key, false);
      }
    },
    [lanes, columns, cfg, flash, coalescedReload, markBusy, rejectPending, touchRecent],
  );

  const openDetailForKey = useCallback(
    (key: string, summary?: string) => {
      touchRecent(key, summary);
      showModal({ kind: "detail", issueKey: key });
    },
    [touchRecent, showModal],
  );

  const openDetail = useCallback(() => {
    const issue = currentIssueNow();
    if (!issue) {
      flash("No issue selected.", "info");
      return;
    }
    openDetailForKey(issue.key);
  }, [currentIssueNow, flash, openDetailForKey]);

  const openIssueInBrowser = useCallback(
    async (issueOverride?: Issue) => {
      const issue = issueOverride ?? currentIssueNow();
      if (!issue) {
        flash("No issue selected.", "info");
        return;
      }
      try {
        await openInBrowser(`${cfg.server}/browse/${issue.key}`);
        flash(`opened ${issue.key} in browser`, "ok");
      } catch (e) {
        flash(errorMessage(e), "err");
      }
    },
    [currentIssueNow, cfg.server, flash],
  );

  const openBoardInBrowser = useCallback(async () => {
    if (!conf) return;
    try {
      const path = conf.projectKey
        ? `/jira/software/projects/${conf.projectKey}/boards/${board.id}`
        : `/secure/RapidBoard.jspa?rapidView=${board.id}`;
      await openInBrowser(`${cfg.server}${path}`);
      flash(`opened board in browser`, "ok");
    } catch (e) {
      flash(errorMessage(e), "err");
    }
  }, [cfg.server, conf, board.id, flash]);

  /** Cache one project's issue-type and link-type catalog at a time. Detail
   * views on multi-project boards can replace it with the issue's project. */
  const ensureMeta = useCallback(
    async (
      projectKey: string,
    ): Promise<{
      types: IssueType[];
      linkTypes: IssueLinkType[];
    }> => {
      if (!projectKey) throw new Error("no project selected — can't create issues here");
      if (metaCache.current?.projectKey !== projectKey) {
        const value = track(
          Promise.all([getIssueTypes(cfg, projectKey), getIssueLinkTypes(cfg)]).then(
            ([types, linkTypes]) => ({ types, linkTypes }),
          ),
        );
        metaCache.current = { projectKey, value };
      }
      const entry = metaCache.current;
      try {
        const value = await entry.value;
        return value;
      } catch (error) {
        if (metaCache.current === entry) metaCache.current = null;
        throw error;
      }
    },
    [cfg, track],
  );

  const startCreate = useCallback(async () => {
    if (!conf) return;
    const launchSeq = ++modalLaunchSeq.current;
    try {
      if (!conf.projectKey) throw new Error("no project on this board — can't create issues here");
      const { types: allTypes, linkTypes } = await ensureMeta(conf.projectKey);
      if (launchSeq !== modalLaunchSeq.current) return;
      const types = allTypes.filter((type) => !type.subtask);
      if (types.length === 0) {
        flash("No creatable issue types.", "err");
        return;
      }
      showModal({
        kind: "create",
        projectKey: conf.projectKey,
        types,
        linkTypes,
        returnTo: { kind: "board" },
      });
    } catch (e) {
      if (launchSeq !== modalLaunchSeq.current) return;
      flash(errorMessage(e), "err");
    }
  }, [conf, ensureMeta, flash, showModal]);

  /**
   * Quick-add is `c` minus the wizard — just a title, landing in whatever
   * column the cursor was on. Type defaults to the first non-subtask Jira
   * returns (typically Story/Task). `colIdx` is captured at open-time so
   * the user can move the cursor while typing without the target drifting.
   */
  const startQuickAdd = useCallback(async () => {
    if (!conf) return;
    const targetColIdx = swimViewRef.current ? swimCursorRef.current.col : activeColRef.current;
    const launchSeq = ++modalLaunchSeq.current;
    try {
      if (!conf.projectKey) throw new Error("no project on this board — can't create issues here");
      const { types: allTypes, linkTypes } = await ensureMeta(conf.projectKey);
      if (launchSeq !== modalLaunchSeq.current) return;
      const types = allTypes.filter((type) => !type.subtask);
      const defaultType = types[0];
      if (!defaultType) {
        flash("No creatable issue types.", "err");
        return;
      }
      const fields = await getCreateFields(cfg, conf.projectKey, defaultType.id);
      if (launchSeq !== modalLaunchSeq.current) return;
      if (needsMoreThanTitle(fields)) {
        showModal({
          kind: "create",
          projectKey: conf.projectKey,
          types,
          linkTypes,
          initialType: defaultType,
          returnTo: { kind: "board" },
        });
        flash("This issue type has more required fields. Opened full create.", "info");
        return;
      }
      showModal({ kind: "quick-add", colIdx: targetColIdx, type: defaultType, value: "" });
    } catch (e) {
      if (launchSeq !== modalLaunchSeq.current) return;
      flash(errorMessage(e), "err");
    }
  }, [cfg, conf, ensureMeta, flash, showModal]);

  const submitQuickAdd = useCallback(
    async (colIdx: number, type: IssueType, title: string) => {
      if (!conf) return;
      if (modalSubmitPending.current) return;
      const trimmed = title.trim();
      if (!trimmed) {
        setModal((current) =>
          current.kind === "quick-add"
            ? { ...current, error: "Title is required. Enter a title or press esc to cancel." }
            : current,
        );
        return;
      }
      const targetCol = conf.columns[colIdx];
      if (!targetCol) {
        closeModal();
        return;
      }
      setModal((current) =>
        current.kind === "quick-add" ? { ...current, busy: true, error: undefined } : current,
      );
      modalSubmitPending.current = true;
      let created: { key: string };
      try {
        created = await createIssue(cfg, conf.projectKey, type.id, trimmed, "");
      } catch (e) {
        const reason = errorMessage(e);
        setModal((current) =>
          current.kind === "quick-add"
            ? { ...current, busy: false, error: `Could not create issue: ${reason}` }
            : current,
        );
        modalSubmitPending.current = false;
        return;
      }

      modalSubmitPending.current = false;
      closeModal();
      const followupSeq = modalLaunchSeq.current;

      setActiveColumn(colIdx);
      setSwimPosition({ ...swimCursorRef.current, col: colIdx });
      pendingFocus.current = { key: created.key, afterVersion: boardDataVersion.current + 1 };
      touchRecent(created.key, trimmed);

      let landed = false;
      let warning: string | null = null;
      try {
        // Jira drops the issue into the workflow's initial status, which
        // usually isn't where the cursor was. Transition if it's not already
        // in the target column; soft-fail if the workflow blocks the jump.
        const statusId = await getIssueStatusId(cfg, created.key);
        landed = targetCol.statusIds.includes(statusId);
        if (!landed) {
          const trs = await getTransitions(cfg, created.key);
          const candidates = trs.filter((transition) =>
            targetCol.statusIds.includes(transition.toStatusId),
          );
          const hop =
            candidates.find((transition) => transition.requiredFields.length === 0) ??
            candidates[0];
          if (hop) {
            if (hop.requiredFields.length > 0) {
              await load();
              flash(`created ${created.key}; complete required fields to move it`, "info");
              if (followupSeq === modalLaunchSeq.current)
                showModal({
                  kind: "transition-screen",
                  transition: hop,
                  issueKey: created.key,
                  projectKey: conf.projectKey,
                  targetColIdx: colIdx,
                  returnTo: { kind: "board" },
                });
              return;
            }
            await transitionIssue(cfg, created.key, hop.id);
            landed = true;
          } else {
            warning = `no transition to ${targetCol.name}`;
          }
        }
      } catch (e) {
        warning = errorMessage(e);
      }
      flash(
        landed
          ? `Created ${created.key} in ${targetCol.name}.`
          : `Created ${created.key}; follow-up failed${warning ? `: ${warning}` : "."}`,
        landed ? "ok" : "err",
      );
      await load();
    },
    [cfg, conf, flash, load, closeModal, touchRecent, showModal, setActiveColumn, setSwimPosition],
  );

  // Nudge the cursor within the active column / across columns.
  const nudgeRow = useCallback(
    (delta: number) => {
      const colIndex = activeColRef.current;
      const col = columns[colIndex];
      if (!col) return;
      const row = clamp(
        (activeRowsRef.current[colIndex] ?? 0) + delta,
        0,
        Math.max(0, col.issues.length - 1),
      );
      setActiveRowAt(colIndex, row);
      setSelectedIssueKey(col.issues[row]?.key ?? null);
    },
    [columns, setActiveRowAt],
  );
  const nudgeCol = useCallback(
    (delta: number) => {
      const col = clamp(activeColRef.current + delta, 0, Math.max(0, columns.length - 1));
      const row = clamp(
        activeRowsRef.current[col] ?? 0,
        0,
        Math.max(0, (columns[col]?.issues.length ?? 0) - 1),
      );
      setActiveColumn(col);
      setSelectedIssueKey(columns[col]?.issues[row]?.key ?? null);
    },
    [columns, setActiveColumn],
  );

  // Swimlane cursor movement — delegates the spill-across-lanes logic to the
  // pure `moveCursor` in swimlanes.ts. dRow steps within/between lanes; dCol
  // moves across columns, clamping the row into the new column.
  const swimMove = useCallback(
    (dRow: number, dCol: number) => {
      const cursor = moveCursor(lanes, swimCursorRef.current, dRow, dCol);
      setSwimPosition(cursor);
      setSelectedIssueKey(lanes[cursor.lane]?.columns[cursor.col]?.issues[cursor.row]?.key ?? null);
    },
    [lanes, setSwimPosition],
  );

  useInput(
    (input, key) => {
      if (!conf) {
        if (key.escape || input === "q" || (key.ctrl && input === "c")) return onExit();
        if (loadError && input === "r") void load();
        return;
      }
      // Global
      if (key.ctrl && input.toLowerCase() === "g") {
        dismiss();
        return;
      }
      if (key.ctrl && input === "c") return onExit();
      if (input === "q") return onExit();
      if (input === "?") return showModal({ kind: "help" });

      // Navigation — swim view uses the lane cursor, flat board the columns.
      if (swimViewRef.current) {
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
          const col = activeColRef.current;
          setActiveRowAt(col, 0);
          setSelectedIssueKey(columns[col]?.issues[0]?.key ?? null);
          return;
        }
        if (input === "G") {
          const colIndex = activeColRef.current;
          const col = columns[colIndex];
          if (col) {
            const row = Math.max(0, col.issues.length - 1);
            setActiveRowAt(colIndex, row);
            setSelectedIssueKey(col.issues[row]?.key ?? null);
          }
          return;
        }
        if (key.pageUp) return nudgeRow(-cardsVisible);
        if (key.pageDown) return nudgeRow(cardsVisible);
      }

      // g / G — jump to the first / last lane (swim) or column top/bottom
      // (flat, handled above). snapToCard lands on a populated cell (preferring
      // the current column) so the cursor never strands on an empty cell in a
      // lane that doesn't have a card in that column.
      if (swimViewRef.current && input === "g") {
        const cursor = snapToCard(lanes, 0, swimCursorRef.current.col);
        setSwimPosition(cursor);
        setSelectedIssueKey(
          lanes[cursor.lane]?.columns[cursor.col]?.issues[cursor.row]?.key ?? null,
        );
        return;
      }
      if (swimViewRef.current && input === "G") {
        const cursor = snapToCard(lanes, lanes.length - 1, swimCursorRef.current.col);
        setSwimPosition(cursor);
        setSelectedIssueKey(
          lanes[cursor.lane]?.columns[cursor.col]?.issues[cursor.row]?.key ?? null,
        );
        return;
      }

      const targetIssue = currentIssueNow();

      // Block mutating actions on a card that's mid-update (a transition or
      // rerank in flight, or an optimistic move still settling). Read-only
      // actions (view, copy, open, refresh) and navigation stay live so the
      // user can look around while it settles.
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
      if (mutating && targetIssue && rejectPending(targetIssue)) return;

      // Actions on current card
      if (key.return) {
        if (targetIssue) showModal({ kind: "card-action", issue: targetIssue });
        return;
      }
      if (input === "v") return void openDetail();
      if (input === "e") return void doEditSummary();
      if (input === "E") return void doEditDescription();
      if (input === "o") return void openIssueInBrowser();
      if (input === "m") {
        if (!targetIssue) return flash("No issue selected.", "info");
        showModal({ kind: "move-picker", issue: targetIssue, returnTo: { kind: "board" } });
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
        if (!targetIssue) return flash("No issue selected.", "info");
        copyToClipboard(targetIssue.key)
          .then(() => flash(`copied ${targetIssue.key}`, "ok"))
          .catch((e) => flash(errorMessage(e), "err"));
        return;
      }
      if (input === "Y") {
        if (!targetIssue) return flash("No issue selected.", "info");
        const url = `${cfg.server}/browse/${targetIssue.key}`;
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
        flash("Refreshing…", "info");
        return;
      }

      // Search + match cycling
      if (input === "/") {
        setSearchBuffer(query);
        showModal({ kind: "search" });
        return;
      }
      if (input === "n") return jumpToMatch(1);
      if (input === "N") return jumpToMatch(-1);

      // Quick-open finder: opens on recently-visited issues; typing searches
      // every project globally.
      if (input === "R") return showModal({ kind: "quick-open" });

      // JQL
      if (input === "J") {
        showModal({ kind: "jql" });
        return;
      }

      // Filters
      if (input === "f") {
        showModal({ kind: "filter-menu" });
        return;
      }
      if (input === "F") {
        if (activeFilterCount(filters) > 0) {
          setFilters(EMPTY_FILTERS);
          flash("All filters cleared.", "ok");
        } else {
          flash("No filters active.", "info");
        }
        return;
      }
      // Swimlanes: toggle the grouped lane view. Only available when the
      // board actually defines swimlanes (custom JQL lanes or a field
      // strategy) — otherwise there's nothing to group by.
      if (input === "s") {
        if (!hasSwimlanes) {
          flash("No swimlanes are configured on this board.", "info");
          return;
        }
        const next = !swimViewRef.current;
        const selected = currentIssueNow();
        swimViewRef.current = next;
        setSwimView(next);
        if (next) {
          const seed = selected ? findCursor(lanes, selected.key) : null;
          setSwimPosition(seed ?? snapToCard(lanes, 0, activeColRef.current));
          swimScrollRef.current = 0;
        } else if (selected) {
          for (let col = 0; col < columns.length; col++) {
            const row = columns[col]!.issues.findIndex((issue) => issue.key === selected.key);
            if (row >= 0) {
              setActiveColumn(col);
              setActiveRowAt(col, row);
              setSelectedIssueKey(selected.key);
              break;
            }
          }
        }
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
        <Box flexDirection="column" padding={1} width={termCols} height={termRows}>
          <Box>
            <Text color={theme.accent} bold>
              ifhj{" "}
            </Text>
            <Text color={theme.muted}>— {board.name}</Text>
          </Box>
          <Box marginTop={1}>
            <ErrorMessage message={loadError} width={Math.max(1, termCols - 2)} rows={3} />
          </Box>
          <Box marginTop={1}>
            <Text color={theme.muted}>r retry · esc/q boards</Text>
          </Box>
        </Box>
      );
    }
    return (
      <Box flexDirection="column" padding={1} width={termCols} height={termRows}>
        <Box>
          <Text color={theme.accent} bold>
            ifhj{" "}
          </Text>
          <Text color={theme.muted}>— {board.name}</Text>
        </Box>
        <Box marginTop={1}>
          <LoadingLine label="Loading board…" />
        </Box>
        <Box marginTop={1}>
          <Text color={theme.muted}>esc/q boards</Text>
        </Box>
      </Box>
    );
  }

  const detailKey = retainedDetailKey(modal);

  const renderDetail = (issueKey: string, enabled: boolean) => (
    <InputScope enabled={enabled}>
      <Box display={enabled ? "flex" : "none"}>
        <IssueDetailModal
          cfg={cfg}
          projectKey={projectForIssue(issueKey)}
          issueKey={issueKey}
          ensureUsers={usersLoader}
          onLocalAction={() => {
            modalLaunchSeq.current++;
          }}
          onClose={closeModal}
          externalBusy={busy}
          externalToasts={toasts}
          onDismissExternalToasts={dismiss}
          onMove={(issue) => {
            showModal({
              kind: "move-picker",
              issue,
              returnTo: { kind: "detail", issueKey },
            });
          }}
          onTransition={async (projectKey) => {
            const seq = ++modalLaunchSeq.current;
            try {
              const transitions = await track(getTransitions(cfg, issueKey));
              if (
                seq !== modalLaunchSeq.current ||
                modalRef.current.kind !== "detail" ||
                modalRef.current.issueKey !== issueKey
              )
                return;
              if (transitions.length === 0) {
                flash("No workflow transitions are available.", "info");
                return;
              }
              showModal({
                kind: "transition-picker",
                transitions,
                issueKey,
                projectKey,
                returnTo: { kind: "detail", issueKey },
              });
            } catch (error) {
              if (seq === modalLaunchSeq.current) flash(errorMessage(error), "err");
            }
          }}
          onCreateSubtask={(parent) => {
            const seq = ++modalLaunchSeq.current;
            void (async () => {
              try {
                const { types: allTypes, linkTypes } = await ensureMeta(parent.projectKey);
                if (
                  seq !== modalLaunchSeq.current ||
                  modalRef.current.kind !== "detail" ||
                  modalRef.current.issueKey !== issueKey
                )
                  return;
                const types = allTypes.filter((type) => type.subtask);
                if (types.length === 0) throw new Error("No subtask issue types in this project.");
                showModal({
                  kind: "create",
                  projectKey: parent.projectKey,
                  types,
                  linkTypes,
                  parent,
                  returnTo: { kind: "detail", issueKey },
                });
              } catch (error) {
                if (seq === modalLaunchSeq.current) flash(errorMessage(error), "err");
              }
            })();
          }}
          onRefresh={() => void load()}
        />
      </Box>
    </InputScope>
  );

  const withRetainedDetail = (content: ReactNode, detailActive = false) => {
    if (!detailKey) return content;
    return (
      <>
        {renderDetail(detailKey, detailActive)}
        {detailActive ? null : <>{content}</>}
      </>
    );
  };

  const renderMovePicker = (picker: MovePickerReturn, enabled: boolean) => {
    const targetIssue = picker.issue;
    const currentColIdx = conf.columns.findIndex((column) =>
      column.statusIds.includes(targetIssue.statusId),
    );
    return (
      <InputScope key={`move-${targetIssue.key}`} enabled={enabled}>
        <Box display={enabled ? "flex" : "none"} flexDirection="column">
          <FilterPicker
            title={`Move ${targetIssue.key} to…`}
            items={conf.columns.map((column, index) => ({
              id: String(index),
              label: column.name,
            }))}
            {...(currentColIdx >= 0 ? { currentId: String(currentColIdx) } : {})}
            {...(picker.busy
              ? { busy: true, busyLabel: `Loading transitions for ${targetIssue.key}…` }
              : {})}
            onCancel={() => restore(picker.returnTo)}
            onPick={(id) => {
              const targetIndex = Number(id);
              const column = conf.columns[targetIndex];
              if (!column) return;
              if (column.statusIds.includes(targetIssue.statusId)) {
                setModal({ ...picker, error: "Already in that column." });
                return;
              }
              const launchSeq = ++modalLaunchSeq.current;
              setModal({ ...picker, busy: true, error: undefined });
              void moveToColumn(targetIndex, targetIssue, launchSeq, picker, {
                onReady: (transition) => {
                  if (transition.requiredFields.length === 0) closeModal();
                },
                onError: (message) => {
                  setModal((current) =>
                    current.kind === "move-picker"
                      ? { ...current, busy: false, error: message }
                      : current,
                  );
                },
              });
            }}
          />
          {picker.error ? (
            <ErrorMessage message={picker.error} width={Math.max(1, termCols - 6)} rows={2} />
          ) : null}
        </Box>
      </InputScope>
    );
  };

  const renderTransitionPicker = (picker: TransitionPickerReturn, enabled: boolean) => (
    <InputScope key={`transition-${picker.issueKey}`} enabled={enabled}>
      <Box display={enabled ? "flex" : "none"}>
        <ListPicker
          title={`Transition ${picker.issueKey}`}
          items={picker.transitions.map((transition) => ({
            id: transition.id,
            label: transition.name,
          }))}
          onCancel={() => restore(picker.returnTo)}
          onPick={(id) => {
            const transition = picker.transitions.find((candidate) => candidate.id === id);
            if (!transition) return restore(picker.returnTo);
            const targetIndex = conf.columns.findIndex((column) =>
              column.statusIds.includes(transition.toStatusId),
            );
            if (transition.requiredFields.length === 0) closeModal();
            void commitTransition(picker.issueKey, transition, {
              projectKey: picker.projectKey,
              returnTo: picker,
              ...(picker.drafts?.[transition.id]
                ? { initialValues: picker.drafts[transition.id] }
                : {}),
              ...(targetIndex !== -1 ? { targetColIdx: targetIndex } : {}),
            });
          }}
        />
      </Box>
    </InputScope>
  );

  // Modal overlays. Each branch is a discrete, full-screen-ish component.
  if (modal.kind === "nvim") return <NvimBanner warning={modal.warning} />;
  if (modal.kind === "description-save") {
    return (
      <DescriptionSaveModal
        issueKey={modal.issue.key}
        busy={modal.busy}
        error={modal.error}
        onRetry={() => {
          if (descriptionWrites.current.has(modal.issue.key)) return;
          setModal({ ...modal, busy: true, error: undefined });
          void saveBoardDescription(modal.issue, modal.draft);
        }}
        onEdit={() => void doEditDescription(modal.issue)}
        onCancel={closeModal}
      />
    );
  }
  if (modal.kind === "help") return <HelpModal onClose={closeModal} />;
  if (modal.kind === "card-action") {
    const actionIssue = modal.issue;
    return (
      <ListPicker
        title={`${actionIssue.key} · ${actionIssue.summary.slice(0, 60)}`}
        items={[
          { id: "detail", label: "View details" },
          { id: "title", label: "Edit title" },
          { id: "desc", label: `Edit description (${editorLabel()})` },
          { id: "transition", label: "Choose workflow transition…" },
          { id: "move", label: "Move to column…" },
          { id: "assign-me", label: "Assign to me" },
          { id: "open", label: "Open in browser" },
        ]}
        onCancel={closeModal}
        onPick={(id) => {
          closeModal();
          if (id === "detail") openDetailForKey(actionIssue.key);
          else if (id === "title") void doEditSummary(actionIssue);
          else if (id === "desc") void doEditDescription(actionIssue);
          else if (id === "transition") void doFuzzyTransition(actionIssue);
          else if (id === "move")
            showModal({ kind: "move-picker", issue: actionIssue, returnTo: { kind: "board" } });
          else if (id === "assign-me") void doAssignToMe(actionIssue);
          else if (id === "open") void openIssueInBrowser(actionIssue);
        }}
      />
    );
  }
  if (modal.kind === "move-picker") {
    return withRetainedDetail(renderMovePicker(modal, true));
  }
  if (modal.kind === "quick-add") {
    const colName = conf.columns[modal.colIdx]?.name ?? "column";
    return (
      <QuickAddModal
        colName={colName}
        typeName={modal.type.name}
        value={modal.value}
        busy={modal.busy}
        error={modal.error}
        onChange={(v) => setModal({ ...modal, value: v, error: undefined })}
        onSubmit={(val) => void submitQuickAdd(modal.colIdx, modal.type, val)}
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
        busy={modal.busy}
        error={modal.error}
        onChange={(v) => setModal({ ...modal, current: v, error: undefined })}
        onSubmit={async (val) => {
          if (modalSubmitPending.current) return;
          const next = val.trim();
          if (!next) {
            setModal({
              ...modal,
              error: "Title is required. Enter a title or press esc to cancel.",
            });
            return;
          }
          if (next === modal.original.trim()) {
            flash("No title change.", "info");
            closeModal();
            return;
          }
          setModal({ ...modal, busy: true, error: undefined });
          modalSubmitPending.current = true;
          try {
            await updateSummary(cfg, editKey, next);
            modalSubmitPending.current = false;
            closeModal();
            flash(`${editKey} title updated.`, "ok");
            touchRecent(editKey);
            await load();
          } catch (e) {
            modalSubmitPending.current = false;
            setModal((current) =>
              current.kind === "title-edit" && current.issueKey === editKey
                ? {
                    ...current,
                    busy: false,
                    error: `Could not save title: ${errorMessage(e)}`,
                  }
                : current,
            );
          }
        }}
        onCancel={closeModal}
      />
    );
  }
  if (modal.kind === "detail") {
    return withRetainedDetail(null, true);
  }
  if (modal.kind === "transition-picker") {
    return withRetainedDetail(renderTransitionPicker(modal, true));
  }
  if (modal.kind === "transition-screen") {
    const screenKey = modal.issueKey;
    const screenTr = modal.transition;
    const screenTargetIdx = modal.targetColIdx;
    const parentLayer =
      modal.returnTo.kind === "transition-picker"
        ? renderTransitionPicker(modal.returnTo, false)
        : modal.returnTo.kind === "move-picker"
          ? renderMovePicker(modal.returnTo, false)
          : null;
    return withRetainedDetail([
      parentLayer,
      <TransitionScreenModal
        key={`transition-screen-${screenKey}-${screenTr.id}`}
        cfg={cfg}
        projectKey={modal.projectKey}
        issueKey={screenKey}
        transition={screenTr}
        {...(modal.initialValues ? { initialValues: modal.initialValues } : {})}
        busy={modal.busy}
        error={modal.error}
        onEdit={() => {
          setModal((current) =>
            isTransitionScreen(current, screenKey, screenTr.id)
              ? { ...current, error: undefined }
              : current,
          );
        }}
        onOpenIssue={() => {
          void openInBrowser(`${cfg.server}/browse/${screenKey}`).catch((error) => {
            setModal((current) =>
              isTransitionScreen(current, screenKey, screenTr.id)
                ? { ...current, error: errorMessage(error) }
                : current,
            );
          });
        }}
        onCancel={(values) => {
          const drafts = {
            ...(modal.returnTo.kind === "transition-picker" || modal.returnTo.kind === "move-picker"
              ? modal.returnTo.drafts
              : {}),
            [screenTr.id]: values ?? {},
          };
          if (modal.returnTo.kind === "transition-picker") restore({ ...modal.returnTo, drafts });
          else if (modal.returnTo.kind === "move-picker")
            restore({ ...modal.returnTo, busy: false, drafts });
          else restore(modal.returnTo);
        }}
        onSubmit={(fields) => {
          if (modalSubmitPending.current) return;
          modalSubmitPending.current = true;
          setModal({ ...modal, busy: true, error: undefined });
          void commitTransition(screenKey, screenTr, {
            projectKey: modal.projectKey,
            fields,
            onError: (message) => {
              modalSubmitPending.current = false;
              setModal((current) =>
                isTransitionScreen(current, screenKey, screenTr.id)
                  ? {
                      ...current,
                      busy: false,
                      error: `Could not save transition: ${message}. Your values are kept.`,
                    }
                  : current,
              );
            },
            ...(screenTargetIdx !== undefined ? { targetColIdx: screenTargetIdx } : {}),
          }).then((saved) => {
            if (saved && isTransitionScreen(modalRef.current, screenKey, screenTr.id)) {
              modalSubmitPending.current = false;
              closeModal();
            }
            return undefined;
          });
        }}
      />,
    ]);
  }
  if (modal.kind === "filter-menu") {
    const count = activeFilterCount(filters);
    const items = [
      { id: "assignee", label: `Assignee${filters.assignee ? ` · ${filters.assignee}` : ""}` },
      { id: "type", label: `Issue type${filters.type ? ` · ${filters.type}` : ""}` },
      { id: "sprint", label: `Sprint${filters.sprint ? ` · ${filters.sprint}` : ""}` },
      { id: "label", label: `Label${filters.label ? ` · ${filters.label}` : ""}` },
      { id: "epic", label: `Epic${filters.epic ? ` · ${filters.epic}` : ""}` },
      ...(count > 0 ? [{ id: "clear", label: "Clear all filters" }] : []),
    ];
    return (
      <Box flexDirection="column" width={termCols} height={termRows}>
        <ListPicker
          title={`Filters${count > 0 ? ` (${count} active)` : ""}`}
          items={items}
          onPick={(id) => {
            if (id === "clear") {
              setFilters(EMPTY_FILTERS);
              closeModal();
              flash("All filters cleared.", "ok");
            } else if (id === "assignee") {
              showModal({ kind: "filter-assignee", names: filterOptions.assignees });
            } else if (id === "type") {
              showModal({ kind: "filter-type", types: filterOptions.types });
            } else if (id === "sprint") {
              if (filterOptions.sprints.length === 0) {
                flash("No sprints found.", "info");
                return;
              }
              showModal({ kind: "filter-sprint", sprints: filterOptions.sprints });
            } else if (id === "label") {
              if (filterOptions.labels.length === 0) {
                flash("No labels found.", "info");
                return;
              }
              showModal({ kind: "filter-label", labels: filterOptions.labels });
            } else if (id === "epic") {
              if (filterOptions.epics.length === 0) {
                flash("No epics found.", "info");
                return;
              }
              showModal({ kind: "filter-epic", epics: filterOptions.epics });
            }
          }}
          onCancel={closeModal}
        />
        <ToastStack toasts={toasts} maxWidth={termCols} onDismiss={dismiss} />
      </Box>
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
        onCancel={() => showModal({ kind: "filter-menu" })}
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
    return withRetainedDetail(
      <CreateWizard
        cfg={cfg}
        projectKey={modal.projectKey}
        types={modal.types}
        linkTypes={modal.linkTypes}
        initialType={modal.initialType}
        defaultParent={modal.parent}
        ensureUsers={usersLoader}
        onCancel={() => restore(modal.returnTo)}
        onDone={({ key, title, linkSummary, warning }) => {
          const headline = `Created ${key}: ${title}`;
          const linked = linkSummary ? `${headline} · ${linkSummary}` : headline;
          flash(
            warning ? `${linked}; follow-up failed: ${warning}` : linked,
            warning ? "err" : "ok",
          );
          pendingFocus.current = { key, afterVersion: boardDataVersion.current + 1 };
          // Clean creates open detail. Partial success stays on the board so
          // its warning is visible; both paths reload and focus the new card.
          void load();
          if (warning) {
            touchRecent(key, title);
            closeModal();
          } else void openDetailForKey(key, title);
        }}
        onError={(msg) => {
          flash(msg, "err");
        }}
      />,
    );
  }

  // Main kanban view.
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
        estimateDisplay={estimateDisplay}
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
                estimateDisplay={estimateDisplay}
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
                  estimateDisplay={estimateDisplay}
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
        emptyMessage={
          issues.length === 0
            ? "No issues on this board."
            : filteredIssues.length === 0
              ? "No issues match the active filters."
              : columns.length === 0
                ? "No board columns available."
                : undefined
        }
      />
      <ToastStack toasts={toasts} maxWidth={termCols} onDismiss={dismiss} />
    </Box>
  );
}
