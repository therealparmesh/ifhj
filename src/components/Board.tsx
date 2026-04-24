import { Box, Text, useInput } from "ink";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { readBoardCache, writeBoardCache } from "../cache";
import type { JiraConfig } from "../config";
import { editInNeovim } from "../editor";
import { useDimensions } from "../hooks";
import {
  type BoardColumn,
  type BoardConfig,
  type Issue,
  type IssueSearchResult,
  type IssueLinkType,
  type IssueType,
  type Transition,
  assignIssueToMe,
  getBoardConfig,
  rankIssueAfter,
  rankIssueBefore,
  getBoardIssues,
  getIssueLinkTypes,
  getIssueTypes,
  getTransitions,
  searchByJql,
  transitionIssue,
  updateDescription,
  updateSummary,
} from "../jira";
import { clamp, copyToClipboard, errorMessage, openInBrowser, theme, truncate } from "../ui";
import { BoardHeader } from "./BoardHeader";
import { CreateWizard } from "./CreateWizard";
import { FilterPicker } from "./FilterPicker";
import { Footer } from "./Footer";
import { HelpModal } from "./HelpModal";
import { Hint } from "./Hint";
import { IssueDetailModal } from "./IssueDetailModal";
import { type Column, ColumnView, PagingArrow } from "./Kanban";
import { ListPicker } from "./ListPicker";
import { TextInput } from "./TextInput";
import { ToastStack, useToasts } from "./Toasts";

const MAX_VISIBLE_COLS = 4;

type Board = { id: number; name: string };

type Props = {
  cfg: JiraConfig;
  board: Board;
  onExit: () => void;
};

type Modal =
  | { kind: "none" }
  | { kind: "help" }
  | { kind: "search" }
  | { kind: "card-action" }
  | { kind: "move-picker"; issueKey?: string }
  | { kind: "transition-picker"; transitions: Transition[]; issueKey: string }
  | { kind: "filter-menu" }
  | { kind: "filter-assignee"; names: string[] }
  | { kind: "filter-type"; types: string[] }
  | { kind: "filter-sprint"; sprints: string[] }
  | { kind: "filter-label"; labels: string[] }
  | { kind: "filter-epic"; epics: string[] }
  | { kind: "create"; types: IssueType[]; linkTypes: IssueLinkType[]; parentKey?: string }
  | { kind: "detail"; issueKey: string }
  | { kind: "title-edit"; issueKey: string; current: string }
  | { kind: "nvim" }
  | { kind: "jql" }
  | { kind: "recents" };

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

type CellRef = { col: number; row: number };

/**
 * Bucket issues into columns by statusId. Issues with a status not mapped
 * by the board config get dropped — Jira sometimes returns stale ones.
 */
function buildColumns(colDefs: BoardColumn[], issues: Issue[]): Column[] {
  const cols: Column[] = colDefs.map((c) => ({ ...c, issues: [] }));
  const statusToCol = new Map<string, number>();
  cols.forEach((c, i) => c.statusIds.forEach((s) => statusToCol.set(s, i)));
  for (const issue of issues) {
    const idx = statusToCol.get(issue.statusId);
    if (idx !== undefined) cols[idx]!.issues.push(issue);
  }
  return cols;
}

