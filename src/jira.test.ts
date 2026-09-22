import { afterEach, describe, expect, test } from "bun:test";

import type { JiraConfig } from "./config";
import {
  createIssue,
  getAssignableUsers,
  getBoardConfig,
  getBoardIssues,
  getCreateFields,
  getIssueTypes,
  getTransitions,
  listBoards,
  searchByJql,
} from "./jira";
import { deferred } from "./test/utils";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function cfg(name: string): JiraConfig {
  return { server: `https://${name}.example.test`, authHeader: "Basic test" };
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status });
}

function rawIssue(id: number): Record<string, unknown> {
  return {
    id: String(id),
    key: `PROJ-${id}`,
    fields: {
      summary: `Issue ${id}`,
      status: { id: "1", name: "To Do", statusCategory: { key: "new" } },
      updated: "2026-01-01T00:00:00.000Z",
      issuetype: { name: "Task" },
      labels: [],
    },
  };
}

describe("Jira pagination", () => {
  test("uses Jira response page sizes for boards and deduplicates shifted boundaries", async () => {
    const starts: number[] = [];
    globalThis.fetch = (async (input) => {
      const url = new URL(String(input));
      if (url.pathname !== "/rest/agile/1.0/board") throw new Error(`unexpected request: ${url}`);
      const start = Number(url.searchParams.get("startAt"));
      starts.push(start);
      const values =
        start === 0
          ? [
              { id: 1, name: "One", type: "kanban" },
              { id: 2, name: "Two", type: "scrum" },
            ]
          : [
              { id: 2, name: "Two", type: "scrum" },
              { id: 3, name: "Three", type: "kanban" },
            ];
      return json({ startAt: start, maxResults: 2, total: 4, isLast: start === 2, values });
    }) as typeof fetch;

    const boards = await listBoards(cfg("boards"));
    expect(starts).toEqual([0, 2]);
    expect(boards.map((board) => board.id)).toEqual([1, 2, 3]);
  });

  test("does not stop board issues when Jira caps a page below the requested size", async () => {
    const starts: number[] = [];
    globalThis.fetch = (async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/rest/api/3/field") return json([]);
      const start = Number(url.searchParams.get("startAt"));
      starts.push(start);
      return json({
        startAt: start,
        maxResults: 2,
        total: 3,
        issues: start === 0 ? [rawIssue(1), rawIssue(2)] : [rawIssue(3)],
      });
    }) as typeof fetch;

    const issues = await getBoardIssues(cfg("board-issues"), 10);
    expect(starts).toEqual([0, 2]);
    expect(issues.map((issue) => issue.key)).toEqual(["PROJ-1", "PROJ-2", "PROJ-3"]);
  });

  test("normalizes a board with no project location to an empty project key", async () => {
    globalThis.fetch = (async (input) => {
      const url = new URL(String(input));
      if (url.pathname !== "/rest/agile/1.0/board/10/configuration") {
        throw new Error(`unexpected request: ${url}`);
      }
      return json({ name: "Filter board", columnConfig: { columns: [] } });
    }) as typeof fetch;
    expect(await getBoardConfig(cfg("board-config"), 10)).toEqual({
      name: "Filter board",
      projectKey: "",
      columns: [],
    });
  });

  test("uses each board's configured estimation field without changing tenant defaults", async () => {
    const requested: string[][] = [];
    globalThis.fetch = (async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/rest/api/3/field") return json([]);
      if (url.pathname.endsWith("/configuration")) {
        const fieldId = url.pathname.includes("/1/") ? "customfield_41" : "customfield_42";
        return json({
          name: "Board",
          location: { key: "PROJ" },
          columnConfig: { columns: [] },
          estimation: { type: "field", field: { fieldId } },
        });
      }
      if (url.pathname.endsWith("/issue")) {
        const fields = (url.searchParams.get("fields") ?? "").split(",");
        requested.push(fields);
        const estimate = fields.includes("customfield_41") ? 3 : 8;
        const fieldId = fields.includes("customfield_41") ? "customfield_41" : "customfield_42";
        const item = rawIssue(requested.length) as any;
        item.fields[fieldId] = estimate;
        return json({ startAt: 0, maxResults: 1, total: 1, isLast: true, issues: [item] });
      }
      throw new Error(`unexpected request: ${url}`);
    }) as typeof fetch;

    const config = cfg("board-estimation");
    const first = await getBoardConfig(config, 1);
    const second = await getBoardConfig(config, 2);
    const firstIssues = await getBoardIssues(config, 1, first.estimationFieldId);
    const secondIssues = await getBoardIssues(config, 2, second.estimationFieldId);

    expect(first.estimationFieldId).toBe("customfield_41");
    expect(second.estimationFieldId).toBe("customfield_42");
    expect(requested[0]).toContain("customfield_41");
    expect(requested[0]).not.toContain("customfield_42");
    expect(requested[1]).toContain("customfield_42");
    expect(requested[1]).not.toContain("customfield_41");
    expect(firstIssues[0]?.storyPoints).toBe(3);
    expect(secondIssues[0]?.storyPoints).toBe(8);
  });

  test("reads all issueTypes pages from create metadata", async () => {
    const starts: number[] = [];
    globalThis.fetch = (async (input) => {
      const url = new URL(String(input));
      if (url.pathname !== "/rest/api/3/issue/createmeta/A%2FB/issuetypes") {
        throw new Error(`unexpected request: ${url}`);
      }
      const start = Number(url.searchParams.get("startAt"));
      starts.push(start);
      return json({
        startAt: start,
        maxResults: 1,
        total: 2,
        isLast: start === 1,
        issueTypes: [{ id: String(start + 1), name: start === 0 ? "Task" : "Bug", subtask: false }],
      });
    }) as typeof fetch;

    expect((await getIssueTypes(cfg("types"), "A/B")).map((type) => type.name)).toEqual([
      "Task",
      "Bug",
    ]);
    expect(starts).toEqual([0, 1]);
  });

  test("keeps unpaged metadata compatibility and rejects a non-advancing page", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return json({ issueTypes: [{ id: "1", name: "Task", subtask: false }] });
    }) as unknown as typeof fetch;
    expect(await getIssueTypes(cfg("unpaged-types"), "PROJ")).toEqual([
      { id: "1", name: "Task", subtask: false },
    ]);
    expect(calls).toBe(1);

    globalThis.fetch = (async () =>
      json({
        startAt: 0,
        maxResults: 0,
        total: 2,
        isLast: false,
        fields: [],
      })) as unknown as typeof fetch;
    await expect(getCreateFields(cfg("stalled-fields"), "PROJ", "1")).rejects.toThrow(
      "create field pagination did not advance",
    );
  });

  test("follows enhanced-search tokens and enforces the requested limit", async () => {
    const bodies: Record<string, unknown>[] = [];
    globalThis.fetch = (async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname !== "/rest/api/3/search/jql" || init?.method !== "POST") {
        throw new Error(`unexpected request: ${init?.method ?? "GET"} ${url}`);
      }
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      bodies.push(body);
      const token = body["nextPageToken"];
      return json({
        isLast: token === "next",
        ...(token ? {} : { nextPageToken: "next" }),
        issues: token ? [rawIssue(2), rawIssue(3)] : [rawIssue(1), rawIssue(2)],
      });
    }) as typeof fetch;

    const results = await searchByJql(cfg("search"), "project = PROJ", 3);
    expect(results.map((issue) => issue.key)).toEqual(["PROJ-1", "PROJ-2", "PROJ-3"]);
    expect(bodies).toEqual([
      { jql: "project = PROJ", fields: ["summary", "issuetype", "project"], maxResults: 3 },
      {
        jql: "project = PROJ",
        fields: ["summary", "issuetype", "project"],
        maxResults: 1,
        nextPageToken: "next",
      },
    ]);
  });

  test("requests the complete assignable-user scan range", async () => {
    let requested: URL | undefined;
    globalThis.fetch = (async (input) => {
      requested = new URL(String(input));
      if (requested.pathname !== "/rest/api/3/user/assignable/search") {
        throw new Error(`unexpected request: ${requested}`);
      }
      return json([{ accountId: "a", displayName: "Ada" }]);
    }) as typeof fetch;

    expect(await getAssignableUsers(cfg("users"), "A B")).toEqual([
      { accountId: "a", displayName: "Ada" },
    ]);
    expect(requested?.searchParams.get("project")).toBe("A B");
    expect(requested?.searchParams.get("maxResults")).toBe("1000");
  });

  test("does not request assignable users without a project", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return json([]);
    }) as unknown as typeof fetch;

    expect(await getAssignableUsers(cfg("empty-users"), "")).toEqual([]);
    expect(calls).toBe(0);
  });
});

