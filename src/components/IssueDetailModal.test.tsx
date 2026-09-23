import { afterEach, expect, spyOn, test } from "bun:test";
import { PassThrough } from "node:stream";

import { render } from "ink";

import type { JiraConfig } from "../config";
import * as editor from "../editor";
import { createTerminal, deferred, nextTurn, sendInput, waitFor } from "../test/utils";
import { IssueDetailModal } from "./IssueDetailModal";

const originalFetch = globalThis.fetch;
const columnsDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "columns");
const rowsDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "rows");
const apps: ReturnType<typeof render>[] = [];
let restoreEditor: (() => void) | null = null;

afterEach(() => {
  globalThis.fetch = originalFetch;
  restoreEditor?.();
  restoreEditor = null;
  for (const app of apps.splice(0)) app.unmount();
  if (columnsDescriptor) Object.defineProperty(process.stdout, "columns", columnsDescriptor);
  else delete (process.stdout as unknown as Record<string, unknown>)["columns"];
  if (rowsDescriptor) Object.defineProperty(process.stdout, "rows", rowsDescriptor);
  else delete (process.stdout as unknown as Record<string, unknown>)["rows"];
});

function setDimensions(columns: number, rows: number): void {
  Object.defineProperty(process.stdout, "columns", { configurable: true, value: columns });
  Object.defineProperty(process.stdout, "rows", { configurable: true, value: rows });
}

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function issue(key: string, summary: string, subtask = false) {
  return {
    id: key === "PROJ-1" ? "1" : "2",
    key,
    fields: {
      summary,
      description: null,
      status: { id: "1", name: "Open", statusCategory: { key: "new" } },
      issuetype: { name: subtask ? "Subtask" : "Task", subtask },
      labels: [],
      components: [],
      fixVersions: [],
      subtasks: [],
      issuelinks: [],
      created: "2026-01-01T00:00:00.000Z",
      updated: "2026-01-01T00:00:00.000Z",
    },
  };
}

test("buffered detail field actions follow the displayed selection across metadata changes", async () => {
  setDimensions(120, 40);
  const writes: unknown[] = [];
  let metadataGets = 0;
  let metadataShrunk = false;
  const values: Record<string, string | null> = {
    customfield_101: "alpha",
    customfield_102: "beta",
  };
  globalThis.fetch = (async (input, init = {}) => {
    const url = new URL(String(input));
    if (url.pathname === "/rest/api/3/field") return json([]);
    if (url.pathname === "/rest/api/3/myself") return json({ accountId: "me" });
    if (url.pathname.endsWith("/comment")) return json({ comments: [] });
    if (url.pathname.endsWith("/editmeta")) {
      metadataGets++;
      return json({
        fields: {
          customfield_101: {
            name: "Alpha note",
            required: false,
            schema: { type: "string" },
          },
          ...(metadataShrunk
            ? {}
            : {
                customfield_102: {
                  name: "Beta note",
                  required: false,
                  schema: { type: "string" },
                },
              }),
        },
      });
    }
    if (url.pathname === "/rest/api/3/issue/PROJ-1" && init.method === "PUT") {
      const body = JSON.parse(String(init.body));
      writes.push(body);
      Object.assign(values, body.fields);
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/rest/api/3/issue/PROJ-1") {
      const detail = issue("PROJ-1", "Packet fields");
      Object.assign(detail.fields, values);
      return json(detail);
    }
    throw new Error(`unexpected request: ${init.method ?? "GET"} ${url}`);
  }) as typeof fetch;
  const terminal = createTerminal(120, 40);
  const app = render(
    <IssueDetailModal
      cfg={{ server: "https://detail-packet.invalid", authHeader: "Basic test" }}
      projectKey="PROJ"
      issueKey="PROJ-1"
      ensureUsers={async () => ({ users: [] })}
      onClose={() => {}}
      onMove={() => {}}
      onTransition={() => {}}
      onCreateSubtask={() => {}}
      onRefresh={() => {}}
    />,
    {
      interactive: true,
      stdin: terminal.stdin as unknown as typeof process.stdin,
      stdout: terminal.stdout as unknown as typeof process.stdout,
      stderr: new PassThrough() as unknown as typeof process.stderr,
      exitOnCtrlC: false,
      patchConsole: false,
    },
  );
  apps.push(app);
  await waitFor(() => terminal.output().toLowerCase().includes("beta note"), "custom fields");
  const currentPaint = async () => {
    setDimensions(121, 40);
    terminal.stdout.columns = 121;
    process.stdout.emit("resize");
    await nextTurn();
    await app.waitUntilRenderFlush();
    terminal.clearOutput();
    setDimensions(120, 40);
    terminal.stdout.columns = 120;
    process.stdout.emit("resize");
    await nextTurn();
    await app.waitUntilRenderFlush();
    return Bun.stripANSI(terminal.output());
  };

  await sendInput(app, terminal.stdin, "\t");
  await sendInput(app, terminal.stdin, "G");
  await sendInput(app, terminal.stdin, "\u001b[Ax");
  await waitFor(() => writes.length === 1, "field clear");
  await waitFor(() => terminal.output().includes("Alpha note cleared"), "clear feedback");

  expect(writes).toEqual([{ fields: { customfield_101: null } }]);
  expect(terminal.output()).toMatch(/alpha note\s+—/i);
  expect(terminal.output()).toMatch(/beta note\s+beta/i);

  await sendInput(app, terminal.stdin, "G");
  metadataShrunk = true;
  await sendInput(app, terminal.stdin, "r");
  await waitFor(() => metadataGets >= 3, "shrunk edit metadata");
  const clamped = await currentPaint();
  expect(clamped).toMatch(/> alpha note\s+—/i);
  expect(clamped).not.toMatch(/beta note/i);

  await sendInput(app, terminal.stdin, "\u001b[Ax");
  await waitFor(() => terminal.output().includes("Not editable on this issue"), "read-only action");
  const readOnly = await currentPaint();
  expect(writes).toEqual([{ fields: { customfield_101: null } }]);
  expect(readOnly).toMatch(/> updated\s+/i);
  expect(readOnly).toContain("Not editable on this issue");
});

test("an older issue request cannot replace a newer issue", async () => {
  const first = deferred<Response>();
  const second = deferred<Response>();
  let firstRequested = false;
  let secondRequested = false;
  globalThis.fetch = (async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/rest/api/3/field") return json([]);
    if (url.pathname === "/rest/api/3/myself") {
      return json({ accountId: "me", displayName: "Me" });
    }
    if (url.pathname.endsWith("/comment")) return json({ comments: [] });
    if (url.pathname.endsWith("/editmeta")) return json({ fields: {} });
    if (url.pathname === "/rest/api/3/issue/PROJ-1") {
      firstRequested = true;
      return first.promise;
    }
    if (url.pathname === "/rest/api/3/issue/PROJ-2") {
      secondRequested = true;
      return second.promise;
    }
    throw new Error(`unexpected request: ${url}`);
  }) as typeof fetch;

  const cfg: JiraConfig = {
    server: "https://issue-detail.invalid",
    authHeader: "Basic test",
  };
  const props = {
    cfg,
    projectKey: "PROJ",
    ensureUsers: async () => ({ users: [] }),
    onClose: () => {},
    onMove: () => {},
    onTransition: () => {},
    onCreateSubtask: () => {},
    onRefresh: () => {},
  };
  const { stdin, stdout, output, clearOutput } = createTerminal();
  const app = render(<IssueDetailModal {...props} issueKey="PROJ-1" />, {
    interactive: true,
    stdin: stdin as unknown as typeof process.stdin,
    stdout: stdout as unknown as typeof process.stdout,
    stderr: new PassThrough() as unknown as typeof process.stderr,
    exitOnCtrlC: false,
    patchConsole: false,
  });
  apps.push(app);
  await waitFor(() => firstRequested, "first issue request");

  app.rerender(<IssueDetailModal {...props} issueKey="PROJ-2" />);
  await waitFor(() => secondRequested, "second issue request");
  second.resolve(json(issue("PROJ-2", "newer detail")));
  await waitFor(() => output().includes("newer detail"), "newer issue detail");

  clearOutput();
  first.resolve(json(issue("PROJ-1", "stale detail")));
  await nextTurn();
  await nextTurn();
  expect(output()).not.toContain("stale detail");
});

