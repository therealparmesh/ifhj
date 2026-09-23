import { adfToText, textToAdf } from "./adf";
import type { JiraConfig } from "./config";
import { type CustomField, normalizeCustomField } from "./customFields";
export type { CustomField } from "./customFields";

export const ISSUE_SEARCH_LIMIT = 25;
export const JQL_SEARCH_LIMIT = 50;

/**
 * Jira Cloud's default custom-field IDs — the fallback when field discovery
 * fails or a tenant exposes no matching field. Tenants can remap these, so we
 * prefer to *discover* the real ids (see `resolveFieldIds`); these defaults
 * cover the vast majority and keep the app working if `/field` is unreachable.
 */
const DEFAULT_FIELD_IDS: FieldIds = {
  epicLink: "customfield_10014",
  sprint: "customfield_10020",
  storyPoints: "customfield_10016",
};

/** The three agile fields whose ids vary by tenant, resolved per server. */
type FieldIds = { epicLink: string; sprint: string; storyPoints: string };

/**
 * Resolved field ids are stable for the life of a credential, so cache them
 * per server and auth header. The promise also coalesces concurrent callers.
 */
const fieldIdCache = new Map<string, Promise<FieldIds>>();

/**
 * Discover the epic-link, sprint, and story-points field ids for this tenant.
 * The numeric `customfield_NNNNN` differs per instance, but Jira's `schema.custom`
 * plugin identifier is invariant — so we match on that. Story points has no
 * single stable key on classic projects (it's a generic float), so we match
 * the team-managed `jsw-story-points` and otherwise keep the default. Any
 * failure falls back wholesale to `DEFAULT_FIELD_IDS`; nothing here is fatal.
 */
async function resolveFieldIds(cfg: JiraConfig): Promise<FieldIds> {
  const cacheKey = `${cfg.server}\0${cfg.authHeader}`;
  const cached = fieldIdCache.get(cacheKey);
  if (cached) return cached;

  const discovery = (async () => {
    const data = await jget(cfg, `/rest/api/3/field`, "Load fields");
    if (!Array.isArray(data)) throw new Error("field discovery returned a malformed response");
    const fields: any[] = data;
    const byCustom = (key: string) =>
      fields.find((f) => (f?.schema?.custom ?? "").endsWith(key))?.id;
    return {
      epicLink: byCustom("gh-epic-link") ?? DEFAULT_FIELD_IDS.epicLink,
      sprint: byCustom("gh-sprint") ?? DEFAULT_FIELD_IDS.sprint,
      storyPoints: byCustom("jsw-story-points") ?? DEFAULT_FIELD_IDS.storyPoints,
    };
  })();
  let pending: Promise<FieldIds>;
  pending = discovery.catch(() => {
    // Failure handling belongs to the shared promise so every concurrent
    // caller gets the fallback. Eviction lets a later operation retry.
    if (fieldIdCache.get(cacheKey) === pending) fieldIdCache.delete(cacheKey);
    return { ...DEFAULT_FIELD_IDS };
  });
  fieldIdCache.set(cacheKey, pending);
  return pending;
}

export type Board = {
  id: number;
  name: string;
  type: string;
  projectKey?: string;
  projectName?: string;
};

export type BoardColumn = {
  name: string;
  statusIds: string[];
  /** WIP max from board config. 0 (or unset) means no limit. */
  max?: number;
};

/**
 * How a board buckets issues into horizontal swimlanes. `custom` lanes are
 * JQL-defined and evaluated server-side (see `getBoardSwimlanes`); the field
 * strategies are grouped client-side from issue fields we already fetch.
 */
export type SwimlaneStrategy =
  | "none"
  | "custom"
  | "assignee"
  | "epic"
  | "issueType"
  | "parentChild";

export type BoardConfig = {
  name: string;
  projectKey: string;
  columns: BoardColumn[];
  estimationFieldId?: string;
};

/** One swimlane's identity (custom lanes only — field lanes are derived). */
type SwimlaneDef = { id: string; name: string };

/**
 * Swimlane layout for a board, sourced from the internal GreenHopper board
 * model (the public Agile config endpoint doesn't expose swimlanes at all).
 * For `custom` strategy the server evaluates each lane's JQL and hands back
 * membership by issue id — we map those to issue keys in `laneByKey` and keep
 * the server's lane order. Field strategies leave `lanes`/`laneByKey` empty
 * and are grouped by `buildLanes` from issue fields instead.
 */
export type BoardSwimlanes = {
  strategy: SwimlaneStrategy;
  lanes: SwimlaneDef[];
  laneByKey: Record<string, string>;
  /** The catch-all lane's id, if any — where unmatched issues land. */
  defaultLaneId?: string;
};

export type Issue = {
  key: string;
  /** Numeric Jira id — needed to join against the GreenHopper swimlane
   *  model, which reports custom-lane membership by id, not key. */
  id: number;
  summary: string;
  description: string;
  statusId: string;
  statusName: string;
  /** Jira's tenant-invariant status category: "new" (To Do),
   *  "indeterminate" (In Progress), or "done". Used to sort finished-work
   *  columns by recency rather than rank — see `buildColumns`. */
  statusCategory: string;
  /** ISO timestamp of the last update, for recency sort in done columns. */
  updated: string;
  issueType: string;
  issueTypeId?: string;
  issueTypeHierarchyLevel?: number;
  projectKey?: string;
  subtask?: boolean;
  assignee?: string;
  priority?: string;
  epicKey?: string;
  labels: string[];
  sprintName?: string;
  storyPoints?: number;
};

