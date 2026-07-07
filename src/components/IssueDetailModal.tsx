import { Box, Text, useInput } from "ink";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { JiraConfig } from "../config";
import { coerceFieldValue } from "../customFields";
import { editInNeovim } from "../editor";
import { useDimensions, useLoading } from "../hooks";
import {
  type Comment,
  type CustomField,
  type EditableField,
  type EditableFieldValue,
  type IssueDetail,
  type JiraUser,
  addComment,
  fetchCurrentUser,
  getAssignableUsers,
  getIssueDetail,
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
  fg,
  openInBrowser,
  theme,
  truncate,
  typeColor,
  typeGlyph,
} from "../ui";
import { FieldEditor } from "./FieldEditor";
import { Hint } from "./Hint";
import { formatShortDate, renderDetailLines } from "./IssueDetailLines";
import { InlineFieldInput } from "./IssueDetailSide";
import { ListPicker } from "./ListPicker";
import { ProgressBar } from "./ProgressBar";
import { ToastStack, useToasts } from "./Toasts";

type Pane = "body" | "fields";

type FieldId =
  | "status"
  | "assignee"
  | "priority"
  | "parent"
  | "labels"
  | "components"
  | "fixVersions"
  | "due"
  | "reporter"
  | "created"
  | "updated";

const ALL_FIELDS: FieldId[] = [
  "status",
  "assignee",
  "reporter",
  "priority",
  "parent",
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
  labels: "labels",
  components: "components",
  fixVersions: "fix vers",
  due: "due",
  created: "created",
  updated: "updated",
};

/** Map baked display IDs to Jira REST field keys for editmeta lookup. */
const JIRA_FIELD_KEY: Record<FieldId, string> = {
  status: "status",
  assignee: "assignee",
  reporter: "reporter",
  priority: "priority",
  parent: "parent",
  labels: "labels",
  components: "components",
  fixVersions: "fixVersions",
  due: "duedate",
  created: "created",
  updated: "updated",
};

/** System fields that are never editable via PUT — transitions, timestamps. */
const SYSTEM_FIELDS: Set<FieldId> = new Set(["status", "created", "updated"]);

