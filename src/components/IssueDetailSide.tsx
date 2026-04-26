import { Box, Text } from "ink";
import { useState } from "react";

import type { CustomField } from "../jira";
import { bg, theme, truncate } from "../ui";
import { Hint } from "./Hint";
import { TextInput } from "./TextInput";

/**
 * Side-panel row for a project-specific custom field. Read-only — Jira's
 * custom-field type surface (user pickers, cascades, rich-text ADF,
 * etc.) is too wide to edit well from a TUI, and a partial edit story
 * is worse than honest read-only. Label width comes from the caller so
 * baked + custom rows align in one column.
 */
export function CustomSideField({
  field,
  focused,
  atCursor,
  sideWidth,
  labelWidth,
}: {
  field: CustomField;
  focused: boolean;
  /** Cursor sits here, but pane focus might be elsewhere (body pane). */
  atCursor: boolean;
  sideWidth: number;
  labelWidth: number;
}) {
  const display = customFieldDisplay(field);
  // Fixed-width text runs so Ink's layout and diff are deterministic —
  // no ambiguous-width glyph counting and no flex-shrink collapse. Tail
  // padding matches SideField's ⏎-hint slot so row widths align across
  // baked and custom rows.
  const pointer = focused ? "> " : atCursor ? "· " : "  ";
  const label = truncate(field.name.toLowerCase(), labelWidth).padEnd(labelWidth);
  const tail = "  ";
  const prefix = pointer + label;
  const valueWidth = Math.max(4, sideWidth - prefix.length - tail.length - 1);
  const padded = truncate(display, valueWidth).padEnd(valueWidth);
  const rowBg = focused ? theme.accentDim : undefined;
  const pointerColor = focused || atCursor ? theme.accent : theme.muted;
  const labelColor = focused ? theme.accent : atCursor ? theme.fg : theme.muted;
  return (
    <Box>
      <Text color={pointerColor} bold={focused} {...bg(rowBg)}>
        {pointer}
      </Text>
      <Text color={labelColor} bold={focused} {...bg(rowBg)}>
        {label}
      </Text>
      <Text color={theme.fg} bold={focused} {...bg(rowBg)}>
        {padded}
      </Text>
      <Text {...bg(rowBg)}>{tail}</Text>
    </Box>
  );
}

function customFieldDisplay(f: CustomField): string {
  if (f.value === null) return "—";
  if (Array.isArray(f.value)) return f.value.length === 0 ? "—" : f.value.join(", ");
  return String(f.value);
}

/**
 * Inline text input for the three baked fields that edit this way:
 * title, points, due. Caller routes the submit by `field`.
 */
export function InlineFieldInput({
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
  const placeholder =
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
          placeholder={placeholder}
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
