import { Box, Text, useInput } from "ink";
import { useCallback, useMemo, useState } from "react";

import type { JiraConfig } from "../config";
import type { EditableField, EditableFieldValue, Transition } from "../jira";
import { clamp, theme, truncate } from "../ui";
import { FieldEditor } from "./FieldEditor";
import { Hint } from "./Hint";

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
  if (field.kind === "user") return (value as { accountId: string }).accountId;
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
  onCancel,
  onSubmit,
}: {
  cfg: JiraConfig;
  projectKey: string;
  issueKey: string;
  transition: Transition;
  onCancel: () => void;
  onSubmit: (fields: Record<string, EditableFieldValue>) => void;
}) {
  const [values, setValues] = useState<Record<string, EditableFieldValue>>({});
  const [idx, setIdx] = useState(0);
  const [editing, setEditing] = useState<EditableField | null>(null);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);

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
    if (missing.length > 0) {
      setStatusMsg(`missing: ${missing.join(", ")}`);
      return;
    }
    onSubmit(values);
  }, [missing, values, onSubmit]);

  useInput(
    (input, key) => {
      if (key.escape) return onCancel();
      if (key.downArrow || input === "j")
        setIdx((i) => clamp(i + 1, 0, Math.max(0, fields.length - 1)));
      else if (key.upArrow || input === "k")
        setIdx((i) => clamp(i - 1, 0, Math.max(0, fields.length - 1)));
      else if (key.return) {
        const f = fields[clamp(idx, 0, fields.length - 1)];
        if (!f) return;
        if (f.kind === "unsupported") {
          setStatusMsg(`${f.name}: ${f.schemaType} isn't editable from the TUI`);
          return;
        }
        setStatusMsg(null);
        setEditing(f);
      } else if (input === "s") doSubmit();
    },
    { isActive: editing === null },
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
          setValues((v) => {
            const next = { ...v };
            if (value === null) delete next[editing.id];
            else next[editing.id] = value;
            return next;
          });
          setEditing(null);
        }}
        onCancel={() => setEditing(null)}
      />
    );
  }

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
        {fields.map((f, i) => {
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
        })}
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
