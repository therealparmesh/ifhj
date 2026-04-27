import { adfToText, textToAdf } from "./adf";
import type { JiraConfig } from "./config";
import { type CustomField, normalizeCustomField } from "./customFields";
export type { CustomField } from "./customFields";

/**
 * Jira Cloud's default custom-field IDs. Tenants can remap these, but the
 * defaults cover the vast majority.
 */
const CF_EPIC_LINK = "customfield_10014";
const CF_SPRINT = "customfield_10020";
const CF_STORY_POINTS = "customfield_10016";

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

export type BoardConfig = {
  name: string;
  projectKey: string;
  columns: BoardColumn[];
};

export type Issue = {
  key: string;
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
 * screens and lets custom-field callers ignore it. `hasDefaultValue` is
 * kept for completeness; we don't seed from it because Jira doesn't tell
 * us which allowedValue is the default, and a wrong guess is worse than
 * asking.
 */
type EditableFieldBase = {
  id: string;
  name: string;
  required: boolean;
  hasDefaultValue: boolean;
};

export type EditableOption = { id: string; name: string };

export type EditableOptionField = EditableFieldBase & {
  kind: "option";
  allowedValues: EditableOption[];
};

export type EditableOptionListField = EditableFieldBase & {
  kind: "option-list";
  allowedValues: EditableOption[];
};

export type EditableUserField = EditableFieldBase & { kind: "user" };
export type EditableUserListField = EditableFieldBase & { kind: "user-list" };
export type EditableTextField = EditableFieldBase & { kind: "text" };
/**
 * Plain string arrays — labels-style. Edited as a comma-separated list in
 * an inline input. Distinct from option-list because the shape Jira wants
 * is `["foo", "bar"]`, not `[{id}]`.
 */
export type EditableStringListField = EditableFieldBase & { kind: "string-list" };
export type EditableNumberField = EditableFieldBase & { kind: "number" };
export type EditableDateField = EditableFieldBase & { kind: "date" };

/**
 * Field types we can't sensibly edit from a TUI (cascading selects, ADF
 * rich-text bodies, etc.). Surfaced explicitly so the UI can mark them
 * read-only with a "complete in browser" hint.
 */
export type EditableUnsupportedField = EditableFieldBase & {
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
  sprint?: string;
  dueDate?: string;
  created: string;
  updated: string;
  parentKey?: string;
  subtasks: { key: string; summary: string; statusName: string }[];
  links: IssueLink[];
  comments: Comment[];
  watching?: boolean;
  /**
   * Project-specific custom fields, surfaced read-only. Discovered via
   * editmeta (so we only show fields that are at least nominally
   * writable for this user — anything more exotic than that lives
   * outside the TUI's scope). Minus the three we have dedicated UI for:
   * epic, sprint, story points. Empty when editmeta fetch fails.
   */
  customFields: CustomField[];
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
    projectKey: data.location?.key,
    columns,
  };
}

export async function getBoardIssues(cfg: JiraConfig, boardId: number): Promise<Issue[]> {
  const fields = [
    "summary",
    "status",
    "issuetype",
    "assignee",
    "priority",
    "description",
    "labels",
    CF_EPIC_LINK,
    CF_SPRINT,
    CF_STORY_POINTS,
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
      const sprints = Array.isArray(f[CF_SPRINT]) ? f[CF_SPRINT] : [];
      const activeSprint = sprints.find((s: any) => s?.state === "active") ?? sprints[0];
      const issue: Issue = {
        key: it.key,
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
      if (typeof f[CF_STORY_POINTS] === "number") issue.storyPoints = f[CF_STORY_POINTS];
      const epic = f[CF_EPIC_LINK] || f.parent?.key;
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
  const fields = [
    "summary",
    "status",
    "issuetype",
    "assignee",
    "reporter",
    "priority",
    "description",
    "labels",
    "components",
    "fixVersions",
    "duedate",
    "created",
    "updated",
    CF_EPIC_LINK,
    CF_SPRINT,
    CF_STORY_POINTS,
    "parent",
    "subtasks",
    "issuelinks",
    "watches",
    // `*all` pulls every field — including custom ones — which we later
    // narrow to customfield_* via editmeta. Exclude the big/noisy system
    // fields we already fetch via their dedicated endpoints so the
    // payload stays lean.
    "*all",
    "-attachment",
    "-comment",
    "-worklog",
  ].join(",");
  // Editmeta tells us which custom fields Jira considers part of this
  // project + issue type — we use it as a filter so we don't surface
  // internal / deprecated customfield_* that show up in the main GET.
  // Empty on failure, which just means no custom fields render.
  const [data, commentsData, editMetaData] = await Promise.all([
    jget(cfg, `/rest/api/3/issue/${issueKey}?fields=${fields}&expand=renderedFields`),
    jget(cfg, `/rest/api/3/issue/${issueKey}/comment?orderBy=created&maxResults=100`),
    jget(cfg, `/rest/api/3/issue/${issueKey}/editmeta`).catch(() => ({ fields: {} })),
  ]);
  const f = data.fields ?? {};
  const descRaw = f.description;
  const description = typeof descRaw === "string" ? descRaw : adfToText(descRaw).trim();
  const sprints = Array.isArray(f[CF_SPRINT]) ? f[CF_SPRINT] : [];
  const activeSprint = sprints.find((s: any) => s?.state === "active") ?? sprints[0];
  const comments: Comment[] = (commentsData.comments ?? []).map((c: any) => ({
    id: String(c.id),
    author: c.author?.displayName ?? "unknown",
    authorAccountId: c.author?.accountId ?? "",
    body: typeof c.body === "string" ? c.body : adfToText(c.body).trim(),
    created: c.created,
  }));
  const detail: IssueDetail = {
    key: data.key,
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
    // Walk the issue's own `fields` response in its natural key order —
    // on Atlassian Cloud this matches the project's configured view
    // screen ordering, which is what users see in the web UI. Filter
    // to custom-field ids that editmeta acknowledged (keeps the noise
    // out: non-editable internals, deprecated remnants, etc.).
    customFields: (() => {
      const metaFields = editMetaData?.fields ?? {};
      // Parse the editmeta once so every custom-field row carries the
      // same EditableField shape used by transitions — the detail modal
      // can pass these directly to FieldEditor without re-inspecting.
      const editable = new Map<string, EditableField>();
      for (const ef of parseEditableFields(metaFields)) editable.set(ef.id, ef);
      // Walk editmeta, not the issue's fields — so fields that are
      // editable but currently unset still appear (user can click in to
      // set them). Preserves editmeta key order, which on Atlassian
      // Cloud matches the project's view screen ordering.
      return Object.keys(metaFields)
        .filter((id) => id.startsWith("customfield_"))
        .flatMap((id) => {
          const normalized = normalizeCustomField(id, metaFields[id], f[id], editable.get(id));
          return normalized ? [normalized] : [];
        });
    })(),
  };
  if (f.assignee?.displayName) detail.assignee = f.assignee.displayName;
  if (f.priority?.name) detail.priority = f.priority.name;
  const epic = f[CF_EPIC_LINK] || f.parent?.key;
  if (epic) detail.epicKey = epic;
  if (f.reporter?.displayName) detail.reporter = f.reporter.displayName;
  if (activeSprint?.name) detail.sprint = activeSprint.name;
  if (typeof f[CF_STORY_POINTS] === "number") detail.storyPoints = f[CF_STORY_POINTS];
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
    // Only required fields block a transition — optional screen fields
    // are noise for the uniform "show the screen modal" path.
    requiredFields: parseEditableFields(t.fields ?? {}).filter((f) => f.required),
  }));
}