export function BoardView({ cfg, board, onExit }: Props) {
  const { cols: termCols, rows: termRows } = useDimensions();

  // Server state
  const [conf, setConf] = useState<BoardConfig | null>(null);
  const [issues, setIssues] = useState<Issue[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Cursor / scroll state
  const [activeCol, setActiveCol] = useState(0);
  const [activeRows, setActiveRows] = useState<number[]>([]);
  const [scrolls, setScrolls] = useState<number[]>([]);

  // UI state
  const { toasts, flash } = useToasts();
  const [query, setQuery] = useState("");
  const [matchIdx, setMatchIdx] = useState(0);
  const [modal, setModal] = useState<Modal>({ kind: "none" });
  const [searchBuffer, setSearchBuffer] = useState("");
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);

  // Link & issue types don't change for the life of the board — fetch once, reuse.
  const metaCache = useRef<{ types: IssueType[]; linkTypes: IssueLinkType[] } | null>(null);
  // First load is fatal; reload failures just flash a toast.
  const hasLoadedOnce = useRef(false);
  // After a transition, follow the moved card to its new column on reload.
  const pendingFocusKey = useRef<string | null>(null);
  const [recents, setRecents] = useState<{ key: string; summary: string }[]>([]);

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
  const columns = useMemo(
    () => (conf ? buildColumns(conf.columns, filteredIssues) : []),
    [conf, filteredIssues],
  );

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
    setScrolls((prev) => c.columns.map((_, i) => prev[i] ?? 0));
  }, []);

  const load = useCallback(async () => {
    setLoadError(null);
    if (!hasLoadedOnce.current) {
      const cached = await readBoardCache(board.id);
      if (cached) {
        applyBoardData(cached.config, cached.issues);
        hasLoadedOnce.current = true;
      }
    }
    try {
      const [c, is] = await Promise.all([
        getBoardConfig(cfg, board.id),
        getBoardIssues(cfg, board.id),
      ]);
      applyBoardData(c, is);
      hasLoadedOnce.current = true;
      void writeBoardCache(board.id, c, is);
    } catch (e) {
      const msg = errorMessage(e);
      if (hasLoadedOnce.current) flash(msg, "err");
      else setLoadError(msg);
    }
  }, [cfg, board.id, flash, applyBoardData]);

  useEffect(() => {
    void load();
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
        if (
          issue.summary.toLowerCase().includes(q) ||
          issue.key.toLowerCase().includes(q) ||
          (issue.assignee ?? "").toLowerCase().includes(q)
        )
          out.push({ col: ci, row: ri });
      });
    });
    return out;
  }, [columns, liveQuery]);

  const matchSet = useMemo(() => new Set(matches.map((m) => `${m.col}:${m.row}`)), [matches]);

  // Without this clamp the footer reads "4/2" after matches shrink.
  useEffect(() => {
    if (matchIdx >= matches.length) setMatchIdx(0);
  }, [matches, matchIdx]);

  const jumpToFirstMatch = useCallback(() => {
    const first = matches[0];
    if (!first) return false;
    setActiveCol(first.col);
    setActiveRowAt(first.col, first.row);
    return true;
  }, [matches, setActiveRowAt]);

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
      const target = matches[next]!;
      setActiveCol(target.col);
      setActiveRowAt(target.col, target.row);
    },
    [matches, matchIdx, flash, query, setActiveRowAt],
  );

  /**
   * Layout math. The grid fits `MAX_VISIBLE_COLS` columns; everything beyond
   * that requires ←/→ paging.
   */
  const footerRows = modal.kind === "search" ? 5 : 3;
  const columnHeight = Math.max(6, termRows - 2 - footerRows);
  const columnInnerHeight = columnHeight - 2; // minus border top/bottom
  const perCardLines = 5; // card = 3 content + 1 spacer + 1 (border-ish) handled via marginBottom
  const cardsVisible = Math.max(1, Math.floor(columnInnerHeight / perCardLines));

  const visibleColCount = Math.min(MAX_VISIBLE_COLS, columns.length);
  const colWindowStart = Math.max(
    0,
    Math.min(columns.length - visibleColCount, activeCol - Math.floor(visibleColCount / 2)),
  );
  const colWindowEnd = colWindowStart + visibleColCount;
  const hasColsLeft = colWindowStart > 0;
  const hasColsRight = colWindowEnd < columns.length;

  /**
   * Clamp each column's active row into bounds when columns shrink (e.g.
   * toggling the assignee filter) so the cursor doesn't sit past the last card.
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
   * Keep each column's scroll offset in sync with its active row so the
   * cursor never scrolls off screen. Returns prev unchanged when nothing
   * shifted so we don't trigger pointless re-renders.
   */
  useEffect(() => {
    if (columns.length === 0) return;
    setScrolls((prev) => {
      let changed = false;
      const arr = prev.slice();
      columns.forEach((_, i) => {
        const row = activeRows[i] ?? 0;
        const scroll = arr[i] ?? 0;
        if (row < scroll) {
          arr[i] = row;
          changed = true;
        } else if (row >= scroll + cardsVisible) {
          arr[i] = row - cardsVisible + 1;
          changed = true;
        }
      });
      return changed ? arr : prev;
    });
  }, [activeRows, cardsVisible, columns]);

  const currentIssue: Issue | null = useMemo(() => {
    const col = columns[activeCol];
    if (!col) return null;
    return col.issues[activeRows[activeCol] ?? 0] ?? null;
  }, [columns, activeCol, activeRows]);

  const moving = useRef(false);

  const moveToColumn = useCallback(
    async (targetColIdx: number, issueOverride?: Issue) => {
      const issue = issueOverride ?? currentIssue;
      if (!issue || !conf) return;
      if (targetColIdx < 0 || targetColIdx >= conf.columns.length) return;
      /**
       * Reject rapid re-entry while a move is in flight — spamming `<` / `>`
       * otherwise stacks transitions and races the focus snap.
       */
      if (moving.current) {
        flash("transition in progress…", "info");
        return;
      }
      moving.current = true;
      const targetCol = conf.columns[targetColIdx]!;
      try {
        const trs = await getTransitions(cfg, issue.key);
        const candidates = trs.filter((t) => targetCol.statusIds.includes(t.toStatusId));
        if (candidates.length === 0) {
          flash(`no transition to ${targetCol.name}`, "err");
          return;
        }
        if (candidates.length === 1) {
          await transitionIssue(cfg, issue.key, candidates[0]!.id);
          flash(`${issue.key} → ${targetCol.name}`, "ok");
          // Follow the card so focus doesn't get lost after reload.
          setActiveCol(targetColIdx);
          pendingFocusKey.current = issue.key;
          await load();
        } else {
          setModal({ kind: "transition-picker", transitions: candidates, issueKey: issue.key });
        }
      } catch (e) {
        pendingFocusKey.current = null;
        flash(errorMessage(e), "err");
      } finally {
        moving.current = false;
      }
    },
    [currentIssue, conf, cfg, flash, load],
  );

  /**
   * After a reload, snap activeRows to wherever the tracked card ended up.
   * Only clear the marker once we actually find the card — pre-reload
   * column changes (e.g. toggling the assignee filter mid-flight)
   * shouldn't consume it.
   */
  useEffect(() => {
    const key = pendingFocusKey.current;
    if (!key) return;
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
  }, [columns, setActiveRowAt]);

  const doTransition = useCallback(
    async (direction: 1 | -1) => {
      if (!conf) return;
      const targetColIdx = activeCol + direction;
      if (targetColIdx < 0 || targetColIdx >= conf.columns.length) {
        flash("no column in that direction", "info");
        return;
      }
      await moveToColumn(targetColIdx);
    },
    [conf, activeCol, flash, moveToColumn],
  );

  const doEditSummary = useCallback(() => {
    const issue = currentIssue;
    if (!issue) return;
    setModal({ kind: "title-edit", issueKey: issue.key, current: issue.summary });
  }, [currentIssue]);

  const doEditDescription = useCallback(async () => {
    const issue = currentIssue;
    if (!issue) return;
    setModal({ kind: "nvim" });
    try {
      const raw = await editInNeovim(issue.description, `${issue.key}-desc.md`);
      setModal({ kind: "none" });
      if (raw.trim() === issue.description.trim()) {
        flash("no change", "info");
        return;
      }
      await updateDescription(cfg, issue.key, raw);
      flash(`${issue.key} description updated`, "ok");
      await load();
    } catch (e) {
      setModal({ kind: "none" });
      flash(errorMessage(e), "err");
    }
  }, [currentIssue, cfg, flash, load]);

  const doAssignToMe = useCallback(async () => {
    const issue = currentIssue;
    if (!issue) {
      flash("no issue selected", "info");
      return;
    }
    try {
      await assignIssueToMe(cfg, issue.key);
      flash(`${issue.key} assigned to you`, "ok");
      await load();
    } catch (e) {
      flash(errorMessage(e), "err");
    }
  }, [currentIssue, cfg, flash, load]);

  const doFuzzyTransition = useCallback(async () => {
    const issue = currentIssue;
    if (!issue) {
      flash("no issue selected", "info");
      return;
    }
    try {
      const trs = await getTransitions(cfg, issue.key);
      if (trs.length === 0) {
        flash("no transitions available", "info");
        return;
      }
      setModal({ kind: "transition-picker", transitions: trs, issueKey: issue.key });
    } catch (e) {
      flash(errorMessage(e), "err");
    }
  }, [currentIssue, cfg, flash]);

  const doRerank = useCallback(
    async (direction: -1 | 1) => {
      const col = columns[activeCol];
      const row = activeRows[activeCol] ?? 0;
      if (!col) return;
      const issue = col.issues[row];
      if (!issue) return;
      const targetRow = row + direction;
      if (targetRow < 0 || targetRow >= col.issues.length) {
        flash("already at the edge", "info");
        return;
      }
      const neighbor = col.issues[targetRow]!;
      try {
        if (direction === -1) {
          await rankIssueBefore(cfg, issue.key, neighbor.key);
        } else {
          await rankIssueAfter(cfg, issue.key, neighbor.key);
        }
        pendingFocusKey.current = issue.key;
        await load();
      } catch (e) {
        flash(errorMessage(e), "err");
      }
    },
    [columns, activeCol, activeRows, cfg, flash, load],
  );

  const openDetailForKey = useCallback(
    (key: string) => {
      const issue = issues.find((i) => i.key === key);
      const summary = issue?.summary ?? key;
      setRecents((prev) => [{ key, summary }, ...prev.filter((r) => r.key !== key).slice(0, 19)]);
      setModal({ kind: "detail", issueKey: key });
    },
    [issues],
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

  const startCreate = useCallback(async () => {
    if (!conf) return;
    try {
      if (!metaCache.current) {
        const [types, linkTypes] = await Promise.all([
          getIssueTypes(cfg, conf.projectKey),
          getIssueLinkTypes(cfg),
        ]);
        metaCache.current = { types: types.filter((t) => !t.subtask), linkTypes };
      }
      const { types, linkTypes } = metaCache.current;
      if (types.length === 0) {
        flash("no creatable issue types", "err");
        return;
      }
      setModal({ kind: "create", types, linkTypes });
    } catch (e) {
      flash(errorMessage(e), "err");
    }
  }, [cfg, conf, flash]);

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

  useInput(
    (input, key) => {
      // Global
      if (key.ctrl && input === "c") return onExit();
      if (input === "q") return onExit();
      if (input === "?") return setModal({ kind: "help" });

      // Navigation
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
      if (key.ctrl && input === ",") return void doRerank(-1);
      if (key.ctrl && input === ".") return void doRerank(1);
      if (input === "<" || input === ",") return void doTransition(-1);
      if (input === ">" || input === ".") return void doTransition(1);
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

      // Recents
      if (input === "R") {
        if (recents.length === 0) return flash("no recent issues", "info");
        setModal({ kind: "recents" });
        return;
      }

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
    },
    { isActive: modal.kind === "none" },
  );

  if (!conf) {
    /**
     * First-load states only — spinner or fatal error. Once `conf` lands,
     * reload errors surface as a toast so the grid stays up.
     */
    if (loadError) {
      return (
        <Box flexDirection="column" padding={1}>
          <Text color={theme.err}>{loadError}</Text>
          <Text color={theme.muted}>press q to go back</Text>
        </Box>
      );
    }
    return (
      <Box padding={1}>
        <Text color={theme.accent}>◴ </Text>
        <Text color={theme.fg}>loading {board.name}…</Text>
      </Box>
    );
  }

  // Modal overlays. Each branch is a discrete, full-screen-ish component.
  if (modal.kind === "nvim") {
    return (
      <Box flexDirection="column" padding={2} borderStyle="round" borderColor={theme.accent}>
        <Text color={theme.accent} bold>
          editing in Neovim
        </Text>
        <Box marginTop={1}>
          <Text color={theme.muted}>save & quit to return</Text>
        </Box>
      </Box>
    );
  }
  if (modal.kind === "help") return <HelpModal onClose={closeModal} />;
  if (modal.kind === "card-action" && currentIssue) {
    return (
      <ListPicker
        title={`${currentIssue.key} · ${currentIssue.summary.slice(0, 60)}`}
        items={[
          { id: "detail", label: "view details" },
          { id: "title", label: "edit title" },
          { id: "desc", label: "edit description (Neovim)" },
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
          title={`Move ${targetIssue.key} to…`}
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
        title={`Move ${modal.issueKey ?? "issue"} to…`}
        items={[]}
        loading
        onCancel={closeModal}
        onPick={() => {}}
      />
    );
  }
  if (modal.kind === "title-edit") {
    const editKey = modal.issueKey;
    return (
      <Box flexDirection="column" padding={2} borderStyle="round" borderColor={theme.accent}>
        <Text color={theme.accent} bold>
          edit title · {editKey}
        </Text>
        <Box marginTop={1}>
          <Text color={theme.muted}>› </Text>
          <TextInput
            value={modal.current}
            placeholder="issue title"
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
                await load();
              } catch (e) {
                flash(errorMessage(e), "err");
              }
            }}
            onCancel={closeModal}
          />
        </Box>
        <Box marginTop={1}>
          <Hint k="⏎" label="save" />
          <Hint k="esc" label="cancel" />
        </Box>
      </Box>
    );
  }
  if (modal.kind === "detail") {
    return (
      <IssueDetailModal
        cfg={cfg}
        projectKey={conf.projectKey}
        issueKey={modal.issueKey}
        onClose={closeModal}
        onMove={() => setModal({ kind: "move-picker", issueKey: modal.issueKey })}
        onTransition={async () => {
          const key = modal.issueKey;
          try {
            const trs = await getTransitions(cfg, key);
            if (trs.length === 0) return;
            setModal({ kind: "transition-picker", transitions: trs, issueKey: key });
          } catch {}
        }}
        onCreateSubtask={(parentKey) => {
          closeModal();
          void (async () => {
            if (!conf) return;
            try {
              if (!metaCache.current) {
                const [types, linkTypes] = await Promise.all([
                  getIssueTypes(cfg, conf.projectKey),
                  getIssueLinkTypes(cfg),
                ]);
                metaCache.current = { types: types.filter((t) => !t.subtask), linkTypes };
              }
              const { types, linkTypes } = metaCache.current;
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
        onPick={async (id) => {
          closeModal();
          const tr = trs.find((t) => t.id === id);
          if (!tr) return;
          try {
            await transitionIssue(cfg, pickerKey, tr.id);
            flash(`${pickerKey} → ${tr.name}`, "ok");
            const targetIdx = conf.columns.findIndex((c) => c.statusIds.includes(tr.toStatusId));
            if (targetIdx !== -1) setActiveCol(targetIdx);
            pendingFocusKey.current = pickerKey;
            await load();
          } catch (e) {
            pendingFocusKey.current = null;
            flash(errorMessage(e), "err");
          }
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
  if (modal.kind === "filter-assignee") {
    return (
      <FilterPicker
        title="filter by assignee"
        items={modal.names.map((n) => ({ id: n, label: n }))}
        {...(filters.assignee ? { currentId: filters.assignee } : {})}
        borderColor={theme.cyan}
        onPick={(id) => {
          setFilters((f) => ({ ...f, assignee: id }));
          closeModal();
          flash(`assignee: ${id}`, "ok");
        }}
        onClear={() => {
          setFilters((f) => ({ ...f, assignee: null }));
          closeModal();
          flash("assignee filter cleared", "ok");
        }}
        onCancel={() => setModal({ kind: "filter-menu" })}
      />
    );
  }
  if (modal.kind === "filter-type") {
    return (
      <FilterPicker
        title="filter by issue type"
        items={modal.types.map((t) => ({ id: t, label: t }))}
        {...(filters.type ? { currentId: filters.type } : {})}
        borderColor={theme.cyan}
        onPick={(id) => {
          setFilters((f) => ({ ...f, type: id }));
          closeModal();
          flash(`type: ${id}`, "ok");
        }}
        onClear={() => {
          setFilters((f) => ({ ...f, type: null }));
          closeModal();
          flash("type filter cleared", "ok");
        }}
        onCancel={() => setModal({ kind: "filter-menu" })}
      />
    );
  }
  if (modal.kind === "filter-sprint") {
    return (
      <FilterPicker
        title="filter by sprint"
        items={modal.sprints.map((s) => ({ id: s, label: s }))}
        {...(filters.sprint ? { currentId: filters.sprint } : {})}
        borderColor={theme.cyan}
        onPick={(id) => {
          setFilters((f) => ({ ...f, sprint: id }));
          closeModal();
          flash(`sprint: ${id}`, "ok");
        }}
        onClear={() => {
          setFilters((f) => ({ ...f, sprint: null }));
          closeModal();
          flash("sprint filter cleared", "ok");
        }}
        onCancel={() => setModal({ kind: "filter-menu" })}
      />
    );
  }
  if (modal.kind === "filter-label") {
    return (
      <FilterPicker
        title="filter by label"
        items={modal.labels.map((l) => ({ id: l, label: l }))}
        {...(filters.label ? { currentId: filters.label } : {})}
        borderColor={theme.cyan}
        onPick={(id) => {
          setFilters((f) => ({ ...f, label: id }));
          closeModal();
          flash(`label: ${id}`, "ok");
        }}
        onClear={() => {
          setFilters((f) => ({ ...f, label: null }));
          closeModal();
          flash("label filter cleared", "ok");
        }}
        onCancel={() => setModal({ kind: "filter-menu" })}
      />
    );
  }
  if (modal.kind === "filter-epic") {
    return (
      <FilterPicker
        title="filter by epic"
        items={modal.epics.map((e) => ({ id: e, label: e }))}
        {...(filters.epic ? { currentId: filters.epic } : {})}
        borderColor={theme.cyan}
        onPick={(id) => {
          setFilters((f) => ({ ...f, epic: id }));
          closeModal();
          flash(`epic: ${id}`, "ok");
        }}
        onClear={() => {
          setFilters((f) => ({ ...f, epic: null }));
          closeModal();
          flash("epic filter cleared", "ok");
        }}
        onCancel={() => setModal({ kind: "filter-menu" })}
      />
    );
  }
  if (modal.kind === "recents") {
    return (
      <FilterPicker
        title="recent issues"
        items={recents.map((r) => ({
          id: r.key,
          label: `${r.key}  ${truncate(r.summary, 60)}`,
        }))}
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
        onCancel={closeModal}
        onDone={({ key, title, linkSummary }) => {
          const headline = `created ${key}: ${title}`;
          flash(linkSummary ? `${headline} · ${linkSummary}` : headline, "ok");
          pendingFocusKey.current = key;
          // Reload in the background so the new card shows up on the board
          // beneath the detail view — the user closes detail and lands on it.
          void load();
          void openDetailForKey(key);
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
        colIndex={activeCol}
        colCount={columns.length}
        filterCount={activeFilterCount(filters)}
        query={modal.kind === "search" ? "" : query}
        matches={matches.length}
        matchIdx={matchIdx}
      />

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
                scroll={scrolls[ci] ?? 0}
                cardsVisible={cardsVisible}
                matchSet={matchSet}
                colIdx={ci}
              />
            );
          })}
        </Box>
        <PagingArrow direction="right" active={hasColsRight} />
      </Box>

      <Footer
        currentIssue={currentIssue}
        termCols={termCols}
        mode={modal.kind === "search" ? "search" : "normal"}
        query={query}
        matches={matches.length}
        matchIdx={matchIdx}
        filterCount={activeFilterCount(filters)}
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

function JqlView({
  cfg,
  onPick,
  onCancel,
}: {
  cfg: JiraConfig;
  onPick: (key: string) => void;
  onCancel: () => void;
}) {
  const [jql, setJql] = useState("");
  const [results, setResults] = useState<IssueSearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [idx, setIdx] = useState(0);
  const submitted = useRef(false);

  useInput(
    (_input, key) => {
      if (key.escape) onCancel();
    },
    { isActive: !submitted.current },
  );

  return (
    <Box flexDirection="column" padding={2} borderStyle="round" borderColor={theme.warn}>
      <Text color={theme.warn} bold>
        JQL query
      </Text>
      <Box marginTop={1}>
        <Text color={theme.muted}>› </Text>
        <TextInput
          value={jql}
          placeholder="e.g. assignee = currentUser() AND sprint in openSprints()"
          onChange={(v) => {
            setJql(v);
            setError(null);
          }}
          onSubmit={async () => {
            if (!jql.trim()) return;
            submitted.current = true;
            setLoading(true);
            setError(null);
            try {
              const r = await searchByJql(cfg, jql.trim());
              setResults(r);
              setIdx(0);
            } catch (e) {
              setError(errorMessage(e));
              setResults([]);
            } finally {
              setLoading(false);
              submitted.current = false;
            }
          }}
          onCancel={onCancel}
        />
      </Box>
      {error ? (
        <Box marginTop={1}>
          <Text color={theme.err}>{error}</Text>
        </Box>
      ) : null}
      {loading ? (
        <Box marginTop={1}>
          <Text color={theme.accent}>◴ searching…</Text>
        </Box>
      ) : results.length > 0 ? (
        <JqlResults results={results} idx={idx} setIdx={setIdx} onPick={onPick} />
      ) : submitted.current ? null : jql.trim() ? null : (
        <Box marginTop={1}>
          <Text color={theme.muted}>type a JQL query and press ⏎</Text>
        </Box>
      )}
      <Box marginTop={1}>
        <Hint k="⏎" label="search" />
        <Hint k="esc" label="close" />
      </Box>
    </Box>
  );
}

function JqlResults({
  results,
  idx,
  setIdx,
  onPick,
}: {
  results: IssueSearchResult[];
  idx: number;
  setIdx: (i: number) => void;
  onPick: (key: string) => void;
}) {
  const { rows } = useDimensions();
  const maxVisible = Math.max(5, rows - 12);
  const [scroll, setScroll] = useState(0);

  useEffect(() => {
    if (idx < scroll) setScroll(idx);
    else if (idx >= scroll + maxVisible) setScroll(idx - maxVisible + 1);
  }, [idx, scroll, maxVisible]);

  useInput((input, key) => {
    if (key.upArrow || input === "k") setIdx(clamp(idx - 1, 0, results.length - 1));
    else if (key.downArrow || input === "j") setIdx(clamp(idx + 1, 0, results.length - 1));
    else if (key.return) {
      const r = results[idx];
      if (r) onPick(r.key);
    }
  });

  const visible = results.slice(scroll, scroll + maxVisible);
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color={theme.muted}>
        {results.length} result{results.length === 1 ? "" : "s"}
      </Text>
      {scroll > 0 ? <Text color={theme.muted}> ▲ {scroll} more</Text> : null}
      {visible.map((r, i) => {
        const abs = scroll + i;
        const sel = abs === idx;
        return (
          <Box key={r.key}>
            <Text color={sel ? theme.accent : theme.muted}>{sel ? "▶ " : "  "}</Text>
            <Text color={sel ? theme.pink : theme.fgDim} bold={sel}>
              {r.key}
            </Text>
            <Text color={theme.muted}> · </Text>
            <Text color={sel ? theme.fg : theme.fgDim}>{truncate(r.summary, 60)}</Text>
            <Text color={theme.muted}> {r.issueType}</Text>
          </Box>
        );
      })}
      {results.length > scroll + maxVisible ? (
        <Text color={theme.muted}> ▼ {results.length - scroll - maxVisible} more</Text>
      ) : null}
    </Box>
  );
}
