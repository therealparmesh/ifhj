import { Box, Text, useInput } from "ink";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { JiraConfig } from "../config";
import { editInNeovim } from "../editor";
import { useDimensions } from "../hooks";
import {
  type BoardColumn,
  type BoardConfig,
  type Issue,
  type IssueDetail,
  type IssueLinkType,
  type IssueType,
  type Transition,
  getBoardConfig,
  getBoardIssues,
  getIssueDetail,
  getIssueLinkTypes,
  getIssueTypes,
  getTransitions,
  transitionIssue,
  updateDescription,
  updateSummary,
} from "../jira";
import { clamp, errorMessage, openInBrowser, theme } from "../ui";
import { BoardHeader } from "./BoardHeader";
import { CreateWizard } from "./CreateWizard";
import { FilterPicker } from "./FilterPicker";
import { type FlashStatus, Footer, type Tone } from "./Footer";
import { HelpModal } from "./HelpModal";
import { IssueDetailModal } from "./IssueDetailModal";
import { type Column, ColumnView, PagingArrow } from "./Kanban";
import { ListPicker } from "./ListPicker";

// How long a toast message lingers in the footer before auto-clearing.
const FLASH_TTL_MS = 3500;
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
  | { kind: "assignee-picker"; names: string[] }
  | { kind: "create"; types: IssueType[]; linkTypes: IssueLinkType[] }
  | { kind: "detail"; issueKey: string; detail: IssueDetail | null; error: string | null };

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
  const [status, setStatus] = useState<FlashStatus | null>(null);
  const statusTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [query, setQuery] = useState("");
  const [matchIdx, setMatchIdx] = useState(0);
  const [modal, setModal] = useState<Modal>({ kind: "none" });
  const [searchBuffer, setSearchBuffer] = useState("");
  const [assigneeFilter, setAssigneeFilter] = useState<string | null>(null);

  // Link & issue types don't change for the life of the board — fetch once, reuse.
  const metaCache = useRef<{ types: IssueType[]; linkTypes: IssueLinkType[] } | null>(null);
  // First load is fatal; reload failures just flash a toast.
  const hasLoadedOnce = useRef(false);
  // After a transition, follow the moved card to its new column on reload.
  const pendingFocusKey = useRef<string | null>(null);

  const setActiveRowAt = useCallback((col: number, row: number) => {
    setActiveRows((prev) => {
      const arr = prev.slice();
      arr[col] = row;
      return arr;
    });
  }, []);
  const closeModal = useCallback(() => setModal({ kind: "none" }), []);

  const flash = useCallback((text: string, tone: Tone = "info") => {
    setStatus({ text, tone });
    if (statusTimer.current) clearTimeout(statusTimer.current);
    statusTimer.current = setTimeout(() => setStatus(null), FLASH_TTL_MS);
  }, []);

  // Kill the flash timer on unmount — otherwise it fires on a dead component.
  useEffect(
    () => () => {
      if (statusTimer.current) clearTimeout(statusTimer.current);
    },
    [],
  );

  const filteredIssues = useMemo(
    () =>
      assigneeFilter
        ? issues.filter((i) => (i.assignee ?? "Unassigned") === assigneeFilter)
        : issues,
    [issues, assigneeFilter],
  );
  const columns = useMemo(
    () => (conf ? buildColumns(conf.columns, filteredIssues) : []),
    [conf, filteredIssues],
  );
  const assigneeNames = useMemo(() => {
    const set = new Set<string>();
    for (const i of issues) set.add(i.assignee ?? "Unassigned");
    /**
     * Pin "Unassigned" to the top regardless of alphabetical order — it's
     * the special bucket, not a real person.
     */
    return Array.from(set).toSorted((a, b) => {
      if (a === "Unassigned") return -1;
      if (b === "Unassigned") return 1;
      return a.localeCompare(b);
    });
  }, [issues]);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const [c, is] = await Promise.all([
        getBoardConfig(cfg, board.id),
        getBoardIssues(cfg, board.id),
      ]);
      setConf(c);
      setIssues(is);
      setActiveRows((prev) => c.columns.map((_, i) => prev[i] ?? 0));
      setScrolls((prev) => c.columns.map((_, i) => prev[i] ?? 0));
      hasLoadedOnce.current = true;
    } catch (e) {
      const msg = errorMessage(e);
      // Fatal on first load; toast on reload so the user keeps their place.
      if (hasLoadedOnce.current) flash(msg, "err");
      else setLoadError(msg);
    }
  }, [cfg, board.id, flash]);

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
  const footerRows = modal.kind === "search" ? 6 : status ? 5 : 4;
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

  const doEditSummary = useCallback(async () => {
    const issue = currentIssue;
    if (!issue) return;
    try {
      const raw = await editInNeovim(issue.summary, `${issue.key}-title.md`);
      const next = (raw.split(/\n/, 1)[0] ?? "").trim();
      if (!next) {
        flash("summary empty, not saved", "info");
        return;
      }
      if (next === issue.summary.trim()) {
        flash("no change", "info");
        return;
      }
      await updateSummary(cfg, issue.key, next);
      flash(`${issue.key} summary updated`, "ok");
      await load();
    } catch (e) {
      flash(errorMessage(e), "err");
    }
  }, [currentIssue, cfg, flash, load]);

  const doEditDescription = useCallback(async () => {
    const issue = currentIssue;
    if (!issue) return;
    try {
      const raw = await editInNeovim(issue.description, `${issue.key}-desc.md`);
      /**
       * Compare trimmed — a stray trailing newline from Neovim shouldn't
       * trigger a spurious round-trip.
       */
      if (raw.trim() === issue.description.trim()) {
        flash("no change", "info");
        return;
      }
      await updateDescription(cfg, issue.key, raw);
      flash(`${issue.key} description updated`, "ok");
      await load();
    } catch (e) {
      flash(errorMessage(e), "err");
    }
  }, [currentIssue, cfg, flash, load]);

  const openDetailForKey = useCallback(
    async (key: string) => {
      setModal({ kind: "detail", issueKey: key, detail: null, error: null });
      try {
        const detail = await getIssueDetail(cfg, key);
        setModal((m) => (m.kind === "detail" && m.issueKey === key ? { ...m, detail } : m));
      } catch (e) {
        const msg = errorMessage(e);
        setModal((m) => (m.kind === "detail" && m.issueKey === key ? { ...m, error: msg } : m));
      }
    },
    [cfg],
  );

  const openDetail = useCallback(async () => {
    const issue = currentIssue;
    if (!issue) {
      flash("no issue selected", "info");
      return;
    }
    await openDetailForKey(issue.key);
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
      if (key.leftArrow) return nudgeCol(-1);
      if (key.rightArrow) return nudgeCol(1);
      if (key.upArrow) return nudgeRow(-1);
      if (key.downArrow) return nudgeRow(1);

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
      if (input === "<" || input === ",") return void doTransition(-1);
      if (input === ">" || input === ".") return void doTransition(1);

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

      // Assignee filter
      if (input === "a") {
        if (assigneeNames.length === 0) return flash("no assignees to filter", "info");
        setModal({ kind: "assignee-picker", names: assigneeNames });
        return;
      }
      if (input === "A") {
        if (assigneeFilter) {
          setAssigneeFilter(null);
          flash("assignee filter cleared", "ok");
        } else {
          flash("no assignee filter active", "info");
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
  if (modal.kind === "help") return <HelpModal onClose={closeModal} />;
  if (modal.kind === "card-action" && currentIssue) {
    return (
      <ListPicker
        title={`${currentIssue.key} · ${currentIssue.summary.slice(0, 60)}`}
        items={[
          { id: "detail", label: "view details" },
          { id: "title", label: "edit title (Neovim)" },
          { id: "desc", label: "edit description (Neovim)" },
          { id: "move", label: "move to column…" },
          { id: "prev", label: "transition ← prev column" },
          { id: "next", label: "transition → next column" },
          { id: "open", label: "open in browser" },
        ]}
        onCancel={closeModal}
        onPick={(id) => {
          closeModal();
          if (id === "detail") void openDetail();
          else if (id === "title") void doEditSummary();
          else if (id === "desc") void doEditDescription();
          else if (id === "move") setModal({ kind: "move-picker" });
          else if (id === "prev") void doTransition(-1);
          else if (id === "next") void doTransition(1);
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
  if (modal.kind === "detail") {
    return (
      <IssueDetailModal
        issueKey={modal.issueKey}
        detail={modal.detail}
        error={modal.error}
        onClose={closeModal}
        onEditTitle={() => {
          closeModal();
          void doEditSummary();
        }}
        onEditDesc={() => {
          closeModal();
          void doEditDescription();
        }}
        onOpenWeb={() => void openIssueInBrowser()}
        onMove={() => setModal({ kind: "move-picker", issueKey: modal.issueKey })}
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
  if (modal.kind === "assignee-picker") {
    return (
      <FilterPicker
        title="filter by assignee"
        items={modal.names.map((n) => ({ id: n, label: n }))}
        {...(assigneeFilter ? { currentId: assigneeFilter } : {})}
        borderColor={theme.cyan}
        onPick={(id) => {
          setAssigneeFilter(id);
          closeModal();
          flash(`filtering by ${id}`, "ok");
        }}
        onClear={() => {
          setAssigneeFilter(null);
          closeModal();
          flash("assignee filter cleared", "ok");
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
        assigneeFilter={assigneeFilter}
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
        status={status}
        mode={modal.kind === "search" ? "search" : "normal"}
        query={query}
        matches={matches.length}
        matchIdx={matchIdx}
        assigneeFilter={assigneeFilter}
        searchBuffer={searchBuffer}
        onSearchChange={setSearchBuffer}
        onSearchSubmit={(q) => {
          commitQuery(q);
          closeModal();
        }}
        onSearchCancel={() => {
          /**
           * Escape closes the search bar but keeps the committed query — the
           * user may have hit `/` just to peek. Use ⌃u inside the buffer
           * to actually clear it.
           */
          closeModal();
        }}
      />
    </Box>
  );
}