/**
 * Normalize Jira's loose field-metadata shape — the same structure appears
 * in both `/transitions?expand=transitions.fields` and `/editmeta` — into
 * a closed union of field kinds the UI can dispatch against. Callers
 * decide whether to filter by `required`.
 */
export function parseEditableFields(fields: Record<string, any>): EditableField[] {
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
 *
 * Uses POST /rest/api/3/search/jql (Atlassian's current endpoint). The older
 * GET /rest/api/3/search returns empty arrays on newer tenants where it's
 * been throttled or partially retired.
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
  const res = await jf(cfg, `/rest/api/3/search/jql`, {
    method: "POST",
    body: JSON.stringify({ jql, fields: ["summary", "issuetype"], maxResults: limit }),
  });
  if (!res.ok) throw new Error(`search ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as any;
  return (data.issues ?? []).map((i: any) => ({
    key: i.key,
    summary: i.fields?.summary ?? "",
    issueType: i.fields?.issuetype?.name ?? "",
  }));
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

export type Priority = { id: string; name: string };

export async function getPriorities(cfg: JiraConfig): Promise<Priority[]> {
  const data = await jget(cfg, `/rest/api/3/priority`);
  return (data ?? []).map((p: any) => ({ id: String(p.id), name: p.name }));
}

export async function getLabels(cfg: JiraConfig): Promise<string[]> {
  const data = await jget(cfg, `/rest/api/3/label?maxResults=1000`);
  return data.values ?? [];
}

export type ProjectComponent = { id: string; name: string };

export async function getProjectComponents(
  cfg: JiraConfig,
  projectKey: string,
): Promise<ProjectComponent[]> {
  const data = await jget(cfg, `/rest/api/3/project/${encodeURIComponent(projectKey)}/components`);
  return (data ?? []).map((c: any) => ({ id: String(c.id), name: c.name }));
}

export type ProjectVersion = { id: string; name: string; released: boolean };

export async function getProjectVersions(
  cfg: JiraConfig,
  projectKey: string,
): Promise<ProjectVersion[]> {
  const data = await jget(cfg, `/rest/api/3/project/${encodeURIComponent(projectKey)}/versions`);
  return (data ?? []).map((v: any) => ({ id: String(v.id), name: v.name, released: !!v.released }));
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

export async function rankIssueBefore(
  cfg: JiraConfig,
  issueKey: string,
  beforeKey: string,
): Promise<void> {
  const res = await jf(cfg, `/rest/agile/1.0/issue/rank`, {
    method: "PUT",
    body: JSON.stringify({ issues: [issueKey], rankBeforeIssue: beforeKey }),
  });
  if (!res.ok) throw new Error(`rank ${res.status}: ${await res.text()}`);
}

export async function rankIssueAfter(
  cfg: JiraConfig,
  issueKey: string,
  afterKey: string,
): Promise<void> {
  const res = await jf(cfg, `/rest/agile/1.0/issue/rank`, {
    method: "PUT",
    body: JSON.stringify({ issues: [issueKey], rankAfterIssue: afterKey }),
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