test("same-issue refreshes keep only the latest reverse-order result", async () => {
  const olderSuccess = deferred<Response>();
  const latestSuccess = deferred<Response>();
  const olderError = deferred<Response>();
  const latestAfterError = deferred<Response>();
  let issueGets = 0;
  globalThis.fetch = (async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/rest/api/3/field") return json([]);
    if (url.pathname === "/rest/api/3/myself") {
      return json({ accountId: "me", displayName: "Me" });
    }
    if (url.pathname.endsWith("/comment")) return json({ comments: [] });
    if (url.pathname.endsWith("/editmeta")) return json({ fields: {} });
    if (url.pathname === "/rest/api/3/issue/PROJ-1") {
      issueGets++;
      if (issueGets === 1) return json(issue("PROJ-1", "initial detail"));
      if (issueGets === 2) return olderSuccess.promise;
      if (issueGets === 3) return latestSuccess.promise;
      if (issueGets === 4) return olderError.promise;
      if (issueGets === 5) return latestAfterError.promise;
    }
    throw new Error(`unexpected request: ${url}`);
  }) as typeof fetch;

  const cfg: JiraConfig = {
    server: "https://same-issue-refresh.invalid",
    authHeader: "Basic test",
  };
  const props = {
    cfg,
    projectKey: "PROJ",
    issueKey: "PROJ-1",
    ensureUsers: async () => ({ users: [] }),
    onClose: () => {},
    onMove: () => {},
    onTransition: () => {},
    onCreateSubtask: () => {},
    onRefresh: () => {},
  };
  const { stdin, stdout, output, clearOutput } = createTerminal();
  const app = render(<IssueDetailModal {...props} />, {
    interactive: true,
    stdin: stdin as unknown as typeof process.stdin,
    stdout: stdout as unknown as typeof process.stdout,
    stderr: new PassThrough() as unknown as typeof process.stderr,
    exitOnCtrlC: false,
    patchConsole: false,
  });
  apps.push(app);
  await waitFor(() => output().includes("initial detail"), "initial issue detail");
  expect(output()).toContain("initial detail");

  stdin.write("r");
  await waitFor(() => issueGets === 2, "first refresh request");
  expect(issueGets).toBe(2);
  await nextTurn();
  stdin.write("r");
  await waitFor(() => issueGets === 3, "second refresh request");
  expect(issueGets).toBe(3);
  latestSuccess.resolve(json(issue("PROJ-1", "latest detail")));
  await waitFor(() => output().includes("latest detail"), "latest refresh result");
  expect(output()).toContain("latest detail");
  clearOutput();
  olderSuccess.resolve(json(issue("PROJ-1", "older detail")));
  await nextTurn();
  await nextTurn();
  expect(output()).not.toContain("older detail");

  stdin.write("r");
  await waitFor(() => issueGets === 4, "older error refresh request");
  expect(issueGets).toBe(4);
  await nextTurn();
  stdin.write("r");
  await waitFor(() => issueGets === 5, "latest success refresh request");
  expect(issueGets).toBe(5);
  latestAfterError.resolve(json(issue("PROJ-1", "latest after error")));
  await waitFor(() => output().includes("latest after error"), "latest success after older error");
  expect(output()).toContain("latest after error");
  clearOutput();
  olderError.resolve(new Response("old failure", { status: 500 }));
  await nextTurn();
  await nextTurn();
  expect(output()).not.toContain("old failure");
});

test("changed-issue and post-write unmount saves cannot refresh or publish", async () => {
  const oldSave = deferred<Response>();
  const currentSave = deferred<Response>();
  let oldIssueGets = 0;
  let currentIssueGets = 0;
  let watchRequests = 0;
  globalThis.fetch = (async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === "/rest/api/3/field") return json([]);
    if (url.pathname === "/rest/api/3/myself") {
      return json({ accountId: "me", displayName: "Me" });
    }
    if (url.pathname.endsWith("/comment")) return json({ comments: [] });
    if (url.pathname.endsWith("/editmeta")) return json({ fields: {} });
    if (url.pathname.endsWith("/watchers") && init?.method === "POST") {
      watchRequests++;
      return url.pathname.includes("PROJ-2") ? currentSave.promise : oldSave.promise;
    }
    if (url.pathname === "/rest/api/3/issue/PROJ-1") {
      oldIssueGets++;
      return json(issue("PROJ-1", "old issue"));
    }
    if (url.pathname === "/rest/api/3/issue/PROJ-2") {
      currentIssueGets++;
      return json(issue("PROJ-2", "current issue"));
    }
    throw new Error(`unexpected request: ${url}`);
  }) as typeof fetch;

  const cfg: JiraConfig = {
    server: "https://issue-save-lifetime.invalid",
    authHeader: "Basic test",
  };
  let refreshes = 0;
  const props = {
    cfg,
    projectKey: "PROJ",
    ensureUsers: async () => ({ users: [] }),
    onClose: () => {},
    onMove: () => {},
    onTransition: () => {},
    onCreateSubtask: () => {},
    onRefresh: () => refreshes++,
  };
  const { stdin, stdout, output, clearOutput } = createTerminal();
  const app = render(<IssueDetailModal {...props} issueKey="PROJ-1" />, {
    interactive: true,
    stdin: stdin as unknown as typeof process.stdin,
    stdout: stdout as unknown as typeof process.stdout,
    stderr: new PassThrough() as unknown as typeof process.stderr,
    exitOnCtrlC: false,
    patchConsole: false,
  });
  apps.push(app);
  await waitFor(() => output().includes("old issue"), "old issue detail");
  expect(output()).toContain("old issue");

  stdin.write("w");
  await waitFor(() => watchRequests === 1, "old issue watch request");
  expect(watchRequests).toBe(1);

  app.rerender(<IssueDetailModal {...props} issueKey="PROJ-2" />);
  await waitFor(() => output().includes("current issue"), "current issue detail");
  expect(output()).toContain("current issue");
  clearOutput();

  const beforeRefresh = currentIssueGets;
  stdin.write("r");
  await waitFor(() => currentIssueGets === beforeRefresh + 1, "current issue refresh");
  expect(currentIssueGets).toBe(beforeRefresh + 1);

  oldSave.resolve(new Response(null, { status: 204 }));
  await nextTurn();
  await nextTurn();
  expect(oldIssueGets).toBe(1);
  expect(refreshes).toBe(0);
  expect(output()).not.toContain("old issue");

  stdin.write("w");
  await waitFor(() => watchRequests === 2, "current issue watch request");
  const getsBeforeUnmount = currentIssueGets;
  app.unmount();
  apps.splice(apps.indexOf(app), 1);
  currentSave.resolve(new Response(null, { status: 204 }));
  await nextTurn();
  await nextTurn();
  expect(currentIssueGets).toBe(getsBeforeUnmount);
  expect(refreshes).toBe(0);
});

