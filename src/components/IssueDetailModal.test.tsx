import { afterEach, expect, spyOn, test } from "bun:test";
import { PassThrough } from "node:stream";

import { render } from "ink";

import type { JiraConfig } from "../config";
import * as editor from "../editor";
import { createTerminal, deferred, nextTurn, waitFor } from "../test/utils";
import { IssueDetailModal } from "./IssueDetailModal";

const originalFetch = globalThis.fetch;
const apps: ReturnType<typeof render>[] = [];
let restoreEditor: (() => void) | null = null;

afterEach(() => {
  globalThis.fetch = originalFetch;
  restoreEditor?.();
  restoreEditor = null;
  for (const app of apps.splice(0)) app.unmount();
});

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
    ensureUsers: async () => [],
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
    ensureUsers: async () => [],
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

test("a save from a previous issue cannot refresh or publish into the current issue", async () => {
  const oldSave = deferred<Response>();
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
      return oldSave.promise;
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
    ensureUsers: async () => [],
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
      ensureUsers={async () => []}
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
  await waitFor(() => output().includes("a subtask cannot be a parent"), "subtask rejection");
  expect(subtaskFlows).toBe(0);
  expect(output()).toContain("a subtask cannot be a parent");
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
      ensureUsers={async () => []}
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

test("an unmounted detail cannot refresh after an old save completes", async () => {
  const save = deferred<Response>();
  let issueGets = 0;
  let saves = 0;
  let refreshes = 0;
  globalThis.fetch = (async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === "/rest/api/3/field") return json([]);
    if (url.pathname === "/rest/api/3/myself") return json({ accountId: "me" });
    if (url.pathname.endsWith("/comment")) return json({ comments: [] });
    if (url.pathname.endsWith("/editmeta")) return json({ fields: {} });
    if (url.pathname.endsWith("/watchers") && init?.method === "POST") {
      saves++;
      return save.promise;
    }
    if (url.pathname === "/rest/api/3/issue/PROJ-1") {
      issueGets++;
      return json(issue("PROJ-1", "save lifetime"));
    }
    throw new Error(`unexpected request: ${init?.method ?? "GET"} ${url}`);
  }) as typeof fetch;
  const terminal = createTerminal();
  const app = render(
    <IssueDetailModal
      cfg={{ server: "https://unmount-save.invalid", authHeader: "Basic test" }}
      projectKey="PROJ"
      issueKey="PROJ-1"
      ensureUsers={async () => []}
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
  await waitFor(() => terminal.output().includes("save lifetime"), "loaded save detail");
  terminal.stdin.write("w");
  await waitFor(() => saves === 1, "pending save");
  app.unmount();
  save.resolve(new Response(null, { status: 204 }));
  await nextTurn();
  await nextTurn();

  expect(issueGets).toBe(1);
  expect(refreshes).toBe(0);
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
      ensureUsers={async () => []}
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
      ensureUsers={async () => []}
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
