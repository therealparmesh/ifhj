import { Box, Text, useInput } from "ink";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { JiraConfig } from "../config";
import { editInNeovim } from "../editor";
import { useDimensions } from "../hooks";
import {
  type Comment,
  type IssueDetail,
  type JiraUser,
  type Priority,
  type ProjectComponent,
  type ProjectVersion,
  addComment,
  fetchCurrentUser,
  getAssignableUsers,
  getIssueDetail,
  getLabels,
  getPriorities,
  getProjectComponents,
  getProjectVersions,
  searchIssues,
  unwatchIssue,
  updateComment,
  updateDescription,
  updateIssueField,
  updateSummary,
  watchIssue,
} from "../jira";
import {
  bg,
  clamp,
  copyToClipboard,
  errorMessage,
  openInBrowser,
  theme,
  truncate,
  typeColors,
  typeGlyph,
} from "../ui";
import { FilterPicker } from "./FilterPicker";
import { Hint } from "./Hint";
import { ListPicker } from "./ListPicker";
import { TextInput } from "./TextInput";
import { ToastStack, useToasts } from "./Toasts";

const DETAIL_LABEL_WIDTH = 11;
const CF_STORY_POINTS = "customfield_10016";

const pad2 = (n: number) => String(n).padStart(2, "0");