export type Transition = {
  id: string;
  name: string;
  toStatusId: string;
  /**
   * Workflow-screen fields that must be filled in before Jira will accept the
   * transition POST. Empty for transitions with no screen, which is the
   * common case — callers can short-circuit straight to `transitionIssue`.
   */
  requiredFields: EditableField[];
};

/**
 * Normalized view of Jira field metadata. Workflow transition screens,
 * per-issue edit metadata, and per-type create metadata use the same shape,
 * so one parser covers all three call sites.
 * The closed union lets the field-editor component dispatch by `kind`
 * without re-inspecting loose schema strings.
 */
export type EditableField =
  | EditableOptionField
  | EditableOptionListField
  | EditableUserField
  | EditableUserListField
  | EditableTextField
  | EditableStringListField
  | EditableNumberField
  | EditableDateField
  | EditableUnsupportedField;

/**
 * Common head — every editable field carries the Jira-side key (e.g.
 * `customfield_10042` or `resolution`) and the display name shown in
 * Jira's UI (e.g. "Implementer"). `required` is meaningful for transition
 * screens and lets custom-field callers ignore it. `hasDefaultValue` lets
 * `getTransitions` skip prompting for required fields Jira will auto-fill
 * server-side — we don't seed the *value* ourselves (Jira doesn't tell us
 * which allowedValue is the default, and a wrong guess is worse than the
 * server's own default), we just decline to block on them.
 */
type EditableFieldBase = {
  id: string;
  name: string;
  required: boolean;
  hasDefaultValue: boolean;
};

// Per-kind variants are internal to the union — consumers dispatch on
// `kind` and read the per-kind fields directly without importing them.
type EditableOption = { id: string; name: string };

type EditableOptionField = EditableFieldBase & {
  kind: "option";
  allowedValues: EditableOption[];
};

type EditableOptionListField = EditableFieldBase & {
  kind: "option-list";
  allowedValues: EditableOption[];
};

type EditableUserField = EditableFieldBase & { kind: "user" };
type EditableUserListField = EditableFieldBase & { kind: "user-list" };
type EditableTextField = EditableFieldBase & { kind: "text" };
/**
 * Plain string arrays — labels-style. Edited as a comma-separated list in
 * an inline input. Distinct from option-list because the shape Jira wants
 * is `["foo", "bar"]`, not `[{id}]`.
 */
type EditableStringListField = EditableFieldBase & { kind: "string-list" };
type EditableNumberField = EditableFieldBase & { kind: "number" };
type EditableDateField = EditableFieldBase & { kind: "date" };

/**
 * Field types we can't sensibly edit from a TUI (cascading selects, ADF
 * rich-text bodies, etc.). Surfaced explicitly so the UI can mark them
 * read-only with a "complete in browser" hint.
 */
type EditableUnsupportedField = EditableFieldBase & {
  kind: "unsupported";
  schemaType: string;
};

/**
 * Values the user has supplied, keyed by the Jira field id. Shape matches
 * what Jira's REST endpoint wants in `body.fields[id]`.
 */
export type EditableFieldValue =
  | { id: string } // option-typed single
  | { id: string }[] // option-typed list
  | { accountId: string } // user single
  | { accountId: string }[] // user list
  | string // text / date
  | string[] // labels / string-list
  | number; // number

export type IssueType = { id: string; name: string; subtask: boolean; hierarchyLevel?: number };

export type Comment = {
  id: string;
  author: string;
  authorAccountId: string;
  body: string;
  created: string;
};

type IssueLink = {
  direction: string;
  key: string;
  summary: string;
  statusName: string;
  issueType: string;
};

export type IssueDetail = Issue & {
  reporter?: string;
  components: string[];
  fixVersions: string[];
  dueDate?: string;
  created: string;
  parentKey?: string;
  subtasks: { key: string; summary: string; statusName: string }[];
  links: IssueLink[];
  comments: Comment[];
  watching?: boolean;
  customFields: CustomField[];
  /** Full parsed editmeta — keyed by Jira field id. Lets the UI gate
   *  editability for any field generically, not just custom ones. */
  editmeta: Map<string, EditableField>;
  /** Present only when the issue loaded but Jira's edit metadata did not. */
  editmetaError?: string;
  /** Raw fields object from the issue GET — needed to seed FieldEditor
   *  with the current value for standard fields (assignee, priority, etc). */
  rawFields: Record<string, any>;
};

