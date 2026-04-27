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
  createIssue,
  createIssueLink,
  searchIssues,
} from "../jira";
import { errorMessage, fg, theme, truncate } from "../ui";
import { FilterPicker } from "./FilterPicker";
import { Hint } from "./Hint";

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
function visibleFields(form: FormState): FieldId[] {
  const out: FieldId[] = ["title", "description", "type", "link"];
  if (form.link) out.push("target");
  out.push("submit");
  return out;
}

export function CreateWizard({
  cfg,
  projectKey,
  types,
  linkTypes,
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
  defaultParent?: string | undefined;
  /** Supplied by the caller so Neovim's @-completion is fed the same
   *  user list the caller cached. Optional. */
  ensureUsers?: () => Promise<JiraUser[]>;
  onCancel: () => void;
  onDone: (result: { key: string; title: string; linkSummary?: string }) => void;
  onError: (msg: string) => void;
}) {
  const parentLink: LinkChoice | null = defaultParent
    ? { name: PARENT_SENTINEL, label: "is child of", direction: "outward" }
    : null;
  const parentTarget: IssueSearchResult | null = defaultParent
    ? { key: defaultParent, summary: "", issueType: "" }
    : null;
  const [form, setForm] = useState<FormState>({
    title: "",
    description: "",
    type: null,
    link: parentLink,
    target: parentTarget,
  });
  const [mode, setMode] = useState<Mode>({ kind: "browse" });
  const [focused, setFocused] = useState<FieldId>("title");

  // Target-search state for the pick-target picker. Race-guarded via seq.
  const [searchResults, setSearchResults] = useState<IssueSearchResult[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const searchSeq = useRef(0);

  const fields = visibleFields(form);
  const canSubmit =
    form.title.trim() !== "" && form.type !== null && (form.link === null || form.target !== null);

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
    if (modeFired.current === mode.kind) return;
    modeFired.current = mode.kind;

    if (mode.kind === "nvim-title") {
      (async () => {
        try {
          const raw = await editInNeovim(form.title, "new-issue-title.md");
          const title = raw.split(/\n/, 1)[0]?.trim() ?? "";
          setForm((f) => ({ ...f, title }));
          setMode({ kind: "browse" });
        } catch (e) {
          onError(errorMessage(e));
        }
      })();
    } else if (mode.kind === "nvim-desc") {
      (async () => {
        try {
          const mentionUsers = (await ensureUsers?.()) ?? [];
          const raw = await editInNeovim(form.description, "new-issue-desc.md", { mentionUsers });
          setForm((f) => ({ ...f, description: raw.trim() }));
          setMode({ kind: "browse" });
        } catch (e) {
          onError(errorMessage(e));
        }
      })();
    } else if (mode.kind === "submitting") {
      const { title, description, type, link, target } = form;
      if (!type) {
        onError("type required");
        return;
      }
      (async () => {
        try {
          const isParent = link?.name === PARENT_SENTINEL;
          const parentKey = isParent && target ? target.key : undefined;
          const created = await createIssue(
            cfg,
            projectKey,
            type.name,
            title,
            description,
            parentKey,
          );
          if (target && link && !isParent) {
            await createIssueLink(cfg, link.name, created.key, target.key, link.direction);
          }
          const linkSummary = target && link ? `${link.label} ${target.key}` : undefined;
          onDone({
            key: created.key,
            title,
            ...(linkSummary ? { linkSummary } : {}),
          });
        } catch (e) {
          onError(errorMessage(e));
        }
      })();
    }
  }, [mode, form, cfg, projectKey, ensureUsers, onDone, onError]);

  // Browse-mode keys — navigate, activate, submit.
  useInput(
    (input, key) => {
      if (key.escape) return onCancel();
      if (input === "s" && canSubmit) return setMode({ kind: "submitting" });
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
        else if (focused === "target") setMode({ kind: "pick-target" });
        else if (focused === "submit" && canSubmit) setMode({ kind: "submitting" });
      }
    },
    { isActive: mode.kind === "browse" },
  );

  // Neovim banner — editor takes over the TTY while running.
  if (mode.kind === "nvim-title" || mode.kind === "nvim-desc") {
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

  if (mode.kind === "submitting") return <SubmittingBanner onEscape={onCancel} />;

  if (mode.kind === "pick-type") {
    return (
      <FilterPicker
        title="issue type"
        items={types.map((t) => ({ id: t.id, label: t.name }))}
        {...(form.type ? { currentId: form.type.id } : {})}
        onPick={(id) => {
          const t = types.find((x) => x.id === id);
          if (t) setForm((f) => ({ ...f, type: t }));
          setMode({ kind: "browse" });
        }}
        onCancel={() => setMode({ kind: "browse" })}
      />
    );
  }

  if (mode.kind === "pick-link") {
    const choices = buildLinkChoices(linkTypes);
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
        onPick={(id) => {
          const t = searchResults.find((r) => r.key === id);
          if (t) setForm((f) => ({ ...f, target: t }));
          setMode({ kind: "browse" });
        }}
        onCancel={() => setMode({ kind: "browse" })}
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
      projectKey={projectKey}
    />
  );
}

function CreateForm({
  form,
  fields,
  focused,
  canSubmit,
  projectKey,
}: {
  form: FormState;
  fields: FieldId[];
  focused: FieldId;
  canSubmit: boolean;
  projectKey: string;
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
        <Text color={theme.muted}>esc close</Text>
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
            width={innerWidth - 4}
          />
        ))}
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
  width,
}: {
  field: FieldId;
  focused: boolean;
  form: FormState;
  canSubmit: boolean;
  width: number;
}) {
  // Submit row is a single action line, colored by readiness.
  if (field === "submit") {
    const color = canSubmit ? (focused ? theme.success : theme.fgDim) : theme.muted;
    const inverse = focused && canSubmit;
    const text = canSubmit ? "submit" : "submit (fill required fields)";
    return (
      <Box marginTop={1}>
        <Text color={color} bold inverse={inverse}>
          {focused ? "▶ " : "  "}
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
      <Text color={labelColor} inverse={focused}>
        {focused ? "▶ " : "  "}
      </Text>
      <Text color={labelColor} bold={focused} inverse={focused}>
        {labelPadded}
      </Text>
      <Text color={theme.error} inverse={focused}>
        {REQUIRED[field] ? "* " : "  "}
      </Text>
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
function buildLinkChoices(linkTypes: IssueLinkType[]): LinkChoiceOption[] {
  const out: LinkChoiceOption[] = [
    { id: "skip", choice: null, label: "(no relationship)", hint: "create standalone" },
    {
      id: "parent",
      choice: { name: PARENT_SENTINEL, label: "is child of", direction: "outward" },
      label: "is child of",
      hint: "parent field — epic / sub-task",
    },
  ];
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
 * Spinner while the form POSTs. Esc detaches — we can't cancel the fetch
 * in flight, so the promise may still settle but onDone/onError goes nowhere.
 */
function SubmittingBanner({ onEscape }: { onEscape: () => void }) {
  useInput((_input, key) => {
    if (key.escape) onEscape();
  });
  return (
    <Box flexDirection="column" padding={2} borderStyle="round" borderColor={theme.accent}>
      <Text color={theme.accent}>◴ creating issue…</Text>
      <Box marginTop={1}>
        <Text color={theme.muted}>esc to abandon (request may still land)</Text>
      </Box>
    </Box>
  );
}
