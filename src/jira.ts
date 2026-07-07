import { adfToText, textToAdf } from "./adf";
import type { JiraConfig } from "./config";
import { type CustomField, normalizeCustomField } from "./customFields";
export type { CustomField } from "./customFields";

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
 * Resolved field ids are stable for the life of a server, so cache them per
 * `cfg.server` — one `/field` fetch covers every board and issue this run.
 */
const fieldIdCache = new Map<string, FieldIds>();

/**
 * Discover the epic-link, sprint, and story-points field ids for this tenant.
 * The numeric `customfield_NNNNN` differs per instance, but Jira's `schema.custom`
 * plugin identifier is invariant — so we match on that. Story points has no
 * single stable key on classic projects (it's a generic float), so we match
 * the team-managed `jsw-story-points` and otherwise keep the default. Any
 * failure falls back wholesale to `DEFAULT_FIELD_IDS`; nothing here is fatal.
 */
async function resolveFieldIds(cfg: JiraConfig): Promise<FieldIds> {
  const cached = fieldIdCache.get(cfg.server);
  if (cached) return cached;
  let ids: FieldIds = { ...DEFAULT_FIELD_IDS };
  try {
    const fields: any[] = await jget(cfg, `/rest/api/3/field`);
    const byCustom = (key: string) =>
      fields.find((f) => (f.schema?.custom ?? "").endsWith(key))?.id;
    ids = {
      epicLink: byCustom("gh-epic-link") ?? DEFAULT_FIELD_IDS.epicLink,
      sprint: byCustom("gh-sprint") ?? DEFAULT_FIELD_IDS.sprint,
      storyPoints: byCustom("jsw-story-points") ?? DEFAULT_FIELD_IDS.storyPoints,
    };
  } catch {
    // `/field` unreachable or malformed — the defaults still work on most tenants.
  }
  fieldIdCache.set(cfg.server, ids);
  return ids;
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
};

/** One swimlane's identity (custom lanes only — field lanes are derived). */
export type SwimlaneDef = { id: string; name: string };

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
  issueType: string;
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
 * Normalized view of a Jira field's edit metadata. Derived from both the
 * workflow-transition screen expand and the per-issue /editmeta — the shape
 * is identical in both responses, so one parser covers both call sites.
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

export type IssueType = { id: string; name: string; subtask: boolean };

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
  updated: string;
  parentKey?: string;
  subtasks: { key: string; summary: string; statusName: string }[];
  links: IssueLink[];
  comments: Comment[];
  watching?: boolean;
  customFields: CustomField[];
  /** Full parsed editmeta — keyed by Jira field id. Lets the UI gate
   *  editability for any field generically, not just custom ones. */
  editmeta: Map<string, EditableField>;
  /** Raw fields object from the issue GET — needed to seed FieldEditor
   *  with the current value for standard fields (assignee, priority, etc). */
  rawFields: Record<string, any>;
};