function normalizeText(value: string): string {
  return value
    .replace(/https?:\/\/\S+/gi, "[URL omitted]")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeHtml(value: string): string {
  return normalizeText(
    value
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replaceAll("&nbsp;", " ")
      .replaceAll("&amp;", "&")
      .replaceAll("&lt;", "<")
      .replaceAll("&gt;", ">")
      .replaceAll("&quot;", '"')
      .replaceAll("&#39;", "'"),
  );
}

async function throwJiraError(operation: string, res: Response): Promise<never> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    throw new Error(
      `${operation} failed (${res.status}): Jira returned an unreadable error response; retry the operation`,
    );
  }
  const reasons: string[] = [];
  if (raw.trim()) {
    try {
      const body: unknown = JSON.parse(raw);
      if (typeof body === "string") {
        const reason = normalizeText(body);
        if (reason) reasons.push(reason);
      } else if (body && typeof body === "object" && !Array.isArray(body)) {
        const record = body as Record<string, unknown>;
        if (Array.isArray(record["errorMessages"])) {
          for (const reason of record["errorMessages"]) {
            if (typeof reason !== "string") continue;
            const normalized = normalizeText(reason);
            if (normalized) reasons.push(normalized);
          }
        }
        const fieldErrors = record["errors"];
        if (fieldErrors && typeof fieldErrors === "object" && !Array.isArray(fieldErrors)) {
          for (const [field, reason] of Object.entries(fieldErrors)) {
            if (typeof reason !== "string") continue;
            const normalized = normalizeText(reason);
            if (normalized) reasons.push(`${field}: ${normalized}`);
          }
        }
        for (const key of ["message", "errorMessage"] as const) {
          const reason = record[key];
          if (typeof reason !== "string") continue;
          const normalized = normalizeText(reason);
          if (normalized) reasons.push(normalized);
        }
      }
    } catch {
      const trimmed = raw.trim();
      if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
        const isHtml =
          res.headers.get("content-type")?.includes("text/html") ||
          /<(?:!doctype|html|head|body|title|h[1-6]|p|div|span|br|script|style)\b/i.test(trimmed);
        const reason = isHtml ? normalizeHtml(trimmed) : normalizeText(trimmed);
        if (reason) reasons.push(reason);
      }
    }
  }
  const unique = [...new Set(reasons)];
  const reason =
    unique.join("; ") || normalizeText(res.statusText) || "Jira returned no error details";
  throw new Error(`${operation} failed (${res.status}): ${reason}`);
}

