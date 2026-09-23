import { afterEach, describe, expect, test } from "bun:test";

import type { JiraConfig } from "./config";
import {
  ISSUE_SEARCH_LIMIT,
  JQL_SEARCH_LIMIT,
  createIssue,
  createIssueLink,
  getAssignableUsers,
  getBoardConfig,
  getBoardIssues,
  getCreateFields,
  getIssueDetail,
  getIssueTypes,
  getTransitions,
  listBoards,
  searchByJql,
  searchIssues,
  transitionIssue,
  updateSummary,
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

function rawDetailIssue(key: string, issuelinks: unknown[] = []): Record<string, unknown> {
  return {
    id: key.replace(/\D/g, "") || "1",
    key,
    fields: {
      summary: `Issue ${key}`,
      description: "Synthetic description",
      status: { id: "1", name: "To Do", statusCategory: { key: "new" } },
      updated: "2026-01-02T00:00:00.000Z",
      created: "2026-01-01T00:00:00.000Z",
      issuetype: { id: "100", name: "Task", subtask: false },
      project: { key: key.split("-")[0] },
      labels: ["synthetic"],
      components: [],
      fixVersions: [],
      subtasks: [],
      issuelinks,
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
    const requested: string[][] = [];
    globalThis.fetch = (async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/rest/api/3/field") {
        return json([
          { id: "customfield_31", name: "Start date", schema: { type: "date" } },
          {
            id: "customfield_32",
            schema: { custom: "com.pyxis.greenhopper.jira:jsw-story-points" },
          },
        ]);
      }
      const start = Number(url.searchParams.get("startAt"));
      starts.push(start);
      requested.push((url.searchParams.get("fields") ?? "").split(","));
      const first = rawIssue(1) as any;
      first.fields.customfield_31 = "2026-01-01";
      first.fields.duedate = "2026-01-05";
      first.fields.customfield_32 = 1;
      const boundary = rawIssue(2) as any;
      boundary.fields.customfield_31 = start === 0 ? "2026-01-02" : "wrong-duplicate-value";
      boundary.fields.customfield_32 = 2;
      const later = rawIssue(3) as any;
      later.fields.customfield_31 = "raw-later-page-date";
      later.fields.duedate = "2026-01-07";
      later.fields.customfield_32 = 3;
      return json({
        startAt: start,
        maxResults: 2,
        total: 4,
        issues: start === 0 ? [first, boundary] : [boundary, later],
      });
    }) as typeof fetch;

    const issues = await getBoardIssues(cfg("board-issues"), 10);
    expect(starts).toEqual([0, 2]);
    expect(requested[1]).toEqual(expect.arrayContaining(["duedate", "customfield_31"]));
    expect(issues.map((issue) => issue.key)).toEqual(["PROJ-1", "PROJ-2", "PROJ-3"]);
    expect(issues.map((issue) => issue.statusName)).toEqual(["To Do", "To Do", "To Do"]);
    expect(issues.map((issue) => issue.storyPoints)).toEqual([1, 2, 3]);
    expect(issues.map((issue) => issue.startDate)).toEqual([
      "2026-01-01",
      "2026-01-02",
      "raw-later-page-date",
    ]);
    expect(issues[2]?.dueDate).toBe("2026-01-07");
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
    const requestedFields: string[][] = [];
    const fields = deferred<Response>();
    globalThis.fetch = (async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/rest/api/3/field") {
        fieldCalls++;
        return fields.promise;
      }
      if (url.pathname.endsWith("/issue")) {
        requestedFields.push((url.searchParams.get("fields") ?? "").split(","));
        const issue = rawIssue(1) as any;
        issue.fields.created = "2025-12-01T00:00:00.000Z";
        issue.fields.duedate = "2026-01-10";
        return json({ isLast: true, issues: [issue] });
      }
      throw new Error(`unexpected request: ${url}`);
    }) as typeof fetch;

    const config = cfg("field-concurrent");
    const requests = Promise.all([getBoardIssues(config, 1), getBoardIssues(config, 2)]);
    expect(fieldCalls).toBe(1);
    fields.resolve(json([]));
    const results = await requests;
    expect(results.map(([issue]) => issue?.dueDate)).toEqual(["2026-01-10", "2026-01-10"]);
    expect(results.every(([issue]) => issue?.updated === "2026-01-01T00:00:00.000Z")).toBe(true);
    expect(results.every(([issue]) => !issue?.startDate && !issue?.startDateState)).toBe(true);
    expect(requestedFields.every((requested) => !requested.includes("created"))).toBe(true);
  });

  test("shares fallback across a concurrent failure and retries later", async () => {
    let fieldCalls = 0;
    const requestedFields: string[][] = [];
    globalThis.fetch = (async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/rest/api/3/field") {
        fieldCalls++;
        return fieldCalls === 1
          ? new Response("temporary", { status: 503 })
          : json([
              { id: "customfield_902", name: "Start date", schema: { type: "date" } },
              {
                id: "customfield_903",
                schema: { custom: "com.pyxis.greenhopper.jira:gh-epic-link" },
              },
              {
                id: "customfield_904",
                schema: { custom: "com.pyxis.greenhopper.jira:gh-sprint" },
              },
              {
                id: "customfield_905",
                schema: { custom: "com.pyxis.greenhopper.jira:jsw-story-points" },
              },
            ]);
      }
      if (url.pathname.endsWith("/issue")) {
        const requested = (url.searchParams.get("fields") ?? "").split(",");
        requestedFields.push(requested);
        const issue = rawIssue(1) as any;
        issue.fields.duedate = url.pathname.includes("/board/2/") ? false : "2026-02-10";
        if (requested.includes("customfield_902")) {
          issue.fields.customfield_902 = "2026-02-01";
          issue.fields.customfield_903 = "EPIC-NEW";
          issue.fields.customfield_904 = [{ state: "active", name: "Discovered sprint" }];
          issue.fields.customfield_905 = 13;
        } else {
          issue.fields.customfield_10014 = "EPIC-FALLBACK";
          issue.fields.customfield_10020 = [{ state: "active", name: "Fallback sprint" }];
          issue.fields.customfield_10016 = 8;
        }
        return json({
          isLast: true,
          issues: [issue],
        });
      }
      throw new Error(`unexpected request: ${url}`);
    }) as typeof fetch;

    const config = cfg("field-retry");
    const concurrent = await Promise.all([getBoardIssues(config, 1), getBoardIssues(config, 2)]);
    expect(fieldCalls).toBe(1);
    for (const [issue] of concurrent) {
      expect(issue).toMatchObject({
        statusName: "To Do",
        startDateState: "unavailable",
        epicKey: "EPIC-FALLBACK",
        sprintName: "Fallback sprint",
        storyPoints: 8,
      });
    }
    expect(concurrent[0]?.[0]).toMatchObject({ dueDate: "2026-02-10" });
    expect(concurrent[1]?.[0]).toMatchObject({ dueDateState: "invalid" });
    expect(concurrent[1]?.[0]).not.toHaveProperty("dueDate");
    expect(
      requestedFields
        .slice(0, 2)
        .every(
          (requested) =>
            requested.includes("customfield_10014") &&
            requested.includes("customfield_10020") &&
            requested.includes("customfield_10016") &&
            requested.includes("duedate") &&
            !requested.includes("customfield_902"),
        ),
    ).toBe(true);
    const [retried] = await getBoardIssues(config, 1);
    expect(fieldCalls).toBe(2);
    expect(requestedFields[2]).toEqual(
      expect.arrayContaining([
        "customfield_902",
        "customfield_903",
        "customfield_904",
        "customfield_905",
      ]),
    );
    expect(retried).toMatchObject({
      statusName: "To Do",
      startDate: "2026-02-01",
      dueDate: "2026-02-10",
      epicKey: "EPIC-NEW",
      sprintName: "Discovered sprint",
      storyPoints: 13,
    });
    expect("startDateState" in retried!).toBe(false);
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

  test("isolates discovered start fields by credential and server", async () => {
    const fieldCalls: string[] = [];
    const requested = new Map<string, string[]>();
    const candidates: Record<string, { id: string; date: string }> = {
      "same.example.test\0Basic alice": { id: "customfield_801", date: "2026-08-01" },
      "same.example.test\0Basic bob": { id: "customfield_802", date: "2026-08-02" },
      "other.example.test\0Basic alice": { id: "customfield_803", date: "2026-08-03" },
    };
    globalThis.fetch = (async (input, init) => {
      const url = new URL(String(input));
      const auth = new Headers(init?.headers).get("Authorization") ?? "";
      const identity = `${url.host}\0${auth}`;
      const candidate = candidates[identity];
      if (!candidate) throw new Error(`unexpected identity: ${identity}`);
      if (url.pathname === "/rest/api/3/field") {
        fieldCalls.push(identity);
        return json([{ id: candidate.id, name: "Start date", schema: { type: "date" } }]);
      }
      if (url.pathname.endsWith("/issue")) {
        const fields = (url.searchParams.get("fields") ?? "").split(",");
        requested.set(identity, fields);
        const issue = rawIssue(1) as any;
        issue.fields[candidate.id] = candidate.date;
        return json({ isLast: true, issues: [issue] });
      }
      throw new Error(`unexpected request: ${url}`);
    }) as typeof fetch;

    const alice = { server: "https://same.example.test", authHeader: "Basic alice" };
    const bob = { server: "https://same.example.test", authHeader: "Basic bob" };
    const other = { server: "https://other.example.test", authHeader: "Basic alice" };
    const results = await Promise.all([
      getBoardIssues(alice, 1),
      getBoardIssues(bob, 1),
      getBoardIssues(other, 1),
    ]);

    expect(fieldCalls.toSorted()).toEqual(Object.keys(candidates).toSorted());
    expect(results.map(([issue]) => issue?.startDate)).toEqual([
      "2026-08-01",
      "2026-08-02",
      "2026-08-03",
    ]);
    for (const [identity, candidate] of Object.entries(candidates)) {
      expect(requested.get(identity)).toContain(candidate.id);
      expect(
        Object.values(candidates)
          .filter((otherCandidate) => otherCandidate.id !== candidate.id)
          .every((otherCandidate) => !requested.get(identity)?.includes(otherCandidate.id)),
      ).toBe(true);
    }
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

describe("Jira timeline dates", () => {
  test("requests only exact date candidates and preserves raw board date strings", async () => {
    let requestedFields: string[] = [];
    globalThis.fetch = (async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/rest/api/3/field") {
        return json([
          {
            id: "customfield_501",
            name: "  START DATE ",
            schema: {
              type: "date",
              custom: "com.atlassian.jira.plugin.system.customfieldtypes:datepicker",
            },
          },
          {
            id: "customfield_11708",
            name: "Start date (DO NOT USE)",
            schema: {
              type: "date",
              custom: "com.atlassian.jira.plugin.system.customfieldtypes:datepicker",
            },
          },
          {
            id: "customfield_11073",
            name: "Legacy Start date",
            schema: {
              type: "date",
              custom: "com.atlassian.jira.plugin.system.customfieldtypes:datepicker",
            },
          },
          {
            id: "customfield_502",
            name: "Target start/end date",
            schema: {
              type: "date",
              custom: "com.atlassian.jira.plugin.system.customfieldtypes:datepicker",
            },
          },
          {
            id: "customfield_503",
            name: "Start date",
            schema: {
              type: "string",
              custom: "com.atlassian.jira.plugin.system.customfieldtypes:datepicker",
            },
          },
        ]);
      }
      if (url.pathname === "/rest/agile/1.0/board/1/issue") {
        requestedFields = (url.searchParams.get("fields") ?? "").split(",");
        const item = rawIssue(1) as any;
        item.fields.customfield_501 = "not-a-calendar-date";
        item.fields.customfield_11708 = "2026-07-01";
        item.fields.customfield_11073 = "2026-07-02";
        item.fields.customfield_502 = "2026-07-03";
        item.fields.customfield_503 = "2026-07-04";
        item.fields.duedate = "2026-14-40";
        return json({ isLast: true, issues: [item] });
      }
      throw new Error(`unexpected request: ${url}`);
    }) as typeof fetch;

    const [issue] = await getBoardIssues(cfg("timeline-fields"), 1);
    expect(requestedFields).toContain("duedate");
    expect(requestedFields).toContain("customfield_501");
    expect(requestedFields).not.toContain("customfield_11708");
    expect(requestedFields).not.toContain("customfield_11073");
    expect(requestedFields).not.toContain("customfield_502");
    expect(requestedFields).not.toContain("customfield_503");
    expect(issue).toMatchObject({
      startDate: "not-a-calendar-date",
      dueDate: "2026-14-40",
    });
  });

  test("maps agreed, conflicting, absent, and wrong-type date endpoints", async () => {
    let requestedFields: string[] = [];
    globalThis.fetch = (async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/rest/api/3/field") {
        return json([
          { id: "customfield_601", name: "Start date", schema: { type: "date" } },
          { id: "customfield_602", name: "start DATE", schema: { type: "date" } },
          { id: "customfield_603", name: " Start date ", schema: { type: "date" } },
        ]);
      }
      if (url.pathname.endsWith("/issue")) {
        requestedFields = (url.searchParams.get("fields") ?? "").split(",");
        const agreed = rawIssue(1) as any;
        agreed.fields.customfield_601 = "2026-04-01";
        agreed.fields.customfield_602 = "2026-04-01";
        const conflicting = rawIssue(2) as any;
        conflicting.fields.customfield_601 = "2026-04-01";
        conflicting.fields.customfield_602 = "2026-04-02";
        const empty = rawIssue(3) as any;
        empty.fields.customfield_601 = "";
        empty.fields.customfield_602 = null;
        empty.fields.customfield_603 = "   ";
        empty.fields.duedate = null;
        const wrongTypes = [
          ["zero", 0],
          ["false", false],
          ["object", { value: "2026-04-03" }],
          ["array", []],
        ] as const;
        const invalidStarts = wrongTypes.map(([name, value], index) => {
          const issue = rawIssue(10 + index) as any;
          issue.fields.customfield_601 = `first-${name}-start`;
          issue.fields.customfield_602 = value;
          if (name === "object") issue.fields.customfield_603 = "conflicting-object-start";
          issue.fields.duedate = `raw-due-${name}`;
          return issue;
        });
        const invalidDues = wrongTypes.map(([name, value], index) => {
          const issue = rawIssue(20 + index) as any;
          issue.fields.customfield_601 = `raw-start-${name}`;
          issue.fields.duedate = value;
          return issue;
        });
        return json({
          isLast: true,
          issues: [agreed, conflicting, empty, ...invalidStarts, ...invalidDues],
        });
      }
      throw new Error(`unexpected request: ${url}`);
    }) as typeof fetch;

    const issues = await getBoardIssues(cfg("timeline-duplicates"), 1);
    expect(requestedFields).toEqual(
      expect.arrayContaining(["customfield_601", "customfield_602", "customfield_603"]),
    );
    expect(issues[0]).toMatchObject({ startDate: "2026-04-01" });
    expect(issues[1]).toMatchObject({ startDateState: "ambiguous" });
    expect(issues[1]).not.toHaveProperty("startDate");
    expect(issues[2]).not.toHaveProperty("dueDate");
    expect(issues[2]).not.toHaveProperty("startDate");
    expect(issues[2]).not.toHaveProperty("startDateState");
    expect(issues[2]).not.toHaveProperty("dueDateState");
    expect(issues.slice(3, 7)).toMatchObject([
      { startDateState: "invalid", dueDate: "raw-due-zero" },
      { startDateState: "invalid", dueDate: "raw-due-false" },
      { startDateState: "invalid", dueDate: "raw-due-object" },
      { startDateState: "invalid", dueDate: "raw-due-array" },
    ]);
    for (const issue of issues.slice(3, 7)) expect(issue).not.toHaveProperty("startDate");
    expect(issues.slice(7, 11)).toMatchObject([
      { startDate: "raw-start-zero", dueDateState: "invalid" },
      { startDate: "raw-start-false", dueDateState: "invalid" },
      { startDate: "raw-start-object", dueDateState: "invalid" },
      { startDate: "raw-start-array", dueDateState: "invalid" },
    ]);
    for (const issue of issues.slice(7, 11)) expect(issue).not.toHaveProperty("dueDate");
  });

  test("uses one discovery result and the same date boundaries for board and detail", async () => {
    let fieldCalls = 0;
    const detailFields: string[] = [];
    globalThis.fetch = (async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/rest/api/3/field") {
        fieldCalls++;
        return json([
          { id: "customfield_701", name: "Start date", schema: { type: "date" } },
          { id: "customfield_702", name: "START DATE", schema: { type: "date" } },
        ]);
      }
      if (url.pathname === "/rest/agile/1.0/board/1/issue") {
        const valid = rawIssue(1) as any;
        valid.fields.customfield_701 = "raw-start-value";
        valid.fields.customfield_702 = "raw-start-value";
        valid.fields.duedate = "raw-due-value";
        const ambiguous = rawIssue(2) as any;
        ambiguous.fields.customfield_701 = "2026-05-01";
        ambiguous.fields.customfield_702 = "2026-05-02";
        ambiguous.fields.duedate = "not-a-calendar-date";
        const invalid = rawIssue(3) as any;
        invalid.fields.customfield_701 = { value: "2026-05-03" };
        invalid.fields.customfield_702 = null;
        invalid.fields.duedate = 17;
        return json({ isLast: true, issues: [valid, ambiguous, invalid] });
      }
      const issueMatch = url.pathname.match(/^\/rest\/api\/3\/issue\/(PROJ-[123])$/);
      if (issueMatch) {
        const key = issueMatch[1]!;
        detailFields.push(url.searchParams.get("fields") ?? "");
        const item = rawDetailIssue(key) as any;
        if (key === "PROJ-1") {
          item.fields.customfield_701 = "raw-start-value";
          item.fields.customfield_702 = "raw-start-value";
          item.fields.duedate = "raw-due-value";
        } else if (key === "PROJ-2") {
          item.fields.customfield_701 = "2026-05-01";
          item.fields.customfield_702 = "2026-05-02";
          item.fields.duedate = "not-a-calendar-date";
        } else {
          item.fields.customfield_701 = { value: "2026-05-03" };
          item.fields.customfield_702 = null;
          item.fields.duedate = 17;
        }
        return json(item);
      }
      if (url.pathname.endsWith("/comment")) return json({ comments: [] });
      if (url.pathname.endsWith("/editmeta")) return json({ fields: {} });
      throw new Error(`unexpected request: ${url}`);
    }) as typeof fetch;

    const config = cfg("timeline-parity");
    const boardIssues = await getBoardIssues(config, 1);
    const detail = await getIssueDetail(config, "PROJ-1");
    const ambiguous = await getIssueDetail(config, "PROJ-2");
    const invalid = await getIssueDetail(config, "PROJ-3");
    expect(boardIssues[0]).toMatchObject({
      startDate: "raw-start-value",
      dueDate: "raw-due-value",
    });
    expect(boardIssues[1]).toMatchObject({
      dueDate: "not-a-calendar-date",
      startDateState: "ambiguous",
    });
    expect(boardIssues[1]).not.toHaveProperty("startDate");
    expect(boardIssues[2]).toMatchObject({
      startDateState: "invalid",
      dueDateState: "invalid",
    });
    expect(boardIssues[2]).not.toHaveProperty("startDate");
    expect(boardIssues[2]).not.toHaveProperty("dueDate");
    expect(detail).toMatchObject({ startDate: "raw-start-value", dueDate: "raw-due-value" });
    expect(ambiguous).toMatchObject({
      dueDate: "not-a-calendar-date",
      startDateState: "ambiguous",
    });
    expect(ambiguous).not.toHaveProperty("startDate");
    expect(invalid).toMatchObject({ startDateState: "invalid", dueDateState: "invalid" });
    expect(invalid).not.toHaveProperty("startDate");
    expect(invalid).not.toHaveProperty("dueDate");
    expect(detailFields).toEqual([
      "*all,-attachment,-comment,-worklog",
      "*all,-attachment,-comment,-worklog",
      "*all,-attachment,-comment,-worklog",
    ]);
    expect(fieldCalls).toBe(1);
  });
});

