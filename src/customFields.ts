/**
 * Custom-field representation for the detail side panel. The heavy
 * normalization used to live in `jira.ts`; it's here because the
 * editmeta → display translation is shared between the board's
 * board-issue list and the per-issue detail view, and neither wants to
 * know about REST plumbing.
 *
 * Now also threads through the EditableField metadata from editmeta so
 * the side panel can reuse the shared FieldEditor component for edits.
 */

import type { EditableField, EditableFieldValue } from "./jira";

/**
 * Fields we already render with dedicated UI. Skipped here so they don't
 * appear twice in the detail side panel. Jira Cloud defaults.
 */
const BAKED_CUSTOM_FIELDS = new Set([
  "customfield_10014",
  "customfield_10016",
  "customfield_10020",
]);

/**
 * A project's custom fields, normalized for display AND edit. `display`
 * is the human-readable string (or number, or list) the side panel shows.
 * `meta` carries the EditableField dispatch info; `current` is the raw
 * value coerced into the shape Jira expects on PUT — i.e. what
 * FieldEditor would produce if the user opened and re-picked the same
 * value. `current` is absent for unsupported kinds or when the field is
 * unset.
 */
export type CustomField = {
  id: string;
  name: string;
  display: string | number | string[] | null;
  meta: EditableField;
  current?: EditableFieldValue;
};

function extractDisplay(
  raw: unknown,
  schemaType: unknown,
  schemaItems: unknown,
): CustomField["display"] {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "number") return raw;
  if (typeof raw === "string") {
    // Dates arrive as full ISO timestamps — keep only the calendar date.
    return schemaType === "date" || schemaType === "datetime" ? raw.slice(0, 10) : raw;
  }
  if (Array.isArray(raw)) {
    if (schemaItems === "string") return raw.map((v) => String(v));
    const mapped = raw.map(extractObjectDisplay).filter(Boolean);
    return mapped.length === 0 ? null : mapped;
  }
  if (typeof raw === "object") {
    const s = extractObjectDisplay(raw);
    return s === "" ? null : s;
  }
  return null;
}

function extractObjectDisplay(o: any): string {
  if (o === null || o === undefined) return "";
  if (typeof o === "string") return o;
  if (typeof o === "number") return String(o);
  if (o.displayName) return String(o.displayName);
  if (o.value) return o.child?.value ? `${o.value} / ${o.child.value}` : String(o.value);
  if (o.name) return String(o.name);
  return "";
}

/**
 * Coerce a raw Jira field value into the shape `FieldEditor` expects as
 * `current`. Must match the shape we POST back (see jira.ts
 * `EditableFieldValue`), so editing an option field seeds `{id}` not
 * `{id, value, name}`. Returns undefined when the field is unset OR the
 * kind is unsupported — the caller treats both as "no pre-selection".
 */
function extractEditorValue(raw: unknown, field: EditableField): EditableFieldValue | undefined {
  if (raw === null || raw === undefined) return undefined;
  switch (field.kind) {
    case "option":
      if (typeof raw === "object" && raw !== null && "id" in raw) {
        return { id: String((raw as any).id) };
      }
      return undefined;
    case "option-list":
      if (!Array.isArray(raw)) return undefined;
      return raw
        .filter((v) => v && typeof v === "object" && "id" in v)
        .map((v) => ({ id: String((v as any).id) }));
    case "user":
      if (typeof raw === "object" && raw !== null && "accountId" in raw) {
        return { accountId: String((raw as any).accountId) };
      }
      return undefined;
    case "user-list":
      if (!Array.isArray(raw)) return undefined;
      return raw
        .filter((v) => v && typeof v === "object" && "accountId" in v)
        .map((v) => ({ accountId: String((v as any).accountId) }));
    case "text":
      return typeof raw === "string" ? raw : undefined;
    case "string-list":
      if (!Array.isArray(raw)) return undefined;
      return raw.map((v) => String(v));
    case "number":
      return typeof raw === "number" ? raw : undefined;
    case "date":
      return typeof raw === "string" ? raw.slice(0, 10) : undefined;
    case "unsupported":
      return undefined;
  }
}

/**
 * Build a CustomField from an editmeta entry. Returns null for the three
 * baked-in custom fields (epic, sprint, points) so they don't render
 * twice in the side panel, and when the meta itself is malformed.
 */
export function normalizeCustomField(
  id: string,
  meta: any,
  rawValue: unknown,
  editable: EditableField | undefined,
): CustomField | null {
  if (BAKED_CUSTOM_FIELDS.has(id)) return null;
  if (!editable) return null;
  const name: string = meta?.name ?? id;
  const display = extractDisplay(rawValue, meta?.schema?.type, meta?.schema?.items);
  const current = extractEditorValue(rawValue, editable);
  const out: CustomField = { id, name, display, meta: editable };
  if (current !== undefined) out.current = current;
  return out;
}
