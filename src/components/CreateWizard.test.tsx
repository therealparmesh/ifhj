import { afterEach, expect, spyOn, test } from "bun:test";
import { PassThrough } from "node:stream";

import { render } from "ink";

import * as editor from "../editor";
import type { IssueSearchResult, IssueType } from "../jira";
import { createTerminal, deferred, nextTurn, sendInput, waitFor } from "../test/utils";
import { CreateWizard } from "./CreateWizard";

type RenderResult = ReturnType<typeof render>;

const originalFetch = globalThis.fetch;
const apps: RenderResult[] = [];
const inputApps = new WeakMap<PassThrough, RenderResult>();
const inputReady = new WeakMap<PassThrough, Promise<void>>();
let restoreEditor: (() => void) | null = null;

afterEach(() => {
  restoreEditor?.();
  restoreEditor = null;
  globalThis.fetch = originalFetch;
  for (const app of apps.splice(0)) app.unmount();
});

async function send(stdin: PassThrough, input: string) {
  const app = inputApps.get(stdin);
  if (!app) throw new Error("input is not attached to a rendered wizard");
  await inputReady.get(stdin);
  await sendInput(app, stdin, input);
}

const cfg = { server: "https://create-wizard.invalid", authHeader: "Basic test" };
const types = [{ id: "1", name: "Task", subtask: false }];
const linkTypes = [{ id: "10", name: "Blocks", outward: "blocks", inward: "is blocked by" }];

function mount(
  callbacks: {
    onCancel?: () => void;
    onDone?: (result: {
      key: string;
      title: string;
      linkSummary?: string;
      warning?: string;
    }) => void;
    onError?: (s: string) => void;
  },
  options: { initialType?: IssueType; defaultParent?: IssueSearchResult } = {},
) {
  const { stdin, stdout, output, clearOutput } = createTerminal();
  let markReady!: () => void;
  const ready = new Promise<void>((resolve) => {
    markReady = resolve;
  });
  const app = render(
    <CreateWizard
      cfg={cfg}
      projectKey="PROJ"
      types={types}
      linkTypes={linkTypes}
      initialType={options.initialType}
      defaultParent={options.defaultParent}
      onCancel={callbacks.onCancel ?? (() => {})}
      onDone={callbacks.onDone ?? (() => {})}
      onError={callbacks.onError ?? (() => {})}
    />,
    {
      interactive: true,
      stdin: stdin as unknown as typeof process.stdin,
      stdout: stdout as unknown as typeof process.stdout,
      stderr: new PassThrough() as unknown as typeof process.stderr,
      exitOnCtrlC: false,
      patchConsole: false,
      onRender: markReady,
    },
  );
  apps.push(app);
  inputApps.set(stdin, app);
  inputReady.set(stdin, ready);
  return { stdin, output, clearOutput };
}

async function openTargetPicker(stdin: PassThrough) {
  await send(stdin, "\u001b[B");
  await send(stdin, "\u001b[B");
  await send(stdin, "\u001b[B");
  await send(stdin, "\r");
  await send(stdin, "\u001b[B");
  await send(stdin, "\u001b[B");
  await send(stdin, "\r");
  await send(stdin, "\u001b[B");
  await send(stdin, "\r");
}