test("an obsolete title rejection cannot replace a new issue field editor", async () => {
  const oldSave = deferred<Response>();
  const writes: { key: string; body: unknown }[] = [];
  globalThis.fetch = (async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === "/rest/api/3/field") return json([]);
    if (url.pathname === "/rest/api/3/myself") return json({ accountId: "me" });
    if (url.pathname.endsWith("/comment")) return json({ comments: [] });
    if (url.pathname.endsWith("/editmeta")) {
      return json({
        fields: {
          customfield_1: {
            name: "New choice",
            required: false,
            schema: { type: "option" },
            allowedValues: [{ id: "a", value: "Alpha choice" }],
          },
        },
      });
    }
    const key = url.pathname.endsWith("PROJ-2") ? "PROJ-2" : "PROJ-1";
    if (init?.method === "PUT") {
      writes.push({ key, body: JSON.parse(String(init.body)) });
      return key === "PROJ-1" ? oldSave.promise : new Response(null, { status: 204 });
    }
    if (url.pathname.endsWith(key)) return json(issue(key, key === "PROJ-1" ? "Old" : "New"));
    throw new Error(`unexpected request: ${init?.method ?? "GET"} ${url}`);
  }) as typeof fetch;
  const terminal = createTerminal();
  const props = {
    cfg: { server: "https://obsolete-save.invalid", authHeader: "Basic test" },
    projectKey: "PROJ",
    ensureUsers: async () => ({ users: [] }),
    onClose: () => {},
    onMove: () => {},
    onTransition: () => {},
    onCreateSubtask: () => {},
    onRefresh: () => {},
  };
  const app = render(<IssueDetailModal {...props} issueKey="PROJ-1" />, {
    interactive: true,
    stdin: terminal.stdin as unknown as typeof process.stdin,
    stdout: terminal.stdout as unknown as typeof process.stdout,
    stderr: new PassThrough() as unknown as typeof process.stderr,
    exitOnCtrlC: false,
    patchConsole: false,
  });
  apps.push(app);
  await waitFor(() => terminal.output().includes("Old"), "old issue");
  await sendInput(app, terminal.stdin, "e");
  await sendInput(app, terminal.stdin, " changed");
  await sendInput(app, terminal.stdin, "\r");
  await waitFor(() => writes.length === 1, "old title save");

  app.rerender(<IssueDetailModal {...props} issueKey="PROJ-2" />);
  await waitFor(() => terminal.output().includes("New"), "new issue");
  await sendInput(app, terminal.stdin, "\t");
  await sendInput(app, terminal.stdin, "G");
  await sendInput(app, terminal.stdin, "\r");
  await waitFor(() => terminal.output().includes("Alpha choice"), "new field editor");
  terminal.clearOutput();
  oldSave.resolve(new Response("old title rejected", { status: 400 }));
  await nextTurn();
  await app.waitUntilRenderFlush();
  expect(terminal.output()).not.toContain("Could not save title");
  await sendInput(app, terminal.stdin, "\r");
  await waitFor(() => writes.length === 2, "new field save");
  expect(writes).toEqual([
    { key: "PROJ-1", body: { fields: { summary: "Old changed" } } },
    { key: "PROJ-2", body: { fields: { customfield_1: { id: "a" } } } },
  ]);
});

test("a subtask cannot open another subtask flow beneath itself", async () => {
  globalThis.fetch = (async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/rest/api/3/field") return json([]);
    if (url.pathname === "/rest/api/3/myself") {
      return json({ accountId: "me", displayName: "Me" });
    }
    if (url.pathname.endsWith("/comment")) return json({ comments: [] });
    if (url.pathname.endsWith("/editmeta")) return json({ fields: {} });
    if (url.pathname === "/rest/api/3/issue/PROJ-2") {
      return json(issue("PROJ-2", "child issue", true));
    }
    throw new Error(`unexpected request: ${url}`);
  }) as typeof fetch;
  let subtaskFlows = 0;
  const { stdin, stdout, output } = createTerminal();
  const app = render(
    <IssueDetailModal
      cfg={{ server: "https://subtask-parent.invalid", authHeader: "Basic test" }}
      projectKey="PROJ"
      issueKey="PROJ-2"
      ensureUsers={async () => ({ users: [] })}
      onClose={() => {}}
      onMove={() => {}}
      onTransition={() => {}}
      onCreateSubtask={() => subtaskFlows++}
      onRefresh={() => {}}
    />,
    {
      interactive: true,
      stdin: stdin as unknown as typeof process.stdin,
      stdout: stdout as unknown as typeof process.stdout,
      stderr: new PassThrough() as unknown as typeof process.stderr,
      exitOnCtrlC: false,
      patchConsole: false,
    },
  );
  apps.push(app);
  await waitFor(() => output().includes("child issue"), "subtask detail");

  stdin.write("C");
  await waitFor(() => output().includes("A subtask cannot be a parent"), "subtask rejection");
  expect(subtaskFlows).toBe(0);
  expect(output()).toContain("A subtask cannot be a parent");
});

test("parent and transition actions wait for loaded issue metadata", async () => {
  const pendingDetail = deferred<Response>();
  let detailRequested = false;
  globalThis.fetch = (async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/rest/api/3/field") return json([]);
    if (url.pathname === "/rest/api/3/myself") {
      return json({ accountId: "me", displayName: "Me" });
    }
    if (url.pathname.endsWith("/comment")) return json({ comments: [] });
    if (url.pathname.endsWith("/editmeta")) return json({ fields: {} });
    if (url.pathname === "/rest/api/3/issue/OTHER-7") {
      detailRequested = true;
      return pendingDetail.promise;
    }
    throw new Error(`unexpected request: ${url}`);
  }) as typeof fetch;
  const parents: unknown[] = [];
  const transitionProjects: string[] = [];
  const moves: unknown[] = [];
  const { stdin, stdout, output } = createTerminal();
  const app = render(
    <IssueDetailModal
      cfg={{ server: "https://pending-parent.invalid", authHeader: "Basic test" }}
      projectKey=""
      issueKey="OTHER-7"
      ensureUsers={async () => ({ users: [] })}
      onClose={() => {}}
      onMove={(detail) => moves.push(detail)}
      onTransition={(projectKey) => transitionProjects.push(projectKey)}
      onCreateSubtask={(parent) => parents.push(parent)}
      onRefresh={() => {}}
    />,
    {
      interactive: true,
      stdin: stdin as unknown as typeof process.stdin,
      stdout: stdout as unknown as typeof process.stdout,
      stderr: new PassThrough() as unknown as typeof process.stderr,
      exitOnCtrlC: false,
      patchConsole: false,
    },
  );
  apps.push(app);
  await waitFor(() => detailRequested, "pending issue request");

  stdin.write("C");
  await nextTurn();
  stdin.write("t");
  await nextTurn();
  stdin.write("m");
  await nextTurn();
  expect(parents).toEqual([]);
  expect(transitionProjects).toEqual([]);
  expect(moves).toEqual([]);

  const loaded = issue("OTHER-7", "loaded parent");
  Object.assign(loaded.fields, {
    project: { key: "OTHER" },
    issuetype: {
      id: "77",
      name: "Capability",
      subtask: false,
      hierarchyLevel: 0,
    },
  });
  pendingDetail.resolve(json(loaded));
  await waitFor(() => output().includes("loaded parent"), "loaded parent detail");
  stdin.write("m");
  await nextTurn();
  stdin.write("C");
  await waitFor(() => parents.length === 1, "loaded parent action");
  stdin.write("t");
  await waitFor(() => transitionProjects.length === 1, "loaded transition action");

  expect(parents).toEqual([
    {
      key: "OTHER-7",
      projectKey: "OTHER",
      summary: "loaded parent",
      issueType: "Capability",
      issueTypeId: "77",
      subtask: false,
      hierarchyLevel: 0,
    },
  ]);
  expect(transitionProjects).toEqual(["OTHER"]);
  expect((moves[0] as { key?: string; projectKey?: string }) ?? {}).toEqual(
    expect.objectContaining({ key: "OTHER-7", projectKey: "OTHER" }),
  );
});

