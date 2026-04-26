/**
 * Custom-field display-value extraction, split out of `jira.ts` because
 * the editmeta → CustomField translation has nothing to do with REST
 * plumbing. Editing custom fields isn't supported — Jira's type surface
 * (user pickers, cascades, version pickers, group pickers, time
 * tracking, rich-text ADF) is too wide to do well from a TUI, and a
 * partial edit story is worse than honest read-only.
 */

/**
 * Fields we already render with dedicated UI. Skipped here so they don't
 * appear twice in the detail side panel. These are the Jira Cloud
 * defaults; tenants can remap, but we don't try to be clever about it.
 */
const BAKED_CUSTOM_FIELDS = new Set([
  "customfield_10014",
  "customfield_10016",
  "customfield_10020",
]);

/**
 * A project's custom fields, normalized for display. Values collapse to
 * strings, numbers, arrays of strings, or null (unset) — enough for the
 * detail side panel to render without caring about the schema.
 */
export type CustomField = {
  /** Jira field id, e.g. `customfield_10042`. */
  id: string;
  /** Human label Jira has configured. */
  name: string;
  value: string | number | string[] | null;
};

/**
 * Walk whatever shape Jira returned and pull a sensible display value.
 * Covers the common cases — string, number, option, multi-option,
 * labels-shaped, user, multi-user, cascading — and falls back to empty
 * when the shape isn't recognized.
 */
function extractValue(
  raw: unknown,
  schemaType: unknown,
  schemaItems: unknown,
): CustomField["value"] {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "number") return raw;
  if (typeof raw === "string") {
    // Dates arrive as full ISO timestamps — keep only the calendar date.
    return schemaType === "date" || schemaType === "datetime" ? raw.slice(0, 10) : raw;
  }
  if (Array.isArray(raw)) {
    // Labels-shaped arrays come in as `string[]`; everything else is
    // array-of-objects (options, users, etc.) and needs per-entry
    // flattening.
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
  // Users come with `displayName`; options with `value`; cascades add a
  // `child` under the parent option.
  if (o.displayName) return String(o.displayName);
  if (o.value) return o.child?.value ? `${o.value} / ${o.child.value}` : String(o.value);
  if (o.name) return String(o.name);
  return "";
}

/**
 * Normalize an editmeta field + its current value into our display
 * shape. Returns null for the three baked-in custom fields (epic,
 * sprint, points) so they don't render twice in the side panel.
 */
export function normalizeCustomField(id: string, meta: any, rawValue: unknown): CustomField | null {
  if (BAKED_CUSTOM_FIELDS.has(id)) return null;
  const name: string = meta?.name ?? id;
  const value = extractValue(rawValue, meta?.schema?.type, meta?.schema?.items);
  return { id, name, value };
}