test("a reopened target picker cannot submit results from its previous session", async () => {
  let resolveReopened!: (response: Response) => void;
  const reopened = new Promise<Response>((resolve) => {
    resolveReopened = resolve;
  });
  let searches = 0;
  globalThis.fetch = (async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/rest/api/3/search/jql") {
      searches++;
      if (searches > 1) return reopened;
      return new Response(
        JSON.stringify({
          isLast: true,
          issues: [
            { key: "PROJ-OLD", fields: { summary: "old target", issuetype: { name: "Task" } } },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    throw new Error(`unexpected request: ${url}`);
  }) as typeof fetch;
  let cancelled = 0;
  const { stdin, output } = mount({ onCancel: () => cancelled++ });

  await openTargetPicker(stdin);
  await waitFor(() => output().includes("PROJ-OLD"), "initial target results");
  await send(stdin, "\u001b");

  await send(stdin, "\r");
  await send(stdin, "\r");
  await send(stdin, "\u001b");
  expect(cancelled).toBe(0);

  resolveReopened(Response.json({ isLast: true, issues: [] }));

  await send(stdin, "\u001b");
  await waitFor(() => cancelled > 0, "wizard close after reopened target");
  expect(cancelled).toBe(1);
});

test("a new target query immediately makes old results unselectable", async () => {
  let resolveNew!: (response: Response) => void;
  const newResults = new Promise<Response>((resolve) => {
    resolveNew = resolve;
  });
  let searches = 0;
  globalThis.fetch = (async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/rest/api/3/search/jql") {
      searches++;
      if (searches > 1) return newResults;
      return Response.json({
        isLast: true,
        issues: [
          { key: "PROJ-OLD", fields: { summary: "old target", issuetype: { name: "Task" } } },
        ],
      });
    }
    throw new Error(`unexpected request: ${url}`);
  }) as typeof fetch;
  let cancelled = 0;
  const { stdin, output } = mount({ onCancel: () => cancelled++ });

  await openTargetPicker(stdin);
  await waitFor(() => output().includes("PROJ-OLD"), "old target results");
  await send(stdin, "new");
  await waitFor(() => searches === 2, "replacement target request");
  await send(stdin, "\r");
  await send(stdin, "\u001b");
  expect(cancelled).toBe(0);

  resolveNew(
    Response.json({
      isLast: true,
      issues: [{ key: "PROJ-NEW", fields: { summary: "new target", issuetype: { name: "Task" } } }],
    }),
  );
});

test("target search shows failure and retries the current query with Enter", async () => {
  let searches = 0;
  globalThis.fetch = (async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/rest/api/3/search/jql") {
      searches++;
      if (searches === 1) return new Response("temporary target failure", { status: 503 });
      return Response.json({
        isLast: true,
        issues: [
          { key: "PROJ-2", fields: { summary: "recovered target", issuetype: { name: "Task" } } },
        ],
      });
    }
    throw new Error(`unexpected request: ${url}`);
  }) as typeof fetch;
  const { stdin, output } = mount({});

  await openTargetPicker(stdin);
  await waitFor(() => output().includes("Could not search Jira"), "target search error");
  expect(output()).not.toContain("No matches");
  await send(stdin, "\r");
  await waitFor(() => searches === 2, "target retry");
  await waitFor(() => output().includes("recovered target"), "retried target result");
});