async function jf(cfg: JiraConfig, path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${cfg.server}${path}`, {
    ...init,
    headers: {
      Authorization: cfg.authHeader,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
  });
}

async function jget(cfg: JiraConfig, path: string): Promise<any> {
  const res = await jf(cfg, path);
  if (!res.ok) throw new Error(`GET ${path} ${res.status}: ${await res.text()}`);
  return res.json();
}

export async function listBoards(cfg: JiraConfig): Promise<Board[]> {
  const all: Board[] = [];
  let startAt = 0;
  const pageSize = 50;
  while (true) {
    const data = await jget(cfg, `/rest/agile/1.0/board?startAt=${startAt}&maxResults=${pageSize}`);
    for (const b of data.values ?? []) {
      all.push({
        id: b.id,
        name: b.name,
        type: b.type,
        projectKey: b.location?.projectKey,
        projectName: b.location?.projectName,
      });
    }
    if (data.isLast || (data.values?.length ?? 0) < pageSize) break;
    startAt += pageSize;
    if (startAt > 5000) break;
  }
  return all;
}

export async function getBoardConfig(cfg: JiraConfig, boardId: number): Promise<BoardConfig> {
  const data = await jget(cfg, `/rest/agile/1.0/board/${boardId}/configuration`);
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
  return {
    name: data.name,
    // The configuration endpoint's `location` uses `key` (verified against
    // live boards) — distinct from the board-list endpoint's `projectKey`.
    projectKey: data.location?.key,
    columns,
  };
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
    data = await jget(cfg, `/rest/greenhopper/1.0/xboard/work/allData.json?rapidViewId=${boardId}`);
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

export async function getBoardIssues(cfg: JiraConfig, boardId: number): Promise<Issue[]> {
  const cf = await resolveFieldIds(cfg);
  const fields = [
    "summary",
    "status",
    "issuetype",
    "assignee",
    "priority",
    "description",
    "labels",
    cf.epicLink,
    cf.sprint,
    cf.storyPoints,
    "parent",
  ].join(",");
  const all: Issue[] = [];
  let startAt = 0;
  while (true) {
    const data = await jget(
      cfg,
      `/rest/agile/1.0/board/${boardId}/issue?startAt=${startAt}&maxResults=100&fields=${fields}&jql=${encodeURIComponent("ORDER BY Rank ASC")}`,
    );
    for (const it of data.issues ?? []) {
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
        issueType: f.issuetype?.name ?? "",
        labels: Array.isArray(f.labels) ? f.labels : [],
      };
      if (f.assignee?.displayName) issue.assignee = f.assignee.displayName;
      if (f.priority?.name) issue.priority = f.priority.name;
      if (activeSprint?.name) issue.sprintName = activeSprint.name;
      if (typeof f[cf.storyPoints] === "number") issue.storyPoints = f[cf.storyPoints];
      const epic = f[cf.epicLink] || f.parent?.key;
      if (epic) issue.epicKey = epic;
      all.push(issue);
    }
    if ((data.issues?.length ?? 0) < 100) break;
    startAt += 100;
    // Matches listBoards' cap. Bump if real boards start hitting it.
    if (startAt > 5000) break;
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
  // Empty on failure, which just means no custom fields render.
  const [data, commentsData, editMetaData] = await Promise.all([
    jget(cfg, `/rest/api/3/issue/${issueKey}?fields=${fields}`),
    // Newest-first + no pagination: on an issue with >100 comments we want
    // the most recent 100 to survive the cap, not the oldest. We reverse
    // below so the display stays chronological (oldest → newest).
    jget(cfg, `/rest/api/3/issue/${issueKey}/comment?orderBy=-created&maxResults=100`),
    jget(cfg, `/rest/api/3/issue/${issueKey}/editmeta`).catch(() => ({ fields: {} })),
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
  const detail: IssueDetail = {
    key: data.key,
    id: Number(data.id),
    summary: f.summary ?? "",
    description,
    statusId: String(f.status?.id ?? ""),
    statusName: f.status?.name ?? "",
    issueType: f.issuetype?.name ?? "",
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
          if (l.outwardIssue) {
            return [
              {
                direction: l.type?.outward ?? "relates to",
                key: l.outwardIssue.key,
                summary: l.outwardIssue.fields?.summary ?? "",
                statusName: l.outwardIssue.fields?.status?.name ?? "",
                issueType: l.outwardIssue.fields?.issuetype?.name ?? "",
              },
            ];
          }
          if (l.inwardIssue) {
            return [
              {
                direction: l.type?.inward ?? "relates to",
                key: l.inwardIssue.key,
                summary: l.inwardIssue.fields?.summary ?? "",
                statusName: l.inwardIssue.fields?.status?.name ?? "",
                issueType: l.inwardIssue.fields?.issuetype?.name ?? "",
              },
            ];
          }
          return [];
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
    ...(() => {
      const metaFields = editMetaData?.fields ?? {};
      const editable = new Map<string, EditableField>();
      for (const ef of parseEditableFields(metaFields)) editable.set(ef.id, ef);
      const customFields = Object.keys(metaFields)
        .filter((id) => id.startsWith("customfield_"))
        .flatMap((id) => {
          const normalized = normalizeCustomField(id, metaFields[id], f[id], editable.get(id));
          return normalized ? [normalized] : [];
        });
      return { customFields, editmeta: editable };
    })(),
  };
  if (f.assignee?.displayName) detail.assignee = f.assignee.displayName;
  if (f.priority?.name) detail.priority = f.priority.name;
  const epic = f[cf.epicLink] || f.parent?.key;
  if (epic) detail.epicKey = epic;
  if (f.reporter?.displayName) detail.reporter = f.reporter.displayName;
  if (typeof f[cf.storyPoints] === "number") detail.storyPoints = f[cf.storyPoints];
  if (f.duedate) detail.dueDate = f.duedate;
  if (f.parent?.key) detail.parentKey = f.parent.key;
  return detail;
}

/**
 * Cheap lookup for just the current status id — used after create to decide
 * whether the fresh issue already sits in the column we want, or needs a
 * transition to get there.
 */
export async function getIssueStatusId(cfg: JiraConfig, issueKey: string): Promise<string> {
  const data = await jget(cfg, `/rest/api/3/issue/${issueKey}?fields=status`);
  return String(data.fields?.status?.id ?? "");
}

export async function getTransitions(cfg: JiraConfig, issueKey: string): Promise<Transition[]> {
  // `expand=transitions.fields` surfaces the workflow screen's required
  // fields inline — lets the caller decide up front whether it needs to
  // prompt the user or can POST silently.
  const data = await jget(
    cfg,
    `/rest/api/3/issue/${issueKey}/transitions?expand=transitions.fields`,
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
 * Normalize Jira's loose field-metadata shape — the same structure appears
 * in both `/transitions?expand=transitions.fields` and `/editmeta` — into
 * a closed union of field kinds the UI can dispatch against. Callers
 * decide whether to filter by `required`.
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
    } else if (schemaType === "string") {
      out.push({ ...base, kind: "text" });
    } else if (schemaType === "number") {
      out.push({ ...base, kind: "number" });
    } else if (schemaType === "date" || schemaType === "datetime") {
      out.push({ ...base, kind: "date" });
    } else {
      out.push({ ...base, kind: "unsupported", schemaType });
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
  const res = await jf(cfg, `/rest/api/3/issue/${issueKey}/transitions`, {
    method: "POST",
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`transition failed ${res.status}: ${await res.text()}`);
}

export async function updateSummary(
  cfg: JiraConfig,
  issueKey: string,
  summary: string,
): Promise<void> {
  const res = await jf(cfg, `/rest/api/3/issue/${issueKey}`, {
    method: "PUT",
    body: JSON.stringify({ fields: { summary } }),
  });
  if (!res.ok) throw new Error(`update summary ${res.status}: ${await res.text()}`);
}

export async function updateDescription(
  cfg: JiraConfig,
  issueKey: string,
  description: string,
): Promise<void> {
  const res = await jf(cfg, `/rest/api/3/issue/${issueKey}`, {
    method: "PUT",
    body: JSON.stringify({ fields: { description: textToAdf(description) } }),
  });
  if (!res.ok) throw new Error(`update description ${res.status}: ${await res.text()}`);
}

export async function getIssueTypes(cfg: JiraConfig, projectKey: string): Promise<IssueType[]> {
  const data = await jget(
    cfg,
    `/rest/api/3/issue/createmeta/${encodeURIComponent(projectKey)}/issuetypes`,
  );
  return (data.issueTypes ?? data.values ?? []).map((t: any) => ({
    id: String(t.id),
    name: t.name,
    subtask: !!t.subtask,
  }));
}

export type IssueLinkType = {
  id: string;
  name: string;
  // Human-readable direction labels, e.g. "blocks" / "is blocked by".
  inward: string;
  outward: string;
};

export async function getIssueLinkTypes(cfg: JiraConfig): Promise<IssueLinkType[]> {
  const data = await jget(cfg, `/rest/api/3/issueLinkType`);
  return (data.issueLinkTypes ?? []).map((t: any) => ({
    id: String(t.id),
    name: t.name,
    inward: t.inward,
    outward: t.outward,
  }));
}

export type IssueSearchResult = {
  key: string;
  summary: string;
  issueType: string;
};

/**
 * Search issues across the project — matches on summary or key, up to limit.
 * Builds the JQL, then defers to `searchByJql` for the actual POST + parse.
 */
export async function searchIssues(
  cfg: JiraConfig,
  projectKey: string,
  query: string,
  limit = 25,
): Promise<IssueSearchResult[]> {
  // Strip quotes / backslashes so stray input can't break out of the JQL string.
  const q = query.trim().replaceAll(/["\\]/g, "");
  // `issuekey = X` only works when X looks like a real key (PROJ-123).
  const looksLikeKey = /^[A-Za-z][A-Za-z0-9]*-\d+$/.test(q);
  const match = q
    ? looksLikeKey
      ? ` AND (summary ~ "${q}*" OR issuekey = "${q.toUpperCase()}")`
      : ` AND summary ~ "${q}*"`
    : "";
  const jql = `project = "${projectKey}"${match} ORDER BY updated DESC`;
  return searchByJql(cfg, jql, limit);
}

/**
 * Link two issues. `direction` picks which side of the link-type the new
 * issue sits on — for "blocks" (outward) / "is blocked by" (inward),
 * outwardIssue blocks inwardIssue.
 */
export async function createIssueLink(
  cfg: JiraConfig,
  linkTypeName: string,
  newIssueKey: string,
  targetKey: string,
  direction: "outward" | "inward",
): Promise<void> {
  const [outward, inward] =
    direction === "outward" ? [newIssueKey, targetKey] : [targetKey, newIssueKey];
  const res = await jf(cfg, `/rest/api/3/issueLink`, {
    method: "POST",
    body: JSON.stringify({
      type: { name: linkTypeName },
      outwardIssue: { key: outward },
      inwardIssue: { key: inward },
    }),
  });
  if (!res.ok) throw new Error(`link ${res.status}: ${await res.text()}`);
}

export type JiraUser = { accountId: string; displayName: string };

export async function getAssignableUsers(cfg: JiraConfig, projectKey: string): Promise<JiraUser[]> {
  const data = await jget(
    cfg,
    `/rest/api/3/user/assignable/search?project=${encodeURIComponent(projectKey)}&maxResults=100`,
  );
  return (data ?? []).map((u: any) => ({
    accountId: String(u.accountId),
    displayName: u.displayName ?? u.emailAddress ?? u.accountId,
  }));
}

export async function updateIssueField(
  cfg: JiraConfig,
  issueKey: string,
  fields: Record<string, any>,
): Promise<void> {
  const res = await jf(cfg, `/rest/api/3/issue/${issueKey}`, {
    method: "PUT",
    body: JSON.stringify({ fields }),
  });
  if (!res.ok) throw new Error(`update ${res.status}: ${await res.text()}`);
}

export async function addComment(cfg: JiraConfig, issueKey: string, body: string): Promise<void> {
  const res = await jf(cfg, `/rest/api/3/issue/${issueKey}/comment`, {
    method: "POST",
    body: JSON.stringify({ body: textToAdf(body) }),
  });
  if (!res.ok) throw new Error(`add comment ${res.status}: ${await res.text()}`);
}

export async function updateComment(
  cfg: JiraConfig,
  issueKey: string,
  commentId: string,
  body: string,
): Promise<void> {
  const res = await jf(cfg, `/rest/api/3/issue/${issueKey}/comment/${commentId}`, {
    method: "PUT",
    body: JSON.stringify({ body: textToAdf(body) }),
  });
  if (!res.ok) throw new Error(`update comment ${res.status}: ${await res.text()}`);
}

export async function fetchCurrentUser(
  cfg: JiraConfig,
): Promise<{ accountId: string; displayName: string }> {
  const data = await jget(cfg, `/rest/api/3/myself`);
  return {
    accountId: data.accountId ?? "",
    displayName: data.displayName ?? data.emailAddress ?? "unknown",
  };
}

export async function watchIssue(cfg: JiraConfig, issueKey: string): Promise<void> {
  const res = await jf(cfg, `/rest/api/3/issue/${issueKey}/watchers`, { method: "POST" });
  if (!res.ok) throw new Error(`watch ${res.status}: ${await res.text()}`);
}

export async function unwatchIssue(cfg: JiraConfig, issueKey: string): Promise<void> {
  const me = await fetchCurrentUser(cfg);
  const res = await jf(
    cfg,
    `/rest/api/3/issue/${issueKey}/watchers?accountId=${encodeURIComponent(me.accountId)}`,
    { method: "DELETE" },
  );
  if (!res.ok) throw new Error(`unwatch ${res.status}: ${await res.text()}`);
}

export async function searchByJql(
  cfg: JiraConfig,
  jql: string,
  limit = 50,
): Promise<IssueSearchResult[]> {
  const res = await jf(cfg, `/rest/api/3/search/jql`, {
    method: "POST",
    body: JSON.stringify({ jql, fields: ["summary", "issuetype"], maxResults: limit }),
  });
  if (!res.ok) throw new Error(`jql search ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as any;
  return (data.issues ?? []).map((i: any) => ({
    key: i.key,
    summary: i.fields?.summary ?? "",
    issueType: i.fields?.issuetype?.name ?? "",
  }));
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
  const res = await jf(cfg, `/rest/agile/1.0/issue/rank`, {
    method: "PUT",
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`rank ${res.status}: ${await res.text()}`);
}

export async function assignIssueToMe(cfg: JiraConfig, issueKey: string): Promise<void> {
  const me = await fetchCurrentUser(cfg);
  const res = await jf(cfg, `/rest/api/3/issue/${issueKey}`, {
    method: "PUT",
    body: JSON.stringify({ fields: { assignee: { accountId: me.accountId } } }),
  });
  if (!res.ok) throw new Error(`assign ${res.status}: ${await res.text()}`);
}

export async function createIssue(
  cfg: JiraConfig,
  projectKey: string,
  typeName: string,
  summary: string,
  description: string,
  parentKey?: string,
): Promise<{ key: string }> {
  const fields: any = {
    project: { key: projectKey },
    issuetype: { name: typeName },
    summary,
  };
  if (description) fields.description = textToAdf(description);
  /**
   * `parent` is canonical for epic-child and sub-task links in Jira Cloud.
   * The legacy `customfield_10014` ("Epic Link") is deliberately not set —
   * team-managed projects reject it with "cannot be set on this issue type".
   */
  if (parentKey) fields.parent = { key: parentKey };
  const res = await jf(cfg, `/rest/api/3/issue`, {
    method: "POST",
    body: JSON.stringify({ fields }),
  });
  if (!res.ok) throw new Error(`create ${res.status}: ${await res.text()}`);
  return (await res.json()) as { key: string };
}