test("an editor result after detail unmount cannot start a write", async () => {
  const edit = deferred<string>();
  const editorMock = spyOn(editor, "editInNeovim").mockReturnValue(edit.promise);
  restoreEditor = () => editorMock.mockRestore();
  let updates = 0;
  let refreshes = 0;
  globalThis.fetch = (async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === "/rest/api/3/field") return json([]);
    if (url.pathname === "/rest/api/3/myself") return json({ accountId: "me" });
    if (url.pathname.endsWith("/comment")) return json({ comments: [] });
    if (url.pathname.endsWith("/editmeta")) return json({ fields: {} });
    if (url.pathname === "/rest/api/3/issue/PROJ-1" && init?.method === "PUT") {
      updates++;
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/rest/api/3/issue/PROJ-1") {
      return json(issue("PROJ-1", "editor lifetime"));
    }
    throw new Error(`unexpected request: ${init?.method ?? "GET"} ${url}`);
  }) as typeof fetch;
  const terminal = createTerminal();
  const app = render(
    <IssueDetailModal
      cfg={{ server: "https://unmount-editor.invalid", authHeader: "Basic test" }}
      projectKey="PROJ"
      issueKey="PROJ-1"
      ensureUsers={async () => ({ users: [] })}
      onClose={() => {}}
      onMove={() => {}}
      onTransition={() => {}}
      onCreateSubtask={() => {}}
      onRefresh={() => refreshes++}
    />,
    {
      interactive: true,
      stdin: terminal.stdin as unknown as typeof process.stdin,
      stdout: terminal.stdout as unknown as typeof process.stdout,
      stderr: new PassThrough() as unknown as typeof process.stderr,
      exitOnCtrlC: false,
      patchConsole: false,
    },
  );
  await waitFor(() => terminal.output().includes("editor lifetime"), "loaded editor detail");
  terminal.stdin.write("E");
  await waitFor(() => editorMock.mock.calls.length === 1, "description editor");
  app.unmount();
  edit.resolve("changed after unmount");
  await nextTurn();
  await nextTurn();

  expect(updates).toBe(0);
  expect(refreshes).toBe(0);
});

test("one buffered input packet starts only one detail editor", async () => {
  const pending = deferred<string>();
  const editorMock = spyOn(editor, "editInNeovim").mockReturnValue(pending.promise);
  restoreEditor = () => editorMock.mockRestore();
  let puts = 0;
  globalThis.fetch = (async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === "/rest/api/3/field") return json([]);
    if (url.pathname === "/rest/api/3/myself") return json({ accountId: "me" });
    if (url.pathname.endsWith("/comment")) return json({ comments: [] });
    if (url.pathname.endsWith("/editmeta")) return json({ fields: {} });
    if (url.pathname === "/rest/api/3/issue/PROJ-1" && init?.method === "PUT") {
      puts++;
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/rest/api/3/issue/PROJ-1") {
      const value = issue("PROJ-1", "Buffered editor input");
      (value.fields as unknown as { description: string }).description = "Initial body";
      return json(value);
    }
    throw new Error(`unexpected request: ${init?.method ?? "GET"} ${url}`);
  }) as typeof fetch;
  const terminal = createTerminal();
  const app = render(
    <IssueDetailModal
      cfg={{ server: "https://buffered-editor.invalid", authHeader: "Basic test" }}
      projectKey="PROJ"
      issueKey="PROJ-1"
      ensureUsers={async () => ({ users: [] })}
      onClose={() => {}}
      onMove={() => {}}
      onTransition={() => {}}
      onCreateSubtask={() => {}}
      onRefresh={() => {}}
    />,
    {
      interactive: true,
      stdin: terminal.stdin as unknown as typeof process.stdin,
      stdout: terminal.stdout as unknown as typeof process.stdout,
      stderr: new PassThrough() as unknown as typeof process.stderr,
      exitOnCtrlC: false,
      patchConsole: false,
    },
  );
  apps.push(app);
  try {
    await waitFor(() => terminal.output().includes("Initial body"), "loaded description");
    terminal.stdin.write("E\u001b[CE");
    await waitFor(() => editorMock.mock.calls.length > 0, "first editor launch");
    await app.waitUntilRenderFlush();
    expect(editorMock).toHaveBeenCalledTimes(1);
    expect(puts).toBe(0);
  } finally {
    pending.resolve("Initial body");
  }
});

