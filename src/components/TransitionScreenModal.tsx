import { Box, Text } from "ink";
import { useCallback, useMemo, useRef, useState } from "react";

import type { JiraConfig } from "../config";
import { useDimensions } from "../hooks";
import { useInput } from "../input";
import type { EditableField, EditableFieldValue, Transition } from "../jira";
import { clamp, fg, stickyScroll, theme, truncate } from "../ui";
import { ErrorMessage } from "./ErrorMessage";
import { FieldEditor } from "./FieldEditor";
import { Hint } from "./Hint";
import { LoadingLine } from "./LoadingLine";

/**
 * Render a stored value back as a human label for the field list.
 */
function displayValue(field: EditableField, value: EditableFieldValue | undefined): string {
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
  // We only hold the accountId here (FieldEditor collects `{accountId}`, not
  // the display name), and a raw id is noise — just confirm it's set.
  if (field.kind === "user") return "selected";
  if (field.kind === "user-list") {
    const arr = value as { accountId: string }[];
    return arr.length === 0 ? "—" : `${arr.length} user${arr.length === 1 ? "" : "s"}`;
  }
  if (field.kind === "string-list") {
    const arr = value as string[];
    return arr.length === 0 ? "—" : arr.join(", ");
  }
  if (field.kind === "number") return String(value as number);
  if (field.kind === "text" || field.kind === "date") return String(value);
  return "—";
}

/**
 * Required-fields screen for a Jira workflow transition. Only opens when
 * `transition.requiredFields` is non-empty — otherwise the caller POSTs
 * straight through. Each field's sub-editor is delegated to `FieldEditor`
 * so the same dispatch logic handles custom-field edits in the detail
 * view. Unsupported kinds show in red with an inline hint; `missing`
 * includes them so submit stays blocked until the user resolves them
 * (typically by completing the transition in the browser).
 */
