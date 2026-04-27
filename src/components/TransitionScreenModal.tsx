import { Box, Text, useInput } from "ink";
import { useCallback, useState, useMemo } from "react";

import type { JiraConfig } from "../config";
import {
  type JiraUser,
  type Transition,
  type TransitionField,
  type TransitionFieldValue,
  getAssignableUsers,
} from "../jira";
import { clamp, errorMessage, theme, truncate } from "../ui";
import { FilterPicker } from "./FilterPicker";
import { Hint } from "./Hint";
import { InlineFieldInput } from "./IssueDetailSide";

type Sub =
  | { kind: "none" }
  | { kind: "option"; field: TransitionField & { kind: "option" } }
  | { kind: "option-list"; field: TransitionField & { kind: "option-list" } }
  | { kind: "user"; field: TransitionField & { kind: "user" }; users: JiraUser[] }
  | { kind: "user-list"; field: TransitionField & { kind: "user-list" }; users: JiraUser[] }
  | { kind: "text"; field: TransitionField & { kind: "text" } }
  | { kind: "number"; field: TransitionField & { kind: "number" } }
  | { kind: "date"; field: TransitionField & { kind: "date" } };

/**
 * Render a value (as stored in our `values` map) for the read-only field
 * list. `field` is passed in so option labels can be looked up without
 * re-fetching.
 */
function displayValue(field: TransitionField, value: TransitionFieldValue | undefined): string {
  if (value === undefined) return "—";
  if (field.kind === "option") {
    const id = (value as { id: string }).id;
    return field.allowedValues.find((v) => v.id === id)?.name ?? id;
  }
  if (field.kind === "option-list") {
    const arr = value as { id: string }[];
    if (arr.length === 0) return "—";
    return arr.map((v) => field.allowedValues.find((a) => a.id === v.id)?.name ?? v.id).join(", ");
  }
  if (field.kind === "user") return (value as { accountId: string }).accountId;
  if (field.kind === "user-list") {
    const arr = value as { accountId: string }[];
    return arr.length === 0 ? "—" : `${arr.length} user${arr.length === 1 ? "" : "s"}`;
  }
  if (field.kind === "number") return String(value as number);
  if (field.kind === "text" || field.kind === "date") return String(value);
  return "—";
}

/**
 * Required-fields screen for a Jira workflow transition. Only opens when
 * `transition.requiredFields` is non-empty — otherwise the caller POSTs
 * straight through. Field editors reuse FilterPicker / InlineFieldInput
 * so the UX matches the rest of the app.
 *
 * Unsupported schema types (cascading selects, rich-text, etc.) are shown
 * in red but can't be satisfied from the TUI — submit stays blocked by
 * the `missing` check, and the user is told to complete them in the
 * browser via the inline status line.
 */