describe("Jira issue details", () => {
  test("keeps issue fields and comments when edit metadata fails", async () => {
    globalThis.fetch = (async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/rest/api/3/field") return json([]);
      if (url.pathname === "/rest/api/3/issue/PROJ-1") {
        return json(rawDetailIssue("PROJ-1"));
      }
      if (url.pathname.endsWith("/comment")) {
        return json({
          comments: [
            {
              id: "7",
              author: { accountId: "synthetic-user", displayName: "Synthetic User" },
              body: "Synthetic comment",
              created: "2026-01-03T00:00:00.000Z",
            },
          ],
        });
      }
      if (url.pathname.endsWith("/editmeta")) {
        return json({ errorMessages: ["Metadata permission denied"] }, 403);
      }
      throw new Error(`unexpected request: ${url}`);
    }) as typeof fetch;

    const detail = await getIssueDetail(cfg("detail-editmeta-failure"), "PROJ-1");
    expect(detail.summary).toBe("Issue PROJ-1");
    expect(detail.labels).toEqual(["synthetic"]);
    expect(detail.comments).toEqual([
      {
        id: "7",
        author: "Synthetic User",
        authorAccountId: "synthetic-user",
        body: "Synthetic comment",
        created: "2026-01-03T00:00:00.000Z",
      },
    ]);
    expect(detail.customFields).toEqual([]);
    expect(detail.editmeta.size).toBe(0);
    expect(detail.editmetaError).toBe(
      "Load edit metadata failed (403): Metadata permission denied",
    );
  });

  test("does not set editmetaError for successful empty metadata", async () => {
    globalThis.fetch = (async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/rest/api/3/field") return json([]);
      if (url.pathname === "/rest/api/3/issue/PROJ-2") {
        return json(rawDetailIssue("PROJ-2"));
      }
      if (url.pathname.endsWith("/comment")) return json({ comments: [] });
      if (url.pathname.endsWith("/editmeta")) return json({ fields: {} });
      throw new Error(`unexpected request: ${url}`);
    }) as typeof fetch;

    const detail = await getIssueDetail(cfg("detail-empty-editmeta"), "PROJ-2");
    expect(detail.editmeta.size).toBe(0);
    expect("editmetaError" in detail).toBe(false);
  });

  test("sets useful editmetaError context when metadata rejects with an empty message", async () => {
    globalThis.fetch = (async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/rest/api/3/field") return json([]);
      if (url.pathname === "/rest/api/3/issue/PROJ-3") {
        return json(rawDetailIssue("PROJ-3"));
      }
      if (url.pathname.endsWith("/comment")) return json({ comments: [] });
      if (url.pathname.endsWith("/editmeta")) throw new Error("");
      throw new Error(`unexpected request: ${url}`);
    }) as typeof fetch;

    const detail = await getIssueDetail(cfg("detail-empty-editmeta-error"), "PROJ-3");
    expect(detail.summary).toBe("Issue PROJ-3");
    expect(detail.editmetaError).toBe(
      "Load edit metadata failed: Jira request failed before a response was received",
    );
  });
});