export function TransitionScreenModal({
  cfg,
  projectKey,
  issueKey,
  transition,
  initialValues = {},
  onCancel,
  onSubmit,
  onOpenIssue,
  onEdit,
  busy = false,
  error,
}: {
  cfg: JiraConfig;
  projectKey: string;
  issueKey: string;
  transition: Transition;
  initialValues?: Record<string, EditableFieldValue>;
  onCancel: (values?: Record<string, EditableFieldValue>) => void;
  onSubmit: (fields: Record<string, EditableFieldValue>) => void;
  onOpenIssue?: () => void;
  /** Called only when a collected field value actually changes. */
  onEdit?: () => void;
  busy?: boolean | undefined;
  error?: string | null | undefined;
}) {
  const { cols: termCols, rows: termRows } = useDimensions();
  const [values, setValues] = useState<Record<string, EditableFieldValue>>(initialValues);
  const [idx, setIdx] = useState(0);
  const scrollRef = useRef(0);
  const [editing, setEditing] = useState<EditableField | null>(null);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const submitLocked = useRef(false);
  const wasBusy = useRef(busy);
  if (wasBusy.current && !busy) submitLocked.current = false;
  wasBusy.current = busy;

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
      else if (typeof val === "string" && val.trim() === "") names.push(f.name);
    }
    return names;
  }, [fields, values]);

  const doSubmit = useCallback(() => {
    if (submitLocked.current) return;
    if (missing.length > 0) {
      setStatusMsg(`missing: ${missing.join(", ")}`);
      return;
    }
    submitLocked.current = true;
    onSubmit(values);
  }, [missing, values, onSubmit]);

  useInput(
    (input, key) => {
      if (key.escape) return onCancel(values);
      if (input === "o" && onOpenIssue) return onOpenIssue();
      if (key.downArrow || input === "j")
        setIdx((i) => clamp(i + 1, 0, Math.max(0, fields.length - 1)));
      else if (key.upArrow || input === "k")
        setIdx((i) => clamp(i - 1, 0, Math.max(0, fields.length - 1)));
      else if (key.return) {
        const f = fields[clamp(idx, 0, fields.length - 1)];
        if (!f) return;
        if (f.kind === "unsupported") {
          setStatusMsg(
            onOpenIssue
              ? `${f.name} needs Jira. Press o to open ${issueKey}.`
              : `${f.name}: complete this required field in the browser`,
          );
          return;
        }
        setStatusMsg(null);
        setEditing(f);
      } else if (input === "s") doSubmit();
    },
    { isActive: editing === null && !busy },
  );

  if (editing) {
    const currentValue = values[editing.id];
    return (
      <FieldEditor
        cfg={cfg}
        projectKey={projectKey}
        field={editing}
        {...(currentValue !== undefined ? { current: currentValue } : {})}
        onSubmit={(value) => {
          setStatusMsg(null);
          const nextValue = value === null ? undefined : value;
          if (JSON.stringify(currentValue) !== JSON.stringify(nextValue)) onEdit?.();
          setValues((v) => {
            const next = { ...v };
            if (value === null) delete next[editing.id];
            else next[editing.id] = value;
            return next;
          });
          setEditing(null);
        }}
        onCancel={() => setEditing(null)}
        submitLabel="use value"
      />
    );
  }

  const cursor = clamp(idx, 0, Math.max(0, fields.length - 1));
  // Padding, borders, headings, footer, and status consume 14 rows.
  const fieldWindow = Math.max(1, termRows - 14);
  const scroll = stickyScroll(fields.length, fieldWindow, cursor, scrollRef.current);
  scrollRef.current = scroll;
  const visibleFields = fields.slice(scroll, scroll + fieldWindow);
  const contentWidth = Math.max(1, termCols - 6);
  const issueText = ` · ${issueKey}`;
  const titleWidth = Math.max(1, contentWidth - Bun.stringWidth(issueText));
  const labelWidth = Math.min(
    24,
    Math.max(
      10,
      fields.reduce((m, f) => Math.max(m, f.name.length), 10),
    ),
  );
  const rowWidth = Math.min(72, contentWidth);
  const valueWidth = Math.max(10, rowWidth - labelWidth - 4);

  return (
    <Box flexDirection="column" padding={2} borderStyle="round" borderColor={theme.accent}>
      <Box width={contentWidth} height={1} overflow="hidden">
        <Text color={theme.accent} bold wrap="truncate">
          {truncate(transition.name, titleWidth)}
        </Text>
        <Text color={theme.muted}>{issueText}</Text>
      </Box>
      <Box marginTop={1}>
        <Text color={theme.muted} wrap="truncate">
          {busy
            ? "Saving transition. Inputs are unavailable."
            : "Fill required fields, then press s to submit."}
        </Text>
      </Box>
      <Box flexDirection="column" marginTop={1}>
        {visibleFields.map((f, i) => {
          const focused = scroll + i === cursor;
          const pointer = focused ? "> " : "  ";
          const labelCell = truncate(f.name, labelWidth).padEnd(labelWidth);
          const hasValue =
            f.kind !== "unsupported" &&
            values[f.id] !== undefined &&
            !(Array.isArray(values[f.id]) && (values[f.id] as unknown[]).length === 0);
          const valueStr =
            f.kind === "unsupported"
              ? `(${f.schemaType} — ${busy ? "unavailable while saving" : onOpenIssue ? "press o to open" : "complete in browser"})`
              : displayValue(f, values[f.id]);
          const valueCell = truncate(valueStr, valueWidth).padEnd(valueWidth);
          const color =
            f.kind === "unsupported"
              ? theme.error
              : focused
                ? theme.accent
                : hasValue
                  ? theme.fg
                  : theme.muted;
          return (
            <Text key={`f-${f.id}`} {...fg(color)} bold={focused} wrap="truncate">
              {pointer + labelCell + "  " + valueCell}
            </Text>
          );
        })}
      </Box>
      <Box marginTop={1} justifyContent="space-between">
        {busy ? (
          <Text color={theme.muted}>Please wait for the save to finish.</Text>
        ) : (
          <Box>
            <Hint k="↑↓" label="nav" />
            <Hint k="⏎" label="edit" />
            <Hint k="s" label="submit" />
            {onOpenIssue ? <Hint k="o" label={`open ${issueKey}`} /> : null}
            <Hint k="esc" label="cancel" />
          </Box>
        )}
        <Text color={theme.muted}>
          {cursor + 1}/{fields.length}
        </Text>
      </Box>
      {busy ? <LoadingLine label="Saving transition…" /> : null}
      {error ? (
        <Box marginTop={1}>
          <ErrorMessage message={error} width={contentWidth} />
        </Box>
      ) : statusMsg ? (
        <Box marginTop={1}>
          <ErrorMessage message={statusMsg} width={contentWidth} />
        </Box>
      ) : missing.length > 0 ? (
        <Box marginTop={1}>
          <Text color={theme.muted} wrap="truncate">
            missing: {missing.join(", ")}
          </Text>
        </Box>
      ) : null}
    </Box>
  );
}