test("unsupported detail description returns without editor or PUT", async () => {
  const editorMock = spyOn(editor, "editInNeovim").mockResolvedValue("must not open");
  restoreEditor = () => editorMock.mockRestore();
  let puts = 0;
  globalThis.fetch = (async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === "/rest/api/3/field") return json([]);
    if (url.pathname === "/rest/api/3/myself") return json({ accountId: "me" });
    if (url.pathname.endsWith("/comment")) return json({ comments: [] });
    if (url.pathname.endsWith("/editmeta")) return json({ fields: {} });
    if (url.pathname === "/rest/api/3/issue/PROJ-1" && init?.method === "PUT") {
      puts++;
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/rest/api/3/issue/PROJ-1") {
      const value = issue("PROJ-1", "Unsupported description");
      (value.fields as { description: unknown }).description = {
        type: "doc",
        version: 1,
        content: [
          {
            type: "table",
            content: [
              {
                type: "tableRow",
                content: [
                  {
                    type: "tableHeader",
                    attrs: {},
                    content: [{ type: "paragraph", content: [{ type: "text", text: "Header" }] }],
                  },
                ],
              },
              {
                type: "tableRow",
                content: [
                  {
                    type: "tableCell",
                    attrs: {},
                    content: [
                      { type: "paragraph", content: [{ type: "text", text: "first" }] },
                      { type: "paragraph", content: [{ type: "text", text: "second" }] },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      };
      return json(value);
    }
    throw new Error(`unexpected request: ${init?.method ?? "GET"} ${url}`);
  }) as typeof fetch;
  const terminal = createTerminal();
  const app = render(
    <IssueDetailModal
      cfg={{ server: "https://unsupported-detail.invalid", authHeader: "Basic test" }}
      projectKey="PROJ"
      issueKey="PROJ-1"
      ensureUsers={async () => ({ users: [] })}
      onClose={() => {}}
      onMove={() => {}}
      onTransition={() => {}}
      onCreateSubtask={() => {}}
      onRefresh={() => {}}
    />,
    {
      interactive: true,
      stdin: terminal.stdin as unknown as typeof process.stdin,
      stdout: terminal.stdout as unknown as typeof process.stdout,
      stderr: new PassThrough() as unknown as typeof process.stderr,
      exitOnCtrlC: false,
      patchConsole: false,
    },
  );
  apps.push(app);
  await waitFor(() => terminal.output().includes("Unsupported description"), "detail");
  await sendInput(app, terminal.stdin, "E");
  await waitFor(() => terminal.output().includes("Rich text needs Jira"), "unsupported notice");
  expect(editorMock).toHaveBeenCalledTimes(0);
  expect(puts).toBe(0);
  await sendInput(app, terminal.stdin, "\u001b");
  await waitFor(() => terminal.output().includes("Unsupported description"), "returned detail");
});

test("a failed description draft does not leak to a different issue", async () => {
  const seeds: string[] = [];
  const editorMock = spyOn(editor, "editInNeovim").mockImplementation(async (initial) => {
    seeds.push(initial);
    return seeds.length === 1 ? "Issue one draft" : initial;
  });
  restoreEditor = () => editorMock.mockRestore();
  globalThis.fetch = (async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === "/rest/api/3/field") return json([]);
    if (url.pathname === "/rest/api/3/myself") return json({ accountId: "me" });
    if (url.pathname.endsWith("/comment")) return json({ comments: [] });
    if (url.pathname.endsWith("/editmeta")) return json({ fields: {} });
    if (url.pathname === "/rest/api/3/issue/PROJ-1" && init?.method === "PUT")
      return new Response("rejected", { status: 400 });
    if (url.pathname === "/rest/api/3/issue/PROJ-1") {
      const value = issue("PROJ-1", "First issue");
      (value.fields as { description: string | null }).description = "First saved description";
      return json(value);
    }
    if (url.pathname === "/rest/api/3/issue/PROJ-2") {
      const value = issue("PROJ-2", "Second issue");
      (value.fields as { description: string | null }).description = "Second saved description";
      return json(value);
    }
    throw new Error(`unexpected request: ${init?.method ?? "GET"} ${url}`);
  }) as typeof fetch;
  const terminal = createTerminal();
  const props = {
    cfg: { server: "https://draft-identity.invalid", authHeader: "Basic test" },
    projectKey: "PROJ",
    ensureUsers: async () => ({ users: [] }),
    onClose: () => {},
    onMove: () => {},
    onTransition: () => {},
    onCreateSubtask: () => {},
    onRefresh: () => {},
  };
  const app = render(<IssueDetailModal {...props} issueKey="PROJ-1" />, {
    interactive: true,
    stdin: terminal.stdin as unknown as typeof process.stdin,
    stdout: terminal.stdout as unknown as typeof process.stdout,
    stderr: new PassThrough() as unknown as typeof process.stderr,
    exitOnCtrlC: false,
    patchConsole: false,
  });
  apps.push(app);
  await waitFor(() => terminal.output().includes("First issue"), "first issue");
  terminal.stdin.write("E");
  await waitFor(() => terminal.output().includes("Description not saved"), "failed description");

  app.rerender(<IssueDetailModal {...props} issueKey="PROJ-2" />);
  await waitFor(() => terminal.output().includes("Second issue"), "second issue");
  terminal.stdin.write("E");
  await waitFor(() => seeds.length === 2, "second editor");
  expect(seeds).toEqual(["First saved description", "Second saved description"]);
});

for (const mode of ["description", "new-comment", "existing-comment"] as const) {
  test(`discarded ${mode} draft does not return after a failed save`, async () => {
    const stored =
      mode === "description"
        ? "Stored description"
        : mode === "new-comment"
          ? ""
          : "Stored comment";
    const rejected = `${mode} rejected draft`;
    const seeds: string[] = [];
    const finalEditor = deferred<string>();
    const editorMock = spyOn(editor, "editInNeovim").mockImplementation(async (initial) => {
      seeds.push(initial);
      if (seeds.length === 1) return rejected;
      if (seeds.length === 2) return stored;
      return finalEditor.promise;
    });
    restoreEditor = () => editorMock.mockRestore();
    let writes = 0;
    globalThis.fetch = (async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === "/rest/api/3/field") return json([]);
      if (url.pathname === "/rest/api/3/myself") return json({ accountId: "me" });
      if (url.pathname.endsWith("/editmeta")) return json({ fields: {} });
      if (url.pathname.endsWith("/comment") && !init?.method) {
        return json({
          comments: [
            {
              id: "comment-1",
              author: { accountId: "me", displayName: "Me" },
              body: "Stored comment",
              created: "2026-01-01T00:00:00.000Z",
            },
          ],
        });
      }
      if (init?.method === "PUT" || init?.method === "POST") {
        writes++;
        return new Response("rejected", { status: 400 });
      }
      if (url.pathname === "/rest/api/3/issue/PROJ-1") {
        const value = issue("PROJ-1", "Draft disposal");
        (value.fields as { description: string | null }).description = "Stored description";
        return json(value);
      }
      throw new Error(`unexpected request: ${init?.method ?? "GET"} ${url}`);
    }) as typeof fetch;
    const terminal = createTerminal();
    const app = render(
      <IssueDetailModal
        cfg={{ server: "https://discard-draft.invalid", authHeader: "Basic test" }}
        projectKey="PROJ"
        issueKey="PROJ-1"
        ensureUsers={async () => ({ users: [] })}
        onClose={() => {}}
        onMove={() => {}}
        onTransition={() => {}}
        onCreateSubtask={() => {}}
        onRefresh={() => {}}
      />,
      {
        interactive: true,
        stdin: terminal.stdin as unknown as typeof process.stdin,
        stdout: terminal.stdout as unknown as typeof process.stdout,
        stderr: new PassThrough() as unknown as typeof process.stderr,
        exitOnCtrlC: false,
        patchConsole: false,
      },
    );
    apps.push(app);
    await waitFor(() => terminal.output().includes("Draft disposal"), "draft detail");
    const openEditor = async () => {
      if (mode === "description") await sendInput(app, terminal.stdin, "E");
      else if (mode === "new-comment") await sendInput(app, terminal.stdin, "c");
      else {
        await sendInput(app, terminal.stdin, "\r");
        await waitFor(() => terminal.output().includes("edit comment"), "comment action");
        await sendInput(app, terminal.stdin, "\r");
      }
    };
    await openEditor();
    await waitFor(() => writes === 1 && terminal.output().includes("not saved"), "failed draft");
    await openEditor();
    const discardMessage =
      mode === "description"
        ? "No description change"
        : mode === "new-comment"
          ? "Comment is empty"
          : "No comment change";
    await waitFor(() => terminal.output().includes(discardMessage), "discarded draft");
    expect(writes).toBe(1);
    await openEditor();
    await waitFor(() => seeds.length === 3, "reopened editor");
    expect(seeds).toEqual([stored, rejected, stored]);
  });
}

test("mention lookup failure is visible before nonfatal editor handoff", async () => {
  const editorMock = spyOn(editor, "editInNeovim").mockResolvedValue("saved description");
  restoreEditor = () => editorMock.mockRestore();
  globalThis.fetch = (async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/rest/api/3/field") return json([]);
    if (url.pathname === "/rest/api/3/myself") return json({ accountId: "me" });
    if (url.pathname.endsWith("/comment")) return json({ comments: [] });
    if (url.pathname.endsWith("/editmeta")) return json({ fields: {} });
    if (url.pathname === "/rest/api/3/issue/PROJ-1") return json(issue("PROJ-1", "Mention"));
    throw new Error(`unexpected request: ${url}`);
  }) as typeof fetch;
  const terminal = createTerminal();
  const app = render(
    <IssueDetailModal
      cfg={{ server: "https://mention-warning.invalid", authHeader: "Basic test" }}
      projectKey="PROJ"
      issueKey="PROJ-1"
      ensureUsers={async () => ({
        users: [],
        warning:
          "Mention suggestions could not load: temporary. Plain @text is not a Jira mention.",
      })}
      onClose={() => {}}
      onMove={() => {}}
      onTransition={() => {}}
      onCreateSubtask={() => {}}
      onRefresh={() => {}}
    />,
    {
      interactive: true,
      stdin: terminal.stdin as unknown as typeof process.stdin,
      stdout: terminal.stdout as unknown as typeof process.stdout,
      stderr: new PassThrough() as unknown as typeof process.stderr,
      exitOnCtrlC: false,
      patchConsole: false,
    },
  );
  apps.push(app);
  await waitFor(() => terminal.output().includes("Mention"), "detail");
  terminal.stdin.write("E");
  await waitFor(() => terminal.output().includes("Plain @text"), "mention warning");
  expect(editorMock).toHaveBeenCalledTimes(0);
  await waitFor(() => editorMock.mock.calls.length === 1, "nonfatal editor handoff", 1_500);
  expect(editorMock.mock.calls[0]?.[2]).toEqual({ mentionUsers: [] });
});