describe("Jira field metadata", () => {
  test("coalesces concurrent discovery requests", async () => {
    let fieldCalls = 0;
    const fields = deferred<Response>();
    globalThis.fetch = (async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/rest/api/3/field") {
        fieldCalls++;
        return fields.promise;
      }
      if (url.pathname.endsWith("/issue")) {
        return json({ startAt: 0, maxResults: 100, total: 0, issues: [] });
      }
      throw new Error(`unexpected request: ${url}`);
    }) as typeof fetch;

    const config = cfg("field-concurrent");
    const requests = Promise.all([getBoardIssues(config, 1), getBoardIssues(config, 2)]);
    expect(fieldCalls).toBe(1);
    fields.resolve(json([]));
    await requests;
  });

  test("shares fallback across a concurrent failure and retries later", async () => {
    let fieldCalls = 0;
    globalThis.fetch = (async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/rest/api/3/field") {
        fieldCalls++;
        return fieldCalls === 1 ? new Response("temporary", { status: 503 }) : json([]);
      }
      if (url.pathname.endsWith("/issue")) {
        return json({ startAt: 0, maxResults: 100, total: 0, issues: [] });
      }
      throw new Error(`unexpected request: ${url}`);
    }) as typeof fetch;

    const config = cfg("field-retry");
    const concurrent = await Promise.allSettled([
      getBoardIssues(config, 1),
      getBoardIssues(config, 2),
    ]);
    expect(concurrent).toEqual([
      { status: "fulfilled", value: [] },
      { status: "fulfilled", value: [] },
    ]);
    expect(fieldCalls).toBe(1);
    await getBoardIssues(config, 1);
    expect(fieldCalls).toBe(2);
  });

  test("does not cache a malformed discovery response", async () => {
    let fieldCalls = 0;
    globalThis.fetch = (async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/rest/api/3/field") {
        fieldCalls++;
        return json(fieldCalls === 1 ? { values: [] } : []);
      }
      if (url.pathname.endsWith("/issue")) {
        return json({ startAt: 0, maxResults: 100, total: 0, issues: [] });
      }
      throw new Error(`unexpected request: ${url}`);
    }) as typeof fetch;

    const config = cfg("field-malformed");
    await getBoardIssues(config, 1);
    await getBoardIssues(config, 1);
    expect(fieldCalls).toBe(2);
  });

  test("does not expose ADF textarea fields as plain strings", async () => {
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname !== "/rest/api/3/issue/PROJ-1/transitions") {
        throw new Error(`unexpected request: ${url}`);
      }
      return json({
        transitions: [
          {
            id: "1",
            name: "Done",
            to: { id: "2" },
            fields: {
              customfield_1: {
                name: "Root cause",
                required: true,
                schema: {
                  type: "string",
                  custom: "com.atlassian.jira.plugin.system.customfieldtypes:textarea",
                },
              },
            },
          },
        ],
      });
    }) as typeof fetch;

    const [transition] = await getTransitions(cfg("textarea"), "PROJ-1");
    expect(transition?.requiredFields).toEqual([
      {
        id: "customfield_1",
        name: "Root cause",
        required: true,
        hasDefaultValue: false,
        kind: "unsupported",
        schemaType: "string",
      },
    ]);
  });

  test("paginates create fields by fieldId and keeps rich text and datetime unsupported", async () => {
    const starts: number[] = [];
    globalThis.fetch = (async (input) => {
      const url = new URL(String(input));
      if (url.pathname !== "/rest/api/3/issue/createmeta/A%2FB/issuetypes/10") {
        throw new Error(`unexpected request: ${url}`);
      }
      const start = Number(url.searchParams.get("startAt"));
      starts.push(start);
      const field =
        start === 0
          ? {
              fieldId: "description",
              name: "Description",
              required: true,
              schema: { type: "string", system: "description" },
            }
          : {
              fieldId: "customfield_2",
              name: "Launch time",
              required: true,
              schema: { type: "datetime" },
            };
      return json({
        startAt: start,
        maxResults: 1,
        total: 2,
        isLast: start === 1,
        fields: [field],
      });
    }) as typeof fetch;

    expect(await getCreateFields(cfg("create-fields"), "A/B", "10")).toEqual([
      {
        id: "description",
        name: "Description",
        required: true,
        hasDefaultValue: false,
        kind: "unsupported",
        schemaType: "richtext",
      },
      {
        id: "customfield_2",
        name: "Launch time",
        required: true,
        hasDefaultValue: false,
        kind: "unsupported",
        schemaType: "datetime",
      },
    ]);
    expect(starts).toEqual([0, 1]);
  });

  test("creates by type id and prevents supplied fields from overriding core values", async () => {
    let body: any;
    globalThis.fetch = (async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname !== "/rest/api/3/issue" || init?.method !== "POST") {
        throw new Error(`unexpected request: ${init?.method ?? "GET"} ${url}`);
      }
      body = JSON.parse(String(init?.body));
      return json({ key: "PROJ-9" }, 201);
    }) as typeof fetch;

    expect(
      await createIssue(cfg("create-payload"), "PROJ", "10001", "Real summary", "Body", "PROJ-1", {
        summary: "wrong",
        project: "wrong",
        issuetype: "wrong",
        description: "wrong",
        parent: "wrong",
        customfield_1: 0,
      }),
    ).toEqual({ key: "PROJ-9" });
    expect(body.fields.project).toEqual({ key: "PROJ" });
    expect(body.fields.issuetype).toEqual({ id: "10001" });
    expect(body.fields.summary).toBe("Real summary");
    expect(body.fields.parent).toEqual({ key: "PROJ-1" });
    expect(body.fields.customfield_1).toBe(0);
    expect(body.fields.description).toEqual(expect.objectContaining({ type: "doc", version: 1 }));
  });
});
