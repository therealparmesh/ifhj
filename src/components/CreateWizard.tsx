import { Box, Text, useInput } from "ink";
import { useEffect, useRef, useState } from "react";

import type { JiraConfig } from "../config";
import { editInNeovim } from "../editor";
import { useDimensions } from "../hooks";
import {
  type IssueLinkType,
  type IssueSearchResult,
  type IssueType,
  type JiraUser,
  type EditableField,
  type EditableFieldValue,
  createIssue,
  createIssueLink,
  getCreateFields,
  searchIssues,
} from "../jira";
import { errorMessage, fg, theme, truncate } from "../ui";
import { FilterPicker } from "./FilterPicker";
import { Hint } from "./Hint";
import { LoadingLine } from "./LoadingLine";
import { NvimBanner } from "./NvimBanner";
import { TransitionScreenModal } from "./TransitionScreenModal";

/**
 * Parent linking (epic child, sub-task) uses the `parent` field at create
 * time; every other link is a post-create POST to /issueLink. The sentinel
 * on `LinkChoice.name` flags the parent path.
 */
const PARENT_SENTINEL = "__parent__";
const LABEL_COL_WIDTH = 14;

type LinkChoice = {
  name: string;
  label: string;
  direction: "outward" | "inward";
};

// The live form state. Empty strings / null mean "not yet entered".
type FormState = {
  title: string;
  description: string;
  type: IssueType | null;
  link: LinkChoice | null;
  target: IssueSearchResult | null;
};

type FieldId = "title" | "description" | "type" | "link" | "target" | "submit";

/**
 * Form is in `browse` most of the time. Activating a row flips us into one
 * of the transient modes below — a Neovim editor, a filter picker, or the
 * final POST.
 */
type Mode =
  | { kind: "browse" }
  | { kind: "nvim-title" }
  | { kind: "nvim-desc" }
  | { kind: "pick-type" }
  | { kind: "pick-link" }
  | { kind: "pick-target" }
  | { kind: "required-fields" }
  | { kind: "submitting" };

const FIELD_LABELS: Record<FieldId, string> = {
  title: "Title",
  description: "Description",
  type: "Issue type",
  link: "Relationship",
  target: "Target",
  submit: "",
};

const REQUIRED: Record<FieldId, boolean> = {
  title: true,
  description: false,
  type: true,
  link: false,
  target: true, // only shown when a link is active, so it's required then
  submit: false,
};

// The `target` row only shows once the user has picked a non-skip link.
function visibleFields(form: FormState, lockedParent: boolean): FieldId[] {
  const out: FieldId[] = ["title", "description", "type"];
  if (!lockedParent) out.push("link");
  if (form.link) out.push("target");
  out.push("submit");
  return out;
}

function parentValidationError(
  type: IssueType | null,
  link: LinkChoice | null,
  target: IssueSearchResult | null,
  projectKey: string,
): string | null {
  if (!type) return null;
  if (type.subtask && link?.name !== PARENT_SENTINEL) return "a subtask requires a parent";
  if (link?.name !== PARENT_SENTINEL) return null;
  if (!target) return "parent required";
  if (target.projectKey !== projectKey) return "parent must be in the same project";
  if (target.subtask) return "a subtask cannot be a parent";
  if (
    type.hierarchyLevel !== undefined &&
    target.hierarchyLevel !== undefined &&
    target.hierarchyLevel !== type.hierarchyLevel + 1
  ) {
    return "parent must be one hierarchy level above the selected type";
  }
  return null;
}