describe("Jira issue link directions", () => {
  test("round-trips outward and inward labels from both linked issues", async () => {
    type LinkBody = {
      type: { name: string };
      outwardIssue: { key: string };
      inwardIssue: { key: string };
    };
    const links: LinkBody[] = [];
    globalThis.fetch = (async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === "/rest/api/3/issueLink" && init?.method === "POST") {
        links.push(JSON.parse(String(init.body)) as LinkBody);
        return new Response(null, { status: 201 });
      }
      if (url.pathname === "/rest/api/3/field") return json([]);
      const issueMatch = url.pathname.match(/^\/rest\/api\/3\/issue\/([^/]+)$/);
      if (issueMatch) {
        const key = issueMatch[1]!;
        const issueLinks: Record<string, unknown>[] = [];
        for (const link of links) {
          const type = {
            name: link.type.name,
            outward: "blocks",
            inward: "is blocked by",
          };
          if (key === link.inwardIssue.key) {
            issueLinks.push({
              type,
              outwardIssue: {
                key: link.outwardIssue.key,
                fields: {
                  summary: "Linked issue",
                  status: { name: "To Do" },
                  issuetype: { name: "Task" },
                },
              },
            });
          } else if (key === link.outwardIssue.key) {
            issueLinks.push({
              type,
              inwardIssue: {
                key: link.inwardIssue.key,
                fields: {
                  summary: "Linked issue",
                  status: { name: "To Do" },
                  issuetype: { name: "Task" },
                },
              },
            });
          }
        }
        return json(rawDetailIssue(key, issueLinks));
      }
      if (url.pathname.endsWith("/comment")) return json({ comments: [] });
      if (url.pathname.endsWith("/editmeta")) return json({ fields: {} });
      throw new Error(`unexpected request: ${init?.method ?? "GET"} ${url}`);
    }) as typeof fetch;

    const config = cfg("link-directions");
    await createIssueLink(config, "Blocks", "NEW-1", "TARGET-2", "outward");
    await createIssueLink(config, "Blocks", "NEW-3", "TARGET-4", "inward");

    expect(links).toEqual([
      {
        type: { name: "Blocks" },
        outwardIssue: { key: "TARGET-2" },
        inwardIssue: { key: "NEW-1" },
      },
      {
        type: { name: "Blocks" },
        outwardIssue: { key: "NEW-3" },
        inwardIssue: { key: "TARGET-4" },
      },
    ]);
    expect((await getIssueDetail(config, "NEW-1")).links).toEqual([
      expect.objectContaining({ key: "TARGET-2", direction: "blocks" }),
    ]);
    expect((await getIssueDetail(config, "TARGET-2")).links).toEqual([
      expect.objectContaining({ key: "NEW-1", direction: "is blocked by" }),
    ]);
    expect((await getIssueDetail(config, "NEW-3")).links).toEqual([
      expect.objectContaining({ key: "TARGET-4", direction: "is blocked by" }),
    ]);
    expect((await getIssueDetail(config, "TARGET-4")).links).toEqual([
      expect.objectContaining({ key: "NEW-3", direction: "blocks" }),
    ]);
  });
});