test("detail scalar save shows pending state and keeps its draft for retry", async () => {
  const saves = [deferred<Response>(), deferred<Response>()];
  const bodies: unknown[] = [];
  let puts = 0;
  let refreshes = 0;
  globalThis.fetch = (async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === "/rest/api/3/field") return json([]);
    if (url.pathname === "/rest/api/3/myself") return json({ accountId: "me" });
    if (url.pathname.endsWith("/comment")) return json({ comments: [] });
    if (url.pathname.endsWith("/editmeta")) {
      return json({
        fields: {
          customfield_1: {
            name: "Estimate",
            required: false,
            schema: { type: "number" },
          },
        },
      });
    }
    if (url.pathname === "/rest/api/3/issue/PROJ-1" && init?.method === "PUT") {
      bodies.push(JSON.parse(String(init.body)));
      const pending = saves[puts++];
      if (!pending) throw new Error("duplicate save");
      return pending.promise;
    }
    if (url.pathname === "/rest/api/3/issue/PROJ-1") {
      const value = issue("PROJ-1", "Scalar field");
      Object.assign(value.fields, { customfield_1: null });
      return json(value);
    }
    throw new Error(`unexpected request: ${init?.method ?? "GET"} ${url}`);
  }) as typeof fetch;
  const terminal = createTerminal();
  const app = render(
    <IssueDetailModal
      cfg={{ server: "https://field-save.invalid", authHeader: "Basic test" }}
      projectKey="PROJ"
      issueKey="PROJ-1"
      ensureUsers={async () => ({ users: [] })}
      onClose={() => {}}
      onMove={() => {}}
      onTransition={() => {}}
      onCreateSubtask={() => {}}
      onRefresh={() => refreshes++}
    />,
    {
      interactive: true,
      stdin: terminal.stdin as unknown as typeof process.stdin,
      stdout: terminal.stdout as unknown as typeof process.stdout,
      stderr: new PassThrough() as unknown as typeof process.stderr,
      exitOnCtrlC: false,
      patchConsole: false,
    },
  );
  apps.push(app);
  await waitFor(() => terminal.output().includes("Scalar field"), "detail");
  await sendInput(app, terminal.stdin, "\t");
  await sendInput(app, terminal.stdin, "G");
  await sendInput(app, terminal.stdin, "\r");
  await waitFor(() => terminal.output().includes("Estimate"), "number editor");
  await sendInput(app, terminal.stdin, "5");
  terminal.clearOutput();
  await sendInput(app, terminal.stdin, "\r");
  await waitFor(() => puts === 1, "first field save");
  await waitFor(() => terminal.output().includes("Saving Estimate"), "field pending state");
  expect(bodies[0]).toEqual({ fields: { customfield_1: 5 } });
  await sendInput(app, terminal.stdin, "\r");
  expect(puts).toBe(1);
  terminal.clearOutput();
  saves[0]!.resolve(new Response("field rejected", { status: 400 }));
  await waitFor(() => terminal.output().includes("Could not save Estimate"), "field error");
  expect(Bun.stripANSI(terminal.output())).toMatch(/›\s+5/);
  await sendInput(app, terminal.stdin, "e");
  await sendInput(app, terminal.stdin, "\x15");
  await sendInput(app, terminal.stdin, "6");
  await sendInput(app, terminal.stdin, "\r");
  await waitFor(() => puts === 2, "field retry");
  expect(bodies[1]).toEqual({ fields: { customfield_1: 6 } });
  terminal.clearOutput();
  saves[1]!.resolve(new Response(null, { status: 204 }));
  await waitFor(() => refreshes === 1, "saved field completion");
  await app.waitUntilRenderFlush();
  expect(terminal.output()).not.toContain("Estimate was not saved");
});

test("detail option save preserves filtered picker query and selection after failure", async () => {
  const saves = [deferred<Response>(), deferred<Response>()];
  const bodies: unknown[] = [];
  globalThis.fetch = (async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === "/rest/api/3/field") return json([]);
    if (url.pathname === "/rest/api/3/myself") return json({ accountId: "me" });
    if (url.pathname.endsWith("/comment")) return json({ comments: [] });
    if (url.pathname.endsWith("/editmeta")) {
      return json({
        fields: {
          customfield_2: {
            name: "Choice",
            required: false,
            schema: { type: "option" },
            allowedValues: [
              { id: "a", value: "Alpha" },
              { id: "b", value: "Beta" },
              { id: "g", value: "Gamma" },
            ],
          },
        },
      });
    }
    if (url.pathname === "/rest/api/3/issue/PROJ-1" && init?.method === "PUT") {
      bodies.push(JSON.parse(String(init.body)));
      return saves[bodies.length - 1]!.promise;
    }
    if (url.pathname === "/rest/api/3/issue/PROJ-1") {
      const value = issue("PROJ-1", "Option field");
      Object.assign(value.fields, { customfield_2: null });
      return json(value);
    }
    throw new Error(`unexpected request: ${init?.method ?? "GET"} ${url}`);
  }) as typeof fetch;
  const terminal = createTerminal();
  const app = render(
    <IssueDetailModal
      cfg={{ server: "https://option-save.invalid", authHeader: "Basic test" }}
      projectKey="PROJ"
      issueKey="PROJ-1"
      ensureUsers={async () => ({ users: [] })}
      onClose={() => {}}
      onMove={() => {}}
      onTransition={() => {}}
      onCreateSubtask={() => {}}
      onRefresh={() => {}}
    />,
    {
      interactive: true,
      stdin: terminal.stdin as unknown as typeof process.stdin,
      stdout: terminal.stdout as unknown as typeof process.stdout,
      stderr: new PassThrough() as unknown as typeof process.stderr,
      exitOnCtrlC: false,
      patchConsole: false,
    },
  );
  apps.push(app);
  await waitFor(() => terminal.output().includes("Option field"), "detail");
  await sendInput(app, terminal.stdin, "\t");
  await sendInput(app, terminal.stdin, "G");
  await sendInput(app, terminal.stdin, "\r");
  await waitFor(() => terminal.output().includes("Gamma"), "option picker");
  await sendInput(app, terminal.stdin, "ga");
  terminal.clearOutput();
  await sendInput(app, terminal.stdin, "\r");
  await waitFor(() => bodies.length === 1, "option save");
  await waitFor(
    () => terminal.output().includes("Please wait for the save to finish"),
    "option pending copy",
  );
  expect(terminal.output()).not.toContain("esc cancel");
  expect(terminal.output()).toContain("Please wait for the save to finish");
  saves[0]!.resolve(new Response("option rejected", { status: 400 }));
  await waitFor(() => terminal.output().includes("Choice was not saved"), "option error");
  await sendInput(app, terminal.stdin, "e");
  await waitFor(() => terminal.output().includes("ga"), "restored option query");
  expect(terminal.output()).toContain("> Gamma");
  await sendInput(app, terminal.stdin, "\r");
  await waitFor(() => bodies.length === 2, "option retry");
  expect(bodies).toEqual([
    { fields: { customfield_2: { id: "g" } } },
    { fields: { customfield_2: { id: "g" } } },
  ]);
  saves[1]!.resolve(new Response(null, { status: 204 }));
});

test("80x24 detail pane preserves characters across padded body wrapping", async () => {
  setDimensions(80, 24);
  const description = `${"a".repeat(47)}XYZ0123456789`;
  const detailResponse = deferred<Response>();
  globalThis.fetch = (async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/rest/api/3/field") return json([]);
    if (url.pathname === "/rest/api/3/myself") return json({ accountId: "me" });
    if (url.pathname.endsWith("/comment")) return json({ comments: [] });
    if (url.pathname.endsWith("/editmeta")) return json({ fields: {} });
    if (url.pathname === "/rest/api/3/issue/PROJ-1") {
      return detailResponse.promise;
    }
    throw new Error(`unexpected request: ${url}`);
  }) as typeof fetch;
  const terminal = createTerminal(80, 24);
  const app = render(
    <IssueDetailModal
      cfg={{ server: "https://wrap-detail.invalid", authHeader: "Basic test" }}
      projectKey="PROJ"
      issueKey="PROJ-1"
      ensureUsers={async () => ({ users: [] })}
      onClose={() => {}}
      onMove={() => {}}
      onTransition={() => {}}
      onCreateSubtask={() => {}}
      onRefresh={() => {}}
    />,
    {
      interactive: true,
      stdin: terminal.stdin as unknown as typeof process.stdin,
      stdout: terminal.stdout as unknown as typeof process.stdout,
      stderr: new PassThrough() as unknown as typeof process.stderr,
      exitOnCtrlC: false,
      patchConsole: false,
    },
  );
  apps.push(app);
  await nextTurn();
  terminal.clearOutput();
  const value = issue("PROJ-1", "Wrapped detail");
  (value.fields as { description: string | null }).description = description;
  detailResponse.resolve(json(value));
  await waitFor(() => terminal.output().includes("Wrapped detail"), "wrapped detail");
  const frame = Bun.stripANSI(terminal.output());
  expect(frame).toContain(`${"a".repeat(47)}X`);
  expect(frame).toContain("YZ0123456789");
  expect(frame).toContain("0123456789");
});

