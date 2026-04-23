import type { JiraConfig } from "./config";

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
};

export type Transition = { id: string; name: string; toStatusId: string };

export type IssueType = { id: string; name: string; subtask: boolean };

export type Comment = {
  id: string;
  author: string;
  body: string;
  created: string;
};

export type IssueDetail = Issue & {
  reporter?: string;
  labels: string[];
  components: string[];
  fixVersions: string[];
  sprint?: string;
  storyPoints?: number;
  dueDate?: string;
  created: string;
  updated: string;
  parentKey?: string;
  subtasks: { key: string; summary: string; statusName: string }[];
  comments: Comment[];
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
  const columns: BoardColumn[] = (data.columnConfig?.columns ?? []).map((c: any) => ({
    name: c.name,
    statusIds: (c.statuses ?? []).map((s: any) => String(s.id)),
  }));
  return {
    name: data.name,
    projectKey: data.location?.key,
    columns,
  };
}

function adfToText(node: any): string {
  if (!node) return "";
  if (typeof node === "string") return node;
  // Tabs desync Ink's column math with terminal width — normalize to spaces.
  if (node.type === "text") return (node.text ?? "").replaceAll("\t", "  ");
  if (node.type === "hardBreak") return "\n";
  if (node.type === "mention") return `@${node.attrs?.text ?? node.attrs?.displayName ?? ""}`;
  if (node.type === "emoji") return node.attrs?.text ?? node.attrs?.shortName ?? "";
  if (node.type === "inlineCard") return node.attrs?.url ?? "";
  if (node.type === "media" || node.type === "mediaSingle" || node.type === "mediaGroup")
    return "[media]\n";
  if (node.type === "rule") return "\n───\n";
  /**
   * Fence code blocks so line structure survives and the reader can tell
   * code from prose — otherwise it all flattens into one run.
   */
  if (node.type === "codeBlock") {
    const lang = node.attrs?.language ?? "";
    const body = Array.isArray(node.content) ? node.content.map(adfToText).join("") : "";
    return `\n\`\`\`${lang}\n${body}\n\`\`\`\n`;
  }
  const children = Array.isArray(node.content) ? node.content.map(adfToText).join("") : "";
  if (node.type === "listItem") return `• ${children.trim()}\n`;
  const block =
    node.type === "paragraph" ||
    node.type === "heading" ||
    node.type === "bulletList" ||
    node.type === "orderedList" ||
    node.type === "blockquote";
  return block ? children + "\n" : children;
}

export async function getBoardIssues(cfg: JiraConfig, boardId: number): Promise<Issue[]> {
  const fields = [
    "summary",
    "status",
    "issuetype",
    "assignee",
    "priority",
    "description",
    CF_EPIC_LINK,
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
      const issue: Issue = {
        key: it.key,
        summary: f.summary ?? "",
        description,
        statusId: String(f.status?.id ?? ""),
        statusName: f.status?.name ?? "",
        issueType: f.issuetype?.name ?? "",
      };
      if (f.assignee?.displayName) issue.assignee = f.assignee.displayName;
      if (f.priority?.name) issue.priority = f.priority.name;
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
  ].join(",");
  const [data, commentsData] = await Promise.all([
    jget(cfg, `/rest/api/3/issue/${issueKey}?fields=${fields}&expand=renderedFields`),
    jget(cfg, `/rest/api/3/issue/${issueKey}/comment?orderBy=created&maxResults=100`),
  ]);
  const f = data.fields ?? {};
  const descRaw = f.description;
  const description = typeof descRaw === "string" ? descRaw : adfToText(descRaw).trim();
  const sprints = Array.isArray(f[CF_SPRINT]) ? f[CF_SPRINT] : [];
  const activeSprint = sprints.find((s: any) => s?.state === "active") ?? sprints[0];
  const comments: Comment[] = (commentsData.comments ?? []).map((c: any) => ({
    id: String(c.id),
    author: c.author?.displayName ?? "unknown",
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
    comments,
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

export async function getTransitions(cfg: JiraConfig, issueKey: string): Promise<Transition[]> {
  const data = await jget(cfg, `/rest/api/3/issue/${issueKey}/transitions`);
  return (data.transitions ?? []).map((t: any) => ({
    id: t.id,
    name: t.name,
    toStatusId: String(t.to?.id ?? ""),
  }));
}

export async function transitionIssue(
  cfg: JiraConfig,
  issueKey: string,
  transitionId: string,
): Promise<void> {
  const res = await jf(cfg, `/rest/api/3/issue/${issueKey}/transitions`, {
    method: "POST",
    body: JSON.stringify({ transition: { id: transitionId } }),
  });
  if (!res.ok) throw new Error(`transition failed ${res.status}: ${await res.text()}`);
}

function textToAdf(text: string) {
  // Strip \r so Windows-flavored tmp files don't carry ^M into ADF nodes.
  const lines = text.replaceAll(/\r\n/g, "\n").split("\n");
  const content = lines.map((line) =>
    line.length === 0
      ? { type: "paragraph" }
      : { type: "paragraph", content: [{ type: "text", text: line }] },
  );
  return { type: "doc", version: 1, content };
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