export function CreateWizard({
  cfg,
  projectKey,
  types,
  linkTypes,
  initialType,
  defaultParent,
  ensureUsers,
  onCancel,
  onDone,
  onError,
}: {
  cfg: JiraConfig;
  projectKey: string;
  types: IssueType[];
  linkTypes: IssueLinkType[];
  initialType?: IssueType | undefined;
  defaultParent?: IssueSearchResult | undefined;
  /** Supplied by the caller so Neovim's @-completion is fed the same
   *  user list the caller cached. Optional. */
  ensureUsers?: (projectKey: string) => Promise<JiraUser[]>;
  onCancel: () => void;
  onDone: (result: { key: string; title: string; linkSummary?: string; warning?: string }) => void;
  onError: (msg: string) => void;
}) {
  const parentLink: LinkChoice | null = defaultParent
    ? { name: PARENT_SENTINEL, label: "is child of", direction: "outward" }
    : null;
  const parentTarget: IssueSearchResult | null = defaultParent ? defaultParent : null;
  const [form, setForm] = useState<FormState>({
    title: "",
    description: "",
    type: initialType ?? null,
    link: parentLink,
    target: parentTarget,
  });
  const [mode, setMode] = useState<Mode>({ kind: "browse" });
  const [focused, setFocused] = useState<FieldId>("title");
  const [createFields, setCreateFields] = useState<EditableField[] | null>(null);
  const [metadataError, setMetadataError] = useState<string | null>(null);
  const [metadataAttempt, setMetadataAttempt] = useState(0);
  const [extraFields, setExtraFields] = useState<Record<string, EditableFieldValue>>({});
  const [statusError, setStatusError] = useState<string | null>(null);
  const [abandoned, setAbandoned] = useState(false);
  const onErrorRef = useRef(onError);
  useEffect(() => {
    onErrorRef.current = onError;
  }, [onError]);

  // Target-search state for the pick-target picker. Race-guarded via seq.
  const [searchResults, setSearchResults] = useState<IssueSearchResult[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const searchSeq = useRef(0);

  // Set on explicit cancellation and unmount. We cannot undo an in-flight
  // create, but no result or follow-up link may publish after abandonment.
  const cancelled = useRef(false);
  useEffect(() => {
    cancelled.current = false;
    return () => {
      cancelled.current = true;
    };
  }, []);

  const metadataType = useRef<string | null>(null);
  useEffect(() => {
    if (cancelled.current) return;
    const type = form.type;
    if (!type) {
      setCreateFields(null);
      setMetadataError(null);
      return;
    }
    if (metadataType.current !== type.id) {
      metadataType.current = type.id;
      setExtraFields({});
    }
    let obsolete = false;
    setCreateFields(null);
    setMetadataError(null);
    setStatusError(null);
    void (async () => {
      try {
        const next = await getCreateFields(cfg, projectKey, type.id);
        if (obsolete || cancelled.current) return;
        const supportsParent = next.some((field) => field.id === "parent");
        if (defaultParent && (!type.subtask || !supportsParent)) {
          const message = "selected type cannot be created as a subtask";
          setMetadataError(message);
          setStatusError(message);
          onErrorRef.current(message);
          return;
        }
        if (!supportsParent) {
          setForm((current) =>
            current.link?.name === PARENT_SENTINEL
              ? { ...current, link: null, target: null }
              : current,
          );
        }
        setCreateFields(next);
      } catch (error) {
        if (obsolete || cancelled.current) return;
        const message = errorMessage(error);
        setMetadataError(message);
        setStatusError(message);
        onErrorRef.current(message);
      }
    })();
    return () => {
      obsolete = true;
    };
  }, [cfg, projectKey, form.type, defaultParent, metadataAttempt]);

  const fields = visibleFields(form, Boolean(defaultParent));
  const descriptionRequired =
    createFields?.some(
      (field) => field.id === "description" && field.required && !field.hasDefaultValue,
    ) ?? false;
  const parentRequired =
    createFields?.some(
      (field) => field.id === "parent" && field.required && !field.hasDefaultValue,
    ) ?? false;
  const requiredFields =
    createFields?.filter(
      (field) =>
        field.required &&
        !field.hasDefaultValue &&
        !["project", "issuetype", "summary", "description", "parent"].includes(field.id),
    ) ?? [];
  const parentError = parentValidationError(form.type, form.link, form.target, projectKey);
  const canSubmit =
    form.title.trim() !== "" &&
    form.type !== null &&
    createFields !== null &&
    metadataError === null &&
    (!descriptionRequired || form.description.trim() !== "") &&
    (form.link === null || form.target !== null) &&
    (!parentRequired || form.link?.name === PARENT_SENTINEL) &&
    parentError === null;
  const requestSubmit = () => {
    if (parentError) {
      setStatusError(parentError);
      onErrorRef.current(parentError);
      return;
    }
    if (!canSubmit) return;
    setStatusError(null);
    setMode({ kind: requiredFields.length > 0 ? "required-fields" : "submitting" });
  };
  const cancelWizard = () => {
    if (cancelled.current) return;
    cancelled.current = true;
    searchSeq.current++;
    setAbandoned(true);
    onCancel();
  };

  /**
   * Pick "no relationship" after a target is set → target row vanishes.
   * Re-anchor focus so we're not pointing at a gone row.
   */
  useEffect(() => {
    if (!fields.includes(focused)) setFocused("submit");
  }, [fields, focused]);

  /**
   * Each mode transition fires its side-effect (Neovim or network) exactly
   * once per entry. Without the ref, a parent rerender recomputing deps
   * would double-spawn.
   */
  const modeFired = useRef<string>("");
  useEffect(() => {
    if (cancelled.current) return;
    if (modeFired.current === mode.kind) return;
    modeFired.current = mode.kind;

    if (mode.kind === "nvim-title") {
      (async () => {
        try {
          const raw = await editInNeovim(form.title, "new-issue-title.md");
          if (cancelled.current) return;
          const title = raw.split(/\n/, 1)[0]?.trim() ?? "";
          setForm((f) => ({ ...f, title }));
          setMode({ kind: "browse" });
        } catch (e) {
          if (cancelled.current) return;
          const message = errorMessage(e);
          setStatusError(message);
          onErrorRef.current(message);
          setMode({ kind: "browse" });
        }
      })();
    } else if (mode.kind === "nvim-desc") {
      (async () => {
        try {
          const mentionUsers = (await ensureUsers?.(projectKey)) ?? [];
          if (cancelled.current) return;
          const raw = await editInNeovim(form.description, "new-issue-desc.md", { mentionUsers });
          if (cancelled.current) return;
          setForm((f) => ({ ...f, description: raw.trim() }));
          setMode({ kind: "browse" });
        } catch (e) {
          if (cancelled.current) return;
          const message = errorMessage(e);
          setStatusError(message);
          onErrorRef.current(message);
          setMode({ kind: "browse" });
        }
      })();
    } else if (mode.kind === "submitting") {
      const { title, description, type, link, target } = form;
      if (!type) {
        setStatusError("type required");
        onErrorRef.current("type required");
        return;
      }
      (async () => {
        let created: { key: string };
        try {
          const isParent = link?.name === PARENT_SENTINEL;
          const parentKey = isParent && target ? target.key : undefined;
          created = await createIssue(
            cfg,
            projectKey,
            type.id,
            title,
            description,
            parentKey,
            extraFields,
          );
        } catch (e) {
          if (cancelled.current) return;
          const message = errorMessage(e);
          setStatusError(message);
          onErrorRef.current(message);
          setMode({ kind: "browse" });
          return;
        }
        if (cancelled.current) return;
        if (target && link && link.name !== PARENT_SENTINEL) {
          try {
            await createIssueLink(cfg, link.name, created.key, target.key, link.direction);
          } catch (e) {
            if (cancelled.current) return;
            onDone({
              key: created.key,
              title,
              warning: `relationship failed: ${errorMessage(e)}`,
            });
            return;
          }
        }
        if (cancelled.current) return;
        const linkSummary = target && link ? `${link.label} ${target.key}` : undefined;
        onDone({
          key: created.key,
          title,
          ...(linkSummary ? { linkSummary } : {}),
        });
      })();
    }
  }, [mode, form, cfg, projectKey, ensureUsers, extraFields, onDone]);

  // Browse-mode keys — navigate, activate, submit.
  useInput(
    (input, key) => {
      if (key.escape) return cancelWizard();
      if (input === "s") return requestSubmit();
      if (key.upArrow || input === "k") {
        const i = fields.indexOf(focused);
        if (i > 0) setFocused(fields[i - 1]!);
        return;
      }
      if (key.downArrow || input === "j") {
        const i = fields.indexOf(focused);
        if (i < fields.length - 1) setFocused(fields[i + 1]!);
        return;
      }
      if (key.return) {
        if (focused === "title") setMode({ kind: "nvim-title" });
        else if (focused === "description") setMode({ kind: "nvim-desc" });
        else if (focused === "type") setMode({ kind: "pick-type" });
        else if (focused === "link") setMode({ kind: "pick-link" });
        else if (focused === "target") {
          if (defaultParent) return;
          searchSeq.current++;
          setSearchResults([]);
          setSearchLoading(true);
          setMode({ kind: "pick-target" });
        } else if (focused === "submit") requestSubmit();
      }
    },
    { isActive: mode.kind === "browse" && !abandoned },
  );

  // Neovim banner — editor takes over the TTY while running.
  if (mode.kind === "nvim-title" || mode.kind === "nvim-desc") return <NvimBanner />;

  if (mode.kind === "submitting") return <SubmittingBanner onEscape={cancelWizard} />;

  if (mode.kind === "required-fields" && form.type) {
    return (
      <TransitionScreenModal
        cfg={cfg}
        projectKey={projectKey}
        issueKey={projectKey}
        transition={{
          id: "create",
          name: `Create ${form.type.name}`,
          toStatusId: "",
          requiredFields,
        }}
        initialValues={extraFields}
        onCancel={(values) => {
          if (values) setExtraFields(values);
          setMode({ kind: "browse" });
        }}
        onSubmit={(values) => {
          setExtraFields(values);
          setMode({ kind: "submitting" });
        }}
      />
    );
  }

  if (mode.kind === "pick-type") {
    return (
      <FilterPicker
        title="issue type"
        items={types.map((t) => ({ id: t.id, label: t.name }))}
        {...(form.type ? { currentId: form.type.id } : {})}
        onPick={(id) => {
          const t = types.find((x) => x.id === id);
          if (t) {
            setForm((f) => ({ ...f, type: t }));
            setMetadataAttempt((attempt) => attempt + 1);
          }
          setMode({ kind: "browse" });
        }}
        onCancel={() => setMode({ kind: "browse" })}
      />
    );
  }

  if (mode.kind === "pick-link") {
    const choices = buildLinkChoices(
      linkTypes,
      createFields?.some((field) => field.id === "parent") ?? false,
    );
    const currentId = findCurrentLinkId(choices, form.link);
    return (
      <FilterPicker
        title="relationship"
        items={choices.map(({ id, label, hint }) => ({ id, label, hint }))}
        {...(currentId ? { currentId } : {})}
        placeholder="blocks / relates to / parent …"
        onPick={(id) => {
          const picked = choices.find((c) => c.id === id);
          if (!picked) return;
          // Drop the target if the user picks "no relationship".
          setForm((f) => ({
            ...f,
            link: picked.choice,
            target: picked.choice ? f.target : null,
          }));
          setMode({ kind: "browse" });
        }}
        onCancel={() => setMode({ kind: "browse" })}
      />
    );
  }

  if (mode.kind === "pick-target") {
    return (
      <FilterPicker
        title={`${form.link?.label ?? "link"} which issue?`}
        items={searchResults.map((r) => ({
          id: r.key,
          label: `${r.key}  ${truncate(r.summary, 80)}`,
          hint: r.issueType,
        }))}
        loading={searchLoading}
        placeholder="type summary or issue key…"
        debounceMs={0}
        onQueryChange={(q) => {
          const seq = ++searchSeq.current;
          setSearchResults([]);
          setSearchLoading(true);
          (async () => {
            try {
              const r = await searchIssues(cfg, q, { projectKey });
              if (!cancelled.current && seq === searchSeq.current) setSearchResults(r);
            } catch {
              if (!cancelled.current && seq === searchSeq.current) setSearchResults([]);
            } finally {
              if (!cancelled.current && seq === searchSeq.current) setSearchLoading(false);
            }
          })();
        }}
        onPick={(id) => {
          const t = searchResults.find((r) => r.key === id);
          if (t) {
            if (form.link?.name === PARENT_SENTINEL && t.subtask) {
              const message = "a subtask cannot be a parent";
              setStatusError(message);
              onErrorRef.current(message);
              return;
            }
            setForm((f) => ({ ...f, target: t }));
          }
          setMode({ kind: "browse" });
        }}
        onCancel={() => {
          searchSeq.current++;
          setSearchLoading(false);
          setMode({ kind: "browse" });
        }}
      />
    );
  }

  // Browse mode — full-screen form modeled on Jira's web create dialog.
  return (
    <CreateForm
      form={form}
      fields={fields}
      focused={focused}
      canSubmit={canSubmit}
      descriptionRequired={descriptionRequired}
      projectKey={projectKey}
      metadataStatus={
        form.type && createFields === null && !metadataError ? "loading create fields…" : null
      }
      statusError={statusError}
    />
  );
}

function CreateForm({
  form,
  fields,
  focused,
  canSubmit,
  descriptionRequired,
  projectKey,
  metadataStatus,
  statusError,
}: {
  form: FormState;
  fields: FieldId[];
  focused: FieldId;
  canSubmit: boolean;
  descriptionRequired: boolean;
  projectKey: string;
  metadataStatus: string | null;
  statusError: string | null;
}) {
  const { cols: termCols, rows: termRows } = useDimensions();
  const innerHeight = Math.max(12, termRows - 4);
  const innerWidth = Math.max(60, termCols - 4);
  return (
    <Box
      flexDirection="column"
      width={innerWidth + 2}
      height={innerHeight + 2}
      borderStyle="round"
      borderColor={theme.accent}
    >
      {/* Header — mirrors the detail modal so the two feel like siblings. */}
      <Box paddingX={1} justifyContent="space-between">
        <Box>
          <Text color={theme.accent} bold>
            ◆ Create issue
          </Text>
          <Text color={theme.muted}> · </Text>
          <Text color={theme.accentAlt}>{projectKey}</Text>
        </Box>
        <Text color={theme.muted}>esc cancel</Text>
      </Box>
      <Box paddingX={1}>
        <Text color={theme.muted}>fields marked </Text>
        <Text color={theme.error}>*</Text>
        <Text color={theme.muted}> are required. ⏎ edits the focused field.</Text>
      </Box>
      <Box paddingX={1}>
        <Text color={theme.divider}>{"─".repeat(Math.max(0, innerWidth))}</Text>
      </Box>

      {/* Body */}
      <Box flexDirection="column" flexGrow={1} paddingX={2} paddingY={1}>
        {fields.map((f) => (
          <FormRow
            key={f}
            field={f}
            focused={focused === f}
            form={form}
            canSubmit={canSubmit}
            required={f === "description" ? descriptionRequired : REQUIRED[f]}
            width={innerWidth - 4}
          />
        ))}
        {metadataStatus ? <Text color={theme.muted}>{metadataStatus}</Text> : null}
        {statusError && statusError !== metadataStatus ? (
          <Text color={theme.error}>{statusError}</Text>
        ) : null}
      </Box>

      {/* Footer */}
      <Box paddingX={1}>
        <Text color={theme.divider}>{"─".repeat(Math.max(0, innerWidth))}</Text>
      </Box>
      <Box paddingX={1}>
        <Hint k="↑↓" label="nav" />
        <Hint k="⏎" label={focused === "submit" ? "submit" : "edit"} />
        {canSubmit ? <Hint k="s" label="submit" /> : null}
        <Hint k="esc" label="cancel" />
      </Box>
    </Box>
  );
}

function FormRow({
  field,
  focused,
  form,
  canSubmit,
  required,
  width,
}: {
  field: FieldId;
  focused: boolean;
  form: FormState;
  canSubmit: boolean;
  required: boolean;
  width: number;
}) {
  // Submit row is a single action line, colored by readiness.
  if (field === "submit") {
    const color = canSubmit ? (focused ? theme.success : theme.fgDim) : theme.muted;
    const text = canSubmit ? "submit" : "submit (fill required fields)";
    return (
      <Box marginTop={1}>
        <Text color={color} bold inverse={focused && canSubmit}>
          {focused ? "> " : "  "}
          {text}
        </Text>
      </Box>
    );
  }

  const value = displayValue(field, form);
  const isEmpty = value === "";
  const labelColor = focused ? theme.accent : theme.muted;
  const valueColor = isEmpty ? theme.muted : focused ? theme.fg : theme.fgDim;
  const valueText = isEmpty ? "(empty, ⏎ to edit)" : value;
  /**
   * Fixed label column, star sits outside it so required/optional labels
   * line up on the value side.
   */
  const baseLabel = FIELD_LABELS[field];
  const labelPadded = baseLabel.padEnd(LABEL_COL_WIDTH - 2);
  const valueMax = Math.max(4, width - 2 - LABEL_COL_WIDTH - 1);
  return (
    <Box width={width} marginBottom={1}>
      <Text color={labelColor}>{focused ? "> " : "  "}</Text>
      <Text color={labelColor} bold={focused} inverse={focused}>
        {labelPadded}
      </Text>
      <Text color={theme.error}>{required ? "* " : "  "}</Text>
      <Text {...fg(valueColor)} inverse={focused} wrap="truncate">
        {truncate(valueText, valueMax)}
      </Text>
    </Box>
  );
}

function displayValue(field: FieldId, form: FormState): string {
  if (field === "title") return form.title;
  if (field === "description") {
    const firstLine = form.description.split(/\n/, 1)[0] ?? "";
    const extraLines = form.description ? form.description.split("\n").length - 1 : 0;
    const head = truncate(firstLine, 60);
    return extraLines > 0 ? `${head}  (+${extraLines} more lines)` : head;
  }
  if (field === "type") return form.type?.name ?? "";
  if (field === "link") return form.link?.label ?? "(no relationship)";
  if (field === "target")
    return form.target ? `${form.target.key} · ${truncate(form.target.summary, 50)}` : "";
  return "";
}

type LinkChoiceOption = { id: string; choice: LinkChoice | null; label: string; hint: string };

/**
 * Relationship picker menu. Two synthetic options on top — "skip" and
 * "parent" (atomic `parent` field at create time) — then each link-type's
 * two directions.
 */
function buildLinkChoices(linkTypes: IssueLinkType[], supportsParent: boolean): LinkChoiceOption[] {
  const out: LinkChoiceOption[] = [
    { id: "skip", choice: null, label: "(no relationship)", hint: "create standalone" },
  ];
  if (supportsParent) {
    out.push({
      id: "parent",
      choice: { name: PARENT_SENTINEL, label: "is child of", direction: "outward" },
      label: "is child of",
      hint: "parent field",
    });
  }
  for (const lt of linkTypes) {
    out.push({
      id: `${lt.id}-outward`,
      choice: { name: lt.name, label: lt.outward, direction: "outward" },
      label: lt.outward,
      hint: lt.name,
    });
    if (lt.inward !== lt.outward) {
      out.push({
        id: `${lt.id}-inward`,
        choice: { name: lt.name, label: lt.inward, direction: "inward" },
        label: lt.inward,
        hint: lt.name,
      });
    }
  }
  return out;
}

function findCurrentLinkId(choices: LinkChoiceOption[], current: LinkChoice | null): string | null {
  if (current === null) return "skip";
  return (
    choices.find(
      (c) => c.choice?.name === current.name && c.choice?.direction === current.direction,
    )?.id ?? null
  );
}

/**
 * Spinner while the form POSTs. Esc detaches the wizard — we can't cancel the
 * in-flight request, so the issue may still be created, but the `cancelled`
 * ref stops its resolution from calling back (no surprise success / detail
 * pop for an abandoned create).
 */
function SubmittingBanner({ onEscape }: { onEscape: () => void }) {
  useInput((_input, key) => {
    if (key.escape) onEscape();
  });
  return (
    <Box flexDirection="column" padding={2} borderStyle="round" borderColor={theme.accent}>
      <LoadingLine label="creating issue…" />
      <Box marginTop={1}>
        <Text color={theme.muted}>esc to abandon (request may still land)</Text>
      </Box>
    </Box>
  );
}