test("older issue save completion cannot clear a newer issue pending state", async () => {
  const oldSave = deferred<Response>();
  const newSaves = [deferred<Response>(), deferred<Response>()];
  const writes: { key: string; body: unknown }[] = [];
  let newSaveIndex = 0;
  globalThis.fetch = (async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === "/rest/api/3/field") return json([]);
    if (url.pathname === "/rest/api/3/myself") return json({ accountId: "me" });
    if (url.pathname.endsWith("/comment")) return json({ comments: [] });
    if (url.pathname.endsWith("/editmeta")) return json({ fields: {} });
    const key = url.pathname.endsWith("PROJ-2") ? "PROJ-2" : "PROJ-1";
    if (init?.method === "PUT") {
      writes.push({ key, body: JSON.parse(String(init.body)) });
      if (key === "PROJ-1") return oldSave.promise;
      return newSaves[newSaveIndex++]!.promise;
    }
    if (url.pathname.endsWith(key)) return json(issue(key, `Issue ${key}`));
    throw new Error(`unexpected request: ${init?.method ?? "GET"} ${url}`);
  }) as typeof fetch;
  const terminal = createTerminal();
  const props = {
    cfg: { server: "https://save-lifetime.invalid", authHeader: "Basic test" },
    projectKey: "PROJ",
    ensureUsers: async () => ({ users: [] }),
    onClose: () => {},
    onMove: () => {},
    onTransition: () => {},
    onCreateSubtask: () => {},
    onRefresh: () => {},
  };
  const app = render(<IssueDetailModal {...props} issueKey="PROJ-1" />, {
    interactive: true,
    stdin: terminal.stdin as unknown as typeof process.stdin,
    stdout: terminal.stdout as unknown as typeof process.stdout,
    stderr: new PassThrough() as unknown as typeof process.stderr,
    exitOnCtrlC: false,
    patchConsole: false,
  });
  apps.push(app);
  await waitFor(() => terminal.output().includes("Issue PROJ-1"), "first issue");
  await sendInput(app, terminal.stdin, "e");
  await sendInput(app, terminal.stdin, " changed");
  await sendInput(app, terminal.stdin, "\r");
  await waitFor(() => writes.length === 1, "first save");

  app.rerender(<IssueDetailModal {...props} issueKey="PROJ-2" />);
  await waitFor(() => terminal.output().includes("Issue PROJ-2"), "second issue");
  await sendInput(app, terminal.stdin, "e");
  await sendInput(app, terminal.stdin, " changed");
  await sendInput(app, terminal.stdin, "\r");
  await waitFor(() => writes.length === 2, "second save");
  oldSave.resolve(new Response(null, { status: 204 }));
  await nextTurn();
  await nextTurn();
  await sendInput(app, terminal.stdin, " foreground sentinel");
  await sendInput(app, terminal.stdin, "\r");
  expect(writes).toHaveLength(2);

  terminal.clearOutput();
  newSaves[0]!.resolve(new Response("new save rejected", { status: 400 }));
  await waitFor(() => terminal.output().includes("Could not save title"), "new save failure");
  const failedFrame = Bun.stripANSI(terminal.output());
  expect(failedFrame).toMatch(/›\s+Issue PROJ-2 changed/);
  expect(failedFrame).not.toContain("foreground sentinel");

  await sendInput(app, terminal.stdin, "\x15");
  await sendInput(app, terminal.stdin, "Retry PROJ-2 title");
  await sendInput(app, terminal.stdin, "\r");
  await waitFor(() => writes.length === 3, "new save retry");
  expect(writes).toEqual([
    { key: "PROJ-1", body: { fields: { summary: "Issue PROJ-1 changed" } } },
    { key: "PROJ-2", body: { fields: { summary: "Issue PROJ-2 changed" } } },
    { key: "PROJ-2", body: { fields: { summary: "Retry PROJ-2 title" } } },
  ]);
  newSaves[1]!.resolve(new Response(null, { status: 204 }));
});

for (const metadataFails of [true, false]) {
  test(
    metadataFails
      ? "clear explains an edit metadata failure and retry path"
      : "clear keeps genuine read-only metadata feedback",
    async () => {
      globalThis.fetch = (async (input) => {
        const url = new URL(String(input));
        if (url.pathname === "/rest/api/3/field") return json([]);
        if (url.pathname === "/rest/api/3/myself") return json({ accountId: "me" });
        if (url.pathname.endsWith("/comment")) return json({ comments: [] });
        if (url.pathname.endsWith("/editmeta")) {
          return metadataFails
            ? new Response("metadata denied", { status: 403 })
            : json({ fields: {} });
        }
        if (url.pathname === "/rest/api/3/issue/PROJ-1") return json(issue("PROJ-1", "Metadata"));
        throw new Error(`unexpected request: ${url}`);
      }) as typeof fetch;
      const terminal = createTerminal();
      const app = render(
        <IssueDetailModal
          cfg={{ server: "https://metadata-clear.invalid", authHeader: "Basic test" }}
          projectKey="PROJ"
          issueKey="PROJ-1"
          ensureUsers={async () => ({ users: [] })}
          onClose={() => {}}
          onMove={() => {}}
          onTransition={() => {}}
          onCreateSubtask={() => {}}
          onRefresh={() => {}}
        />,
        {
          interactive: true,
          stdin: terminal.stdin as unknown as typeof process.stdin,
          stdout: terminal.stdout as unknown as typeof process.stdout,
          stderr: new PassThrough() as unknown as typeof process.stderr,
          exitOnCtrlC: false,
          patchConsole: false,
        },
      );
      apps.push(app);
      await waitFor(() => terminal.output().includes("Metadata"), "metadata detail");
      await sendInput(app, terminal.stdin, "\t");
      await sendInput(app, terminal.stdin, "\x1b[B");
      terminal.clearOutput();
      await sendInput(app, terminal.stdin, "x");
      if (metadataFails) {
        await waitFor(() => terminal.output().includes("metadata denied"), "metadata clear error");
        expect(terminal.output()).toContain("Press r to retry");
        expect(terminal.output()).not.toContain("Not editable on this issue");
      } else {
        await waitFor(
          () => terminal.output().includes("Not editable on this issue"),
          "read-only clear feedback",
        );
        expect(terminal.output()).not.toContain("Field information could not load");
      }
    },
  );
}

