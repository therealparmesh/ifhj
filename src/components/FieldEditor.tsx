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
          <LoadingLine label="loading users…" />
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
        {...(!field.required ? { onClear: () => onSubmit(null) } : {})}
        onCancel={onCancel}
      />
    );
  }

  if (field.kind === "option-list") {
    const existing = (current as { id: string }[] | undefined) ?? [];
    const existingIds = new Set(existing.map((e) => e.id));
    return (
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
          if (existingIds.has(id)) {
            if (!field.required || existing.length > 1) {
              onSubmit(existing.filter((value) => value.id !== id));
            }
          } else {
            onSubmit([...existing, { id }]);
          }
        }}
        {...(!field.required ? { onClear: () => onSubmit([]) } : {})}
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
        {...(!field.required ? { onClear: () => onSubmit(null) } : {})}
        onCancel={onCancel}
      />
    );
  }

  if (field.kind === "user-list" && users) {
    const existing = (current as { accountId: string }[] | undefined) ?? [];
    const existingIds = new Set(existing.map((e) => e.accountId));
    return (
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
          if (existingIds.has(accountId)) {
            if (!field.required || existing.length > 1) {
              onSubmit(existing.filter((value) => value.accountId !== accountId));
            }
          } else {
            onSubmit([...existing, { accountId }]);
          }
        }}
        {...(!field.required ? { onClear: () => onSubmit([]) } : {})}
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
        placeholder={field.required ? "number" : "number (empty to clear)"}
        onSubmit={(raw) => {
          const trimmed = raw.trim();
          if (trimmed === "") {
            if (!field.required) onSubmit(null);
            return;
          }
          const n = Number(trimmed);
          // Non-numeric: no-op. The input stays mounted with the user's
          // text so they can correct it; the placeholder names the format.
          if (!Number.isFinite(n)) return;
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
        placeholder={field.required ? "YYYY-MM-DD" : "YYYY-MM-DD (empty to clear)"}
        onSubmit={(raw) => {
          const trimmed = raw.trim();
          if (trimmed === "") {
            if (!field.required) onSubmit(null);
            return;
          }
          // Reject both malformed and impossible dates (e.g. 2026-13-45)
          // before they POST — a round-trip parse catches calendar overflow
          // that the shape regex alone would pass.
          if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return;
          const d = new Date(`${trimmed}T00:00:00Z`);
          if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== trimmed) return;
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
        placeholder={field.required ? "comma-separated" : "comma-separated (empty to clear)"}
        onSubmit={(raw) => {
          const tokens = raw
            .split(",")
            .map((s) => s.trim())
            .filter((s) => s.length > 0);
          if (tokens.length > 0 || !field.required) onSubmit(tokens);
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
      placeholder={field.required ? "text" : "text (empty to clear)"}
      onSubmit={(raw) => {
        const trimmed = raw.trim();
        if (trimmed !== "") onSubmit(raw);
        else if (!field.required) onSubmit(null);
      }}
      onCancel={onCancel}
    />
  );
}