type Overlay =
  | { kind: "none" }
  | { kind: "nvim" }
  | { kind: "inline-input"; field: string; value: string }
  | { kind: "field-edit"; fieldId: string; meta: EditableField; current?: EditableFieldValue }
  | { kind: "pick-comment-action"; comment: Comment };

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
  // Progress line for background detail (re)loads — the `r` refresh and the
  // re-fetch after a field save, which otherwise gave no signal.
  const { busy, track } = useLoading();

  const [pane, setPane] = useState<Pane>("body");
  const [bodyScroll, setBodyScroll] = useState(0);
  // The side pane has exactly one piece of state: the cursor row. Scroll
  // is derived at render time from the cursor + a sticky anchor in a ref,
  // so there's no way for cursor and scroll to disagree on a frame.
  const [fieldIdx, setFieldIdx] = useState(0);
  const fieldScrollRef = useRef(0);
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

  const fetchDetail = useCallback(async () => {
    try {
      const d = await track(getIssueDetail(cfg, issueKey));
      setDetail(d);
      setLoadError(null);
    } catch (e) {
      setLoadError(errorMessage(e));
    }
  }, [cfg, issueKey, track]);

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

  // Layout. Fixed siblings inside the modal box: header row (1) + summary
  // row (1) + top separator (1) + bottom separator (1) + footer row (1) = 5
  // lines. The body row takes whatever's left. Earlier math said `-4` which
  // off-by-one'd the body by a line, causing Yoga to clip the last row in
  // both the main pane and the side pane — which showed up as "the cursor
  // disappears after pressing down 3-4 times" because the focused slot was
  // the clipped one.
  const innerHeight = Math.max(10, termRows - 4);
  const innerWidth = Math.max(60, termCols - 4);
  const sideWidth = Math.min(Math.max(26, Math.floor(innerWidth * 0.34)), innerWidth - 30);
  const mainWidth = innerWidth - sideWidth;
  const bodyHeight = Math.max(3, innerHeight - 5);

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

  /**
   * Unified list of side-panel rows — baked fields first, then the
   * project's custom fields discovered via editmeta. Cursor `fieldIdx`
   * indexes into this.
   */
  type FieldRow = { kind: "baked"; id: FieldId } | { kind: "custom"; field: CustomField };
  const fieldRows: FieldRow[] = useMemo(() => {
    const out: FieldRow[] = ALL_FIELDS.map((id) => ({ kind: "baked", id }));
    for (const cf of detail?.customFields ?? []) out.push({ kind: "custom", field: cf });
    return out;
  }, [detail]);
  // Clamp before indexing — state can lag fieldRows.length when
  // editmeta shrinks between a fetch and the invariant effect firing.
  // Without this, currentRow is undefined and keypresses no-op.
  const currentRow = fieldRows[clamp(fieldIdx, 0, Math.max(0, fieldRows.length - 1))];

  /** Resolve the EditableField metadata for the current row, if editmeta
   *  says it's writable on this issue. Returns undefined for read-only. */
  const resolveEditable = useCallback(
    (row: FieldRow | undefined): EditableField | undefined => {
      if (!row || !detail) return undefined;
      if (row.kind === "custom") {
        return row.field.meta.kind !== "unsupported" ? row.field.meta : undefined;
      }
      if (SYSTEM_FIELDS.has(row.id)) return undefined;
      const jiraKey = JIRA_FIELD_KEY[row.id];
      // Same unsupported-kind guard as the custom branch: e.g. `parent` on
      // sub-tasks / team-managed projects is an `issuelink` schema, which
      // FieldEditor can't render — without this it'd fall through to a raw
      // text input and POST a garbage value Jira rejects.
      const meta = detail.editmeta.get(jiraKey);
      return meta && meta.kind !== "unsupported" ? meta : undefined;
    },
    [detail],
  );

  /**
   * Side pane: one terminal line per row. `bodyHeight - 1` rows leaves a
   * row of vertical slack so the last slot can't be clipped by flex
   * rounding — which is EXACTLY what was eating the cursor whenever scroll
   * advanced (cursor pins to the last slot after overflow, and the last
   * slot was the clipped one). Position counter lives in the modal
   * footer, so we don't need dedicated indicator rows.
   */
  const fieldWindow = Math.max(3, bodyHeight - 1);

  /**
   * Custom field labels can be long ("Technical Owner", "Target Release
   * Date") — widen the label column up to 20 chars to fit them, but cap
   * so values still have room. Baked fields are all under 11 by design,
   * so they just pad to whatever the custom fields demand.
   */
  const customLabelWidth = useMemo(() => {
    const base = 11;
    const customs = detail?.customFields ?? [];
    if (customs.length === 0) return base;
    const longest = customs.reduce((m, f) => Math.max(m, f.name.length), 0);
    return clamp(longest, base, Math.min(20, Math.floor(sideWidth / 2)));
  }, [detail, sideWidth]);

  /**
   * Move the cursor by `delta` rows with bound-clamping. Scroll is a
   * pure derivation at render time — this just updates `fieldIdx` via
   * the functional form so rapid key-repeat chains correctly.
   */
  const moveFieldCursor = useCallback(
    (delta: number) => {
      const length = fieldRows.length;
      if (length === 0) return;
      setFieldIdx((i) => clamp(i + delta, 0, length - 1));
    },
    [fieldRows.length],
  );

  const jumpFieldCursor = useCallback(
    (to: number) => {
      const length = fieldRows.length;
      if (length === 0) return;
      setFieldIdx(clamp(to, 0, length - 1));
    },
    [fieldRows.length],
  );

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

  /** Resolve the current value from rawFields for seeding FieldEditor.
   *  Custom rows carry their own coerced `current`; baked rows coerce the
   *  raw field through the shared helper so both paths agree on shape. */
  const resolveCurrentValue = useCallback(
    (row: FieldRow): EditableFieldValue | undefined => {
      if (!detail) return undefined;
      if (row.kind === "custom") return row.field.current;
      const jiraKey = JIRA_FIELD_KEY[row.id];
      const meta = detail.editmeta.get(jiraKey);
      if (!meta) return undefined;
      return coerceFieldValue(detail.rawFields[jiraKey], meta);
    },
    [detail],
  );

  const openFieldEditor = useCallback(() => {
    if (!detail || !currentRow) return;
    const meta = resolveEditable(currentRow);
    if (!meta) {
      if (currentRow.kind === "baked" && SYSTEM_FIELDS.has(currentRow.id)) {
        if (currentRow.id === "status") showFlash("use t to transition");
        else showFlash(`${FIELD_LABELS[currentRow.id]} is read-only`);
      } else if (currentRow.kind === "custom" && currentRow.field.meta.kind === "unsupported") {
        showFlash(`${currentRow.field.name}: not editable from TUI`);
      } else {
        showFlash("not editable on this issue");
      }
      return;
    }
    const fieldId =
      currentRow.kind === "custom" ? currentRow.field.id : JIRA_FIELD_KEY[currentRow.id];
    const current = resolveCurrentValue(currentRow);
    setOverlay({
      kind: "field-edit",
      fieldId,
      meta,
      ...(current !== undefined ? { current } : {}),
    });
  }, [detail, currentRow, resolveEditable, resolveCurrentValue, showFlash]);

  const clearField = useCallback(async () => {
    if (!detail || !currentRow) return;
    const meta = resolveEditable(currentRow);
    if (!meta) {
      showFlash("not editable on this issue");
      return;
    }
    const fieldId =
      currentRow.kind === "custom" ? currentRow.field.id : JIRA_FIELD_KEY[currentRow.id];
    const label =
      currentRow.kind === "custom" ? currentRow.field.name : FIELD_LABELS[currentRow.id];
    await doSave(() => updateIssueField(cfg, detail.key, { [fieldId]: null }), `${label} cleared`);
  }, [detail, currentRow, resolveEditable, cfg, doSave, showFlash]);

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
      if (input === "r") {
        void fetchDetail();
        showFlash("refreshing…");
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
        if (key.downArrow || input === "j") moveFieldCursor(1);
        else if (key.upArrow || input === "k") moveFieldCursor(-1);
        else if (key.pageDown) moveFieldCursor(fieldWindow);
        else if (key.pageUp) moveFieldCursor(-fieldWindow);
        else if (input === "g") jumpFieldCursor(0);
        else if (input === "G") jumpFieldCursor(fieldRows.length - 1);
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
        }}
      />
    );
  }

  if (overlay.kind === "field-edit" && detail) {
    return (
      <FieldEditor
        cfg={cfg}
        projectKey={projectKey}
        field={overlay.meta}
        {...(overlay.current !== undefined ? { current: overlay.current } : {})}
        onCancel={() => setOverlay({ kind: "none" })}
        onSubmit={async (value: EditableFieldValue | null) => {
          setOverlay({ kind: "none" });
          await doSave(
            () => updateIssueField(cfg, detail.key, { [overlay.fieldId]: value }),
            `${overlay.meta.name} ${value === null ? "cleared" : "updated"}`,
          );
        }}
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
        borderColor={theme.error}
        padding={1}
      >
        <Text color={theme.error} bold>
          failed to load {issueKey}
        </Text>
        <Box marginTop={1}>
          <Text {...fg(theme.fg)}>{loadError}</Text>
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

  const typeAccent = typeColor(detail.issueType);
  const clampedScroll = Math.min(bodyScroll, maxScroll);
  const visibleMain = mainLines.slice(clampedScroll, clampedScroll + bodyHeight);

  /**
   * Pure-function scroll derivation: one source of truth (fieldIdx),
   * scroll anchored in a ref so the window only shifts when the cursor
   * hits an edge. No state, no effects, no race. Cursor and scroll
   * always agree because we compute scroll *from* cursor at render.
   */
  const fieldCursor = clamp(fieldIdx, 0, Math.max(0, fieldRows.length - 1));
  let fieldScroll = fieldScrollRef.current;
  const scrollCeiling = Math.max(0, fieldRows.length - fieldWindow);
  if (fieldScroll > scrollCeiling) fieldScroll = scrollCeiling;
  if (fieldCursor < fieldScroll) fieldScroll = fieldCursor;
  else if (fieldCursor >= fieldScroll + fieldWindow) fieldScroll = fieldCursor - fieldWindow + 1;
  if (fieldScroll < 0) fieldScroll = 0;
  fieldScrollRef.current = fieldScroll;
  const visibleFields = fieldRows.slice(fieldScroll, fieldScroll + fieldWindow);
  // Inner width of the side pane: sideWidth box - borderLeft (1) - paddingX * 2.
  const sidePaneInner = Math.max(8, sideWidth - 3);
  /**
   * Each slot is one flat line. EXACTLY `fieldWindow` slots — no indicator
   * rows, no variable child count. Position-based keys (slot-N) so React
   * never reorders children on scroll. The focused row's text is padded
   * to the pane's full inner width so the painted selection bg fills a
   * rectangular stripe, not a ragged one — ragged asymmetric bg is where
   * Ink's terminal diff leaves partial-paint artifacts.
   */
  type SideLine = {
    key: string;
    text: string;
    color: string | undefined;
    bold: boolean;
    focused: boolean;
  };
  const sideLines: SideLine[] = [];
  for (let slot = 0; slot < fieldWindow; slot++) {
    const row = visibleFields[slot];
    const absIdx = fieldScroll + slot;
    if (!row) {
      sideLines.push({
        key: `slot-${slot}`,
        text: "".padEnd(sidePaneInner),
        color: theme.muted,
        bold: false,
        focused: false,
      });
      continue;
    }
    const focused = pane === "fields" && absIdx === fieldCursor;
    const parked = pane === "body" && absIdx === fieldCursor;
    const { label, value } =
      row.kind === "baked"
        ? { label: FIELD_LABELS[row.id], value: fieldDisplayValue(row.id, detail) }
        : { label: row.field.name.toLowerCase(), value: customFieldValue(row.field) };
    // Pointer is always exactly 2 ASCII cells. `>` when the pane is
    // focused, `·` when it's parked (pane=body but cursor is remembered),
    // spaces otherwise. Symmetric width means string-width can't disagree
    // with the terminal on column count.
    const pointer = focused ? "> " : parked ? ". " : "  ";
    const labelCell = truncate(label, customLabelWidth).padEnd(customLabelWidth);
    const valueBudget = Math.max(1, sidePaneInner - pointer.length - labelCell.length);
    const valueCell = truncate(value, valueBudget).padEnd(valueBudget);
    sideLines.push({
      key: `slot-${slot}`,
      text: pointer + labelCell + valueCell,
      color: focused ? theme.fg : parked ? theme.accent : theme.muted,
      bold: focused,
      focused,
    });
  }

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
        <Text color={typeAccent}>{typeGlyph(detail.issueType)} </Text>
        <Text color={theme.accent} bold>
          {detail.key}
        </Text>
        <Text color={theme.muted}> · </Text>
        <Text color={typeAccent}>{detail.issueType}</Text>
        {detail.parentKey ? (
          <>
            <Text color={theme.muted}> · </Text>
            <Text color={theme.accentAlt}>{detail.parentKey}</Text>
          </>
        ) : null}
        {detail.watching ? <Text color={theme.info}> ◉</Text> : null}
        {saving ? <Text color={theme.warning}> ◴ saving…</Text> : null}
      </Box>
      <Box paddingX={1}>
        <Text {...fg(theme.fg)} bold>
          {truncate(detail.summary, innerWidth - 4)}
        </Text>
      </Box>
      {/* The header divider doubles as the background-load progress line —
          same row, so it animates during a refresh without shifting layout. */}
      <Box paddingX={1}>
        {busy ? (
          <ProgressBar width={Math.max(1, innerWidth)} active />
        ) : (
          <Text color={theme.divider}>{"─".repeat(Math.max(0, innerWidth))}</Text>
        )}
      </Box>

      {/* Body: main + side */}
      <Box flexDirection="row" height={bodyHeight}>
        <Box flexDirection="column" width={mainWidth} height={bodyHeight} paddingX={1}>
          {visibleMain.map((ln, i) => {
            const lineCommentIdx = ln.commentIdx;
            const isCommentHeader =
              lineCommentIdx !== undefined &&
              ln.bold === true &&
              pane === "body" &&
              lineCommentIdx === focusedCommentIdx;
            return (
              <Text
                key={`${clampedScroll + i}`}
                {...fg(ln.color)}
                bold={ln.bold ?? false}
                wrap="truncate"
                inverse={isCommentHeader}
                {...bg(ln.codeBg ? theme.divider : undefined)}
              >
                {ln.text || " "}
              </Text>
            );
          })}
        </Box>

        <Box
          flexDirection="column"
          width={sideWidth}
          height={bodyHeight}
          paddingX={1}
          borderLeft
          borderTop={false}
          borderBottom={false}
          borderRight={false}
          borderStyle="single"
          borderColor={pane === "fields" ? theme.accent : theme.divider}
        >
          {sideLines.map((ln) => (
            <Text
              key={ln.key}
              {...fg(ln.color)}
              bold={ln.bold}
              wrap="truncate"
              inverse={ln.focused}
            >
              {ln.text}
            </Text>
          ))}
        </Box>
      </Box>

      {/* Footer */}
      <Box paddingX={1}>
        <Text color={theme.divider}>{"─".repeat(Math.max(0, innerWidth))}</Text>
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
          {pane === "fields"
            ? `${fieldRows.length === 0 ? 0 : fieldCursor + 1}/${fieldRows.length}`
            : `${clampedScroll + 1}-${Math.min(clampedScroll + bodyHeight, mainLines.length)}/${mainLines.length}`}
        </Text>
      </Box>
      <ToastStack toasts={toasts} maxWidth={innerWidth} />
    </Box>
  );
}

function customFieldValue(f: CustomField): string {
  if (f.display === null) return "—";
  if (Array.isArray(f.display)) return f.display.length === 0 ? "—" : f.display.join(", ");
  return String(f.display);
}

function fieldDisplayValue(field: FieldId, d: IssueDetail): string {
  if (field === "status") return d.statusName;
  if (field === "assignee") return d.assignee ?? "Unassigned";
  if (field === "reporter") return d.reporter ?? "—";
  if (field === "priority") return d.priority ?? "—";
  if (field === "parent") return d.parentKey ?? d.epicKey ?? "—";
  if (field === "labels") return d.labels.length === 0 ? "—" : d.labels.join(", ");
  if (field === "components") return d.components.length === 0 ? "—" : d.components.join(", ");
  if (field === "fixVersions") return d.fixVersions.length === 0 ? "—" : d.fixVersions.join(", ");
  if (field === "due") return d.dueDate ?? "—";
  if (field === "created") return formatShortDate(d.created);
  if (field === "updated") return formatShortDate(d.updated);
  return "—";
}