test("80x24 detail bounds one combined long-error queue and keeps controls visible", async () => {
  setDimensions(80, 24);
  const detailResponse = deferred<Response>();
  globalThis.fetch = (async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/rest/api/3/field") return json([]);
    if (url.pathname === "/rest/api/3/myself") return json({ accountId: "me" });
    if (url.pathname.endsWith("/comment")) return json({ comments: [] });
    if (url.pathname.endsWith("/editmeta")) return json({ fields: {} });
    if (url.pathname === "/rest/api/3/issue/PROJ-1") return detailResponse.promise;
    throw new Error(`unexpected request: ${url}`);
  }) as typeof fetch;
  const terminal = createTerminal(80, 24);
  const externalToasts = Array.from({ length: 6 }, (_, index) => ({
    id: index + 1,
    tone: "err" as const,
    text: `${`longerror${index + 1}`.repeat(20)} END_${index + 1}`,
  }));
  const app = render(
    <IssueDetailModal
      cfg={{ server: "https://detail-errors.invalid", authHeader: "Basic test" }}
      projectKey="PROJ"
      issueKey="PROJ-1"
      ensureUsers={async () => ({ users: [] })}
      onClose={() => {}}
      onMove={() => {}}
      onTransition={() => {}}
      onCreateSubtask={() => {}}
      onRefresh={() => {}}
      externalToasts={externalToasts}
    />,
    {
      interactive: true,
      stdin: terminal.stdin as unknown as typeof process.stdin,
      stdout: terminal.stdout as unknown as typeof process.stdout,
      stderr: new PassThrough() as unknown as typeof process.stderr,
      exitOnCtrlC: false,
      patchConsole: false,
    },
  );
  apps.push(app);
  await nextTurn();
  terminal.clearOutput();
  detailResponse.resolve(json(issue("PROJ-1", "Errors")));
  await waitFor(() => terminal.output().includes("Errors"), "detail errors");
  const frame = Bun.stripANSI(terminal.output());
  expect(frame.split("\n").length).toBeLessThanOrEqual(24);
  expect(frame).toContain("esc close");
  expect(frame).not.toContain("longerror1");
  for (let page = 0; page < 20; page++) await sendInput(app, terminal.stdin, "\x10");
  expect(terminal.output()).toContain("END_6");
});

test("a nondefault estimate remains visible through actual detail field metadata", async () => {
  globalThis.fetch = (async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/rest/api/3/field") return json([]);
    if (url.pathname === "/rest/api/3/myself") return json({ accountId: "me" });
    if (url.pathname.endsWith("/comment")) return json({ comments: [] });
    if (url.pathname.endsWith("/editmeta")) {
      return json({
        fields: {
          customfield_4242: {
            name: "Estimate",
            required: false,
            schema: { type: "number" },
          },
        },
      });
    }
    if (url.pathname === "/rest/api/3/issue/PROJ-1") {
      const detail = issue("PROJ-1", "configured estimate detail");
      Object.assign(detail.fields, { customfield_4242: 7 });
      return json(detail);
    }
    throw new Error(`unexpected request: ${url}`);
  }) as typeof fetch;
  const terminal = createTerminal();
  const app = render(
    <IssueDetailModal
      cfg={{ server: "https://detail-estimate.invalid", authHeader: "Basic test" }}
      projectKey="PROJ"
      issueKey="PROJ-1"
      ensureUsers={async () => ({ users: [] })}
      onClose={() => {}}
      onMove={() => {}}
      onTransition={() => {}}
      onCreateSubtask={() => {}}
      onRefresh={() => {}}
    />,
    {
      interactive: true,
      stdin: terminal.stdin as unknown as typeof process.stdin,
      stdout: terminal.stdout as unknown as typeof process.stdout,
      stderr: new PassThrough() as unknown as typeof process.stderr,
      exitOnCtrlC: false,
      patchConsole: false,
    },
  );
  await waitFor(() => /estimate\s+7/.test(terminal.output()), "configured estimate detail field");
  expect(terminal.output()).toMatch(/estimate\s+7/);
  app.unmount();
});

test("keeps separators, two-row footer, and the selected last field visible", async () => {
  const customFields = Object.fromEntries(
    Array.from({ length: 18 }, (_, index) => [
      `customfield_${1000 + index}`,
      { name: `Custom ${index}`, required: false, schema: { type: "string" } },
    ]),
  );

  for (const [columns, rows] of [
    [80, 24],
    [120, 40],
  ] as const) {
    setDimensions(columns, rows);
    const pendingIssue = deferred<Response>();
    globalThis.fetch = (async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/rest/api/3/field") return json([]);
      if (url.pathname === "/rest/api/3/myself") return json({ accountId: "test" });
      if (url.pathname.endsWith("/comment")) return json({ comments: [] });
      if (url.pathname.endsWith("/editmeta")) return json({ fields: customFields });
      if (url.pathname === "/rest/api/3/issue/TEST-1") return pendingIssue.promise;
      throw new Error(`unexpected request: ${url}`);
    }) as typeof fetch;

    const terminal = createTerminal(columns, rows);
    const app = render(
      <IssueDetailModal
        cfg={{ server: "https://detail-layout.invalid", authHeader: "Basic test" }}
        projectKey="TEST"
        issueKey="TEST-1"
        ensureUsers={async () => ({ users: [] })}
        onClose={() => {}}
        onMove={() => {}}
        onTransition={() => {}}
        onCreateSubtask={() => {}}
        onRefresh={() => {}}
        externalToasts={[{ id: 1, tone: "err", text: "Nondismissible external feedback" }]}
      />,
      {
        interactive: true,
        stdin: terminal.stdin as unknown as typeof process.stdin,
        stdout: terminal.stdout as unknown as typeof process.stdout,
        stderr: new PassThrough() as unknown as typeof process.stderr,
        exitOnCtrlC: false,
        patchConsole: false,
      },
    );
    apps.push(app);
    await app.waitUntilRenderFlush();
    terminal.clearOutput();
    const detail = issue("TEST-1", "Synthetic layout detail");
    Object.assign(
      detail.fields,
      Object.fromEntries(Object.keys(customFields).map((id) => [id, "value"])),
    );
    pendingIssue.resolve(json(detail));
    await waitFor(() => terminal.output().includes("Synthetic layout detail"), "layout detail");

    const loaded = Bun.stripANSI(terminal.output());
    const loadedLines = loaded.split("\n");
    expect(loadedLines.length).toBeLessThanOrEqual(rows);
    expect(Math.max(...loadedLines.map((line) => Bun.stringWidth(line)))).toBeLessThanOrEqual(
      columns,
    );
    expect(loaded).not.toMatch(/^│?\s*─{1,5}\s*│?\s*$/m);
    expect(loaded).toContain("t status");
    expect(loaded).toContain("esc close");

    await sendInput(app, terminal.stdin, "\t");
    await sendInput(app, terminal.stdin, "G");
    terminal.clearOutput();
    const finalColumns = columns === 80 ? 120 : 80;
    const finalRows = rows === 24 ? 40 : 24;
    setDimensions(finalColumns, finalRows);
    terminal.stdout.columns = finalColumns;
    terminal.stdout.rows = finalRows;
    process.stdout.emit("resize");
    await nextTurn();
    await app.waitUntilRenderFlush();
    const selected = Bun.stripANSI(terminal.output());
    const selectedLines = selected.split("\n");
    expect(selectedLines.length).toBeLessThanOrEqual(finalRows);
    expect(Math.max(...selectedLines.map((line) => Bun.stringWidth(line)))).toBeLessThanOrEqual(
      finalColumns,
    );
    expect(selected).toContain("custom 17");
    expect(selected).toContain("29/29");
    expect(selected).toContain("esc close");
    expect(selected).toContain("Nondismissible external feedback");
    expect(selected).not.toContain("Ctrl+G dismiss");

    await sendInput(app, terminal.stdin, "\x07");
    setDimensions(finalColumns + 1, finalRows);
    terminal.stdout.columns = finalColumns + 1;
    process.stdout.emit("resize");
    await nextTurn();
    await app.waitUntilRenderFlush();
    terminal.clearOutput();
    setDimensions(finalColumns, finalRows);
    terminal.stdout.columns = finalColumns;
    process.stdout.emit("resize");
    await nextTurn();
    await app.waitUntilRenderFlush();
    const afterCtrlG = Bun.stripANSI(terminal.output());
    expect(afterCtrlG).toContain("custom 17");
    expect(afterCtrlG).toContain("29/29");
    expect(afterCtrlG).toContain("Nondismissible external feedback");
    expect(afterCtrlG).not.toContain("Ctrl+G dismiss");

    app.unmount();
    apps.splice(apps.indexOf(app), 1);
  }
});