async function jrequest(
  cfg: JiraConfig,
  path: string,
  operation: string,
  init: RequestInit = {},
): Promise<Response> {
  const res = await fetch(`${cfg.server}${path}`, {
    ...init,
    ...(init.signal || cfg.signal ? { signal: init.signal ?? cfg.signal } : {}),
    headers: {
      Authorization: cfg.authHeader,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
  });
  if (!res.ok) await throwJiraError(operation, res);
  return res;
}

async function jget(cfg: JiraConfig, path: string, operation: string): Promise<any> {
  const res = await jrequest(cfg, path, operation);
  return res.json();
}

function nextPageStart(
  data: any,
  currentStart: number,
  itemCount: number,
  errorMessage: string,
): number | null {
  const hasMetadata =
    Number.isInteger(data.startAt) ||
    Number.isInteger(data.maxResults) ||
    Number.isFinite(data.total) ||
    typeof data.isLast === "boolean";
  if (!hasMetadata) return null;
  const responseStart = Number.isInteger(data.startAt) ? data.startAt : currentStart;
  const responseSize = Number.isInteger(data.maxResults) ? data.maxResults : itemCount;
  const nextStart = responseStart + responseSize;
  if (data.isLast || (Number.isFinite(data.total) && nextStart >= data.total)) return null;
  if (responseSize <= 0 || nextStart <= currentStart) throw new Error(errorMessage);
  return nextStart;
}

export async function listBoards(cfg: JiraConfig): Promise<Board[]> {
  const all: Board[] = [];
  const seen = new Set<number>();
  let startAt = 0;
  const pageSize = 50;
  while (true) {
    const data = await jget(
      cfg,
      `/rest/agile/1.0/board?startAt=${startAt}&maxResults=${pageSize}`,
      "Load boards",
    );
    const values: any[] = Array.isArray(data.values) ? data.values : [];
    for (const b of values) {
      if (seen.has(b.id)) continue;
      seen.add(b.id);
      all.push({
        id: b.id,
        name: b.name,
        type: b.type,
        projectKey: b.location?.projectKey,
        projectName: b.location?.projectName,
      });
    }
    const next = nextPageStart(data, startAt, values.length, "board pagination did not advance");
    if (next === null) break;
    startAt = next;
  }
  return all;
}

export async function getBoardConfig(cfg: JiraConfig, boardId: number): Promise<BoardConfig> {
  const data = await jget(
    cfg,
    `/rest/agile/1.0/board/${boardId}/configuration`,
    "Load board configuration",
  );
  const columns: BoardColumn[] = (data.columnConfig?.columns ?? []).map((c: any) => {
    const out: BoardColumn = {
      name: c.name,
      statusIds: (c.statuses ?? []).map((s: any) => String(s.id)),
    };
    // Jira sends 0 when no limit is set — treat as absent.
    const max = Number(c.max);
    if (Number.isFinite(max) && max > 0) out.max = max;
    return out;
  });
  const config: BoardConfig = {
    name: data.name,
    projectKey: "",
    columns,
  };
  const estimationFieldId = data.estimation?.field?.fieldId;
  if (
    data.estimation?.type === "field" &&
    typeof estimationFieldId === "string" &&
    estimationFieldId.length > 0
  ) {
    config.estimationFieldId = estimationFieldId;
  }
  // The configuration endpoint's `location` uses `key`, unlike board lists.
  if (data.location?.key) config.projectKey = String(data.location.key);
  return config;
}

/**
 * Map GreenHopper's internal strategy string to our closed union. The public
 * Agile API doesn't expose swimlanes, so this reads the same internal board
 * model the web UI uses.
 */
function toSwimlaneStrategy(raw: unknown): SwimlaneStrategy {
  switch (raw) {
    case "custom":
      return "custom";
    case "assignee":
      return "assignee";
    case "epic":
      return "epic";
    case "issuetype":
    case "issueType":
      return "issueType";
    case "parentChild":
    case "issueChild":
      return "parentChild";
    default:
      return "none";
  }
}

/**
 * Fetch a board's swimlane layout from the internal GreenHopper board model.
 * For `custom` strategy the server has already evaluated each lane's JQL, so
 * we get authoritative membership by numeric issue id and translate it to
 * issue keys via `idToKey`. Field strategies (assignee/epic/issueType/
 * parentChild) return no precomputed membership — the caller groups those
 * from issue fields. On any failure we degrade to `{strategy: "none"}` so the
 * board still renders flat.
 */
export async function getBoardSwimlanes(
  cfg: JiraConfig,
  boardId: number,
  idToKey: Map<number, string>,
): Promise<BoardSwimlanes> {
  const none: BoardSwimlanes = { strategy: "none", lanes: [], laneByKey: {} };
  let data: any;
  try {
    data = await jget(
      cfg,
      `/rest/greenhopper/1.0/xboard/work/allData.json?rapidViewId=${boardId}`,
      "Load swimlanes",
    );
  } catch {
    return none;
  }
  const sd = data?.swimlanesData ?? {};
  const strategy = toSwimlaneStrategy(sd.swimlaneStrategy);
  if (strategy === "none") return none;

  if (strategy === "custom") {
    const rawLanes: any[] = sd.customSwimlanesData?.swimlanes ?? [];
    const lanes: SwimlaneDef[] = [];
    const laneByKey: Record<string, string> = {};
    let defaultLaneId: string | undefined;
    for (const lane of rawLanes) {
      const id = String(lane.id);
      lanes.push({ id, name: String(lane.name ?? id) });
      if (lane.defaultSwimlane) defaultLaneId = id;
      for (const issueId of lane.issueIds ?? []) {
        const key = idToKey.get(Number(issueId));
        // First lane wins — the server orders lanes by priority, and an
        // issue can technically match multiple JQL lanes.
        if (key && laneByKey[key] === undefined) laneByKey[key] = id;
      }
    }
    return { strategy, lanes, laneByKey, ...(defaultLaneId ? { defaultLaneId } : {}) };
  }

  // Field strategies: membership is derived client-side by buildLanes.
  return { strategy, lanes: [], laneByKey: {} };
}

export async function getBoardIssues(
  cfg: JiraConfig,
  boardId: number,
  estimationFieldId?: string,
): Promise<Issue[]> {
  const cf = await resolveFieldIds(cfg);
  const estimateField = estimationFieldId || cf.storyPoints;
  const fields = [
    "summary",
    "status",
    "updated",
    "issuetype",
    "assignee",
    "priority",
    "description",
    "labels",
    "project",
    cf.epicLink,
    cf.sprint,
    estimateField,
    "parent",
  ].join(",");
  const all: Issue[] = [];
  // Dedupe by key across pages: a card created or reordered mid-fetch shifts
  // the page window and can re-emit a boundary issue, which would collide as a
  // duplicate React key in the grid. Same guard listBoards uses. First
  // occurrence wins (keeps rank order).
  const seen = new Set<string>();
  let startAt = 0;
  while (true) {
    const data = await jget(
      cfg,
      `/rest/agile/1.0/board/${boardId}/issue?startAt=${startAt}&maxResults=100&fields=${fields}&jql=${encodeURIComponent("ORDER BY Rank ASC")}`,
      "Load board issues",
    );
    for (const it of data.issues ?? []) {
      if (seen.has(it.key)) continue;
      seen.add(it.key);
      const f = it.fields ?? {};
      const descRaw = f.description;
      const description = typeof descRaw === "string" ? descRaw : adfToText(descRaw).trim();
      const sprints = Array.isArray(f[cf.sprint]) ? f[cf.sprint] : [];
      const activeSprint = sprints.find((s: any) => s?.state === "active") ?? sprints[0];
      const issue: Issue = {
        key: it.key,
        id: Number(it.id),
        summary: f.summary ?? "",
        description,
        statusId: String(f.status?.id ?? ""),
        statusName: f.status?.name ?? "",
        statusCategory: String(f.status?.statusCategory?.key ?? ""),
        updated: f.updated ?? "",
        issueType: f.issuetype?.name ?? "",
        issueTypeId: String(f.issuetype?.id ?? ""),
        ...(Number.isInteger(f.issuetype?.hierarchyLevel)
          ? { issueTypeHierarchyLevel: Number(f.issuetype.hierarchyLevel) }
          : {}),
        projectKey: String(f.project?.key ?? it.key?.split("-")[0] ?? ""),
        subtask: Boolean(f.issuetype?.subtask),
        labels: Array.isArray(f.labels) ? f.labels : [],
      };
      if (f.assignee?.displayName) issue.assignee = f.assignee.displayName;
      if (f.priority?.name) issue.priority = f.priority.name;
      if (activeSprint?.name) issue.sprintName = activeSprint.name;
      if (typeof f[estimateField] === "number") issue.storyPoints = f[estimateField];
      const epic = f[cf.epicLink] || f.parent?.key;
      if (epic) issue.epicKey = epic;
      all.push(issue);
    }
    const page: any[] = Array.isArray(data.issues) ? data.issues : [];
    const next = nextPageStart(
      data,
      startAt,
      page.length,
      "board issue pagination did not advance",
    );
    if (next === null) break;
    startAt = next;
  }
  return all;
}

export async function getIssueDetail(cfg: JiraConfig, issueKey: string): Promise<IssueDetail> {
  const cf = await resolveFieldIds(cfg);
  // `*all` already pulls every field (including the agile custom fields we
  // read below via `cf`), so we don't enumerate them here — we just trim the
  // big/noisy system fields fetched through their own endpoints.
  const fields = ["*all", "-attachment", "-comment", "-worklog"].join(",");
  // Editmeta tells us which custom fields Jira considers part of this
  // project + issue type — we use it as a filter so we don't surface
  // internal / deprecated customfield_* that show up in the main GET.
  // A metadata failure does not hide the issue. It is returned separately so
  // the UI can explain why fields are read-only.
  let editmetaError: string | undefined;
  const [data, commentsData, editMetaData] = await Promise.all([
    jget(cfg, `/rest/api/3/issue/${issueKey}?fields=${fields}`, "Load issue"),
    // Newest-first + no pagination: on an issue with >100 comments we want
    // the most recent 100 to survive the cap, not the oldest. We reverse
    // below so the display stays chronological (oldest → newest).
    jget(
      cfg,
      `/rest/api/3/issue/${issueKey}/comment?orderBy=-created&maxResults=100`,
      "Load comments",
    ),
    jget(cfg, `/rest/api/3/issue/${issueKey}/editmeta`, "Load edit metadata").catch((error) => {
      const message = (error instanceof Error ? error.message : String(error)).trim();
      editmetaError = message.startsWith("Load edit metadata failed")
        ? message
        : `Load edit metadata failed: ${message || "Jira request failed before a response was received"}`;
      return { fields: {} };
    }),
  ]);
  const f = data.fields ?? {};
  const descRaw = f.description;
  const description = typeof descRaw === "string" ? descRaw : adfToText(descRaw).trim();
  const comments: Comment[] = (commentsData.comments ?? [])
    .map((c: any) => ({
      id: String(c.id),
      author: c.author?.displayName ?? "unknown",
      authorAccountId: c.author?.accountId ?? "",
      body: typeof c.body === "string" ? c.body : adfToText(c.body).trim(),
      created: c.created,
    }))
    .toReversed();
  const metaFields = editMetaData?.fields ?? {};
  const editmeta = new Map<string, EditableField>();
  for (const field of parseEditableFields(metaFields)) editmeta.set(field.id, field);
  const customFields = Object.keys(metaFields)
    .filter((id) => id.startsWith("customfield_"))
    .flatMap((id) => {
      const normalized = normalizeCustomField(
        id,
        metaFields[id],
        f[id],
        editmeta.get(id),
        cf.epicLink,
      );
      return normalized ? [normalized] : [];
    });
  const detail: IssueDetail = {
    key: data.key,
    id: Number(data.id),
    summary: f.summary ?? "",
    description,
    statusId: String(f.status?.id ?? ""),
    statusName: f.status?.name ?? "",
    statusCategory: String(f.status?.statusCategory?.key ?? ""),
    issueType: f.issuetype?.name ?? "",
    issueTypeId: String(f.issuetype?.id ?? ""),
    ...(Number.isInteger(f.issuetype?.hierarchyLevel)
      ? { issueTypeHierarchyLevel: Number(f.issuetype.hierarchyLevel) }
      : {}),
    projectKey: String(f.project?.key ?? data.key?.split("-")[0] ?? ""),
    subtask: Boolean(f.issuetype?.subtask),
    labels: Array.isArray(f.labels) ? f.labels : [],
    components: Array.isArray(f.components) ? f.components.map((c: any) => c.name) : [],
    fixVersions: Array.isArray(f.fixVersions) ? f.fixVersions.map((v: any) => v.name) : [],
    created: f.created ?? "",
    updated: f.updated ?? "",
    subtasks: Array.isArray(f.subtasks)
      ? f.subtasks.map((s: any) => ({
          key: s.key,
          summary: s.fields?.summary ?? "",
          statusName: s.fields?.status?.name ?? "",
        }))
      : [],
    links: Array.isArray(f.issuelinks)
      ? f.issuelinks.flatMap((l: any) => {
          // A link points either outward or inward; pick the present side and
          // its matching direction label, then map both the same way.
          const side = l.outwardIssue
            ? { issue: l.outwardIssue, direction: l.type?.outward ?? "relates to" }
            : l.inwardIssue
              ? { issue: l.inwardIssue, direction: l.type?.inward ?? "relates to" }
              : null;
          if (!side) return [];
          return [
            {
              direction: side.direction,
              key: side.issue.key,
              summary: side.issue.fields?.summary ?? "",
              statusName: side.issue.fields?.status?.name ?? "",
              issueType: side.issue.fields?.issuetype?.name ?? "",
            },
          ];
        })
      : [],
    comments,
    watching: f.watches?.isWatching ?? undefined,
    // Custom fields are sourced from editmeta (not the raw `fields`
    // object): editmeta lists exactly the customfield_* ids that are
    // part of this project + issue type, which filters out the noise the
    // main GET carries (non-editable internals, deprecated remnants). They
    // render in editmeta's key order.
    rawFields: f,
    customFields,
    editmeta,
  };
  if (f.assignee?.displayName) detail.assignee = f.assignee.displayName;
  if (f.priority?.name) detail.priority = f.priority.name;
  const epic = f[cf.epicLink] || f.parent?.key;
  if (epic) detail.epicKey = epic;
  if (f.reporter?.displayName) detail.reporter = f.reporter.displayName;
  if (typeof f[cf.storyPoints] === "number") detail.storyPoints = f[cf.storyPoints];
  if (f.duedate) detail.dueDate = f.duedate;
  if (f.parent?.key) detail.parentKey = f.parent.key;
  if (editmetaError !== undefined) detail.editmetaError = editmetaError;
  return detail;
}

/**
 * Cheap lookup for just the current status id — used after create to decide
 * whether the fresh issue already sits in the column we want, or needs a
 * transition to get there.
 */
export async function getIssueStatusId(cfg: JiraConfig, issueKey: string): Promise<string> {
  const data = await jget(cfg, `/rest/api/3/issue/${issueKey}?fields=status`, "Load issue status");
  return String(data.fields?.status?.id ?? "");
}

export async function getTransitions(cfg: JiraConfig, issueKey: string): Promise<Transition[]> {
  // `expand=transitions.fields` surfaces the workflow screen's required
  // fields inline — lets the caller decide up front whether it needs to
  // prompt the user or can POST silently.
  const data = await jget(
    cfg,
    `/rest/api/3/issue/${issueKey}/transitions?expand=transitions.fields`,
    "Load transitions",
  );
  return (data.transitions ?? []).map((t: any) => ({
    id: String(t.id),
    name: String(t.name),
    toStatusId: String(t.to?.id ?? ""),
    // A field only blocks a transition if it's required AND Jira has no
    // default to fall back on. Required-with-default fields get auto-filled
    // server-side on the POST, so prompting for them is pure noise — that's
    // what made the move feel like it "popped a screen for nothing".
    // Optional screen fields are likewise dropped.
    requiredFields: parseEditableFields(t.fields ?? {}).filter(
      (f) => f.required && !f.hasDefaultValue,
    ),
  }));
}

/**
 * Normalize Jira's loose transition, edit, and create field metadata into a
 * closed union of field kinds the UI can dispatch against. Callers decide
 * whether to filter by `required`.
 */
function parseEditableFields(fields: Record<string, any>): EditableField[] {
  const out: EditableField[] = [];
  for (const [id, raw] of Object.entries(fields)) {
    if (!raw) continue;
    const base: EditableFieldBase = {
      id,
      name: String(raw.name ?? id),
      required: Boolean(raw.required),
      hasDefaultValue: Boolean(raw.hasDefaultValue),
    };
    const schemaType = String(raw.schema?.type ?? "");
    const itemsType = String(raw.schema?.items ?? "");
    const customType = String(raw.schema?.custom ?? "");
    const systemType = String(raw.schema?.system ?? "");
    const allowedValues: EditableOption[] = Array.isArray(raw.allowedValues)
      ? raw.allowedValues.map((v: any) => ({
          id: String(v.id ?? v.value ?? v.name),
          name: String(v.name ?? v.value ?? v.id),
        }))
      : [];

    if (schemaType === "array") {
      if (itemsType === "user") {
        out.push({ ...base, kind: "user-list" });
      } else if (itemsType === "string") {
        // labels-shaped: plain strings, no picker catalog.
        out.push({ ...base, kind: "string-list" });
      } else if (
        itemsType === "option" ||
        itemsType === "priority" ||
        itemsType === "resolution" ||
        itemsType === "version" ||
        itemsType === "component"
      ) {
        out.push({ ...base, kind: "option-list", allowedValues });
      } else {
        out.push({ ...base, kind: "unsupported", schemaType: `array<${itemsType}>` });
      }
      continue;
    }

    if (schemaType === "user") {
      out.push({ ...base, kind: "user" });
    } else if (
      schemaType === "option" ||
      schemaType === "priority" ||
      schemaType === "resolution" ||
      schemaType === "version" ||
      schemaType === "component"
    ) {
      out.push({ ...base, kind: "option", allowedValues });
    } else if (
      schemaType === "string" &&
      !customType.endsWith(":textarea") &&
      systemType !== "description" &&
      systemType !== "environment"
    ) {
      out.push({ ...base, kind: "text" });
    } else if (schemaType === "number") {
      out.push({ ...base, kind: "number" });
    } else if (schemaType === "date") {
      out.push({ ...base, kind: "date" });
    } else {
      const unsupportedType =
        systemType === "description" || systemType === "environment" ? "richtext" : schemaType;
      out.push({ ...base, kind: "unsupported", schemaType: unsupportedType });
    }
  }
  return out;
}

export async function transitionIssue(
  cfg: JiraConfig,
  issueKey: string,
  transitionId: string,
  fields?: Record<string, EditableFieldValue>,
): Promise<void> {
  const body: { transition: { id: string }; fields?: Record<string, EditableFieldValue> } = {
    transition: { id: transitionId },
  };
  if (fields && Object.keys(fields).length > 0) body.fields = fields;
  await jrequest(cfg, `/rest/api/3/issue/${issueKey}/transitions`, "Save transition", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export async function updateSummary(
  cfg: JiraConfig,
  issueKey: string,
  summary: string,
): Promise<void> {
  await jrequest(cfg, `/rest/api/3/issue/${issueKey}`, "Save title", {
    method: "PUT",
    body: JSON.stringify({ fields: { summary } }),
  });
}

export async function updateDescription(
  cfg: JiraConfig,
  issueKey: string,
  description: string,
): Promise<void> {
  await jrequest(cfg, `/rest/api/3/issue/${issueKey}`, "Save description", {
    method: "PUT",
    body: JSON.stringify({ fields: { description: textToAdf(description) } }),
  });
}

export async function getIssueTypes(cfg: JiraConfig, projectKey: string): Promise<IssueType[]> {
  const base = `/rest/api/3/issue/createmeta/${encodeURIComponent(projectKey)}/issuetypes`;
  const all: any[] = [];
  let startAt = 0;
  while (true) {
    const data = await jget(cfg, `${base}?startAt=${startAt}&maxResults=100`, "Load issue types");
    const values: any[] = Array.isArray(data.values)
      ? data.values
      : Array.isArray(data.issueTypes)
        ? data.issueTypes
        : [];
    all.push(...values);
    const next = nextPageStart(
      data,
      startAt,
      values.length,
      "issue type pagination did not advance",
    );
    if (next === null) break;
    startAt = next;
  }
  return all.map((t: any) => ({
    id: String(t.id),
    name: t.name,
    subtask: !!t.subtask,
    ...(Number.isInteger(t.hierarchyLevel) ? { hierarchyLevel: Number(t.hierarchyLevel) } : {}),
  }));
}

export async function getCreateFields(
  cfg: JiraConfig,
  projectKey: string,
  issueTypeId: string,
): Promise<EditableField[]> {
  const base = `/rest/api/3/issue/createmeta/${encodeURIComponent(projectKey)}/issuetypes/${encodeURIComponent(issueTypeId)}`;
  const all: any[] = [];
  let startAt = 0;
  while (true) {
    const data = await jget(cfg, `${base}?startAt=${startAt}&maxResults=100`, "Load create fields");
    const fields: any[] = Array.isArray(data.fields) ? data.fields : [];
    all.push(...fields);
    const next = nextPageStart(
      data,
      startAt,
      fields.length,
      "create field pagination did not advance",
    );
    if (next === null) break;
    startAt = next;
  }
  const byId: Record<string, any> = {};
  for (const field of all) {
    const id = field?.fieldId;
    if (id) byId[String(id)] = field;
  }
  return parseEditableFields(byId);
}

export type IssueLinkType = {
  id: string;
  name: string;
  // Human-readable direction labels, e.g. "blocks" / "is blocked by".
  inward: string;
  outward: string;
};

export async function getIssueLinkTypes(cfg: JiraConfig): Promise<IssueLinkType[]> {
  const data = await jget(cfg, `/rest/api/3/issueLinkType`, "Load issue link types");
  return (data.issueLinkTypes ?? []).map((t: any) => ({
    id: String(t.id),
    name: t.name,
    inward: t.inward,
    outward: t.outward,
  }));
}

export type IssueSearchResult = {
  key: string;
  projectKey: string;
  summary: string;
  issueType: string;
  issueTypeId: string;
  subtask: boolean;
  hierarchyLevel?: number;
};

/**
 * Search issues by summary or key, up to `limit`. Scoped to `projectKey` when
 * given (create-wizard target picker), otherwise global across every project
 * the user can see (quick-open finder). A global search with an empty query
 * would be unbounded, so that combination returns nothing.
 */
export async function searchIssues(
  cfg: JiraConfig,
  query: string,
  opts: { projectKey?: string; limit?: number } = {},
): Promise<IssueSearchResult[]> {
  // Strip quotes / backslashes so stray input can't break out of the JQL string.
  const q = query.trim().replaceAll(/["\\]/g, "");
  if (!q && !opts.projectKey) return [];
  // `issuekey = X` only works when X looks like a real key (PROJ-123).
  const looksLikeKey = /^[A-Za-z][A-Za-z0-9]*-\d+$/.test(q);
  const match = q
    ? looksLikeKey
      ? `summary ~ "${q}*" OR issuekey = "${q.toUpperCase()}"`
      : `summary ~ "${q}*"`
    : "";
  const clauses = [
    opts.projectKey ? `project = "${opts.projectKey}"` : "",
    match ? (opts.projectKey ? `(${match})` : match) : "",
  ].filter(Boolean);
  const jql = `${clauses.join(" AND ")} ORDER BY updated DESC`;
  return searchByJql(cfg, jql, opts.limit ?? ISSUE_SEARCH_LIMIT);
}

/**
 * Link the new issue to a target using the selected display direction. Jira
 * displays the outward label for an `outwardIssue` entry in the new issue's
 * GET response, so the target occupies that endpoint for an outward choice.
 */
export async function createIssueLink(
  cfg: JiraConfig,
  linkTypeName: string,
  newIssueKey: string,
  targetKey: string,
  direction: "outward" | "inward",
): Promise<void> {
  const [outward, inward] =
    direction === "outward" ? [targetKey, newIssueKey] : [newIssueKey, targetKey];
  await jrequest(cfg, `/rest/api/3/issueLink`, "Create issue link", {
    method: "POST",
    body: JSON.stringify({
      type: { name: linkTypeName },
      outwardIssue: { key: outward },
      inwardIssue: { key: inward },
    }),
  });
}

export type JiraUser = { accountId: string; displayName: string };

export async function getAssignableUsers(cfg: JiraConfig, projectKey: string): Promise<JiraUser[]> {
  if (!projectKey.trim()) return [];
  const proj = encodeURIComponent(projectKey);
  // Jira filters assignability after selecting a range, so a short page does
  // not mean end-of-data. Request the endpoint's documented full 1,000 range.
  const data = await jget(
    cfg,
    `/rest/api/3/user/assignable/search?project=${proj}&startAt=0&maxResults=1000`,
    "Load assignable users",
  );
  const users: any[] = Array.isArray(data) ? data : [];
  return users.map((u) => ({
    accountId: String(u.accountId),
    displayName: u.displayName ?? u.emailAddress ?? u.accountId,
  }));
}

export async function updateIssueField(
  cfg: JiraConfig,
  issueKey: string,
  fields: Record<string, any>,
): Promise<void> {
  await jrequest(cfg, `/rest/api/3/issue/${issueKey}`, "Save issue field", {
    method: "PUT",
    body: JSON.stringify({ fields }),
  });
}

export async function addComment(cfg: JiraConfig, issueKey: string, body: string): Promise<void> {
  await jrequest(cfg, `/rest/api/3/issue/${issueKey}/comment`, "Add comment", {
    method: "POST",
    body: JSON.stringify({ body: textToAdf(body) }),
  });
}

export async function updateComment(
  cfg: JiraConfig,
  issueKey: string,
  commentId: string,
  body: string,
): Promise<void> {
  await jrequest(cfg, `/rest/api/3/issue/${issueKey}/comment/${commentId}`, "Save comment", {
    method: "PUT",
    body: JSON.stringify({ body: textToAdf(body) }),
  });
}

export async function fetchCurrentUser(
  cfg: JiraConfig,
): Promise<{ accountId: string; displayName: string }> {
  const data = await jget(cfg, `/rest/api/3/myself`, "Load current user");
  return {
    accountId: data.accountId ?? "",
    displayName: data.displayName ?? data.emailAddress ?? "unknown",
  };
}

export async function watchIssue(cfg: JiraConfig, issueKey: string): Promise<void> {
  await jrequest(cfg, `/rest/api/3/issue/${issueKey}/watchers`, "Watch issue", { method: "POST" });
}

export async function unwatchIssue(cfg: JiraConfig, issueKey: string): Promise<void> {
  const me = await fetchCurrentUser(cfg);
  await jrequest(
    cfg,
    `/rest/api/3/issue/${issueKey}/watchers?accountId=${encodeURIComponent(me.accountId)}`,
    "Unwatch issue",
    { method: "DELETE" },
  );
}

export async function searchByJql(
  cfg: JiraConfig,
  jql: string,
  limit = JQL_SEARCH_LIMIT,
): Promise<IssueSearchResult[]> {
  const wanted = Math.max(0, Math.floor(limit));
  if (wanted === 0) return [];
  const all: IssueSearchResult[] = [];
  const seenKeys = new Set<string>();
  const seenTokens = new Set<string>();
  let nextPageToken: string | undefined;
  while (all.length < wanted) {
    const body: Record<string, unknown> = {
      jql,
      fields: ["summary", "issuetype", "project"],
      maxResults: Math.min(100, wanted - all.length),
    };
    if (nextPageToken) body["nextPageToken"] = nextPageToken;
    const res = await jrequest(cfg, `/rest/api/3/search/jql`, "Search issues", {
      method: "POST",
      body: JSON.stringify(body),
    });
    const data = (await res.json()) as any;
    const issues: any[] = Array.isArray(data.issues) ? data.issues : [];
    for (const i of issues) {
      if (seenKeys.has(i.key)) continue;
      seenKeys.add(i.key);
      all.push({
        key: i.key,
        projectKey: String(i.fields?.project?.key ?? i.key?.split("-")[0] ?? ""),
        summary: i.fields?.summary ?? "",
        issueType: i.fields?.issuetype?.name ?? "",
        issueTypeId: String(i.fields?.issuetype?.id ?? ""),
        subtask: Boolean(i.fields?.issuetype?.subtask),
        ...(Number.isInteger(i.fields?.issuetype?.hierarchyLevel)
          ? { hierarchyLevel: Number(i.fields.issuetype.hierarchyLevel) }
          : {}),
      });
      if (all.length === wanted) break;
    }
    if (data.isLast || !data.nextPageToken) break;
    nextPageToken = String(data.nextPageToken);
    if (seenTokens.has(nextPageToken)) throw new Error("JQL pagination token repeated");
    seenTokens.add(nextPageToken);
  }
  return all;
}

export async function rankIssue(
  cfg: JiraConfig,
  issueKey: string,
  target: { before: string } | { after: string },
): Promise<void> {
  const body =
    "before" in target
      ? { issues: [issueKey], rankBeforeIssue: target.before }
      : { issues: [issueKey], rankAfterIssue: target.after };
  await jrequest(cfg, `/rest/agile/1.0/issue/rank`, "Rank issue", {
    method: "PUT",
    body: JSON.stringify(body),
  });
}

export async function assignIssueToMe(cfg: JiraConfig, issueKey: string): Promise<void> {
  const me = await fetchCurrentUser(cfg);
  await jrequest(cfg, `/rest/api/3/issue/${issueKey}`, "Assign issue", {
    method: "PUT",
    body: JSON.stringify({ fields: { assignee: { accountId: me.accountId } } }),
  });
}

export async function createIssue(
  cfg: JiraConfig,
  projectKey: string,
  issueTypeId: string,
  summary: string,
  description: string,
  parentKey?: string,
  suppliedFields: Record<string, EditableFieldValue> = {},
): Promise<{ key: string }> {
  const fields: Record<string, unknown> = {
    ...suppliedFields,
    project: { key: projectKey },
    issuetype: { id: issueTypeId },
    summary,
  };
  delete fields["description"];
  delete fields["parent"];
  if (description) fields["description"] = textToAdf(description);
  /**
   * `parent` is canonical for epic-child and sub-task links in Jira Cloud.
   * The legacy `customfield_10014` ("Epic Link") is deliberately not set —
   * team-managed projects reject it with "cannot be set on this issue type".
   */
  if (parentKey) fields["parent"] = { key: parentKey };
  const res = await jrequest(cfg, `/rest/api/3/issue`, "Create issue", {
    method: "POST",
    body: JSON.stringify({ fields }),
  });
  return (await res.json()) as { key: string };
}