test("completes creation with a warning when the later relationship request fails", async () => {
  const editorMock = spyOn(editor, "editInNeovim").mockResolvedValue("Created title\n");
  restoreEditor = () => editorMock.mockRestore();
  const reason = `${"Relationship validation detail. ".repeat(12)}FINAL_LINK_REASON`;
  const relationship = deferred<Response>();
  let creates = 0;
  let links = 0;
  globalThis.fetch = (async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/rest/api/3/search/jql") {
      return new Response(
        JSON.stringify({
          isLast: true,
          issues: [{ key: "PROJ-2", fields: { summary: "target", issuetype: { name: "Task" } } }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (url.pathname.includes("/createmeta/PROJ/issuetypes/1")) {
      return new Response(
        JSON.stringify({
          isLast: true,
          fields: [
            { fieldId: "summary", name: "Summary", required: true, schema: { type: "string" } },
            { fieldId: "parent", name: "Parent", required: false, schema: { type: "issuelink" } },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (url.pathname === "/rest/api/3/issue") {
      creates++;
      return new Response(JSON.stringify({ key: "PROJ-9" }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url.pathname === "/rest/api/3/issueLink") {
      links++;
      return relationship.promise;
    }
    throw new Error(`unexpected request: ${url}`);
  }) as typeof fetch;
  const errors: string[] = [];
  const completed: unknown[] = [];
  const { stdin, output } = mount({
    onDone: (result) => completed.push(result),
    onError: (message) => errors.push(message),
  });
  await send(stdin, "\r");
  await send(stdin, "\u001b[B");
  await send(stdin, "\u001b[B");
  await send(stdin, "\r");
  await send(stdin, "\r");
  await send(stdin, "\u001b[B");
  await send(stdin, "\r");
  await send(stdin, "\u001b[B");
  await send(stdin, "\u001b[B");
  await send(stdin, "\r");
  await send(stdin, "\u001b[B");
  await send(stdin, "\r");
  await waitFor(() => output().includes("PROJ-2"), "relationship target");
  await send(stdin, "\r");
  await send(stdin, "s");
  await waitFor(() => creates === 1 && links === 1, "pending relationship");
  await send(stdin, "s");
  await send(stdin, "\r");
  expect({ creates, links, completions: completed.length }).toEqual({
    creates: 1,
    links: 1,
    completions: 0,
  });
  relationship.resolve(new Response(reason, { status: 400 }));
  await waitFor(() => completed.length === 1, "relationship completion");
  await send(stdin, "s");
  await send(stdin, "\r");

  expect({ creates, links }).toEqual({ creates: 1, links: 1 });
  expect(completed).toHaveLength(1);
  expect(completed[0]).toEqual({
    key: "PROJ-9",
    title: "Created title",
    warning: `relationship failed: Create issue link failed (400): ${reason}`,
  });
  expect(errors).toEqual([]);
});

test("submits supported required create fields including numeric zero", async () => {
  const editorMock = spyOn(editor, "editInNeovim").mockResolvedValue("Required fields title\n");
  restoreEditor = () => editorMock.mockRestore();
  let createBody: any;
  globalThis.fetch = (async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.includes("/createmeta/PROJ/issuetypes/1")) {
      return Response.json({
        isLast: true,
        fields: [
          { fieldId: "summary", name: "Summary", required: true, schema: { type: "string" } },
          {
            fieldId: "customfield_7",
            name: "Estimate",
            required: true,
            schema: { type: "number" },
          },
        ],
      });
    }
    if (url.pathname === "/rest/api/3/issue") {
      createBody = JSON.parse(String(init?.body));
      return Response.json({ key: "PROJ-10" }, { status: 201 });
    }
    throw new Error(`unexpected request: ${url}`);
  }) as typeof fetch;
  const completed: unknown[] = [];
  const { stdin, output } = mount(
    { onDone: (result) => completed.push(result) },
    { initialType: types[0]! },
  );
  await send(stdin, "\r");
  await send(stdin, "s");
  await waitFor(() => output().includes("Estimate"), "required field screen");
  await send(stdin, "\r");
  await send(stdin, "0");
  await send(stdin, "\r");
  await send(stdin, "s");
  await waitFor(() => createBody !== undefined, "create request");

  expect(createBody.fields.customfield_7).toBe(0);
  expect(createBody.fields.issuetype).toEqual({ id: "1" });
  expect(completed).toEqual([{ key: "PROJ-10", title: "Required fields title" }]);
});

test("recovers from an editor error without discarding the form", async () => {
  const editorMock = spyOn(editor, "editInNeovim")
    .mockRejectedValueOnce(new Error("editor failed"))
    .mockResolvedValueOnce("Recovered title\n");
  restoreEditor = () => editorMock.mockRestore();
  const errors: string[] = [];
  const { stdin, output } = mount({ onError: (message) => errors.push(message) });

  await send(stdin, "\r");
  await waitFor(() => errors.length === 1, "editor failure");
  expect(errors).toEqual(["editor failed"]);
  await send(stdin, "\r");
  await waitFor(() => output().includes("Recovered title"), "recovered editor result");
  expect(editorMock).toHaveBeenCalledTimes(2);
  expect(output()).toContain("Recovered title");
});

test("clears title-required feedback only after a meaningful title correction", async () => {
  const unchanged = deferred<string>();
  const editorMock = spyOn(editor, "editInNeovim")
    .mockReturnValueOnce(unchanged.promise)
    .mockResolvedValueOnce("Correct title\n");
  restoreEditor = () => editorMock.mockRestore();
  globalThis.fetch = (async (input) => {
    const url = new URL(String(input));
    if (url.pathname.includes("/createmeta/PROJ/issuetypes/1")) {
      return Response.json({
        isLast: true,
        fields: [
          { fieldId: "summary", name: "Summary", required: true, schema: { type: "string" } },
        ],
      });
    }
    throw new Error(`unexpected request: ${url}`);
  }) as typeof fetch;
  const { stdin, output, clearOutput } = mount({}, { initialType: types[0]! });

  await send(stdin, "s");
  await waitFor(() => output().includes("Title is required."), "title validation");
  clearOutput();
  await send(stdin, "\u001b[B");
  await send(stdin, "\u001b[A");
  expect(output()).toContain("Title is required.");
  await send(stdin, "\r");
  await waitFor(() => editorMock.mock.calls.length === 1, "unchanged title edit");
  clearOutput();
  unchanged.resolve("");
  await waitFor(() => output().includes("Title is required."), "unchanged title form");
  expect(output()).toContain("Title is required.");
  clearOutput();
  await send(stdin, "\r");
  await waitFor(() => output().includes("Correct title"), "corrected title");
  expect(output()).not.toContain("Title is required.");
});

test("preserves entered fields and allows retry after a create API error", async () => {
  const editorMock = spyOn(editor, "editInNeovim").mockResolvedValue("Retry title\n");
  restoreEditor = () => editorMock.mockRestore();
  const summaries: string[] = [];
  let creates = 0;
  globalThis.fetch = (async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.includes("/createmeta/PROJ/issuetypes/1")) {
      return Response.json({
        isLast: true,
        fields: [
          { fieldId: "summary", name: "Summary", required: true, schema: { type: "string" } },
        ],
      });
    }
    if (url.pathname === "/rest/api/3/issue") {
      creates++;
      summaries.push(JSON.parse(String(init?.body)).fields.summary);
      return creates === 1
        ? new Response("temporary", { status: 503 })
        : Response.json({ key: "PROJ-13" }, { status: 201 });
    }
    throw new Error(`unexpected request: ${url}`);
  }) as typeof fetch;
  const errors: string[] = [];
  const completed: unknown[] = [];
  const { stdin } = mount(
    {
      onError: (message) => errors.push(message),
      onDone: (result) => completed.push(result),
    },
    { initialType: types[0]! },
  );
  await send(stdin, "\r");
  await send(stdin, "s");
  await waitFor(() => errors.length === 1, "first create error");
  await send(stdin, "s");
  await waitFor(() => completed.length === 1, "retried create");

  expect(summaries).toEqual(["Retry title", "Retry title"]);
  expect(completed).toEqual([{ key: "PROJ-13", title: "Retry title" }]);
});

test("reopens and corrects rejected required values without losing other fields", async () => {
  const editorMock = spyOn(editor, "editInNeovim").mockResolvedValue("Correct values title\n");
  restoreEditor = () => editorMock.mockRestore();
  const bodies: any[] = [];
  globalThis.fetch = (async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.includes("/createmeta/PROJ/issuetypes/1")) {
      return Response.json({
        isLast: true,
        fields: [
          { fieldId: "summary", name: "Summary", required: true, schema: { type: "string" } },
          { fieldId: "customfield_1", name: "First", required: true, schema: { type: "number" } },
          { fieldId: "customfield_2", name: "Second", required: true, schema: { type: "number" } },
        ],
      });
    }
    if (url.pathname === "/rest/api/3/issue") {
      bodies.push(JSON.parse(String(init?.body)));
      return bodies.length === 1
        ? new Response("First is invalid", { status: 400 })
        : Response.json({ key: "PROJ-14" }, { status: 201 });
    }
    throw new Error(`unexpected request: ${url}`);
  }) as typeof fetch;
  const errors: string[] = [];
  const completed: unknown[] = [];
  const { stdin, output, clearOutput } = mount(
    {
      onError: (message) => errors.push(message),
      onDone: (result) => completed.push(result),
    },
    { initialType: types[0]! },
  );
  await send(stdin, "\r");
  await send(stdin, "s");
  await send(stdin, "\r");
  await send(stdin, "1");
  await send(stdin, "\r");
  await send(stdin, "\u001b[B");
  await send(stdin, "\r");
  await send(stdin, "2");
  await send(stdin, "\r");
  await send(stdin, "s");
  await waitFor(() => errors.length === 1, "required value validation error");

  await send(stdin, "s");
  await send(stdin, "\r");
  await send(stdin, "\x15");
  await send(stdin, "3");
  await send(stdin, "\r");
  clearOutput();
  await send(stdin, "\u001b");
  await waitFor(() => output().includes("Create issue"), "corrected create form");
  expect(output()).not.toContain("First is invalid");
  await send(stdin, "s");
  await send(stdin, "s");
  await waitFor(() => completed.length === 1, "corrected create request");

  expect(bodies.map((body) => body.fields)).toEqual([
    expect.objectContaining({
      summary: "Correct values title",
      customfield_1: 1,
      customfield_2: 2,
    }),
    expect.objectContaining({
      summary: "Correct values title",
      customfield_1: 3,
      customfield_2: 2,
    }),
  ]);
});

test("blocks a required unsupported create field with browser guidance", async () => {
  const editorMock = spyOn(editor, "editInNeovim").mockResolvedValue("Unsupported title\n");
  restoreEditor = () => editorMock.mockRestore();
  let creates = 0;
  globalThis.fetch = (async (input) => {
    const url = new URL(String(input));
    if (url.pathname.includes("/createmeta/PROJ/issuetypes/1")) {
      return Response.json({
        isLast: true,
        fields: [
          { fieldId: "summary", name: "Summary", required: true, schema: { type: "string" } },
          {
            fieldId: "customfield_8",
            name: "Root cause",
            required: true,
            schema: {
              type: "string",
              custom: "com.atlassian.jira.plugin.system.customfieldtypes:textarea",
            },
          },
        ],
      });
    }
    if (url.pathname === "/rest/api/3/issue") creates++;
    throw new Error(`unexpected request: ${url}`);
  }) as typeof fetch;
  const { stdin, output } = mount({}, { initialType: types[0]! });

  await send(stdin, "\r");
  await send(stdin, "s");
  await waitFor(() => output().includes("complete in browser"), "browser guidance");
  await send(stdin, "s");
  expect(creates).toBe(0);
});

test("creates a locked subtask with its type id and same-project parent", async () => {
  const subtaskType = { id: "2", name: "Child", subtask: true };
  const editorMock = spyOn(editor, "editInNeovim").mockResolvedValue("Child title\n");
  restoreEditor = () => editorMock.mockRestore();
  let createBody: any;
  globalThis.fetch = (async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.includes("/createmeta/PROJ/issuetypes/2")) {
      return Response.json({
        isLast: true,
        fields: [
          { fieldId: "summary", name: "Summary", required: true, schema: { type: "string" } },
          { fieldId: "parent", name: "Parent", required: true, schema: { type: "issuelink" } },
        ],
      });
    }
    if (url.pathname === "/rest/api/3/issue") {
      createBody = JSON.parse(String(init?.body));
      return Response.json({ key: "PROJ-11" }, { status: 201 });
    }
    throw new Error(`unexpected request: ${url}`);
  }) as typeof fetch;
  const completed: unknown[] = [];
  const { stdin } = mount(
    { onDone: (result) => completed.push(result) },
    {
      initialType: { ...subtaskType, hierarchyLevel: -1 },
      defaultParent: {
        key: "PROJ-1",
        projectKey: "PROJ",
        summary: "Parent",
        issueType: "Feature",
        issueTypeId: "100",
        subtask: false,
        hierarchyLevel: 0,
      },
    },
  );
  await send(stdin, "\r");
  await send(stdin, "s");
  await waitFor(() => createBody !== undefined, "subtask create request");

  expect(createBody.fields.issuetype).toEqual({ id: "2" });
  expect(createBody.fields.parent).toEqual({ key: "PROJ-1" });
  expect(completed).toEqual([
    { key: "PROJ-11", title: "Child title", linkSummary: "is child of PROJ-1" },
  ]);
});

test("rejects a subtask target after changing an ordinary link to parent", async () => {
  const childType = { id: "1", name: "Work item", subtask: false, hierarchyLevel: 0 };
  const editorMock = spyOn(editor, "editInNeovim").mockResolvedValue("Parent validation\n");
  restoreEditor = () => editorMock.mockRestore();
  let creates = 0;
  globalThis.fetch = (async (input) => {
    const url = new URL(String(input));
    if (url.pathname.includes("/createmeta/PROJ/issuetypes/1")) {
      return Response.json({
        isLast: true,
        fields: [
          { fieldId: "summary", name: "Summary", required: true, schema: { type: "string" } },
          { fieldId: "parent", name: "Parent", required: false, schema: { type: "issuelink" } },
        ],
      });
    }
    if (url.pathname === "/rest/api/3/search/jql") {
      return Response.json({
        isLast: true,
        issues: [
          {
            key: "PROJ-2",
            fields: {
              project: { key: "PROJ" },
              summary: "Existing child",
              issuetype: {
                id: "2",
                name: "Child kind",
                subtask: true,
                hierarchyLevel: -1,
              },
            },
          },
        ],
      });
    }
    if (url.pathname === "/rest/api/3/issue") creates++;
    throw new Error(`unexpected request: ${url}`);
  }) as typeof fetch;
  const { stdin, output } = mount({}, { initialType: childType });
  await send(stdin, "\r");
  await send(stdin, "\u001b[B");
  await send(stdin, "\u001b[B");
  await send(stdin, "\u001b[B");
  await send(stdin, "\r");
  await send(stdin, "\u001b[B");
  await send(stdin, "\u001b[B");
  await send(stdin, "\r");
  await send(stdin, "\u001b[B");
  await send(stdin, "\r");
  await waitFor(() => output().includes("Existing child"), "subtask target result");
  await send(stdin, "\r");
  await send(stdin, "\u001b[A");
  await send(stdin, "\r");
  await send(stdin, "\u001b[A");
  await send(stdin, "\r");
  await send(stdin, "s");

  expect(creates).toBe(0);
  expect(output()).toContain("a subtask cannot be a parent");
});

test("rejects a locked parent from another project", async () => {
  const childType = { id: "2", name: "Child", subtask: true, hierarchyLevel: -1 };
  const editorMock = spyOn(editor, "editInNeovim").mockResolvedValue("Cross project child\n");
  restoreEditor = () => editorMock.mockRestore();
  let creates = 0;
  globalThis.fetch = (async (input) => {
    const url = new URL(String(input));
    if (url.pathname.includes("/createmeta/PROJ/issuetypes/2")) {
      return Response.json({
        isLast: true,
        fields: [
          { fieldId: "summary", name: "Summary", required: true, schema: { type: "string" } },
          { fieldId: "parent", name: "Parent", required: true, schema: { type: "issuelink" } },
        ],
      });
    }
    if (url.pathname === "/rest/api/3/issue") creates++;
    throw new Error(`unexpected request: ${url}`);
  }) as typeof fetch;
  const { stdin, output } = mount(
    {},
    {
      initialType: childType,
      defaultParent: {
        key: "OTHER-1",
        projectKey: "OTHER",
        summary: "Other parent",
        issueType: "Feature",
        issueTypeId: "10",
        subtask: false,
        hierarchyLevel: 0,
      },
    },
  );
  await send(stdin, "\r");
  await send(stdin, "s");

  expect(creates).toBe(0);
  expect(output()).toContain("parent must be in the same project");
});

test("requires create description metadata and sends it as rich text", async () => {
  const editorMock = spyOn(editor, "editInNeovim").mockImplementation(async (_initial, filename) =>
    filename.includes("title") ? "Rich title\n" : "Required body\n",
  );
  restoreEditor = () => editorMock.mockRestore();
  let creates = 0;
  let createBody: any;
  globalThis.fetch = (async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.includes("/createmeta/PROJ/issuetypes/1")) {
      return Response.json({
        isLast: true,
        fields: [
          { fieldId: "summary", name: "Summary", required: true, schema: { type: "string" } },
          {
            fieldId: "description",
            name: "Description",
            required: true,
            schema: { type: "string", system: "description" },
          },
        ],
      });
    }
    if (url.pathname === "/rest/api/3/issue") {
      creates++;
      createBody = JSON.parse(String(init?.body));
      return Response.json({ key: "PROJ-12" }, { status: 201 });
    }
    throw new Error(`unexpected request: ${url}`);
  }) as typeof fetch;
  const { stdin } = mount({}, { initialType: types[0]! });

  await send(stdin, "\r");
  await send(stdin, "s");
  await nextTurn();
  expect(creates).toBe(0);

  await send(stdin, "\u001b[B");
  await send(stdin, "\r");
  await send(stdin, "s");
  await waitFor(() => creates === 1, "description create request");
  expect(createBody.fields.description).toEqual(
    expect.objectContaining({ type: "doc", version: 1 }),
  );
});

