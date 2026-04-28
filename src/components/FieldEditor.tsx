import { Box, Text, useInput } from "ink";
import { useEffect, useState } from "react";

import type { JiraConfig } from "../config";
import {
  type EditableField,
  type EditableFieldValue,
  type JiraUser,
  getAssignableUsers,
} from "../jira";
import { errorMessage, theme } from "../ui";
import { FilterPicker } from "./FilterPicker";
import { InlineFieldInput } from "./IssueDetailSide";

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
}: {
  cfg: JiraConfig;
  projectKey: string;
  field: EditableField;
  /** Current value as the caller understands it, for `currentId` seeding. */
  current?: EditableFieldValue;
  onSubmit: (value: EditableFieldValue | null) => void;
  onCancel: () => void;
}) {
  // User-typed fields need an async user-list fetch. Run it once per open.
  const [users, setUsers] = useState<JiraUser[] | null>(
    field.kind === "user" || field.kind === "user-list" ? null : [],
  );
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    if (field.kind !== "user" && field.kind !== "user-list") return;
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
  }, [cfg, projectKey, field.kind]);

  // Esc during the loading / error screens — FilterPicker and
  // InlineFieldInput own their own keyboard once rendered.
  const inTransientScreen =
    loadError !== null || ((field.kind === "user" || field.kind === "user-list") && users === null);
  useInput(
    (_input, key) => {
      if (key.escape) onCancel();
    },
    { isActive: inTransientScreen },
  );

  if (loadError) {
    return (
      <Box flexDirection="column" padding={2} borderStyle="round" borderColor={theme.error}>
        <Text color={theme.error} bold>
          {field.name}
        </Text>
        <Box marginTop={1}>
          <Text color={theme.error}>{loadError}</Text>
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
          <Text color={theme.muted}>loading users…</Text>
        </Box>
      </Box>
    );
  }

  if (field.kind === "option") {
    const currentId = (current as { id: string } | undefined)?.id;
    return (
      <FilterPicker
        title={field.name}
        items={field.allowedValues.map((v) => ({ id: v.id, label: v.name }))}
        {...(currentId ? { currentId } : {})}
        onPick={(id) => onSubmit({ id })}
        onClear={() => onSubmit(null)}
        onCancel={onCancel}
      />
    );
  }

  if (field.kind === "option-list") {
    // Build-then-submit: pick one at a time, each pick commits the
    // accumulated list to the caller. Cancel leaves the list unchanged.
    // `clear all` submits an empty array so the caller knows to clear.
    const existing = (current as { id: string }[] | undefined) ?? [];
    const existingIds = new Set(existing.map((e) => e.id));
    const remaining = field.allowedValues.filter((v) => !existingIds.has(v.id));
    return (
      <FilterPicker
        title={`${field.name} (${existing.length} selected)`}
        items={remaining.map((v) => ({ id: v.id, label: v.name }))}
        onPick={(id) => onSubmit([...existing, { id }])}
        onClear={() => onSubmit([])}
        onCancel={onCancel}
      />
    );
  }

  if (field.kind === "user" && users) {
    const currentId = (current as { accountId: string } | undefined)?.accountId;
    return (
      <FilterPicker
        title={field.name}
        items={users.map((u) => ({ id: u.accountId, label: u.displayName }))}
        {...(currentId ? { currentId } : {})}
        onPick={(accountId) => onSubmit({ accountId })}
        onClear={() => onSubmit(null)}
        onCancel={onCancel}
      />
    );
  }

  if (field.kind === "user-list" && users) {
    const existing = (current as { accountId: string }[] | undefined) ?? [];
    const existingIds = new Set(existing.map((e) => e.accountId));
    const remaining = users.filter((u) => !existingIds.has(u.accountId));
    return (
      <FilterPicker
        title={`${field.name} (${existing.length} selected)`}
        items={remaining.map((u) => ({ id: u.accountId, label: u.displayName }))}
        onPick={(accountId) => onSubmit([...existing, { accountId }])}
        onClear={() => onSubmit([])}
        onCancel={onCancel}
      />
    );
  }

  if (field.kind === "number") {
    const initial = typeof current === "number" ? String(current) : "";
    return (
      <InlineFieldInput
        field={field.name}
        initial={initial}
        onSubmit={(raw) => {
          const trimmed = raw.trim();
          if (trimmed === "") return onSubmit(null);
          const n = Number(trimmed);
          if (Number.isNaN(n)) return; // keep editor open; caller will reshow
          onSubmit(n);
        }}
        onCancel={onCancel}
      />
    );
  }

  if (field.kind === "date") {
    const initial = typeof current === "string" ? current : "";
    return (
      <InlineFieldInput
        field={field.name}
        initial={initial}
        onSubmit={(raw) => {
          const trimmed = raw.trim();
          if (trimmed === "") return onSubmit(null);
          if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return;
          onSubmit(trimmed);
        }}
        onCancel={onCancel}
      />
    );
  }

  if (field.kind === "string-list") {
    // Labels-shaped: comma-separated tokens, trimmed, empties dropped.
    const initial = Array.isArray(current) ? (current as string[]).join(", ") : "";
    return (
      <InlineFieldInput
        field={field.name}
        initial={initial}
        onSubmit={(raw) => {
          const tokens = raw
            .split(",")
            .map((s) => s.trim())
            .filter((s) => s.length > 0);
          onSubmit(tokens.length === 0 ? [] : tokens);
        }}
        onCancel={onCancel}
      />
    );
  }

  // `text` and anything that falls through (shouldn't happen — unsupported
  // is filtered by the caller).
  const initial = typeof current === "string" ? current : "";
  return (
    <InlineFieldInput
      field={field.name}
      initial={initial}
      onSubmit={(raw) => {
        const trimmed = raw.trim();
        onSubmit(trimmed === "" ? null : raw);
      }}
      onCancel={onCancel}
    />
  );
}