describe("Jira API errors", () => {
  test("reports structured validation and permission reasons without URLs or raw JSON", async () => {
    let response = json(
      {
        errorMessages: ["Validation failed at https://jira.example.test/secure/path"],
        errors: {
          summary: "  Summary is required  ",
          assignee: "User cannot be assigned",
          estimate: "Value must be < 10 and > 0",
        },
      },
      400,
    );
    globalThis.fetch = (async () => response) as unknown as typeof fetch;

    await expect(updateSummary(cfg("error-validation"), "PROJ-1", "Bad")).rejects.toThrow(
      "Save title failed (400): Validation failed at [URL omitted]; summary: Summary is required; assignee: User cannot be assigned; estimate: Value must be < 10 and > 0",
    );

    response = json({ message: "You do not have permission to browse this project" }, 403);
    await expect(listBoards(cfg("error-permission"))).rejects.toThrow(
      "Load boards failed (403): You do not have permission to browse this project",
    );
  });

  test("normalizes HTML and text and handles empty or malformed error bodies", async () => {
    const responses = [
      new Response("<html><body><h1>Gateway error</h1> Try &amp; retry.</body></html>", {
        status: 502,
      }),
      new Response("  Link service   unavailable\nplease retry  ", { status: 503 }),
      new Response(JSON.stringify("Issue link type is not available"), { status: 400 }),
      new Response("", { status: 504, statusText: "Gateway Timeout" }),
      new Response('{"errorMessages":[broken', {
        status: 500,
        statusText: "Internal Server Error",
      }),
    ];
    globalThis.fetch = (async () => responses.shift()!) as unknown as typeof fetch;

    await expect(transitionIssue(cfg("error-html"), "PROJ-1", "2")).rejects.toThrow(
      "Save transition failed (502): Gateway error Try & retry.",
    );
    await expect(
      createIssueLink(cfg("error-text"), "Blocks", "PROJ-1", "PROJ-2", "outward"),
    ).rejects.toThrow("Create issue link failed (503): Link service unavailable please retry");
    await expect(
      createIssueLink(cfg("error-json-string"), "Blocks", "PROJ-1", "PROJ-2", "outward"),
    ).rejects.toThrow("Create issue link failed (400): Issue link type is not available");
    await expect(searchByJql(cfg("error-empty"), "project = PROJ")).rejects.toThrow(
      "Search issues failed (504): Gateway Timeout",
    );
    await expect(getIssueTypes(cfg("error-malformed"), "PROJ")).rejects.toThrow(
      "Load issue types failed (500): Internal Server Error",
    );
  });

  test("retains every structured field reason when validation guidance exceeds 300 characters", async () => {
    const errors = {
      summary:
        "Enter a clear summary that identifies the affected workflow, observed result, expected result, and user impact.",
      description:
        "Describe the reproduction steps, relevant conditions, prior troubleshooting, and the exact result shown to the user.",
      environment:
        "List the operating system, terminal, project configuration, issue type, and workflow state used for this request.",
      finalField:
        "Keep this final validation reason because it tells the user to select an approved release before saving.",
    };
    globalThis.fetch = (async () => json({ errors }, 400)) as unknown as typeof fetch;

    let message = "";
    try {
      await updateSummary(cfg("long-validation"), "PROJ-1", "Invalid");
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message.length).toBeGreaterThan(300);
    expect(message).toContain(`finalField: ${errors.finalField}`);
  });

  test("keeps operation and status when the error response body cannot be read", async () => {
    globalThis.fetch = (async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.error(new Error("synthetic stream failure"));
          },
        }),
        { status: 503, statusText: "Service Unavailable" },
      )) as unknown as typeof fetch;

    await expect(listBoards(cfg("error-stream"))).rejects.toThrow(
      "Load boards failed (503): Jira returned an unreadable error response; retry the operation",
    );
  });
});

describe("Jira search defaults", () => {
  test("exports and sends the distinct issue and JQL search limits", async () => {
    const maxResults: number[] = [];
    globalThis.fetch = (async (_input, init) => {
      maxResults.push(JSON.parse(String(init?.body)).maxResults);
      return json({ isLast: true, issues: [] });
    }) as typeof fetch;

    expect(ISSUE_SEARCH_LIMIT).toBe(25);
    expect(JQL_SEARCH_LIMIT).toBe(50);
    await searchIssues(cfg("issue-search-limit"), "synthetic");
    await searchByJql(cfg("jql-search-limit"), "project = PROJ");
    expect(maxResults).toEqual([25, 50]);
  });
});