test("explicit cancel suppresses a pending create result and its later link", async () => {
  const editorMock = spyOn(editor, "editInNeovim").mockResolvedValue("Cancelled create\n");
  restoreEditor = () => editorMock.mockRestore();
  let resolveCreate!: (response: Response) => void;
  const pendingCreate = new Promise<Response>((resolve) => {
    resolveCreate = resolve;
  });
  let createStarted = false;
  let links = 0;
  globalThis.fetch = (async (input) => {
    const url = new URL(String(input));
    if (url.pathname.includes("/createmeta/PROJ/issuetypes/1")) {
      return Response.json({
        isLast: true,
        fields: [
          { fieldId: "summary", name: "Summary", required: true, schema: { type: "string" } },
        ],
      });
    }
    if (url.pathname === "/rest/api/3/search/jql") {
      return Response.json({
        isLast: true,
        issues: [
          {
            key: "PROJ-2",
            fields: {
              project: { key: "PROJ" },
              summary: "Target",
              issuetype: { id: "1", name: "Work item", subtask: false, hierarchyLevel: 0 },
            },
          },
        ],
      });
    }
    if (url.pathname === "/rest/api/3/issue") {
      createStarted = true;
      return pendingCreate;
    }
    if (url.pathname === "/rest/api/3/issueLink") {
      links++;
      return new Response(null, { status: 201 });
    }
    throw new Error(`unexpected request: ${url}`);
  }) as typeof fetch;
  let cancels = 0;
  const completed: unknown[] = [];
  const { stdin, output } = mount(
    { onCancel: () => cancels++, onDone: (result) => completed.push(result) },
    { initialType: types[0]! },
  );
  await send(stdin, "\r");
  await send(stdin, "\u001b[B");
  await send(stdin, "\u001b[B");
  await send(stdin, "\u001b[B");
  await send(stdin, "\r");
  await send(stdin, "\u001b[B");
  await send(stdin, "\r");
  await send(stdin, "\u001b[B");
  await send(stdin, "\r");
  await waitFor(() => output().includes("PROJ-2"), "cancelled create target");
  await send(stdin, "\r");
  await send(stdin, "s");
  await waitFor(() => createStarted, "pending create request");
  await send(stdin, "\u001b");
  await waitFor(() => cancels > 0, "pending create cancellation");
  expect(cancels).toBe(1);
  await send(stdin, "s");
  await send(stdin, "\r");
  expect(cancels).toBe(1);

  resolveCreate(Response.json({ key: "PROJ-20" }, { status: 201 }));
  await nextTurn();
  await nextTurn();
  expect(completed).toEqual([]);
  expect(links).toBe(0);
});

test("browse cancellation is idempotent and disables later input", async () => {
  const editorMock = spyOn(editor, "editInNeovim").mockResolvedValue("must not open");
  restoreEditor = () => editorMock.mockRestore();
  let cancels = 0;
  let requests = 0;
  globalThis.fetch = (async () => {
    requests++;
    return Response.json({});
  }) as unknown as typeof fetch;
  const { stdin } = mount({ onCancel: () => cancels++ });

  await send(stdin, "\u001b");
  await waitFor(() => cancels > 0, "browse cancellation");
  await send(stdin, "\r");
  await send(stdin, "s");
  await send(stdin, "\u001b");

  expect(cancels).toBe(1);
  expect(editorMock).toHaveBeenCalledTimes(0);
  expect(requests).toBe(0);
});
