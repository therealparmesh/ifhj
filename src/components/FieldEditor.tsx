import { Box, Text } from "ink";
import { type ReactNode, useEffect, useState } from "react";

import type { JiraConfig } from "../config";
import { useDimensions } from "../hooks";
import { InputScope, useInput } from "../input";
import {
  type EditableField,
  type EditableFieldValue,
  type JiraUser,
  getAssignableUsers,
} from "../jira";
import { errorMessage, theme } from "../ui";
import { ErrorMessage } from "./ErrorMessage";
import { FilterPicker } from "./FilterPicker";
import { Hint } from "./Hint";
import { InlineFieldInput } from "./IssueDetailSide";
import { LoadingLine } from "./LoadingLine";

/**
 * Single-field editor that renders an appropriate sub-picker for the
 * field's kind and returns the user's pick through `onSubmit`. Shared
 * between `TransitionScreenModal` (which aggregates many fields and
 * submits together) and `IssueDetailModal` (which saves one field at a
 * time). The caller owns persistence — this component only collects.
 *
 * `unsupported` kinds aren't reached here; the caller filters them out
 * and displays a static "complete in browser" message instead.
 */
export function FieldEditor({
  cfg,
  projectKey,
  field,
  current,
  onSubmit,
  onCancel,
  submitLabel = "use value",
  error,
  onEdit,
  busy = false,
  busyLabel = "Saving field…",
  onRetry,
}: {
  cfg: JiraConfig;
  projectKey: string;
  field: EditableField;
  /** Current value as the caller understands it, for `currentId` seeding. */
  current?: EditableFieldValue;
  onSubmit: (value: EditableFieldValue | null) => void;
  onCancel: () => void;
  submitLabel?: string;
  error?: string | undefined;
  onEdit?: () => void;
  busy?: boolean;
  busyLabel?: string;
  onRetry?: () => void;
}) {
  // User-typed fields need an async user-list fetch. Run it once per open.
  const [users, setUsers] = useState<JiraUser[] | null>(
    field.kind === "user" || field.kind === "user-list" ? null : [],
  );
  const [loadError, setLoadError] = useState<string | null>(null);
  const { cols } = useDimensions();
  const usesErrorScreen =
    field.kind === "option" ||
    field.kind === "option-list" ||
    field.kind === "user" ||
    field.kind === "user-list";
  const pickerProps = { submitLabel, busy, busyLabel, onCancel };
  const withError = (child: ReactNode) => (
    <>
      <InputScope enabled={!error && !busy}>
        <Box display={error || busy ? "none" : "flex"}>{child}</Box>
      </InputScope>
      {busy ? (
        <Box flexDirection="column" padding={2} borderStyle="round" borderColor={theme.accent}>
          <Text color={theme.accent} bold>
            {field.name}
          </Text>
          <LoadingLine label={busyLabel} />
          <Text color={theme.muted}>Please wait for the save to finish.</Text>
        </Box>
      ) : error ? (
        <Box flexDirection="column" padding={2} borderStyle="round" borderColor={theme.error}>
          <Text color={theme.error} bold>
            {field.name} was not saved
          </Text>
          <ErrorMessage message={error} width={Math.max(1, cols - 6)} rows={3} />
          <Box marginTop={1}>
            {onRetry ? <Hint k="⏎" label="retry save" /> : null}
            <Hint k="e" label="edit value" />
            <Hint k="esc" label="cancel" />
          </Box>
        </Box>
      ) : null}
    </>
  );

  useEffect(() => {
    setLoadError(null);
    if (field.kind !== "user" && field.kind !== "user-list") {
      setUsers([]);
      return;
    }
    setUsers(null);
    if (!projectKey) {
      setUsers([]);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const u = await getAssignableUsers(cfg, projectKey);
        if (!cancelled) setUsers(u);
      } catch (e) {
        if (!cancelled) setLoadError(errorMessage(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [cfg, projectKey, field.id, field.kind]);

  // Keep this subscription mounted while a child editor replaces the loading
  // screen. Dropping the last subscription resets Ink's pending input parser.
  // Child editors own Escape after the transient screen has gone.
  const inTransientScreen =
    loadError !== null || ((field.kind === "user" || field.kind === "user-list") && users === null);
  useInput((_input, key) => {
    if (inTransientScreen && key.escape) onCancel();
  });
  useInput(
    (input, key) => {
      if (key.escape) onCancel();
      else if (key.return) onRetry?.();
      else if (!key.ctrl && !key.meta && input === "e") onEdit?.();
    },
    { isActive: usesErrorScreen && !inTransientScreen && Boolean(error) && !busy },
  );

  if (loadError) {
    return (
      <Box flexDirection="column" padding={2} borderStyle="round" borderColor={theme.error}>
        <Text color={theme.error} bold>
          {field.name}
        </Text>
        <Box marginTop={1}>
          <ErrorMessage message={loadError} width={Math.max(1, cols - 6)} rows={3} />
        </Box>
        <Box marginTop={1}>
          <Text color={theme.muted}>press esc to cancel</Text>
        </Box>
      </Box>
    );
  }

  if ((field.kind === "user" || field.kind === "user-list") && users === null) {
    return (
      <Box flexDirection="column" padding={2} borderStyle="round" borderColor={theme.accent}>
        <Text color={theme.accent} bold>
          {field.name}
        </Text>
        <Box marginTop={1}>
          <LoadingLine label="Loading users…" />
        </Box>
      </Box>
    );
  }

  if (field.kind === "option") {
    const currentId = (current as { id: string } | undefined)?.id;
    return withError(
      <FilterPicker
        title={field.name}
        items={field.allowedValues.map((v) => ({ id: v.id, label: v.name }))}
        {...(currentId ? { currentId } : {})}
        {...pickerProps}
        onPick={(id) => {
          onEdit?.();
          onSubmit({ id });
        }}
        {...(!field.required ? { onClear: () => onSubmit(null) } : {})}
      />,
    );
  }

  if (field.kind === "option-list") {
    const existing = (current as { id: string }[] | undefined) ?? [];
    const existingIds = new Set(existing.map((e) => e.id));
    return withError(
      <FilterPicker
        title={`${field.name} (${existing.length} selected)`}
        items={field.allowedValues.map((v) => ({
          id: v.id,
          label: v.name,
          ...(existingIds.has(v.id)
            ? {
                hint:
                  field.required && existing.length === 1
                    ? "required; keep selected"
                    : "selected; pick to remove",
              }
            : {}),
        }))}
        onPick={(id) => {
          onEdit?.();
          const next = toggleListValue(existing, { id }, (value) => value.id, field.required);
          if (next) onSubmit(next);
        }}
        {...pickerProps}
        {...(!field.required ? { onClear: () => onSubmit([]) } : {})}
      />,
    );
  }

  if (field.kind === "user" && users) {
    const currentId = (current as { accountId: string } | undefined)?.accountId;
    return withError(
      <FilterPicker
        title={field.name}
        items={users.map((u) => ({ id: u.accountId, label: u.displayName }))}
        {...(currentId ? { currentId } : {})}
        {...pickerProps}
        onPick={(accountId) => {
          onEdit?.();
          onSubmit({ accountId });
        }}
        {...(!field.required ? { onClear: () => onSubmit(null) } : {})}
      />,
    );
  }

  if (field.kind === "user-list" && users) {
    const existing = (current as { accountId: string }[] | undefined) ?? [];
    const existingIds = new Set(existing.map((e) => e.accountId));
    return withError(
      <FilterPicker
        title={`${field.name} (${existing.length} selected)`}
        items={users.map((u) => ({
          id: u.accountId,
          label: u.displayName,
          ...(existingIds.has(u.accountId)
            ? {
                hint:
                  field.required && existing.length === 1
                    ? "required; keep selected"
                    : "selected; pick to remove",
              }
            : {}),
        }))}
        onPick={(accountId) => {
          onEdit?.();
          const next = toggleListValue(
            existing,
            { accountId },
            (value) => value.accountId,
            field.required,
          );
          if (next) onSubmit(next);
        }}
        {...pickerProps}
        {...(!field.required ? { onClear: () => onSubmit([]) } : {})}
      />,
    );
  }

  const inputKind = field.kind;
  const initial =
    inputKind === "number"
      ? typeof current === "number"
        ? String(current)
        : ""
      : inputKind === "string-list"
        ? Array.isArray(current)
          ? (current as string[]).join(", ")
          : ""
        : typeof current === "string"
          ? current
          : "";
  const placeholder =
    inputKind === "number"
      ? "number"
      : inputKind === "date"
        ? "YYYY-MM-DD"
        : inputKind === "string-list"
          ? "comma-separated"
          : "text";
  return (
    <InlineFieldInput
      field={field.name}
      initial={initial}
      placeholder={field.required ? placeholder : `${placeholder} (empty to clear)`}
      submitLabel={submitLabel}
      error={error}
      onChange={onEdit}
      busy={busy}
      busyLabel={busyLabel}
      validate={(raw) => {
        const trimmed = raw.trim();
        if (inputKind === "string-list") {
          return field.required && !raw.split(",").some((value) => value.trim())
            ? "Enter at least one value."
            : null;
        }
        if (!trimmed) return field.required ? `${field.name} is required.` : null;
        if (inputKind === "number") {
          return Number.isFinite(Number(trimmed)) ? null : "Enter a finite number.";
        }
        if (inputKind === "date") {
          if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return "Enter a date as YYYY-MM-DD.";
          const date = new Date(`${trimmed}T00:00:00Z`);
          return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === trimmed
            ? null
            : "Enter a valid calendar date.";
        }
        return null;
      }}
      onSubmit={(raw) => {
        const trimmed = raw.trim();
        if (inputKind === "string-list") {
          onSubmit(
            raw
              .split(",")
              .map((value) => value.trim())
              .filter(Boolean),
          );
        } else if (!trimmed) {
          if (!field.required) onSubmit(null);
        } else if (inputKind === "number") {
          onSubmit(Number(trimmed));
        } else if (inputKind === "date") {
          onSubmit(trimmed);
        } else {
          onSubmit(raw);
        }
      }}
      onCancel={onCancel}
    />
  );
}

function toggleListValue<T>(
  values: T[],
  selected: T,
  getId: (value: T) => string,
  required: boolean,
): T[] | undefined {
  const id = getId(selected);
  if (!values.some((value) => getId(value) === id)) return [...values, selected];
  if (required && values.length === 1) return undefined;
  return values.filter((value) => getId(value) !== id);
}