export function TransitionScreenModal({
  cfg,
  projectKey,
  issueKey,
  transition,
  onCancel,
  onSubmit,
}: {
  cfg: JiraConfig;
  projectKey: string;
  issueKey: string;
  transition: Transition;
  onCancel: () => void;
  onSubmit: (fields: Record<string, TransitionFieldValue>) => void;
}) {
  // Start every field empty. Jira says `hasDefaultValue` on some fields but
  // doesn't tell us which of the allowedValues is actually the default, so
  // guessing is worse than asking — a wrong "Won't Do" resolution is a
  // meaningful mistake. User picks explicitly.
  const [values, setValuesRaw] = useState<Record<string, TransitionFieldValue>>({});
  const [idx, setIdx] = useState(0);
  const [sub, setSub] = useState<Sub>({ kind: "none" });
  const [loading, setLoading] = useState(false);
  // Inline status line — not toasts, because BoardView's ToastStack isn't
  // rendered while this modal is up (BoardView returns early for every
  // modal kind). Cleared on any setValues so that after fixing a field the
  // error goes away instead of persisting.
  const [statusMsg, setStatusMsg] = useState<string | null>(null);

  const setValues = useCallback(
    (
      updater:
        | Record<string, TransitionFieldValue>
        | ((prev: Record<string, TransitionFieldValue>) => Record<string, TransitionFieldValue>),
    ) => {
      setStatusMsg(null);
      setValuesRaw(updater);
    },
    [],
  );

  const fields = transition.requiredFields;

  const missing = useMemo(() => {
    const names: string[] = [];
    for (const f of fields) {
      if (f.kind === "unsupported") {
        names.push(`${f.name} (${f.schemaType})`);
        continue;
      }
      const val = values[f.id];
      if (val === undefined) {
        names.push(f.name);
        continue;
      }
      if (Array.isArray(val) && val.length === 0) names.push(f.name);
      if (typeof val === "string" && val.trim() === "") names.push(f.name);
    }
    return names;
  }, [fields, values]);

  const openEditor = useCallback(
    async (field: TransitionField) => {
      setStatusMsg(null);
      if (field.kind === "unsupported") {
        setStatusMsg(`${field.name}: ${field.schemaType} isn't editable from the TUI`);
        return;
      }
      if (field.kind === "option") return setSub({ kind: "option", field });
      if (field.kind === "option-list") return setSub({ kind: "option-list", field });
      if (field.kind === "text") return setSub({ kind: "text", field });
      if (field.kind === "number") return setSub({ kind: "number", field });
      if (field.kind === "date") return setSub({ kind: "date", field });
      // User picker uses getAssignableUsers — i.e. people who can be assigned
      // issues in this project. Good enough for "Implementer" / "Reviewer"
      // style fields in the common case. If a workflow field targets a
      // wider audience (site-wide users, a specific group), some candidates
      // will be missing. The right fix is Jira's field-specific autocomplete
      // endpoint; deferring until a user actually hits the limitation.
      if (field.kind === "user") {
        setLoading(true);
        try {
          const users = await getAssignableUsers(cfg, projectKey);
          setSub({ kind: "user", field, users });
        } catch (e) {
          setStatusMsg(errorMessage(e));
        } finally {
          setLoading(false);
        }
        return;
      }
      if (field.kind === "user-list") {
        setLoading(true);
        try {
          const users = await getAssignableUsers(cfg, projectKey);
          setSub({ kind: "user-list", field, users });
        } catch (e) {
          setStatusMsg(errorMessage(e));
        } finally {
          setLoading(false);
        }
      }
    },
    [cfg, projectKey],
  );

  const doSubmit = useCallback(() => {
    if (missing.length > 0) {
      setStatusMsg(`missing: ${missing.join(", ")}`);
      return;
    }
    onSubmit(values);
  }, [missing, values, onSubmit]);

  useInput(
    (input, key) => {
      // Esc still works during a user-list fetch so a hung network doesn't
      // trap the user — the in-flight getAssignableUsers resolves later
      // into a no-op since the modal is unmounted.
      if (key.escape) return onCancel();
      if (loading) return;
      if (key.downArrow || input === "j")
        setIdx((i) => clamp(i + 1, 0, Math.max(0, fields.length - 1)));
      else if (key.upArrow || input === "k")
        setIdx((i) => clamp(i - 1, 0, Math.max(0, fields.length - 1)));
      else if (key.return) {
        const f = fields[clamp(idx, 0, fields.length - 1)];
        if (f) void openEditor(f);
      } else if (input === "s") doSubmit();
    },
    { isActive: sub.kind === "none" },
  );

  // Sub-picker overlays

  if (sub.kind === "option") {
    const currentId = (values[sub.field.id] as { id: string } | undefined)?.id;
    return (
      <FilterPicker
        title={sub.field.name}
        items={sub.field.allowedValues.map((v) => ({ id: v.id, label: v.name }))}
        {...(currentId ? { currentId } : {})}
        onPick={(id) => {
          setValues((v) => ({ ...v, [sub.field.id]: { id } }));
          setSub({ kind: "none" });
        }}
        onCancel={() => setSub({ kind: "none" })}
      />
    );
  }

  if (sub.kind === "option-list") {
    // MVP: pick one at a time. A second enter on the same row adds another
    // value. `clear all` resets. Matches how the label/component overlays
    // work in IssueDetailModal.
    const existing = (values[sub.field.id] as { id: string }[] | undefined) ?? [];
    const existingIds = new Set(existing.map((e) => e.id));
    const remaining = sub.field.allowedValues.filter((v) => !existingIds.has(v.id));
    return (
      <FilterPicker
        title={`${sub.field.name} (${existing.length} selected)`}
        items={remaining.map((v) => ({ id: v.id, label: v.name }))}
        onPick={(id) => {
          setValues((v) => ({
            ...v,
            [sub.field.id]: [...existing, { id }],
          }));
          setSub({ kind: "none" });
        }}
        onClear={() => {
          setValues((v) => ({ ...v, [sub.field.id]: [] }));
          setSub({ kind: "none" });
        }}
        onCancel={() => setSub({ kind: "none" })}
      />
    );
  }

  if (sub.kind === "user") {
    return (
      <FilterPicker
        title={sub.field.name}
        items={sub.users.map((u) => ({ id: u.accountId, label: u.displayName }))}
        onPick={(accountId) => {
          setValues((v) => ({ ...v, [sub.field.id]: { accountId } }));
          setSub({ kind: "none" });
        }}
        onCancel={() => setSub({ kind: "none" })}
      />
    );
  }

  if (sub.kind === "user-list") {
    const existing = (values[sub.field.id] as { accountId: string }[] | undefined) ?? [];
    const existingIds = new Set(existing.map((e) => e.accountId));
    const remaining = sub.users.filter((u) => !existingIds.has(u.accountId));
    return (
      <FilterPicker
        title={`${sub.field.name} (${existing.length} selected)`}
        items={remaining.map((u) => ({ id: u.accountId, label: u.displayName }))}
        onPick={(accountId) => {
          setValues((v) => ({
            ...v,
            [sub.field.id]: [...existing, { accountId }],
          }));
          setSub({ kind: "none" });
        }}
        onClear={() => {
          setValues((v) => ({ ...v, [sub.field.id]: [] }));
          setSub({ kind: "none" });
        }}
        onCancel={() => setSub({ kind: "none" })}
      />
    );
  }

  if (sub.kind === "text" || sub.kind === "number" || sub.kind === "date") {
    const current = values[sub.field.id];
    const initial = current === undefined ? "" : String(current);
    return (
      <InlineFieldInput
        field={sub.field.name}
        initial={initial}
        onSubmit={(raw) => {
          const trimmed = raw.trim();
          if (sub.kind === "number") {
            if (trimmed === "") {
              const next = { ...values };
              delete next[sub.field.id];
              setValues(next);
              setSub({ kind: "none" });
              return;
            }
            const n = Number(trimmed);
            if (Number.isNaN(n)) {
              setStatusMsg(`${sub.field.name}: invalid number`);
              return;
            }
            setValues((v) => ({ ...v, [sub.field.id]: n }));
          } else if (sub.kind === "date") {
            if (trimmed !== "" && !/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
              setStatusMsg(`${sub.field.name}: use YYYY-MM-DD`);
              return;
            }
            if (trimmed === "") {
              const next = { ...values };
              delete next[sub.field.id];
              setValues(next);
            } else {
              setValues((v) => ({ ...v, [sub.field.id]: trimmed }));
            }
          } else {
            if (trimmed === "") {
              const next = { ...values };
              delete next[sub.field.id];
              setValues(next);
            } else {
              setValues((v) => ({ ...v, [sub.field.id]: raw }));
            }
          }
          setSub({ kind: "none" });
        }}
        onCancel={() => setSub({ kind: "none" })}
      />
    );
  }

  // Main screen: the field list.
  const cursor = clamp(idx, 0, Math.max(0, fields.length - 1));
  const labelWidth = Math.min(
    24,
    Math.max(
      10,
      fields.reduce((m, f) => Math.max(m, f.name.length), 10),
    ),
  );
  const rowWidth = 72;
  const valueWidth = Math.max(10, rowWidth - labelWidth - 4);

  return (
    <Box flexDirection="column" padding={2} borderStyle="round" borderColor={theme.accent}>
      <Box>
        <Text color={theme.accent} bold>
          {transition.name}
        </Text>
        <Text color={theme.muted}> · {issueKey}</Text>
      </Box>
      <Box marginTop={1}>
        <Text color={theme.muted}>fill required fields, then press s to submit</Text>
      </Box>
      <Box flexDirection="column" marginTop={1}>
        {loading ? (
          <Text color={theme.accent}>loading…</Text>
        ) : (
          fields.map((f, i) => {
            const focused = i === cursor;
            const pointer = focused ? "> " : "  ";
            const labelCell = truncate(f.name, labelWidth).padEnd(labelWidth);
            const hasValue =
              f.kind !== "unsupported" &&
              values[f.id] !== undefined &&
              !(Array.isArray(values[f.id]) && (values[f.id] as unknown[]).length === 0);
            const valueStr =
              f.kind === "unsupported"
                ? `(${f.schemaType} — not editable)`
                : displayValue(f, values[f.id]);
            const valueCell = truncate(valueStr, valueWidth).padEnd(valueWidth);
            const color =
              f.kind === "unsupported"
                ? theme.err
                : focused
                  ? theme.accent
                  : hasValue
                    ? theme.fg
                    : theme.muted;
            return (
              <Text key={`f-${f.id}`} color={color} bold={focused} wrap="truncate">
                {pointer + labelCell + "  " + valueCell}
              </Text>
            );
          })
        )}
      </Box>
      <Box marginTop={1}>
        <Hint k="↑↓" label="nav" />
        <Hint k="⏎" label="edit" />
        <Hint k="s" label="submit" />
        <Hint k="esc" label="cancel" />
      </Box>
      {statusMsg ? (
        <Box marginTop={1}>
          <Text color={theme.err}>{statusMsg}</Text>
        </Box>
      ) : missing.length > 0 ? (
        <Box marginTop={1}>
          <Text color={theme.muted}>missing: {missing.join(", ")}</Text>
        </Box>
      ) : null}
    </Box>
  );
}