function formatShortDate(iso: string | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

type DetailLine = {
  text: string;
  color: string;
  bold?: boolean;
  commentIdx?: number | undefined;
  codeBg?: boolean;
};

function renderDetailLines(detail: IssueDetail, mainWidth: number): DetailLine[] {
  const out: DetailLine[] = [];
  const push = (text: string, color = theme.fg, bold = false, commentIdx?: number) =>
    out.push({ text, color, bold, commentIdx });
  const pushLine = (text: string, color = theme.fg, commentIdx?: number) => {
    if (text.length === 0) {
      push("", color, false, commentIdx);
      return;
    }
    for (let i = 0; i < text.length; i += mainWidth)
      push(text.slice(i, i + mainWidth), color, false, commentIdx);
  };
  const pushSection = (label: string) => {
    push("");
    push(label.toUpperCase(), theme.pink, true);
    push("─".repeat(Math.min(mainWidth, label.length + 6)), theme.accentDim);
  };

  pushSection("description");
  for (const ln of (detail.description || "—").split(/\n/)) pushLine(ln);

  if (detail.subtasks.length > 0) {
    pushSection(`sub-tasks (${detail.subtasks.length})`);
    for (const s of detail.subtasks)
      push(
        `${s.key} · ${s.statusName} · ${truncate(s.summary, mainWidth - s.key.length - 16)}`,
        theme.fgDim,
      );
  }

  if (detail.links.length > 0) {
    pushSection(`linked issues (${detail.links.length})`);
    for (const l of detail.links)
      push(
        `${l.direction} ${l.key} · ${l.statusName} · ${truncate(l.summary, mainWidth - l.key.length - l.direction.length - 16)}`,
        theme.fgDim,
      );
  }

  pushSection(`comments (${detail.comments.length})`);
  if (detail.comments.length === 0) {
    push("no comments yet", theme.muted);
    return out;
  }
  detail.comments.forEach((c, i) => {
    if (i > 0) push("·".repeat(Math.min(mainWidth, 20)), theme.accentDim, false, i);
    push(c.author, theme.cyan, true, i);
    push(formatShortDate(c.created), theme.muted, false, i);
    for (const ln of (c.body || "").split(/\n/)) pushLine(` ${ln}`, theme.fg, i);
  });

  let inCode = false;
  for (const ln of out) {
    if (ln.text.trimStart().startsWith("```")) {
      inCode = !inCode;
      ln.codeBg = true;
    } else if (inCode) {
      ln.codeBg = true;
    }
  }

  return out;
}

type Pane = "body" | "fields";

type FieldId =
  | "status"
  | "assignee"
  | "priority"
  | "parent"
  | "sprint"
  | "points"
  | "labels"
  | "components"
  | "fixVersions"
  | "due"
  | "reporter"
  | "created"
  | "updated";

const EDITABLE_FIELDS: FieldId[] = [
  "assignee",
  "priority",
  "parent",
  "points",
  "labels",
  "components",
  "fixVersions",
  "due",
];

const ALL_FIELDS: FieldId[] = [
  "status",
  "assignee",
  "reporter",
  "priority",
  "parent",
  "sprint",
  "points",
  "labels",
  "components",
  "fixVersions",
  "due",
  "created",
  "updated",
];

const FIELD_LABELS: Record<FieldId, string> = {
  status: "status",
  assignee: "assignee",
  reporter: "reporter",
  priority: "priority",
  parent: "parent",
  sprint: "sprint",
  points: "points",
  labels: "labels",
  components: "components",
  fixVersions: "fix vers",
  due: "due",
  created: "created",
  updated: "updated",
};

type Overlay =
  | { kind: "none" }
  | { kind: "nvim" }
  | { kind: "inline-input"; field: string; value: string }
  | { kind: "pick-assignee"; users: JiraUser[] }
  | { kind: "pick-priority"; priorities: Priority[] }
  | { kind: "pick-labels-action" }
  | { kind: "pick-labels-add"; all: string[] }
  | { kind: "pick-labels-remove" }
  | { kind: "pick-components-action" }
  | { kind: "pick-components-add"; all: ProjectComponent[] }
  | { kind: "pick-components-remove" }
  | { kind: "pick-versions-action" }
  | { kind: "pick-versions-add"; all: ProjectVersion[] }
  | { kind: "pick-versions-remove" }
  | { kind: "pick-comment-action"; comment: Comment }
  | { kind: "search-target" };

export function IssueDetailModal({
  cfg,
  projectKey,
  issueKey,
  onClose,
  onMove,
  onTransition,
  onCreateSubtask,
  onRefresh,
}: {
  cfg: JiraConfig;
  projectKey: string;
  issueKey: string;
  onClose: () => void;
  onMove: () => void;
  onTransition: () => void;
  onCreateSubtask: (parentKey: string) => void;
  onRefresh: () => void;
}) {
  const { cols: termCols, rows: termRows } = useDimensions();

  const [detail, setDetail] = useState<IssueDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const { toasts, flash: showFlash } = useToasts();

  const [pane, setPane] = useState<Pane>("body");
  const [bodyScroll, setBodyScroll] = useState(0);
  const [fieldIdx, setFieldIdx] = useState(0);
  const [overlay, setOverlay] = useState<Overlay>({ kind: "none" });
  const [saving, setSaving] = useState(false);

  const [myAccountId, setMyAccountId] = useState<string | null>(null);

  /**
   * Assignable-users cache, feeding Neovim's `@`-completion menu on every
   * description/comment edit. Lazy-fetched once per modal open — project
   * membership doesn't churn fast enough to be worth refreshing. The
   * `assignee`-field editor fetches its own list; keeping them separate
   * avoids reshuffling that path.
   */
  const usersRef = useRef<JiraUser[] | null>(null);
  const ensureUsers = useCallback(async (): Promise<JiraUser[]> => {
    try {
      if (!usersRef.current) {
        usersRef.current = await getAssignableUsers(cfg, projectKey);
      }
      return usersRef.current;
    } catch {
      return [];
    }
  }, [cfg, projectKey]);

  const [searchResults, setSearchResults] = useState<
    { key: string; summary: string; issueType: string }[]
  >([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const searchSeq = useRef(0);

  const fetchDetail = useCallback(async () => {
    try {
      const d = await getIssueDetail(cfg, issueKey);
      setDetail(d);
      setLoadError(null);
    } catch (e) {
      setLoadError(errorMessage(e));
    }
  }, [cfg, issueKey]);

  useEffect(() => {
    void fetchDetail();
  }, [fetchDetail]);

  useEffect(() => {
    if (myAccountId) return;
    fetchCurrentUser(cfg)
      .then((u) => setMyAccountId(u.accountId))
      .catch(() => {});
  }, [cfg, myAccountId]);

  const doSave = useCallback(
    async (fn: () => Promise<void>, successMsg: string) => {
      setSaving(true);
      try {
        await fn();
        showFlash(successMsg, "ok");
        await fetchDetail();
        onRefresh();
      } catch (e) {
        showFlash(errorMessage(e), "err");
      } finally {
        setSaving(false);
      }
    },
    [fetchDetail, showFlash, onRefresh],
  );

  // Layout
  const innerHeight = Math.max(10, termRows - 4);
  const innerWidth = Math.max(60, termCols - 4);
  const sideWidth = Math.min(Math.max(26, Math.floor(innerWidth * 0.34)), innerWidth - 30);
  const mainWidth = innerWidth - sideWidth;
  const bodyHeight = innerHeight - 4;

  const mainLines = useMemo(
    () => (detail ? renderDetailLines(detail, mainWidth) : []),
    [detail, mainWidth],
  );

  const commentLineIndices = useMemo(() => {
    const indices: number[] = [];
    let lastIdx = -1;
    for (let i = 0; i < mainLines.length; i++) {
      const ci = mainLines[i]!.commentIdx;
      if (ci !== undefined && ci !== lastIdx) {
        indices.push(i);
        lastIdx = ci;
      }
    }
    return indices;
  }, [mainLines]);

  const maxScroll = Math.max(0, mainLines.length - bodyHeight);

  const focusedCommentIdx = useMemo(() => {
    if (pane !== "body") return -1;
    for (let i = 0; i < mainLines.length; i++) {
      if (i >= bodyScroll && i < bodyScroll + bodyHeight) {
        const ci = mainLines[i]!.commentIdx;
        if (ci !== undefined) return ci;
      }
    }
    return -1;
  }, [pane, bodyScroll, bodyHeight, mainLines]);

  const currentField = ALL_FIELDS[fieldIdx];
  const isEditable = currentField ? EDITABLE_FIELDS.includes(currentField) : false;

  const doEditTitle = useCallback(() => {
    if (!detail) return;
    setOverlay({ kind: "inline-input", field: "title", value: detail.summary });
  }, [detail]);

  const doEditDesc = useCallback(async () => {
    if (!detail) return;
    setOverlay({ kind: "nvim" });
    try {
      const mentionUsers = await ensureUsers();
      const raw = await editInNeovim(detail.description, `${detail.key}-desc.md`, { mentionUsers });
      if (raw.trim() === detail.description.trim()) {
        showFlash("no change");
        setOverlay({ kind: "none" });
        return;
      }
      setOverlay({ kind: "none" });
      await doSave(() => updateDescription(cfg, detail.key, raw), "description updated");
    } catch (e) {
      showFlash(errorMessage(e), "err");
      setOverlay({ kind: "none" });
    }
  }, [detail, cfg, showFlash, doSave, ensureUsers]);

  const doAddComment = useCallback(async () => {
    if (!detail) return;
    setOverlay({ kind: "nvim" });
    try {
      const mentionUsers = await ensureUsers();
      const raw = await editInNeovim("", `${detail.key}-comment.md`, { mentionUsers });
      if (!raw.trim()) {
        showFlash("empty comment, not saved");
        setOverlay({ kind: "none" });
        return;
      }
      setOverlay({ kind: "none" });
      await doSave(() => addComment(cfg, detail.key, raw), "comment added");
    } catch (e) {
      showFlash(errorMessage(e), "err");
      setOverlay({ kind: "none" });
    }
  }, [detail, cfg, showFlash, doSave, ensureUsers]);

  const doEditComment = useCallback(
    async (comment: Comment) => {
      if (!detail) return;
      setOverlay({ kind: "nvim" });
      try {
        const mentionUsers = await ensureUsers();
        const raw = await editInNeovim(comment.body, `${detail.key}-comment-${comment.id}.md`, {
          mentionUsers,
        });
        if (raw.trim() === comment.body.trim()) {
          showFlash("no change");
          setOverlay({ kind: "none" });
          return;
        }
        setOverlay({ kind: "none" });
        await doSave(() => updateComment(cfg, detail.key, comment.id, raw), "comment updated");
      } catch (e) {
        showFlash(errorMessage(e), "err");
        setOverlay({ kind: "none" });
      }
    },
    [detail, cfg, showFlash, doSave, ensureUsers],
  );

  const openFieldEditor = useCallback(async () => {
    if (!detail || !currentField || !isEditable) return;

    if (currentField === "assignee") {
      try {
        const users = await getAssignableUsers(cfg, projectKey);
        setOverlay({ kind: "pick-assignee", users });
      } catch (e) {
        showFlash(errorMessage(e), "err");
      }
    } else if (currentField === "priority") {
      try {
        const priorities = await getPriorities(cfg);
        setOverlay({ kind: "pick-priority", priorities });
      } catch (e) {
        showFlash(errorMessage(e), "err");
      }
    } else if (currentField === "parent") {
      setOverlay({ kind: "search-target" });
    } else if (currentField === "points") {
      setOverlay({
        kind: "inline-input",
        field: "points",
        value: detail.storyPoints !== undefined ? String(detail.storyPoints) : "",
      });
    } else if (currentField === "due") {
      setOverlay({
        kind: "inline-input",
        field: "due",
        value: detail.dueDate ?? "",
      });
    } else if (currentField === "labels") {
      setOverlay({ kind: "pick-labels-action" });
    } else if (currentField === "components") {
      setOverlay({ kind: "pick-components-action" });
    } else if (currentField === "fixVersions") {
      setOverlay({ kind: "pick-versions-action" });
    }
  }, [detail, currentField, isEditable, cfg, projectKey, showFlash]);

  const clearField = useCallback(async () => {
    if (!detail || !currentField || !isEditable) return;
    if (currentField === "assignee") {
      await doSave(() => updateIssueField(cfg, detail.key, { assignee: null }), "assignee cleared");
    } else if (currentField === "priority") {
      showFlash("priority cannot be cleared");
    } else if (currentField === "parent") {
      await doSave(() => updateIssueField(cfg, detail.key, { parent: null }), "parent cleared");
    } else if (currentField === "points") {
      await doSave(
        () => updateIssueField(cfg, detail.key, { [CF_STORY_POINTS]: null }),
        "points cleared",
      );
    } else if (currentField === "due") {
      await doSave(() => updateIssueField(cfg, detail.key, { duedate: null }), "due date cleared");
    } else if (currentField === "labels") {
      if (detail.labels.length === 0) {
        showFlash("no labels to clear");
        return;
      }
      await doSave(() => updateIssueField(cfg, detail.key, { labels: [] }), "labels cleared");
    } else if (currentField === "components") {
      if (detail.components.length === 0) {
        showFlash("no components to clear");
        return;
      }
      await doSave(
        () => updateIssueField(cfg, detail.key, { components: [] }),
        "components cleared",
      );
    } else if (currentField === "fixVersions") {
      if (detail.fixVersions.length === 0) {
        showFlash("no fix versions to clear");
        return;
      }
      await doSave(
        () => updateIssueField(cfg, detail.key, { fixVersions: [] }),
        "fix versions cleared",
      );
    }
  }, [detail, currentField, isEditable, cfg, doSave, showFlash]);

  // Main input handler
  useInput(
    (input, key) => {
      if (key.escape || input === "q" || (key.ctrl && input === "c")) return onClose();
      if (input === "e") return void doEditTitle();
      if (input === "E") return void doEditDesc();
      if (input === "o") {
        openInBrowser(`${cfg.server}/browse/${issueKey}`)
          .then(() => showFlash(`opened ${issueKey}`, "ok"))
          .catch((e) => showFlash(errorMessage(e), "err"));
        return;
      }
      if (input === "m") return onMove();
      if (input === "t") return onTransition();
      if (input === "c") return void doAddComment();
      if (input === "C") return onCreateSubtask(issueKey);
      if (input === "y") {
        copyToClipboard(issueKey)
          .then(() => showFlash(`copied ${issueKey}`, "ok"))
          .catch((err) => showFlash(errorMessage(err), "err"));
        return;
      }
      if (input === "Y") {
        const url = `${cfg.server}/browse/${issueKey}`;
        copyToClipboard(url)
          .then(() => showFlash("copied URL", "ok"))
          .catch((err) => showFlash(errorMessage(err), "err"));
        return;
      }
      if (input === "w" && detail) {
        const watching = detail.watching;
        const fn = watching ? () => unwatchIssue(cfg, issueKey) : () => watchIssue(cfg, issueKey);
        void doSave(fn, watching ? "unwatched" : "watching");
        return;
      }
      if (key.tab) {
        setPane((p) => (p === "body" ? "fields" : "body"));
        return;
      }

      if (pane === "body") {
        if (key.downArrow || input === "j") setBodyScroll((s) => Math.min(s + 1, maxScroll));
        else if (key.upArrow || input === "k") setBodyScroll((s) => Math.max(0, s - 1));
        else if (key.pageDown) setBodyScroll((s) => Math.min(s + bodyHeight, maxScroll));
        else if (key.pageUp) setBodyScroll((s) => Math.max(0, s - bodyHeight));
        else if (input === "g") setBodyScroll(0);
        else if (input === "G") setBodyScroll(maxScroll);
        else if (input === "]") {
          const next = commentLineIndices.find((i) => i > bodyScroll);
          if (next !== undefined) setBodyScroll(Math.min(next, maxScroll));
        } else if (input === "[") {
          const prev = commentLineIndices.toReversed().find((i) => i < bodyScroll);
          if (prev !== undefined) setBodyScroll(prev);
        } else if (key.return && detail) {
          const ci = focusedCommentIdx;
          if (ci >= 0 && ci < detail.comments.length) {
            const comment = detail.comments[ci]!;
            const isMine = myAccountId ? comment.authorAccountId === myAccountId : false;
            if (isMine) {
              setOverlay({ kind: "pick-comment-action", comment });
            } else {
              showFlash(`${comment.author}'s comment — not editable`);
            }
          }
        }
      } else {
        if (key.downArrow || input === "j")
          setFieldIdx((i) => clamp(i + 1, 0, ALL_FIELDS.length - 1));
        else if (key.upArrow || input === "k")
          setFieldIdx((i) => clamp(i - 1, 0, ALL_FIELDS.length - 1));
        else if (input === "g") setFieldIdx(0);
        else if (input === "G") setFieldIdx(ALL_FIELDS.length - 1);
        else if (key.return) void openFieldEditor();
        else if (input === "x" || (key.ctrl && input === "x")) void clearField();
      }
    },
    { isActive: overlay.kind === "none" && !saving },
  );

  // Overlays
  if (overlay.kind === "nvim") {
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

  if (overlay.kind === "inline-input") {
    return (
      <InlineFieldInput
        field={overlay.field}
        initial={overlay.value}
        onCancel={() => setOverlay({ kind: "none" })}
        onSubmit={async (val) => {
          setOverlay({ kind: "none" });
          if (!detail) return;
          if (overlay.field === "title") {
            const next = val.trim();
            if (!next) {
              showFlash("summary empty, not saved");
              return;
            }
            if (next === detail.summary.trim()) {
              showFlash("no change");
              return;
            }
            await doSave(() => updateSummary(cfg, detail.key, next), "title updated");
          } else if (overlay.field === "points") {
            const n = val.trim() === "" ? null : Number(val);
            if (n !== null && Number.isNaN(n)) {
              showFlash("invalid number");
              return;
            }
            await doSave(
              () => updateIssueField(cfg, detail.key, { [CF_STORY_POINTS]: n }),
              n === null ? "points cleared" : "points updated",
            );
          } else if (overlay.field === "due") {
            const v = val.trim() || null;
            if (v && !/^\d{4}-\d{2}-\d{2}$/.test(v)) {
              showFlash("use YYYY-MM-DD format");
              return;
            }
            await doSave(
              () => updateIssueField(cfg, detail.key, { duedate: v }),
              v ? "due date updated" : "due date cleared",
            );
          }
        }}
      />
    );
  }

  if (overlay.kind === "pick-assignee") {
    const items = [
      { id: "__unassign__", label: "(Unassigned)" },
      ...overlay.users.map((u) => ({ id: u.accountId, label: u.displayName })),
    ];
    const currentId = detail
      ? overlay.users.find((u) => u.displayName === detail.assignee)?.accountId
      : undefined;
    return (
      <FilterPicker
        title="assignee"
        items={items}
        {...(currentId ? { currentId } : {})}
        onPick={async (id) => {
          setOverlay({ kind: "none" });
          if (!detail) return;
          const value = id === "__unassign__" ? null : { accountId: id };
          await doSave(
            () => updateIssueField(cfg, detail.key, { assignee: value }),
            id === "__unassign__" ? "assignee cleared" : "assignee updated",
          );
        }}
        onClear={() => {
          setOverlay({ kind: "none" });
          if (!detail) return;
          void doSave(
            () => updateIssueField(cfg, detail.key, { assignee: null }),
            "assignee cleared",
          );
        }}
        onCancel={() => setOverlay({ kind: "none" })}
      />
    );
  }

  if (overlay.kind === "pick-priority") {
    const currentId = detail
      ? overlay.priorities.find((p) => p.name === detail.priority)?.id
      : undefined;
    return (
      <FilterPicker
        title="priority"
        items={overlay.priorities.map((p) => ({ id: p.id, label: p.name }))}
        {...(currentId ? { currentId } : {})}
        onPick={async (id) => {
          setOverlay({ kind: "none" });
          if (!detail) return;
          await doSave(
            () => updateIssueField(cfg, detail.key, { priority: { id } }),
            "priority updated",
          );
        }}
        onCancel={() => setOverlay({ kind: "none" })}
      />
    );
  }

  if (overlay.kind === "search-target") {
    return (
      <FilterPicker
        title="parent issue"
        items={searchResults.map((r) => ({
          id: r.key,
          label: `${r.key}  ${truncate(r.summary, 80)}`,
          hint: r.issueType,
        }))}
        loading={searchLoading}
        placeholder="type summary or issue key…"
        onQueryChange={(q) => {
          const seq = ++searchSeq.current;
          setSearchLoading(true);
          (async () => {
            try {
              const r = await searchIssues(cfg, projectKey, q);
              if (seq === searchSeq.current) setSearchResults(r);
            } catch {
              if (seq === searchSeq.current) setSearchResults([]);
            } finally {
              if (seq === searchSeq.current) setSearchLoading(false);
            }
          })();
        }}
        onPick={async (id) => {
          setOverlay({ kind: "none" });
          if (!detail) return;
          await doSave(
            () => updateIssueField(cfg, detail.key, { parent: { key: id } }),
            `parent set to ${id}`,
          );
        }}
        onClear={() => {
          setOverlay({ kind: "none" });
          if (!detail) return;
          void doSave(() => updateIssueField(cfg, detail.key, { parent: null }), "parent cleared");
        }}
        onCancel={() => setOverlay({ kind: "none" })}
      />
    );
  }

  if (overlay.kind === "pick-labels-action") {
    return (
      <ListPicker
        title="labels"
        items={[
          { id: "add", label: "add label" },
          ...(detail && detail.labels.length > 0 ? [{ id: "remove", label: "remove label" }] : []),
          ...(detail && detail.labels.length > 0 ? [{ id: "clear", label: "clear all" }] : []),
        ]}
        onPick={async (id) => {
          if (id === "add") {
            try {
              const all = await getLabels(cfg);
              setOverlay({ kind: "pick-labels-add", all });
            } catch (e) {
              showFlash(errorMessage(e), "err");
              setOverlay({ kind: "none" });
            }
          } else if (id === "remove") {
            setOverlay({ kind: "pick-labels-remove" });
          } else if (id === "clear") {
            setOverlay({ kind: "none" });
            if (detail) {
              await doSave(
                () => updateIssueField(cfg, detail.key, { labels: [] }),
                "labels cleared",
              );
            }
          }
        }}
        onCancel={() => setOverlay({ kind: "none" })}
      />
    );
  }

  if (overlay.kind === "pick-labels-add") {
    const existing = new Set(detail?.labels ?? []);
    const available = overlay.all.filter((l) => !existing.has(l));
    return (
      <FilterPicker
        title="add label"
        items={available.map((l) => ({ id: l, label: l }))}
        onPick={async (id) => {
          setOverlay({ kind: "none" });
          if (!detail) return;
          await doSave(
            () => updateIssueField(cfg, detail.key, { labels: [...detail.labels, id] }),
            `label "${id}" added`,
          );
        }}
        onCancel={() => setOverlay({ kind: "none" })}
      />
    );
  }

  if (overlay.kind === "pick-labels-remove") {
    return (
      <FilterPicker
        title="remove label"
        items={(detail?.labels ?? []).map((l) => ({ id: l, label: l }))}
        onPick={async (id) => {
          setOverlay({ kind: "none" });
          if (!detail) return;
          await doSave(
            () =>
              updateIssueField(cfg, detail.key, {
                labels: detail.labels.filter((l) => l !== id),
              }),
            `label "${id}" removed`,
          );
        }}
        onCancel={() => setOverlay({ kind: "none" })}
      />
    );
  }

  if (overlay.kind === "pick-components-action") {
    return (
      <ListPicker
        title="components"
        items={[
          { id: "add", label: "add component" },
          ...(detail && detail.components.length > 0
            ? [{ id: "remove", label: "remove component" }]
            : []),
          ...(detail && detail.components.length > 0 ? [{ id: "clear", label: "clear all" }] : []),
        ]}
        onPick={async (id) => {
          if (id === "add") {
            try {
              const all = await getProjectComponents(cfg, projectKey);
              setOverlay({ kind: "pick-components-add", all });
            } catch (e) {
              showFlash(errorMessage(e), "err");
              setOverlay({ kind: "none" });
            }
          } else if (id === "remove") {
            setOverlay({ kind: "pick-components-remove" });
          } else if (id === "clear") {
            setOverlay({ kind: "none" });
            if (detail) {
              await doSave(
                () => updateIssueField(cfg, detail.key, { components: [] }),
                "components cleared",
              );
            }
          }
        }}
        onCancel={() => setOverlay({ kind: "none" })}
      />
    );
  }

  if (overlay.kind === "pick-components-add") {
    const existing = new Set(detail?.components ?? []);
    const available = overlay.all.filter((c) => !existing.has(c.name));
    return (
      <FilterPicker
        title="add component"
        items={available.map((c) => ({ id: c.id, label: c.name }))}
        onPick={async (id) => {
          setOverlay({ kind: "none" });
          if (!detail) return;
          const comp = overlay.all.find((c) => c.id === id);
          if (!comp) return;
          await doSave(
            () =>
              updateIssueField(cfg, detail.key, {
                components: [
                  ...detail.components.map((n) => {
                    const found = overlay.all.find((c) => c.name === n);
                    return found ? { id: found.id } : { name: n };
                  }),
                  { id: comp.id },
                ],
              }),
            `component "${comp.name}" added`,
          );
        }}
        onCancel={() => setOverlay({ kind: "none" })}
      />
    );
  }

  if (overlay.kind === "pick-components-remove") {
    return (
      <FilterPicker
        title="remove component"
        items={(detail?.components ?? []).map((c) => ({ id: c, label: c }))}
        onPick={async (id) => {
          setOverlay({ kind: "none" });
          if (!detail) return;
          await doSave(
            () =>
              updateIssueField(cfg, detail.key, {
                components: detail.components.filter((c) => c !== id).map((c) => ({ name: c })),
              }),
            `component "${id}" removed`,
          );
        }}
        onCancel={() => setOverlay({ kind: "none" })}
      />
    );
  }

  if (overlay.kind === "pick-versions-action") {
    return (
      <ListPicker
        title="fix versions"
        items={[
          { id: "add", label: "add version" },
          ...(detail && detail.fixVersions.length > 0
            ? [{ id: "remove", label: "remove version" }]
            : []),
          ...(detail && detail.fixVersions.length > 0 ? [{ id: "clear", label: "clear all" }] : []),
        ]}
        onPick={async (id) => {
          if (id === "add") {
            try {
              const all = await getProjectVersions(cfg, projectKey);
              setOverlay({ kind: "pick-versions-add", all });
            } catch (e) {
              showFlash(errorMessage(e), "err");
              setOverlay({ kind: "none" });
            }
          } else if (id === "remove") {
            setOverlay({ kind: "pick-versions-remove" });
          } else if (id === "clear") {
            setOverlay({ kind: "none" });
            if (detail) {
              await doSave(
                () => updateIssueField(cfg, detail.key, { fixVersions: [] }),
                "fix versions cleared",
              );
            }
          }
        }}
        onCancel={() => setOverlay({ kind: "none" })}
      />
    );
  }

  if (overlay.kind === "pick-versions-add") {
    const existing = new Set(detail?.fixVersions ?? []);
    const available = overlay.all.filter((v) => !existing.has(v.name));
    return (
      <FilterPicker
        title="add version"
        items={available.map((v) => ({
          id: v.id,
          label: v.name,
          hint: v.released ? "released" : undefined,
        }))}
        onPick={async (id) => {
          setOverlay({ kind: "none" });
          if (!detail) return;
          const ver = overlay.all.find((v) => v.id === id);
          if (!ver) return;
          await doSave(
            () =>
              updateIssueField(cfg, detail.key, {
                fixVersions: [
                  ...detail.fixVersions.map((n) => {
                    const found = overlay.all.find((v) => v.name === n);
                    return found ? { id: found.id } : { name: n };
                  }),
                  { id: ver.id },
                ],
              }),
            `version "${ver.name}" added`,
          );
        }}
        onCancel={() => setOverlay({ kind: "none" })}
      />
    );
  }

  if (overlay.kind === "pick-versions-remove") {
    return (
      <FilterPicker
        title="remove version"
        items={(detail?.fixVersions ?? []).map((v) => ({ id: v, label: v }))}
        onPick={async (id) => {
          setOverlay({ kind: "none" });
          if (!detail) return;
          await doSave(
            () =>
              updateIssueField(cfg, detail.key, {
                fixVersions: detail.fixVersions.filter((v) => v !== id).map((v) => ({ name: v })),
              }),
            `version "${id}" removed`,
          );
        }}
        onCancel={() => setOverlay({ kind: "none" })}
      />
    );
  }

  if (overlay.kind === "pick-comment-action") {
    const comment = overlay.comment;
    return (
      <ListPicker
        title={`${comment.author} · ${formatShortDate(comment.created)}`}
        items={[{ id: "edit", label: "edit comment (Neovim)" }]}
        onPick={(id) => {
          if (id === "edit") {
            setOverlay({ kind: "none" });
            void doEditComment(comment);
          }
        }}
        onCancel={() => setOverlay({ kind: "none" })}
      />
    );
  }

  // Error state
  if (loadError) {
    return (
      <Box
        flexDirection="column"
        width={innerWidth + 2}
        height={innerHeight + 2}
        borderStyle="round"
        borderColor={theme.err}
        padding={1}
      >
        <Text color={theme.err} bold>
          failed to load {issueKey}
        </Text>
        <Box marginTop={1}>
          <Text color={theme.fg}>{loadError}</Text>
        </Box>
        <Box marginTop={1}>
          <Text color={theme.muted}>esc / q close</Text>
        </Box>
      </Box>
    );
  }

  // Loading state
  if (!detail) {
    return (
      <Box
        flexDirection="column"
        width={innerWidth + 2}
        height={innerHeight + 2}
        borderStyle="round"
        borderColor={theme.accent}
        padding={1}
      >
        <Text color={theme.accent}>◴ loading {issueKey}…</Text>
      </Box>
    );
  }

  const typeColor = typeColors[detail.issueType] ?? theme.fg;
  const clampedScroll = Math.min(bodyScroll, maxScroll);
  const visibleMain = mainLines.slice(clampedScroll, clampedScroll + bodyHeight);

  return (
    <Box
      flexDirection="column"
      width={innerWidth + 2}
      height={innerHeight + 2}
      borderStyle="round"
      borderColor={theme.accent}
    >
      {/* Header */}
      <Box paddingX={1}>
        <Text color={typeColor}>{typeGlyph(detail.issueType)} </Text>
        <Text color={theme.pink} bold>
          {detail.key}
        </Text>
        <Text color={theme.muted}> · </Text>
        <Text color={typeColor}>{detail.issueType}</Text>
        {detail.parentKey ? (
          <>
            <Text color={theme.muted}> · </Text>
            <Text color={theme.violet}>{detail.parentKey}</Text>
          </>
        ) : null}
        {detail.watching ? <Text color={theme.cyan}> ◉</Text> : null}
        {saving ? <Text color={theme.warn}> ◴ saving…</Text> : null}
      </Box>
      <Box paddingX={1}>
        <Text color={theme.fg} bold>
          {truncate(detail.summary, innerWidth - 4)}
        </Text>
      </Box>
      <Box paddingX={1}>
        <Text color={theme.accentDim}>{"─".repeat(Math.max(0, innerWidth))}</Text>
      </Box>

      {/* Body: main + side */}
      <Box flexDirection="row" flexGrow={1}>
        <Box flexDirection="column" width={mainWidth} paddingX={1}>
          {visibleMain.map((ln, i) => {
            const lineCommentIdx = ln.commentIdx;
            const isCommentHeader =
              lineCommentIdx !== undefined &&
              ln.bold &&
              pane === "body" &&
              lineCommentIdx === focusedCommentIdx;
            return (
              <Text
                key={`${clampedScroll + i}`}
                color={ln.color}
                bold={ln.bold ?? false}
                wrap="truncate"
                {...bg(isCommentHeader ? theme.accentDim : ln.codeBg ? theme.accentDim : undefined)}
              >
                {ln.text || " "}
              </Text>
            );
          })}
        </Box>

        <Box
          flexDirection="column"
          width={sideWidth}
          paddingX={1}
          borderLeft
          borderTop={false}
          borderBottom={false}
          borderRight={false}
          borderStyle="single"
          borderColor={pane === "fields" ? theme.accent : theme.accentDim}
        >
          {ALL_FIELDS.map((f, i) => (
            <SideField
              key={f}
              field={f}
              detail={detail}
              focused={pane === "fields" && i === fieldIdx}
              editable={EDITABLE_FIELDS.includes(f)}
              sideWidth={sideWidth - 3}
            />
          ))}
        </Box>
      </Box>

      {/* Footer */}
      <Box paddingX={1}>
        <Text color={theme.accentDim}>{"─".repeat(Math.max(0, innerWidth))}</Text>
      </Box>
      <Box paddingX={1} justifyContent="space-between">
        <Box flexWrap="wrap">
          <Hint k="tab" label="pane" />
          <Hint k="↑↓" label="scroll" />
          {pane === "body" ? (
            <>
              <Hint k="[ ]" label="comment" />
              <Hint k="c" label="add comment" />
            </>
          ) : (
            <>
              <Hint k="⏎" label="edit" />
              <Hint k="x" label="clear" />
            </>
          )}
          <Hint k="e E" label="title/desc" />
          <Hint k="t" label="transition" />
          <Hint k="m" label="move" />
          <Hint k="C" label="subtask" />
          <Hint k="w" label={detail.watching ? "unwatch" : "watch"} />
          <Hint k="y" label="yank" />
          <Hint k="esc" label="close" />
        </Box>
        <Text color={theme.muted}>
          {clampedScroll + 1}-{Math.min(clampedScroll + bodyHeight, mainLines.length)} /{" "}
          {mainLines.length}
        </Text>
      </Box>
      <ToastStack toasts={toasts} maxWidth={innerWidth} />
    </Box>
  );
}

function SideField({
  field,
  detail,
  focused,
  editable,
  sideWidth,
}: {
  field: FieldId;
  detail: IssueDetail;
  focused: boolean;
  editable: boolean;
  sideWidth: number;
}) {
  const value = fieldDisplayValue(field, detail);
  const color = fieldColor(field, detail);
  const pointer = focused ? "▶" : " ";
  const pointerColor = focused ? theme.accent : theme.muted;
  const valueMax = Math.max(4, sideWidth - DETAIL_LABEL_WIDTH - 2);
  return (
    <Box>
      <Text color={pointerColor}>{pointer}</Text>
      <Text color={focused ? theme.accent : theme.muted}>
        {FIELD_LABELS[field].padEnd(DETAIL_LABEL_WIDTH)}
      </Text>
      <Text
        color={focused ? theme.fg : color}
        bold={focused}
        wrap="truncate"
        {...bg(focused ? theme.accentDim : undefined)}
      >
        {truncate(value, valueMax)}
      </Text>
      {focused && editable ? <Text color={theme.muted}> ⏎</Text> : null}
    </Box>
  );
}

function fieldDisplayValue(field: FieldId, d: IssueDetail): string {
  if (field === "status") return d.statusName;
  if (field === "assignee") return d.assignee ?? "Unassigned";
  if (field === "reporter") return d.reporter ?? "—";
  if (field === "priority") return d.priority ?? "—";
  if (field === "parent") return d.parentKey ?? d.epicKey ?? "—";
  if (field === "sprint") return d.sprint ?? "—";
  if (field === "points") return d.storyPoints !== undefined ? String(d.storyPoints) : "—";
  if (field === "labels") return d.labels.length === 0 ? "—" : d.labels.join(", ");
  if (field === "components") return d.components.length === 0 ? "—" : d.components.join(", ");
  if (field === "fixVersions") return d.fixVersions.length === 0 ? "—" : d.fixVersions.join(", ");
  if (field === "due") return d.dueDate ?? "—";
  if (field === "created") return formatShortDate(d.created);
  if (field === "updated") return formatShortDate(d.updated);
  return "—";
}

function fieldColor(field: FieldId, _d: IssueDetail): string {
  if (field === "status") return theme.ok;
  if (field === "parent") return theme.violet;
  if (field === "labels") return theme.cyan;
  if (field === "due") return theme.warn;
  return theme.fg;
}

function InlineFieldInput({
  field,
  initial,
  onCancel,
  onSubmit,
}: {
  field: string;
  initial: string;
  onCancel: () => void;
  onSubmit: (value: string) => void;
}) {
  const [value, setValue] = useState(initial);
  const hint =
    field === "title"
      ? "issue title"
      : field === "points"
        ? "enter a number (empty to clear)"
        : "YYYY-MM-DD (empty to clear)";
  return (
    <Box flexDirection="column" padding={2} borderStyle="round" borderColor={theme.accent}>
      <Text color={theme.accent} bold>
        {field}
      </Text>
      <Box marginTop={1}>
        <Text color={theme.muted}>› </Text>
        <TextInput
          value={value}
          placeholder={hint}
          onChange={setValue}
          onSubmit={() => onSubmit(value)}
          onCancel={onCancel}
        />
      </Box>
      <Box marginTop={1}>
        <Hint k="⏎" label="save" />
        <Hint k="esc" label="cancel" />
      </Box>
    </Box>
  );
}
