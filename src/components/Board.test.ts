import { expect, test } from "bun:test";
import { rm } from "node:fs/promises";

import { isolatedEnv, makeTempDir, runScript } from "../test/utils";

const boardUrl = new URL("./Board.tsx", import.meta.url).href;
const cacheUrl = new URL("../cache.ts", import.meta.url).href;
const utilsUrl = new URL("../test/utils.ts", import.meta.url).href;

async function runBoardCase(name: string, body: string): Promise<unknown> {
  const home = await makeTempDir(`board-${name}`);
  try {
    const { exitCode, stdout, stderr } = await runScript(
      `
          const { PassThrough } = await import("node:stream");
          const React = await import("react");
          const { render } = await import("ink");
          const { createTerminal, deferred, nextTurn, sendInput, waitFor } = await import(${JSON.stringify(utilsUrl)});
          const { BoardView } = await import(${JSON.stringify(boardUrl)});
          const cache = await import(${JSON.stringify(cacheUrl)});

          const cfg = { server: "https://board.invalid", authHeader: "Basic test" };
          const response = (value, status = 200) => Response.json(value, { status });
          const boardConfig = (projectKey = "PROJ") => response({
            name: "Test board",
            location: projectKey ? { key: projectKey } : undefined,
            columnConfig: { columns: [
              { name: "To Do", statuses: [{ id: "1" }] },
              { name: "Done", statuses: [{ id: "2" }] },
            ] },
          });
          const issue = (key, summary, statusId = "1") => ({
            id: key.split("-")[1],
            key,
            fields: {
              summary,
              description: null,
              status: {
                id: statusId,
                name: statusId === "1" ? "To Do" : "Done",
                statusCategory: { key: statusId === "1" ? "new" : "done" },
              },
              updated: "2026-01-01T00:00:00.000Z",
              issuetype: { name: "Task" },
              labels: [],
            },
          });
          const issuePage = (...issues) => response({
            startAt: 0,
            maxResults: issues.length,
            total: issues.length,
            isLast: true,
            issues,
          });
          const mount = (terminal, maxColumns = 4, onExit = () => {}) => render(
            React.createElement(BoardView, {
              cfg,
              board: { id: 7, name: "Test board" },
              maxColumns,
              onExit,
            }),
            {
              interactive: true,
              stdin: terminal.stdin,
              stdout: terminal.stdout,
              stderr: new PassThrough(),
              exitOnCtrlC: false,
              patchConsole: false,
            },
          );
          const send = (app, terminal, input) => sendInput(app, terminal.stdin, input);
          const currentPaint = async (app, terminal, columns = 120) => {
            const rows = terminal.stdout.rows;
            Object.defineProperty(process.stdout, "columns", { value: columns + 1, configurable: true });
            terminal.stdout.columns = columns + 1;
            process.stdout.emit("resize");
            await nextTurn();
            await app.waitUntilRenderFlush();
            terminal.clearOutput();
            Object.defineProperty(process.stdout, "columns", { value: columns, configurable: true });
            terminal.stdout.columns = columns;
            terminal.stdout.rows = rows;
            process.stdout.emit("resize");
            await nextTurn();
            await app.waitUntilRenderFlush();
            return Bun.stripANSI(terminal.output());
          };

          ${body}
        `,
      isolatedEnv(home),
    );
    expect(exitCode, stderr).toBe(0);
    return JSON.parse(stdout);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

async function runDetailMutationInvalidationCase(
  operation: "clear" | "watch",
  lookupOutcome: "success" | "failure",
): Promise<unknown> {
  return runBoardCase(
    `detail-${operation}-invalidates-${lookupOutcome}-transition`,
    `
      const operation = ${JSON.stringify(operation)};
      const lookupOutcome = ${JSON.stringify(lookupOutcome)};
      const transitionLookup = deferred();
      let transitionGets = 0;
      const mutation = deferred();
      const mutationRequests = [];
      globalThis.fetch = async (input, init = {}) => {
        const url = new URL(String(input));
        const method = init.method ?? "GET";
        if (url.pathname === "/rest/api/3/field") return response([]);
        if (url.pathname === "/rest/api/3/myself") return response({ accountId: "me" });
        if (url.pathname.endsWith("/configuration")) return boardConfig();
        if (url.pathname.endsWith("/allData.json")) return response({});
        if (url.pathname.endsWith("/user/assignable/search")) return response([]);
        if (url.pathname === "/rest/agile/1.0/board/7/issue") return issuePage(issue("PROJ-1", "Card"));
        if (url.pathname === "/rest/api/3/issue/PROJ-1/transitions") {
          transitionGets++;
          return transitionLookup.promise;
        }
        if (url.pathname === "/rest/api/3/issue/PROJ-1" && method === "PUT") {
          mutationRequests.push({ method, path: url.pathname, body: JSON.parse(String(init.body)) });
          return mutation.promise;
        }
        if (url.pathname === "/rest/api/3/issue/PROJ-1/watchers" && method === "POST") {
          mutationRequests.push({ method, path: url.pathname, body: init.body ?? null });
          return mutation.promise;
        }
        if (url.pathname === "/rest/api/3/issue/PROJ-1") {
          const value = issue("PROJ-1", "Card");
          Object.assign(value.fields, {
            project: { key: "PROJ" },
            assignee: { accountId: "user-1", displayName: "Synthetic User" },
            watches: { isWatching: false },
            components: [], fixVersions: [], subtasks: [], issuelinks: [],
            created: "2026-01-01T00:00:00.000Z",
          });
          return response(value);
        }
        if (url.pathname.endsWith("/comment")) return response({ comments: [] });
        if (url.pathname.endsWith("/editmeta")) {
          return response({ fields: {
            assignee: { name: "Assignee", required: false, schema: { type: "user" } },
          } });
        }
        throw new Error("unexpected request: " + method + " " + url);
      };

      const terminal = createTerminal();
      const app = mount(terminal);
      await waitFor(() => terminal.output().includes("Card"), "board");
      await send(app, terminal, "v");
      await waitFor(() => terminal.output().includes("Description"), "detail");
      await send(app, terminal, "t");
      await waitFor(() => transitionGets === 1, "one pending transition lookup");
      if (operation === "clear") {
        await send(app, terminal, "\\t");
        await send(app, terminal, "\\u001b[B");
        await send(app, terminal, "x");
      } else {
        await send(app, terminal, "w");
      }
      await waitFor(() => mutationRequests.length === 1, operation + " mutation request");

      if (lookupOutcome === "failure") {
        transitionLookup.resolve(new Response("old transition rejected", { status: 503 }));
      } else {
        transitionLookup.resolve(response({ transitions: [{ id: "done", name: "Done", to: { id: "2" }, fields: {} }] }));
      }
      await nextTurn();
      await nextTurn();
      const pendingPaint = await currentPaint(app, terminal);

      if (operation === "clear") await send(app, terminal, "x");
      else await send(app, terminal, "w");
      await nextTurn();
      const duplicateCount = mutationRequests.length;

      mutation.resolve(new Response("mutation rejected", { status: 400 }));
      await waitFor(() => terminal.output().includes("mutation rejected"), operation + " mutation failure");
      const settledPaint = await currentPaint(app, terminal);
      app.unmount();
      console.log(JSON.stringify({
        request: mutationRequests[0],
        transitionGets,
        duplicateCount,
        pendingDetail: pendingPaint.includes("Description"),
        pendingPickerAbsent: !pendingPaint.includes("Transition PROJ-1"),
        pendingWriteVisible: pendingPaint.includes("Saving") || pendingPaint.includes("Please wait"),
        staleErrorAbsent: !pendingPaint.includes("old transition rejected"),
        settledDetail: settledPaint.includes("Description"),
        settledPickerAbsent: !settledPaint.includes("Transition PROJ-1"),
      }));
    `,
  );
}

const detailMutationRequests = [
  [
    "clear",
    "success",
    {
      method: "PUT",
      path: "/rest/api/3/issue/PROJ-1",
      body: { fields: { assignee: null } },
    },
  ],
  [
    "watch",
    "failure",
    {
      method: "POST",
      path: "/rest/api/3/issue/PROJ-1/watchers",
      body: null,
    },
  ],
] as const;

for (const [operation, lookupOutcome, request] of detailMutationRequests) {
  test(`detail ${operation} invalidates an older ${lookupOutcome} transition lookup while its write stays locked`, async () => {
    expect(await runDetailMutationInvalidationCase(operation, lookupOutcome)).toEqual({
      request,
      transitionGets: 1,
      duplicateCount: 1,
      pendingDetail: true,
      pendingPickerAbsent: true,
      pendingWriteVisible: true,
      staleErrorAbsent: true,
      settledDetail: true,
      settledPickerAbsent: true,
    });
  });
}

test("the newest overlapping load owns rendered and cached board data", async () => {
  const result = await runBoardCase(
    "overlap",
    `
      const reloads = [];
      let issueCalls = 0;
      globalThis.fetch = async (input) => {
        const url = new URL(String(input));
        if (url.pathname === "/rest/api/3/field") return response([]);
        if (url.pathname.endsWith("/configuration")) return boardConfig();
        if (url.pathname.endsWith("/allData.json")) return response({});
        if (url.pathname.endsWith("/user/assignable/search")) return response([]);
        if (url.pathname.endsWith("/issue")) {
          issueCalls++;
          if (issueCalls === 1) return issuePage(issue("PROJ-1", "base state"));
          const request = deferred();
          reloads.push(request);
          return request.promise;
        }
        throw new Error("unexpected request: " + url);
      };

      const terminal = createTerminal();
      const app = mount(terminal);
      await waitFor(() => terminal.output().includes("base state"), "initial board");
      terminal.clearOutput();
      terminal.stdin.write("r");
      await waitFor(() => reloads.length === 1, "first refresh");
      terminal.stdin.write("r");
      await waitFor(() => reloads.length === 2, "second refresh");
      reloads[1].resolve(issuePage(issue("PROJ-1", "fresh state")));
      await waitFor(() => terminal.output().includes("fresh state"), "fresh render");
      await waitFor(async () => (await cache.readBoardCache(cfg, 7))?.issues[0]?.summary === "fresh state", "fresh cache write");
      reloads[0].resolve(issuePage(issue("PROJ-1", "stale state")));
      await nextTurn();
      await nextTurn();
      const saved = await cache.readBoardCache(cfg, 7);
      app.unmount();
      console.log(JSON.stringify({
        hasStale: terminal.output().includes("stale state"),
        cached: saved?.issues[0]?.summary,
      }));
    `,
  );

  expect(result).toEqual({ hasStale: false, cached: "fresh state" });
});

test("an unmounted board cannot commit or continue an old load", async () => {
  const result = await runBoardCase(
    "lifecycle",
    `
      const requests = [];
      let swimlaneCalls = 0;
      globalThis.fetch = async (input) => {
        const url = new URL(String(input));
        if (url.pathname === "/rest/api/3/field") return response([]);
        if (url.pathname.endsWith("/configuration")) return boardConfig();
        if (url.pathname.endsWith("/allData.json")) {
          swimlaneCalls++;
          return response({});
        }
        if (url.pathname.endsWith("/user/assignable/search")) return response([]);
        if (url.pathname.endsWith("/issue")) {
          const request = deferred();
          requests.push(request);
          return request.promise;
        }
        throw new Error("unexpected request: " + url);
      };

      const oldTerminal = createTerminal();
      const oldApp = mount(oldTerminal);
      await waitFor(() => requests.length === 1, "old load");
      oldApp.unmount();

      const freshTerminal = createTerminal();
      const freshApp = mount(freshTerminal);
      await waitFor(() => requests.length === 2, "fresh load");
      requests[1].resolve(issuePage(issue("PROJ-1", "fresh instance")));
      await waitFor(() => freshTerminal.output().includes("fresh instance"), "fresh instance render");
      await waitFor(async () => (await cache.readBoardCache(cfg, 7))?.issues[0]?.summary === "fresh instance", "fresh instance cache write");
      requests[0].resolve(issuePage(issue("PROJ-1", "disposed instance")));
      await nextTurn();
      await nextTurn();
      const saved = await cache.readBoardCache(cfg, 7);
      freshApp.unmount();
      console.log(JSON.stringify({
        cached: saved?.issues[0]?.summary,
        oldRendered: oldTerminal.output().includes("disposed instance"),
        swimlaneCalls,
        requestCount: requests.length,
      }));
    `,
  );

  expect(result).toEqual({
    cached: "fresh instance",
    oldRendered: false,
    swimlaneCalls: 1,
    requestCount: 2,
  });
});

test("a touch waits for the initial recents read and preserves saved entries", async () => {
  const result = await runBoardCase(
    "recents",
    `
      const { readdir, readFile } = await import("node:fs/promises");
      const { join } = await import("node:path");
      await cache.writeRecents(cfg, 7, [{ key: "OLD-1", summary: "Saved recent" }]);
      const readGate = deferred();
      let recentsReadStarted = false;
      const originalFile = Bun.file;
      Bun.file = (path, options) => {
        const file = originalFile(path, options);
        if (String(path).endsWith("-recents.json")) {
          const readJson = file.json.bind(file);
          file.json = async () => {
            recentsReadStarted = true;
            await readGate.promise;
            return readJson();
          };
        }
        return file;
      };
      globalThis.fetch = async (input) => {
        const url = new URL(String(input));
        if (url.pathname === "/rest/api/3/field") return response([]);
        if (url.pathname === "/rest/api/3/myself") {
          return response({ accountId: "me", displayName: "Me" });
        }
        if (url.pathname.endsWith("/configuration")) return boardConfig();
        if (url.pathname.endsWith("/allData.json")) return response({});
        if (url.pathname.endsWith("/user/assignable/search")) return response([]);
        if (url.pathname.endsWith("/issue")) {
          return issuePage(issue("PROJ-1", "Current card"));
        }
        if (url.pathname === "/rest/api/3/issue/PROJ-1") {
          const detail = issue("PROJ-1", "Current card");
          Object.assign(detail.fields, {
            components: [], fixVersions: [], subtasks: [], issuelinks: [],
            created: "2026-01-01T00:00:00.000Z",
          });
          return response(detail);
        }
        if (url.pathname.endsWith("/comment")) return response({ comments: [] });
        if (url.pathname.endsWith("/editmeta")) return response({ fields: {} });
        throw new Error("unexpected request: " + url);
      };

      const terminal = createTerminal();
      const app = mount(terminal);
      await waitFor(() => terminal.output().includes("Current card"), "board card");
      await waitFor(() => recentsReadStarted, "blocked recents read");
      await send(app, terminal, "v");
      const cacheDir = join(process.env.HOME, ".cache", "ifhj");
      const recentsFile = (await readdir(cacheDir)).find((name) => name.endsWith("-recents.json"));
      const beforeRelease = JSON.parse(await readFile(join(cacheDir, recentsFile), "utf8"));
      readGate.resolve();
      await waitFor(
        async () => (await cache.readRecents(cfg, 7))[0]?.key === "PROJ-1",
        "updated recents",
      );
      Bun.file = originalFile;
      const afterRelease = await cache.readRecents(cfg, 7);
      app.unmount();
      console.log(JSON.stringify({
        before: beforeRelease.recents.map((recent) => recent.key),
        after: afterRelease.map((recent) => recent.key),
      }));
    `,
  );

  expect(result).toEqual({ before: ["OLD-1"], after: ["PROJ-1", "OLD-1"] });
});

test("overlapping moves keep independent locks and a failure cannot clear successful focus", async () => {
  const result = await runBoardCase(
    "moves",
    `
      const posts = new Map();
      const confirmation = deferred();
      const detailKeys = [];
      let boardIssueCalls = 0;
      let transitionGets = 0;
      let assignPuts = 0;
      globalThis.fetch = async (input, init = {}) => {
        const url = new URL(String(input));
        const method = init.method ?? "GET";
        if (url.pathname === "/rest/api/3/field") return response([]);
        if (url.pathname === "/rest/api/3/myself") {
          return response({ accountId: "me", displayName: "Me" });
        }
        if (url.pathname.endsWith("/configuration")) return boardConfig();
        if (url.pathname.endsWith("/allData.json")) return response({});
        if (url.pathname.endsWith("/user/assignable/search")) return response([]);
        if (url.pathname.endsWith("/issue")) {
          boardIssueCalls++;
          if (boardIssueCalls <= 2) {
            return issuePage(issue("PROJ-1", "First card"), issue("PROJ-2", "Second card"));
          }
          return confirmation.promise;
        }
        const transitionKey = ["PROJ-1", "PROJ-2"].find(
          (key) => url.pathname === "/rest/api/3/issue/" + key + "/transitions",
        );
        if (transitionKey && method === "GET") {
          transitionGets++;
          return response({
            transitions: [{ id: "go", name: "Complete", to: { id: "2" }, fields: {} }],
          });
        }
        if (transitionKey && method === "POST") {
          const request = deferred();
          posts.set(transitionKey, request);
          return request.promise;
        }
        const detailKey = ["PROJ-1", "PROJ-2"].find(
          (key) => url.pathname === "/rest/api/3/issue/" + key,
        );
        if (detailKey && method === "PUT") {
          assignPuts++;
          return new Response(null, { status: 204 });
        }
        if (detailKey) {
          detailKeys.push(detailKey);
          const detail = issue(detailKey, detailKey === "PROJ-1" ? "First card" : "Second card", detailKey === "PROJ-1" ? "2" : "1");
          Object.assign(detail.fields, {
            components: [], fixVersions: [], subtasks: [], issuelinks: [],
            created: "2026-01-01T00:00:00.000Z",
          });
          return response(detail);
        }
        if (url.pathname.endsWith("/comment")) return response({ comments: [] });
        if (url.pathname.endsWith("/editmeta")) return response({ fields: {} });
        throw new Error("unexpected request: " + method + " " + url);
      };

      const terminal = createTerminal();
      const app = mount(terminal);
      await waitFor(() => terminal.output().includes("Second card"), "initial cards");
      await send(app, terminal, ">");
      await waitFor(() => posts.has("PROJ-1"), "first transition post");
      await send(app, terminal, "h");
      await send(app, terminal, "j");
      await send(app, terminal, ">");
      await waitFor(() => posts.has("PROJ-2"), "second transition post");

      await send(app, terminal, ">");
      const getsWhileLocked = transitionGets;
      await send(app, terminal, "r");
      await waitFor(() => boardIssueCalls === 2, "unrelated refresh");

      posts.get("PROJ-1").resolve(new Response(null, { status: 204 }));
      await waitFor(() => boardIssueCalls === 3, "successful move confirmation");
      posts.get("PROJ-2").resolve(new Response("rejected", { status: 500 }));
      await nextTurn();
      await send(app, terminal, "l");
      await send(app, terminal, "i");
      await send(app, terminal, "h");
      confirmation.resolve(
        issuePage(issue("PROJ-1", "First card", "2"), issue("PROJ-2", "Second card", "1")),
      );
      await nextTurn();
      await nextTurn();
      await send(app, terminal, "v");
      await waitFor(() => detailKeys.length === 1, "focused issue detail");
      app.unmount();
      console.log(JSON.stringify({
        transitionGets,
        getsWhileLocked,
        opened: detailKeys[0],
        boardIssueCalls,
        assignPuts,
      }));
    `,
  );

  expect(result).toEqual({
    transitionGets: 2,
    getsWhileLocked: 2,
    opened: "PROJ-1",
    boardIssueCalls: 3,
    assignPuts: 0,
  });
});

test("single-packet Down and next-column transition target the new issue", async () => {
  const result = await runBoardCase(
    "rapid-direct-transition",
    `
      const posts = [];
      let issueCalls = 0;
      globalThis.fetch = async (input, init = {}) => {
        const url = new URL(String(input));
        const method = init.method ?? "GET";
        if (url.pathname === "/rest/api/3/field") return response([]);
        if (url.pathname.endsWith("/configuration")) return boardConfig();
        if (url.pathname.endsWith("/allData.json")) return response({});
        if (url.pathname.endsWith("/user/assignable/search")) return response([]);
        if (url.pathname === "/rest/agile/1.0/board/7/issue") {
          issueCalls++;
          return issuePage(issue("PROBE-1", "First"), issue("PROBE-2", "Second", issueCalls > 1 ? "2" : "1"));
        }
        const key = ["PROBE-1", "PROBE-2"].find((candidate) =>
          url.pathname === "/rest/api/3/issue/" + candidate + "/transitions"
        );
        if (key && method === "GET") {
          return response({ transitions: [{ id: "done", name: "Done", to: { id: "2" }, fields: {} }] });
        }
        if (key && method === "POST") {
          posts.push(key);
          return new Response(null, { status: 204 });
        }
        throw new Error("unexpected request: " + method + " " + url);
      };
      const terminal = createTerminal();
      const app = mount(terminal);
      await waitFor(() => terminal.output().includes("Second"), "two cards");
      await send(app, terminal, "\\u001b[B>");
      await waitFor(() => posts.length === 1, "transition post");
      app.unmount();
      console.log(JSON.stringify({ posts }));
    `,
  );
  expect(result).toEqual({ posts: ["PROBE-2"] });
});

test("burst flat-to-swim toggle navigation transitions the swim issue", async () => {
  const result = await runBoardCase(
    "rapid-flat-to-swim",
    `
      const posts = [];
      globalThis.fetch = async (input, init = {}) => {
        const url = new URL(String(input));
        const method = init.method ?? "GET";
        if (url.pathname === "/rest/api/3/field") return response([]);
        if (url.pathname.endsWith("/configuration")) return boardConfig();
        if (url.pathname.endsWith("/allData.json")) {
          return response({ swimlanesData: { swimlaneStrategy: "assignee" } });
        }
        if (url.pathname.endsWith("/user/assignable/search")) return response([]);
        if (url.pathname === "/rest/agile/1.0/board/7/issue") {
          const first = issue("PROBE-1", "First");
          first.fields.assignee = { displayName: "Alpha" };
          const second = issue("PROBE-2", "Second");
          second.fields.assignee = { displayName: "Beta" };
          return issuePage(first, second);
        }
        const key = ["PROBE-1", "PROBE-2"].find((candidate) =>
          url.pathname === "/rest/api/3/issue/" + candidate + "/transitions"
        );
        if (key && method === "GET") {
          return response({ transitions: [{ id: "done", name: "Done", to: { id: "2" }, fields: {} }] });
        }
        if (key && method === "POST") {
          posts.push(key);
          return new Response(null, { status: 204 });
        }
        throw new Error("unexpected request: " + method + " " + url);
      };
      const terminal = createTerminal();
      const app = mount(terminal);
      await waitFor(() => terminal.output().includes("swimlanes"), "swimlane availability");
      terminal.stdin.write("s"); terminal.stdin.emit("readable");
      terminal.stdin.write("\\u001b[B"); terminal.stdin.emit("readable");
      terminal.stdin.write(">"); terminal.stdin.emit("readable");
      await waitFor(() => posts.length === 1, "swim transition post");
      app.unmount();
      console.log(JSON.stringify({ posts }));
    `,
  );
  expect(result).toEqual({ posts: ["PROBE-2"] });
});

test("burst swim-to-flat toggle navigation opens the flat issue", async () => {
  const result = await runBoardCase(
    "rapid-swim-to-flat",
    `
      const opened = [];
      globalThis.fetch = async (input) => {
        const url = new URL(String(input));
        if (url.pathname === "/rest/api/3/field") return response([]);
        if (url.pathname === "/rest/api/3/myself") return response({ accountId: "me" });
        if (url.pathname.endsWith("/configuration")) return boardConfig();
        if (url.pathname.endsWith("/allData.json")) {
          return response({ swimlanesData: { swimlaneStrategy: "assignee" } });
        }
        if (url.pathname.endsWith("/user/assignable/search")) return response([]);
        if (url.pathname === "/rest/agile/1.0/board/7/issue") {
          const first = issue("PROBE-1", "First");
          first.fields.assignee = { displayName: "Alpha" };
          const second = issue("PROBE-2", "Second");
          second.fields.assignee = { displayName: "Beta" };
          return issuePage(first, second);
        }
        if (url.pathname === "/rest/api/3/issue/PROBE-2") {
          opened.push("PROBE-2");
          const value = issue("PROBE-2", "Second");
          Object.assign(value.fields, { components: [], fixVersions: [], subtasks: [], issuelinks: [], created: "2026-01-01T00:00:00.000Z" });
          return response(value);
        }
        if (url.pathname.endsWith("/comment")) return response({ comments: [] });
        if (url.pathname.endsWith("/editmeta")) return response({ fields: {} });
        throw new Error("unexpected request: " + url);
      };
      const terminal = createTerminal();
      const app = mount(terminal);
      await waitFor(() => terminal.output().includes("swimlanes"), "swimlane availability");
      await send(app, terminal, "s");
      await waitFor(() => terminal.output().includes("lanes"), "swim view");
      terminal.stdin.write("s"); terminal.stdin.emit("readable");
      terminal.stdin.write("\\u001b[B"); terminal.stdin.emit("readable");
      terminal.stdin.write("v"); terminal.stdin.emit("readable");
      await waitFor(() => opened.length === 1, "flat detail request");
      app.unmount();
      console.log(JSON.stringify({ opened }));
    `,
  );
  expect(result).toEqual({ opened: ["PROBE-2"] });
});

test("highlight commit derives matches from the submitted callback value", async () => {
  const result = await runBoardCase(
    "rapid-highlight-submit",
    `
      const opened = [];
      globalThis.fetch = async (input) => {
        const url = new URL(String(input));
        if (url.pathname === "/rest/api/3/field") return response([]);
        if (url.pathname === "/rest/api/3/myself") return response({ accountId: "me" });
        if (url.pathname.endsWith("/configuration")) return boardConfig();
        if (url.pathname.endsWith("/allData.json")) return response({});
        if (url.pathname.endsWith("/user/assignable/search")) return response([]);
        if (url.pathname === "/rest/agile/1.0/board/7/issue") {
          return issuePage(issue("PROBE-1", "First"), issue("PROBE-2", "Second"));
        }
        if (url.pathname === "/rest/api/3/issue/PROBE-2") {
          opened.push("PROBE-2");
          const value = issue("PROBE-2", "Second");
          Object.assign(value.fields, { components: [], fixVersions: [], subtasks: [], issuelinks: [], created: "2026-01-01T00:00:00.000Z" });
          return response(value);
        }
        if (url.pathname.endsWith("/comment")) return response({ comments: [] });
        if (url.pathname.endsWith("/editmeta")) return response({ fields: {} });
        throw new Error("unexpected request: " + url);
      };
      const terminal = createTerminal();
      const app = mount(terminal);
      await waitFor(() => terminal.output().includes("Second"), "two cards");
      await send(app, terminal, "/");
      terminal.stdin.write("Second");
      terminal.stdin.emit("readable");
      terminal.stdin.write("\\r");
      terminal.stdin.emit("readable");
      await app.waitUntilRenderFlush();
      await send(app, terminal, "v");
      await waitFor(() => opened.length === 1, "highlighted issue detail");
      const output = terminal.output();
      app.unmount();
      console.log(JSON.stringify({ opened, falseNoMatch: !output.includes("No matches.") }));
    `,
  );
  expect(result).toEqual({ opened: ["PROBE-2"], falseNoMatch: true });
});

test("disposing a board cancels a queued coalesced reload", async () => {
  const result = await runBoardCase(
    "disposed-coalescer",
    `
      const posts = new Map();
      const confirmation = deferred();
      let boardIssueCalls = 0;
      globalThis.fetch = async (input, init = {}) => {
        const url = new URL(String(input));
        const method = init.method ?? "GET";
        if (url.pathname === "/rest/api/3/field") return response([]);
        if (url.pathname.endsWith("/configuration")) return boardConfig();
        if (url.pathname.endsWith("/allData.json")) return response({});
        if (url.pathname.endsWith("/user/assignable/search")) return response([]);
        if (url.pathname.endsWith("/issue")) {
          boardIssueCalls++;
          if (boardIssueCalls === 1) {
            return issuePage(issue("PROJ-1", "First card"), issue("PROJ-2", "Second card"));
          }
          if (boardIssueCalls === 2) return confirmation.promise;
          return issuePage(issue("PROJ-1", "unexpected trailing load", "2"));
        }
        const transitionKey = ["PROJ-1", "PROJ-2"].find(
          (key) => url.pathname === "/rest/api/3/issue/" + key + "/transitions",
        );
        if (transitionKey && method === "GET") {
          return response({
            transitions: [{ id: "go", name: "Complete", to: { id: "2" }, fields: {} }],
          });
        }
        if (transitionKey && method === "POST") {
          const request = deferred();
          posts.set(transitionKey, request);
          return request.promise;
        }
        throw new Error("unexpected request: " + method + " " + url);
      };

      const terminal = createTerminal();
      const app = mount(terminal);
      await waitFor(() => terminal.output().includes("Second card"), "initial cards");
      await send(app, terminal, ">");
      await waitFor(() => posts.has("PROJ-1"), "first post");
      await send(app, terminal, "h");
      await send(app, terminal, "j");
      await send(app, terminal, ">");
      await waitFor(() => posts.has("PROJ-2"), "second post");
      posts.get("PROJ-1").resolve(new Response(null, { status: 204 }));
      await waitFor(() => boardIssueCalls === 2, "first confirmation load");
      posts.get("PROJ-2").resolve(new Response(null, { status: 204 }));
      await nextTurn();
      app.unmount();
      confirmation.resolve(
        issuePage(issue("PROJ-1", "First card", "2"), issue("PROJ-2", "Second card", "2")),
      );
      await nextTurn();
      await nextTurn();
      console.log(JSON.stringify({ boardIssueCalls }));
    `,
  );

  expect(result).toEqual({ boardIssueCalls: 2 });
});

test("fresh configuration does not reuse users from the cached project", async () => {
  const result = await runBoardCase(
    "cached-project-users",
    `
      await cache.writeBoardCache(
        cfg,
        7,
        { name: "Cached board", projectKey: "OLD", columns: [{ name: "To Do", statusIds: ["1"] }] },
        [{
          id: 1, key: "OLD-1", summary: "Cached card", description: "", statusId: "1",
          statusName: "To Do", statusCategory: "new", updated: "", issueType: "Task", labels: [],
        }],
      );
      const freshConfig = deferred();
      const oldUsers = deferred();
      const userProjects = [];
      globalThis.fetch = async (input) => {
        const url = new URL(String(input));
        if (url.pathname === "/rest/api/3/field") return response([]);
        if (url.pathname.endsWith("/configuration")) return freshConfig.promise;
        if (url.pathname.endsWith("/issue")) {
          return issuePage(issue("NEW-1", "Fresh card"));
        }
        if (url.pathname.endsWith("/allData.json")) return response({});
        if (url.pathname.endsWith("/user/assignable/search")) {
          const project = url.searchParams.get("project");
          userProjects.push(project);
          if (project === "OLD") return oldUsers.promise;
          return response([{ accountId: "new", displayName: "New User" }]);
        }
        throw new Error("unexpected request: " + url);
      };

      const terminal = createTerminal();
      const app = mount(terminal);
      await waitFor(() => terminal.output().includes("Cached card"), "cached board");
      await waitFor(() => userProjects.includes("OLD"), "cached project users");
      freshConfig.resolve(boardConfig("NEW"));
      await waitFor(() => terminal.output().includes("Fresh card"), "fresh board");
      await waitFor(() => userProjects.includes("NEW"), "fresh project users");
      oldUsers.resolve(response([]));
      await nextTurn();
      await nextTurn();
      app.unmount();
      console.log(JSON.stringify({ userProjects }));
    `,
  );

  expect(result).toEqual({ userProjects: ["OLD", "NEW"] });
});

test("quick add routes types with extra required fields to full create", async () => {
  const result = await runBoardCase(
    "quick-required",
    `
      let creates = 0;
      globalThis.fetch = async (input, init = {}) => {
        const url = new URL(String(input));
        if (url.pathname === "/rest/api/3/field") return response([]);
        if (url.pathname.endsWith("/configuration")) return boardConfig();
        if (url.pathname.endsWith("/allData.json")) return response({});
        if (url.pathname.endsWith("/user/assignable/search")) return response([]);
        if (url.pathname === "/rest/agile/1.0/board/7/issue") {
          return issuePage(issue("PROJ-1", "Existing card"));
        }
        if (url.pathname === "/rest/api/3/issue/createmeta/PROJ/issuetypes") {
          return response({ issueTypes: [{ id: "1", name: "Task", subtask: false }] });
        }
        if (url.pathname === "/rest/api/3/issue/createmeta/PROJ/issuetypes/1") {
          return response({ fields: [
            { fieldId: "summary", name: "Summary", required: true, schema: { type: "string" } },
            { fieldId: "customfield_7", name: "Estimate", required: true, schema: { type: "number" } },
          ] });
        }
        if (url.pathname === "/rest/api/3/issueLinkType") return response({ issueLinkTypes: [] });
        if (url.pathname === "/rest/api/3/issue" && init.method === "POST") {
          creates++;
          return response({ key: "PROJ-9" }, 201);
        }
        throw new Error("unexpected request: " + (init.method ?? "GET") + " " + url);
      };

      const terminal = createTerminal();
      const app = mount(terminal);
      await waitFor(() => terminal.output().includes("Existing card"), "initial board");
      terminal.clearOutput();
      await send(app, terminal, "a");
      await waitFor(() => terminal.output().includes("Create issue"), "full create wizard");
      app.unmount();
      console.log(JSON.stringify({
        creates,
        fullCreate: terminal.output().includes("Create issue"),
        quickAdd: terminal.output().includes("Quick add ·"),
      }));
    `,
  );

  expect(result).toEqual({ creates: 0, fullCreate: true, quickAdd: false });
});

test("quick add keeps the created key when status lookup fails", async () => {
  const result = await runBoardCase(
    "quick-partial",
    `
      let creates = 0;
      let statusGets = 0;
      globalThis.fetch = async (input, init = {}) => {
        const url = new URL(String(input));
        if (url.pathname === "/rest/api/3/field") return response([]);
        if (url.pathname.endsWith("/configuration")) return boardConfig();
        if (url.pathname.endsWith("/allData.json")) return response({});
        if (url.pathname.endsWith("/user/assignable/search")) return response([]);
        if (url.pathname === "/rest/agile/1.0/board/7/issue") {
          return issuePage(issue("PROJ-1", "Existing card"));
        }
        if (url.pathname === "/rest/api/3/issue/createmeta/PROJ/issuetypes") {
          return response({ issueTypes: [{ id: "1", name: "Task", subtask: false }] });
        }
        if (url.pathname === "/rest/api/3/issue/createmeta/PROJ/issuetypes/1") {
          return response({ fields: [
            { fieldId: "summary", name: "Summary", required: true, schema: { type: "string" } },
          ] });
        }
        if (url.pathname === "/rest/api/3/issueLinkType") return response({ issueLinkTypes: [] });
        if (url.pathname === "/rest/api/3/issue" && init.method === "POST") {
          creates++;
          return response({ key: "PROJ-9" }, 201);
        }
        if (url.pathname === "/rest/api/3/issue/PROJ-9") {
          statusGets++;
          return new Response("status unavailable " + "longreason".repeat(30) + " FOLLOWUP_END", { status: 503 });
        }
        throw new Error("unexpected request: " + (init.method ?? "GET") + " " + url);
      };

      const terminal = createTerminal();
      const app = mount(terminal);
      await waitFor(() => terminal.output().includes("Existing card"), "initial board");
      terminal.clearOutput();
      await send(app, terminal, "a");
      await waitFor(() => terminal.output().includes("Quick add ·"), "quick add input");
      await send(app, terminal, "New card");
      await send(app, terminal, "\\r");
      await waitFor(() => terminal.output().includes("Created PROJ-9"), "partial create result");
      for (let page = 0; page < 10; page++) await send(app, terminal, "\\x10");
      const output = terminal.output();
      app.unmount();
      console.log(JSON.stringify({
        creates,
        statusGets,
        keptKey: output.includes("Created PROJ-9"),
        partial: output.includes("follow-up failed"),
        fullReason: output.includes("FOLLOWUP_END"),
      }));
    `,
  );

  expect(result).toEqual({
    creates: 1,
    statusGets: 1,
    keptKey: true,
    partial: true,
    fullReason: true,
  });
});

test("quick add routes a required postcreate transition through its field screen", async () => {
  const result = await runBoardCase(
    "quick-transition-fields",
    `
      let creates = 0;
      let transitionPosts = 0;
      globalThis.fetch = async (input, init = {}) => {
        const url = new URL(String(input));
        if (url.pathname === "/rest/api/3/field") return response([]);
        if (url.pathname.endsWith("/configuration")) return boardConfig();
        if (url.pathname.endsWith("/allData.json")) return response({});
        if (url.pathname.endsWith("/user/assignable/search")) return response([]);
        if (url.pathname === "/rest/agile/1.0/board/7/issue") {
          return issuePage(issue("PROJ-1", "Existing card"));
        }
        if (url.pathname === "/rest/api/3/issue/createmeta/PROJ/issuetypes") {
          return response({ issueTypes: [{ id: "1", name: "Task", subtask: false }] });
        }
        if (url.pathname === "/rest/api/3/issue/createmeta/PROJ/issuetypes/1") {
          return response({ fields: [
            { fieldId: "summary", name: "Summary", required: true, schema: { type: "string" } },
          ] });
        }
        if (url.pathname === "/rest/api/3/issueLinkType") return response({ issueLinkTypes: [] });
        if (url.pathname === "/rest/api/3/issue" && init.method === "POST") {
          creates++;
          return response({ key: "PROJ-9" }, 201);
        }
        if (url.pathname === "/rest/api/3/issue/PROJ-9") {
          return response({ fields: { status: { id: "1" } } });
        }
        if (url.pathname === "/rest/api/3/issue/PROJ-9/transitions" && init.method === undefined) {
          return response({ transitions: [{
            id: "done", name: "Done", to: { id: "2" }, fields: {
              resolution: {
                name: "Resolution", required: true, hasDefaultValue: false,
                schema: { type: "resolution" },
                allowedValues: [{ id: "10000", name: "Done" }],
              },
            },
          }] });
        }
        if (url.pathname.endsWith("/transitions") && init.method === "POST") {
          transitionPosts++;
          return new Response(null, { status: 204 });
        }
        throw new Error("unexpected request: " + (init.method ?? "GET") + " " + url);
      };

      const terminal = createTerminal();
      const app = mount(terminal);
      await waitFor(() => terminal.output().includes("Existing card"), "initial board");
      await send(app, terminal, "l");
      terminal.clearOutput();
      await send(app, terminal, "a");
      await waitFor(() => terminal.output().includes("Quick add ·"), "quick add input");
      await send(app, terminal, "Needs resolution");
      await send(app, terminal, "\\r");
      await waitFor(() => terminal.output().includes("Resolution"), "transition field screen");
      const output = terminal.output();
      app.unmount();
      console.log(JSON.stringify({
        creates,
        transitionPosts,
        screen: output.includes("Resolution"),
        keptKey: output.includes("PROJ-9"),
      }));
    `,
  );

  expect(result).toEqual({ creates: 1, transitionPosts: 0, screen: true, keptKey: true });
});

test("quick-add follow-up cannot replace newer navigation", async () => {
  const result = await runBoardCase(
    "quick-followup-navigation",
    `
      const transitions = deferred();
      let transitionRequested = false;
      globalThis.fetch = async (input, init = {}) => {
        const url = new URL(String(input));
        if (url.pathname === "/rest/api/3/field") return response([]);
        if (url.pathname.endsWith("/configuration")) return boardConfig();
        if (url.pathname.endsWith("/allData.json")) return response({});
        if (url.pathname.endsWith("/user/assignable/search")) return response([]);
        if (url.pathname === "/rest/agile/1.0/board/7/issue") return issuePage(issue("PROJ-1", "Existing"));
        if (url.pathname === "/rest/api/3/issue/createmeta/PROJ/issuetypes") {
          return response({ issueTypes: [{ id: "1", name: "Task", subtask: false }] });
        }
        if (url.pathname === "/rest/api/3/issue/createmeta/PROJ/issuetypes/1") {
          return response({ fields: [{ fieldId: "summary", name: "Title", required: true, schema: { type: "string" } }] });
        }
        if (url.pathname === "/rest/api/3/issueLinkType") return response({ issueLinkTypes: [] });
        if (url.pathname === "/rest/api/3/issue" && init.method === "POST") return response({ key: "PROJ-9" }, 201);
        if (url.pathname === "/rest/api/3/issue/PROJ-9") return response({ fields: { status: { id: "1" } } });
        if (url.pathname === "/rest/api/3/issue/PROJ-9/transitions") {
          transitionRequested = true;
          return transitions.promise;
        }
        throw new Error("unexpected request: " + (init.method ?? "GET") + " " + url);
      };
      const terminal = createTerminal();
      const app = mount(terminal);
      await waitFor(() => terminal.output().includes("Existing"), "board");
      await send(app, terminal, "l");
      await send(app, terminal, "a");
      await waitFor(() => terminal.output().includes("Quick add"), "quick add");
      await send(app, terminal, "Created card");
      await send(app, terminal, "\\r");
      await waitFor(() => transitionRequested, "post-create transition lookup");
      await send(app, terminal, "J");
      await waitFor(() => terminal.output().includes("JQL query"), "newer JQL navigation");
      terminal.clearOutput();
      transitions.resolve(response({ transitions: [{ id: "done", name: "Done", to: { id: "2" }, fields: {
        customfield_1: { name: "Estimate", required: true, hasDefaultValue: false, schema: { type: "number" } },
      } }] }));
      await nextTurn();
      await nextTurn();
      const output = terminal.output();
      app.unmount();
      console.log(JSON.stringify({ replaced: output.includes("Estimate") }));
    `,
  );
  expect(result).toEqual({ replaced: false });
});

test("detail users and subtask metadata use the issue project", async () => {
  const result = await runBoardCase(
    "issue-project",
    `
      const userProjects = [];
      const typeProjects = [];
      globalThis.fetch = async (input) => {
        const url = new URL(String(input));
        if (url.pathname === "/rest/api/3/field") return response([]);
        if (url.pathname.endsWith("/configuration")) return boardConfig("PROJ");
        if (url.pathname.endsWith("/allData.json")) return response({});
        if (url.pathname.endsWith("/user/assignable/search")) {
          userProjects.push(url.searchParams.get("project"));
          return response([{ accountId: "u", displayName: "User" }]);
        }
        if (url.pathname === "/rest/agile/1.0/board/7/issue") {
          return issuePage(issue("OTHER-1", "Other project card"));
        }
        if (url.pathname === "/rest/api/3/myself") {
          return response({ accountId: "me", displayName: "Me" });
        }
        if (url.pathname === "/rest/api/3/issue/OTHER-1") {
          const detail = issue("OTHER-1", "Other project card");
          Object.assign(detail.fields, {
            project: { key: "OTHER" },
            issuetype: { id: "10", name: "Task", subtask: false },
            components: [], fixVersions: [], subtasks: [], issuelinks: [],
            created: "2026-01-01T00:00:00.000Z",
          });
          return response(detail);
        }
        if (url.pathname.endsWith("/comment")) return response({ comments: [] });
        if (url.pathname.endsWith("/editmeta")) return response({ fields: {
          assignee: { name: "Assignee", required: false, schema: { type: "user" } },
        } });
        if (url.pathname.includes("/createmeta/") && url.pathname.endsWith("/issuetypes")) {
          typeProjects.push(url.pathname.split("/createmeta/")[1].split("/")[0]);
          return response({ issueTypes: [
            { id: "10", name: "Standard", subtask: false },
            { id: "11", name: "Child", subtask: true },
          ] });
        }
        if (url.pathname === "/rest/api/3/issueLinkType") return response({ issueLinkTypes: [] });
        throw new Error("unexpected request: " + url);
      };

      const terminal = createTerminal();
      const app = mount(terminal);
      await waitFor(() => terminal.output().includes("Other project card"), "board card");
      await send(app, terminal, "v");
      await waitFor(() => terminal.output().includes("Description"), "detail view");
      await send(app, terminal, "\\t");
      await send(app, terminal, "j");
      await send(app, terminal, "\\r");
      await waitFor(() => userProjects.includes("OTHER"), "detail project users");
      await send(app, terminal, "\\u001b");
      await send(app, terminal, "C");
      await waitFor(() => typeProjects.includes("OTHER"), "subtask project metadata");
      await waitFor(() => terminal.output().includes("Create issue"), "subtask wizard");
      await send(app, terminal, "\\u001b[B");
      await send(app, terminal, "\\u001b[B");
      await send(app, terminal, "\\r");
      await nextTurn();
      const output = terminal.output();
      app.unmount();
      console.log(JSON.stringify({
        userProjects,
        typeProjects,
        childShown: output.includes("Child"),
        standardShown: output.includes("Standard"),
      }));
    `,
  );

  expect(result).toEqual({
    userProjects: ["PROJ", "OTHER"],
    typeProjects: ["OTHER"],
    childShown: true,
    standardShown: false,
  });
}, 20_000);

test("refresh preserves the selected issue key when rows reorder", async () => {
  const result = await runBoardCase(
    "selection-key",
    `
      let boardCalls = 0;
      const opened = [];
      globalThis.fetch = async (input) => {
        const url = new URL(String(input));
        if (url.pathname === "/rest/api/3/field") return response([]);
        if (url.pathname === "/rest/api/3/myself") return response({ accountId: "me", displayName: "Me" });
        if (url.pathname.endsWith("/configuration")) return boardConfig();
        if (url.pathname.endsWith("/allData.json")) return response({});
        if (url.pathname.endsWith("/user/assignable/search")) return response([]);
        if (url.pathname === "/rest/agile/1.0/board/7/issue") {
          boardCalls++;
          return boardCalls === 1
            ? issuePage(issue("PROJ-1", "First"), issue("PROJ-2", "Selected"))
            : issuePage(issue("PROJ-9", "Inserted"), issue("PROJ-1", "First"), issue("PROJ-2", "Selected"));
        }
        if (url.pathname === "/rest/api/3/issue/PROJ-2") {
          opened.push("PROJ-2");
          const value = issue("PROJ-2", "Selected");
          Object.assign(value.fields, { components: [], fixVersions: [], subtasks: [], issuelinks: [], created: "2026-01-01T00:00:00.000Z" });
          return response(value);
        }
        if (url.pathname.endsWith("/comment")) return response({ comments: [] });
        if (url.pathname.endsWith("/editmeta")) return response({ fields: {} });
        throw new Error("unexpected request: " + url);
      };
      const terminal = createTerminal();
      const app = mount(terminal);
      await waitFor(() => terminal.output().includes("Selected"), "initial issues");
      await send(app, terminal, "j");
      await send(app, terminal, "r");
      await waitFor(() => boardCalls === 2, "refreshed issues");
      await send(app, terminal, "v");
      await waitFor(() => opened.length === 1, "selected detail");
      app.unmount();
      console.log(JSON.stringify({ opened: opened[0] }));
    `,
  );
  expect(result).toEqual({ opened: "PROJ-2" });
});

test("a cancelled detail transition cannot reopen from a late response", async () => {
  const result = await runBoardCase(
    "stale-detail-transition",
    `
      const transition = deferred();
      globalThis.fetch = async (input) => {
        const url = new URL(String(input));
        if (url.pathname === "/rest/api/3/field") return response([]);
        if (url.pathname === "/rest/api/3/myself") return response({ accountId: "me", displayName: "Me" });
        if (url.pathname.endsWith("/configuration")) return boardConfig();
        if (url.pathname.endsWith("/allData.json")) return response({});
        if (url.pathname.endsWith("/user/assignable/search")) return response([]);
        if (url.pathname === "/rest/agile/1.0/board/7/issue") return issuePage(issue("PROJ-1", "Card"));
        if (url.pathname === "/rest/api/3/issue/PROJ-1/transitions") return transition.promise;
        if (url.pathname === "/rest/api/3/issue/PROJ-1") {
          const value = issue("PROJ-1", "Card");
          Object.assign(value.fields, { components: [], fixVersions: [], subtasks: [], issuelinks: [], created: "2026-01-01T00:00:00.000Z" });
          return response(value);
        }
        if (url.pathname.endsWith("/comment")) return response({ comments: [] });
        if (url.pathname.endsWith("/editmeta")) return response({ fields: {} });
        throw new Error("unexpected request: " + url);
      };
      const terminal = createTerminal();
      const app = mount(terminal);
      await waitFor(() => terminal.output().includes("Card"), "board");
      await send(app, terminal, "v");
      await waitFor(() => terminal.output().includes("Description"), "detail");
      await send(app, terminal, "t");
      await send(app, terminal, "\\u001b");
      terminal.clearOutput();
      transition.resolve(response({ transitions: [{ id: "done", name: "Done", to: { id: "2" }, fields: {} }] }));
      await nextTurn();
      await nextTurn();
      const output = terminal.output();
      app.unmount();
      console.log(JSON.stringify({ reopened: output.includes("Transition PROJ-1") }));
    `,
  );
  expect(result).toEqual({ reopened: false });
});

test("detail inline title invalidates a pending transition launch", async () => {
  const result = await runBoardCase(
    "detail-local-title-guard",
    `
      const transition = deferred();
      globalThis.fetch = async (input) => {
        const url = new URL(String(input));
        if (url.pathname === "/rest/api/3/field") return response([]);
        if (url.pathname === "/rest/api/3/myself") return response({ accountId: "me", displayName: "Me" });
        if (url.pathname.endsWith("/configuration")) return boardConfig();
        if (url.pathname.endsWith("/allData.json")) return response({});
        if (url.pathname.endsWith("/user/assignable/search")) return response([]);
        if (url.pathname === "/rest/agile/1.0/board/7/issue") return issuePage(issue("PROJ-1", "Card"));
        if (url.pathname === "/rest/api/3/issue/PROJ-1/transitions") return transition.promise;
        if (url.pathname === "/rest/api/3/issue/PROJ-1") {
          const value = issue("PROJ-1", "Card");
          Object.assign(value.fields, { components: [], fixVersions: [], subtasks: [], issuelinks: [], created: "2026-01-01T00:00:00.000Z" });
          return response(value);
        }
        if (url.pathname.endsWith("/comment")) return response({ comments: [] });
        if (url.pathname.endsWith("/editmeta")) return response({ fields: {} });
        throw new Error("unexpected request: " + url);
      };
      const terminal = createTerminal();
      const app = mount(terminal);
      await waitFor(() => terminal.output().includes("Card"), "board");
      await send(app, terminal, "v");
      await waitFor(() => terminal.output().includes("Description"), "detail");
      await send(app, terminal, "t");
      await send(app, terminal, "e");
      await waitFor(() => terminal.output().includes("Title"), "inline title");
      terminal.clearOutput();
      transition.resolve(response({ transitions: [{ id: "done", name: "Done", to: { id: "2" }, fields: {} }] }));
      await nextTurn();
      await nextTurn();
      const output = terminal.output();
      app.unmount();
      console.log(JSON.stringify({ replaced: output.includes("Transition PROJ-1") }));
    `,
  );
  expect(result).toEqual({ replaced: false });
});

test("detail external editor invalidates a pending transition launch", async () => {
  const result = await runBoardCase(
    "detail-local-editor-guard",
    `
      const transition = deferred();
      const editorExit = deferred();
      let editorStarted = false;
      globalThis.fetch = async (input) => {
        const url = new URL(String(input));
        if (url.pathname === "/rest/api/3/field") return response([]);
        if (url.pathname === "/rest/api/3/myself") return response({ accountId: "me", displayName: "Me" });
        if (url.pathname.endsWith("/configuration")) return boardConfig();
        if (url.pathname.endsWith("/allData.json")) return response({});
        if (url.pathname.endsWith("/user/assignable/search")) return response([]);
        if (url.pathname === "/rest/agile/1.0/board/7/issue") return issuePage(issue("PROJ-1", "Card"));
        if (url.pathname === "/rest/api/3/issue/PROJ-1/transitions") return transition.promise;
        if (url.pathname === "/rest/api/3/issue/PROJ-1") {
          const value = issue("PROJ-1", "Card");
          Object.assign(value.fields, { components: [], fixVersions: [], subtasks: [], issuelinks: [], created: "2026-01-01T00:00:00.000Z" });
          return response(value);
        }
        if (url.pathname.endsWith("/comment")) return response({ comments: [] });
        if (url.pathname.endsWith("/editmeta")) return response({ fields: {} });
        throw new Error("unexpected request: " + url);
      };
      const originalWhich = Bun.which;
      const originalSpawn = Bun.spawn;
      const originalWrite = process.stdout.write;
      Bun.which = () => "/mock/editor";
      Bun.spawn = () => {
        editorStarted = true;
        return { exitCode: 0, exited: editorExit.promise };
      };
      const terminal = createTerminal();
      const app = mount(terminal);
      try {
        await waitFor(() => terminal.output().includes("Card"), "board");
        await send(app, terminal, "v");
        await waitFor(() => terminal.output().includes("Description"), "detail");
        await send(app, terminal, "t");
        process.stdout.write = () => true;
        terminal.stdin.write("E");
        await waitFor(() => editorStarted, "fake editor handoff");
        transition.resolve(response({ transitions: [{ id: "done", name: "Done", to: { id: "2" }, fields: {} }] }));
        terminal.stdin.write("x");
        await nextTurn();
        editorExit.resolve(0);
        await nextTurn();
        await nextTurn();
      } finally {
        process.stdout.write = originalWrite;
        Bun.which = originalWhich;
        Bun.spawn = originalSpawn;
      }
      const output = terminal.output();
      app.unmount();
      console.log(JSON.stringify({ replaced: output.includes("Transition PROJ-1") }));
    `,
  );
  expect(result).toEqual({ replaced: false });
});

test("board navigation invalidates a pending transition picker launch", async () => {
  const result = await runBoardCase(
    "stale-board-transition",
    `
      const transition = deferred();
      globalThis.fetch = async (input) => {
        const url = new URL(String(input));
        if (url.pathname === "/rest/api/3/field") return response([]);
        if (url.pathname.endsWith("/configuration")) return boardConfig();
        if (url.pathname.endsWith("/allData.json")) return response({});
        if (url.pathname.endsWith("/user/assignable/search")) return response([]);
        if (url.pathname === "/rest/agile/1.0/board/7/issue") return issuePage(issue("PROJ-1", "Card"));
        if (url.pathname === "/rest/api/3/issue/PROJ-1/transitions") return transition.promise;
        throw new Error("unexpected request: " + url);
      };
      const terminal = createTerminal();
      const app = mount(terminal);
      await waitFor(() => terminal.output().includes("Card"), "board");
      await send(app, terminal, "t");
      await send(app, terminal, "e");
      await waitFor(() => terminal.output().includes("Edit title"), "newer title screen");
      terminal.clearOutput();
      transition.resolve(response({ transitions: [{ id: "done", name: "Done", to: { id: "2" }, fields: {} }] }));
      await nextTurn();
      await nextTurn();
      const output = terminal.output();
      app.unmount();
      console.log(JSON.stringify({ replaced: output.includes("Transition PROJ-1") }));
    `,
  );
  expect(result).toEqual({ replaced: false });
});

test("Escape cancels a pending move lookup and suppresses its late screen", async () => {
  const result = await runBoardCase(
    "cancelled-move-lookup",
    `
      const transition = deferred();
      globalThis.fetch = async (input) => {
        const url = new URL(String(input));
        if (url.pathname === "/rest/api/3/field") return response([]);
        if (url.pathname.endsWith("/configuration")) return boardConfig();
        if (url.pathname.endsWith("/allData.json")) return response({});
        if (url.pathname.endsWith("/user/assignable/search")) return response([]);
        if (url.pathname === "/rest/agile/1.0/board/7/issue") return issuePage(issue("PROJ-1", "Card"));
        if (url.pathname === "/rest/api/3/issue/PROJ-1/transitions") return transition.promise;
        throw new Error("unexpected request: " + url);
      };
      const terminal = createTerminal();
      const app = mount(terminal);
      await waitFor(() => terminal.output().includes("Card"), "board");
      await send(app, terminal, "m");
      await send(app, terminal, "\\u001b[B");
      await send(app, terminal, "\\r");
      await waitFor(() => terminal.output().includes("Loading transitions"), "move lookup");
      await send(app, terminal, "\\u001b");
      terminal.clearOutput();
      transition.resolve(response({ transitions: [{ id: "done", name: "Done", to: { id: "2" }, fields: {
        customfield_1: { name: "Estimate", required: true, hasDefaultValue: false, schema: { type: "number" } },
      } }] }));
      await nextTurn();
      await nextTurn();
      const output = terminal.output();
      app.unmount();
      console.log(JSON.stringify({ reopened: output.includes("Estimate") }));
    `,
  );
  expect(result).toEqual({ reopened: false });
});

test("80x24 move lookup error stays bounded with recovery controls and full reason", async () => {
  const result = await runBoardCase(
    "bounded-move-error",
    `
      Object.defineProperty(process.stdout, "columns", { value: 80, configurable: true });
      Object.defineProperty(process.stdout, "rows", { value: 24, configurable: true });
      const reason = "wideword".repeat(30) + " MOVE_END";
      globalThis.fetch = async (input) => {
        const url = new URL(String(input));
        if (url.pathname === "/rest/api/3/field") return response([]);
        if (url.pathname.endsWith("/configuration")) return boardConfig();
        if (url.pathname.endsWith("/allData.json")) return response({});
        if (url.pathname.endsWith("/user/assignable/search")) return response([]);
        if (url.pathname === "/rest/agile/1.0/board/7/issue") return issuePage(issue("PROJ-1", "Card"));
        if (url.pathname === "/rest/api/3/issue/PROJ-1/transitions") {
          return new Response(reason, { status: 503 });
        }
        throw new Error("unexpected request: " + url);
      };
      const terminal = createTerminal(80, 24);
      const app = mount(terminal);
      await waitFor(() => terminal.output().includes("Card"), "board");
      await send(app, terminal, "m");
      await send(app, terminal, "\\u001b[B");
      await send(app, terminal, "\\r");
      await waitFor(() => terminal.output().includes("Ctrl+P error"), "bounded move error");
      Object.defineProperty(process.stdout, "columns", { value: 81, configurable: true });
      terminal.stdout.columns = 81;
      process.stdout.emit("resize");
      await nextTurn();
      await app.waitUntilRenderFlush();
      terminal.clearOutput();
      Object.defineProperty(process.stdout, "columns", { value: 80, configurable: true });
      terminal.stdout.columns = 80;
      process.stdout.emit("resize");
      await nextTurn();
      await app.waitUntilRenderFlush();
      const first = Bun.stripANSI(terminal.output());
      for (let page = 0; page < 10; page++) await send(app, terminal, "\\x10");
      const output = terminal.output();
      app.unmount();
      console.log(JSON.stringify({
        bounded: first.split("\\n").length <= 24,
        controls: first.includes("esc cancel"),
        full: output.includes("MOVE_END"),
      }));
    `,
  );
  expect(result).toEqual({ bounded: true, controls: true, full: true });
});

test("three long errors leave a complete selected rich card visible at 80x24", async () => {
  const result = await runBoardCase(
    "toast-card-space",
    `
      Object.defineProperty(process.stdout, "columns", { value: 80, configurable: true });
      Object.defineProperty(process.stdout, "rows", { value: 24, configurable: true });
      let transitionGets = 0;
      globalThis.fetch = async (input) => {
        const url = new URL(String(input));
        if (url.pathname === "/rest/api/3/field") return response([]);
        if (url.pathname.endsWith("/configuration")) return boardConfig();
        if (url.pathname.endsWith("/allData.json")) return response({});
        if (url.pathname.endsWith("/user/assignable/search")) return response([]);
        if (url.pathname === "/rest/agile/1.0/board/7/issue") {
          return issuePage(
            issue("PROBE-1", "First card"),
            issue("PROBE-2", "Second card"),
            issue("PROBE-3", "Third card"),
            issue("PROBE-4", "Fourth card"),
            issue("PROBE-5", "Fifth card"),
          );
        }
        if (url.pathname === "/rest/api/3/issue/PROBE-1/transitions") {
          transitionGets++;
          return new Response("long failure " + "reason".repeat(40) + " END_" + transitionGets, { status: 503 });
        }
        throw new Error("unexpected request: " + url);
      };
      const terminal = createTerminal(80, 24);
      const app = mount(terminal);
      await waitFor(() => terminal.output().includes("Second card"), "three cards");
      for (let index = 0; index < 3; index++) {
        await send(app, terminal, "t");
        await waitFor(() => transitionGets === index + 1, "failed transition " + index);
      }
      terminal.clearOutput();
      await send(app, terminal, "\\u001b[B");
      await send(app, terminal, "\\u001b[B");
      Object.defineProperty(process.stdout, "columns", { value: 81, configurable: true });
      terminal.stdout.columns = 81;
      process.stdout.emit("resize");
      await nextTurn();
      await app.waitUntilRenderFlush();
      terminal.clearOutput();
      Object.defineProperty(process.stdout, "columns", { value: 80, configurable: true });
      terminal.stdout.columns = 80;
      process.stdout.emit("resize");
      await nextTurn();
      await app.waitUntilRenderFlush();
      const output = Bun.stripANSI(terminal.output());
      const footer = output.indexOf("──────────────────────────────────────────────────────────────────────────────");
      const grid = output.slice(0, footer);
      app.unmount();
      console.log(JSON.stringify({
        bounded: output.split("\\n").length <= 24,
        key: grid.includes("PROBE-3"),
        title: grid.includes("Third card"),
        assignee: grid.includes("Unassigned"),
        above: grid.includes("^ 1 more"),
        below: grid.includes("v 2 more"),
      }));
    `,
  );
  expect(result).toEqual({
    bounded: true,
    key: true,
    title: true,
    assignee: true,
    above: true,
    below: true,
  });
});

test("Ctrl+G clears combined Board and detail notifications without moving selection", async () => {
  const result = await runBoardCase(
    "dismiss-combined-detail-notifications",
    `
      Object.defineProperty(process.stdout, "columns", { value: 80, configurable: true });
      Object.defineProperty(process.stdout, "rows", { value: 24, configurable: true });
      const detailGets = [];
      globalThis.fetch = async (input) => {
        const url = new URL(String(input));
        if (url.pathname === "/rest/api/3/field") return response([]);
        if (url.pathname === "/rest/api/3/myself") return response({ accountId: "me" });
        if (url.pathname.endsWith("/configuration")) return boardConfig();
        if (url.pathname.endsWith("/allData.json")) return response({});
        if (url.pathname.endsWith("/user/assignable/search")) return response([]);
        if (url.pathname === "/rest/agile/1.0/board/7/issue") {
          return issuePage(issue("PROJ-1", "First"), issue("PROJ-2", "Second"));
        }
        if (url.pathname === "/rest/api/3/issue/PROJ-2/transitions") {
          return new Response("transition denied", { status: 503 });
        }
        if (url.pathname === "/rest/api/3/issue/PROJ-2") {
          detailGets.push("PROJ-2");
          const value = issue("PROJ-2", "Second");
          Object.assign(value.fields, { components: [], fixVersions: [], subtasks: [], issuelinks: [], created: "2026-01-01T00:00:00.000Z" });
          return response(value);
        }
        if (url.pathname.endsWith("/comment")) return response({ comments: [] });
        if (url.pathname.endsWith("/editmeta")) return response({ fields: {} });
        throw new Error("unexpected request: " + url);
      };
      const terminal = createTerminal(80, 24);
      const app = mount(terminal);
      await waitFor(() => terminal.output().includes("Second"), "board");
      await send(app, terminal, "\\u001b[B");
      await send(app, terminal, "t");
      await waitFor(() => terminal.output().includes("transition denied"), "Board notification");
      await send(app, terminal, "v");
      await waitFor(() => terminal.output().includes("Description"), "detail");
      await send(app, terminal, "\\t");
      await send(app, terminal, "\\u001b[B");
      await send(app, terminal, "\\u001b[B");
      await send(app, terminal, "\\u001b[B");
      await send(app, terminal, "x");
      await waitFor(() => terminal.output().includes("Not editable"), "local detail notification");
      const before = await currentPaint(app, terminal, 80);
      await send(app, terminal, "\\x07");
      const after = await currentPaint(app, terminal, 80);
      await send(app, terminal, "q");
      const board = await currentPaint(app, terminal, 80);
      app.unmount();
      console.log(JSON.stringify({
        beforeExternal: before.includes("transition denied"),
        beforeLocal: before.includes("Not editable"),
        dismissHint: before.includes("Ctrl+G dismiss"),
        beforeBounded: before.split("\\n").length <= 24,
        afterExternal: after.includes("transition denied"),
        afterLocal: after.includes("Not editable"),
        fieldSelection: after.includes("> priority"),
        detailIssue: after.includes("PROJ-2"),
        boardExternal: board.includes("transition denied"),
        boardIssue: board.includes("PROJ-2"),
        detailGets,
      }));
    `,
  );
  expect(result).toEqual({
    beforeExternal: true,
    beforeLocal: true,
    dismissHint: true,
    beforeBounded: true,
    afterExternal: false,
    afterLocal: false,
    fieldSelection: true,
    detailIssue: true,
    boardExternal: false,
    boardIssue: true,
    detailGets: ["PROJ-2"],
  });
});

test("Ctrl+G does not dismiss a controlled title error or change its draft", async () => {
  const result = await runBoardCase(
    "controlled-title-error-not-dismissible",
    `
      const puts = [];
      globalThis.fetch = async (input, init = {}) => {
        const url = new URL(String(input));
        if (url.pathname === "/rest/api/3/field") return response([]);
        if (url.pathname.endsWith("/configuration")) return boardConfig();
        if (url.pathname.endsWith("/allData.json")) return response({});
        if (url.pathname.endsWith("/user/assignable/search")) return response([]);
        if (url.pathname === "/rest/agile/1.0/board/7/issue") return issuePage(issue("PROJ-1", "Card"));
        if (url.pathname === "/rest/api/3/issue/PROJ-1" && init.method === "PUT") {
          puts.push(JSON.parse(String(init.body)));
          return new Response("title rejected", { status: 400 });
        }
        throw new Error("unexpected request: " + (init.method ?? "GET") + " " + url);
      };
      const terminal = createTerminal();
      const app = mount(terminal);
      await waitFor(() => terminal.output().includes("Card"), "board");
      await send(app, terminal, "e");
      await send(app, terminal, " draft");
      await send(app, terminal, "\\r");
      await waitFor(() => terminal.output().includes("Could not save title"), "controlled title error");
      const before = await currentPaint(app, terminal);
      await send(app, terminal, "\\x07");
      const after = await currentPaint(app, terminal);
      app.unmount();
      console.log(JSON.stringify({
        beforeDraft: before.includes("Card draft"),
        beforeError: before.includes("title rejected"),
        beforeDismissHint: before.includes("Ctrl+G dismiss"),
        afterDraft: after.includes("Card draft"),
        afterError: after.includes("title rejected"),
        puts,
      }));
    `,
  );
  expect(result).toEqual({
    beforeDraft: true,
    beforeError: true,
    beforeDismissHint: false,
    afterDraft: true,
    afterError: true,
    puts: [{ fields: { summary: "Card draft" } }],
  });
});

test("unmount invalidates a pending modal launch", async () => {
  const result = await runBoardCase(
    "unmounted-modal-launch",
    `
      const transition = deferred();
      let requested = false;
      globalThis.fetch = async (input) => {
        const url = new URL(String(input));
        if (url.pathname === "/rest/api/3/field") return response([]);
        if (url.pathname.endsWith("/configuration")) return boardConfig();
        if (url.pathname.endsWith("/allData.json")) return response({});
        if (url.pathname.endsWith("/user/assignable/search")) return response([]);
        if (url.pathname === "/rest/agile/1.0/board/7/issue") return issuePage(issue("PROJ-1", "Card"));
        if (url.pathname === "/rest/api/3/issue/PROJ-1/transitions") {
          requested = true;
          return transition.promise;
        }
        throw new Error("unexpected request: " + url);
      };
      const terminal = createTerminal();
      const app = mount(terminal);
      await waitFor(() => terminal.output().includes("Card"), "board");
      await send(app, terminal, "t");
      await waitFor(() => requested, "transition lookup");
      terminal.clearOutput();
      app.unmount();
      transition.resolve(response({ transitions: [{ id: "done", name: "Done", to: { id: "2" }, fields: {} }] }));
      await nextTurn();
      await nextTurn();
      console.log(JSON.stringify({ latePaint: terminal.output().includes("Transition PROJ-1") }));
    `,
  );
  expect(result).toEqual({ latePaint: false });
});

test("move cancellation returns to detail with its field-pane focus", async () => {
  const result = await runBoardCase(
    "detail-move-return",
    `
      globalThis.fetch = async (input) => {
        const url = new URL(String(input));
        if (url.pathname === "/rest/api/3/field") return response([]);
        if (url.pathname === "/rest/api/3/myself") return response({ accountId: "me", displayName: "Me" });
        if (url.pathname.endsWith("/configuration")) return boardConfig();
        if (url.pathname.endsWith("/allData.json")) return response({});
        if (url.pathname.endsWith("/user/assignable/search")) return response([]);
        if (url.pathname === "/rest/agile/1.0/board/7/issue") return issuePage(issue("PROJ-1", "Card"));
        if (url.pathname === "/rest/api/3/issue/PROJ-1") {
          const value = issue("PROJ-1", "Card");
          Object.assign(value.fields, { components: [], fixVersions: [], subtasks: [], issuelinks: [], created: "2026-01-01T00:00:00.000Z" });
          return response(value);
        }
        if (url.pathname.endsWith("/comment")) return response({ comments: [] });
        if (url.pathname.endsWith("/editmeta")) return response({ fields: {} });
        throw new Error("unexpected request: " + url);
      };
      const terminal = createTerminal();
      const app = mount(terminal);
      await waitFor(() => terminal.output().includes("Card"), "board");
      await send(app, terminal, "v");
      await waitFor(() => terminal.output().includes("Description"), "detail");
      await send(app, terminal, "\\t");
      await waitFor(() => terminal.output().includes("> status"), "field pane");
      await send(app, terminal, "m");
      await waitFor(() => terminal.output().includes("Move PROJ-1 to"), "move picker");
      terminal.clearOutput();
      await send(app, terminal, "\\u001b");
      await waitFor(() => terminal.output().includes("> status"), "restored field pane");
      const output = terminal.output();
      app.unmount();
      console.log(JSON.stringify({ detail: output.includes("PROJ-1"), fieldPane: output.includes("> status") }));
    `,
  );
  expect(result).toEqual({ detail: true, fieldPane: true });
});

test("failed description draft survives a move child and cancellation", async () => {
  const result = await runBoardCase(
    "detail-description-draft",
    `
      const seeds = [];
      let puts = 0;
      globalThis.fetch = async (input, init = {}) => {
        const url = new URL(String(input));
        if (url.pathname === "/rest/api/3/field") return response([]);
        if (url.pathname === "/rest/api/3/myself") return response({ accountId: "me", displayName: "Me" });
        if (url.pathname.endsWith("/configuration")) return boardConfig();
        if (url.pathname.endsWith("/allData.json")) return response({});
        if (url.pathname.endsWith("/user/assignable/search")) return response([]);
        if (url.pathname === "/rest/agile/1.0/board/7/issue") return issuePage(issue("PROJ-1", "Card"));
        if (url.pathname === "/rest/api/3/issue/PROJ-1" && init.method === "PUT") {
          puts++;
          return new Response("description rejected", { status: 400 });
        }
        if (url.pathname === "/rest/api/3/issue/PROJ-1") {
          const value = issue("PROJ-1", "Card");
          Object.assign(value.fields, { components: [], fixVersions: [], subtasks: [], issuelinks: [], created: "2026-01-01T00:00:00.000Z" });
          return response(value);
        }
        if (url.pathname.endsWith("/comment")) return response({ comments: [] });
        if (url.pathname.endsWith("/editmeta")) return response({ fields: {} });
        throw new Error("unexpected request: " + (init.method ?? "GET") + " " + url);
      };
      const originalWhich = Bun.which;
      const originalSpawn = Bun.spawn;
      const originalWrite = process.stdout.write;
      Bun.which = () => "/mock/editor";
      Bun.spawn = (args) => ({
        exitCode: 0,
        exited: Bun.file(args.at(-1)).text().then((seed) => {
          seeds.push(seed);
          return Bun.write(args.at(-1), "Retained description draft").then(() => 0);
        }),
      });
      process.stdout.write = () => true;
      const terminal = createTerminal();
      const app = mount(terminal);
      try {
        await waitFor(() => terminal.output().includes("Card"), "board");
        await send(app, terminal, "v");
        await waitFor(() => terminal.output().includes("Description"), "detail");
        await send(app, terminal, "E");
        await waitFor(() => puts === 1, "rejected description");
        await waitFor(() => terminal.output().includes("Description not saved"), "draft error");
        await send(app, terminal, "m");
        await waitFor(() => terminal.output().includes("Move PROJ-1"), "move child");
        await send(app, terminal, "\\u001b");
        await waitFor(() => terminal.output().includes("Description"), "returned detail");
        await send(app, terminal, "E");
        await waitFor(() => seeds.length === 2, "reopened editor");
      } finally {
        app.unmount();
        Bun.which = originalWhich;
        Bun.spawn = originalSpawn;
        process.stdout.write = originalWrite;
      }
      console.log(JSON.stringify({ first: seeds[0], second: seeds[1] }));
    `,
  );
  expect(result).toEqual({ first: "", second: "Retained description draft" });
});

test("board description stays pending, blocks duplicates, and reopens its failed draft", async () => {
  const result = await runBoardCase(
    "board-description-pending",
    `
      const save = deferred();
      const seeds = [];
      let puts = 0;
      globalThis.fetch = async (input, init = {}) => {
        const url = new URL(String(input));
        if (url.pathname === "/rest/api/3/field") return response([]);
        if (url.pathname.endsWith("/configuration")) return boardConfig();
        if (url.pathname.endsWith("/allData.json")) return response({});
        if (url.pathname.endsWith("/user/assignable/search")) return response([]);
        if (url.pathname === "/rest/agile/1.0/board/7/issue") return issuePage(issue("PROJ-1", "Card"));
        if (url.pathname === "/rest/api/3/issue/PROJ-1" && init.method === "PUT") {
          puts++;
          return save.promise;
        }
        throw new Error("unexpected request: " + (init.method ?? "GET") + " " + url);
      };
      const originalWhich = Bun.which;
      const originalSpawn = Bun.spawn;
      const originalWrite = process.stdout.write;
      Bun.which = () => "/mock/editor";
      Bun.spawn = (args) => ({
        exitCode: 0,
        exited: Bun.file(args.at(-1)).text().then((seed) => {
          seeds.push(seed);
          return Bun.write(args.at(-1), "Board description draft").then(() => 0);
        }),
      });
      process.stdout.write = () => true;
      const terminal = createTerminal();
      const app = mount(terminal);
      try {
        await waitFor(() => terminal.output().includes("Card"), "board");
        await send(app, terminal, "E");
        await waitFor(() => puts === 1, "description put");
        await waitFor(() => terminal.output().includes("Saving description"), "pending description");
        await send(app, terminal, "E");
        await send(app, terminal, "v");
        const putsWhilePending = puts;
        save.resolve(new Response("save rejected", { status: 400 }));
        await waitFor(() => terminal.output().includes("Description not saved"), "description error");
        await send(app, terminal, "E");
        await waitFor(() => seeds.length === 2, "draft editor reopen");
        app.unmount();
        console.log(JSON.stringify({ putsWhilePending, seeds }));
      } finally {
        Bun.which = originalWhich;
        Bun.spawn = originalSpawn;
        process.stdout.write = originalWrite;
      }
    `,
  );
  expect(result).toEqual({
    putsWhilePending: 1,
    seeds: ["", "Board description draft"],
  });
});

test("cancelled detail cannot open a late subtask wizard", async () => {
  const result = await runBoardCase(
    "stale-subtask-metadata",
    `
      const types = deferred();
      let typeRequests = 0;
      globalThis.fetch = async (input) => {
        const url = new URL(String(input));
        if (url.pathname === "/rest/api/3/field") return response([]);
        if (url.pathname === "/rest/api/3/myself") return response({ accountId: "me", displayName: "Me" });
        if (url.pathname.endsWith("/configuration")) return boardConfig();
        if (url.pathname.endsWith("/allData.json")) return response({});
        if (url.pathname.endsWith("/user/assignable/search")) return response([]);
        if (url.pathname === "/rest/agile/1.0/board/7/issue") return issuePage(issue("PROJ-1", "Parent"));
        if (url.pathname === "/rest/api/3/issue/PROJ-1") {
          const value = issue("PROJ-1", "Parent");
          Object.assign(value.fields, { project: { key: "PROJ" }, issuetype: { id: "10", name: "Task", subtask: false }, components: [], fixVersions: [], subtasks: [], issuelinks: [], created: "2026-01-01T00:00:00.000Z" });
          return response(value);
        }
        if (url.pathname.endsWith("/comment")) return response({ comments: [] });
        if (url.pathname.endsWith("/editmeta")) return response({ fields: {} });
        if (url.pathname === "/rest/api/3/issue/createmeta/PROJ/issuetypes") {
          typeRequests++;
          return types.promise;
        }
        if (url.pathname === "/rest/api/3/issueLinkType") return response({ issueLinkTypes: [] });
        throw new Error("unexpected request: " + url);
      };
      const terminal = createTerminal();
      const app = mount(terminal);
      await waitFor(() => terminal.output().includes("Parent"), "board");
      await send(app, terminal, "v");
      await waitFor(() => terminal.output().includes("Description"), "detail");
      await send(app, terminal, "C");
      await waitFor(() => typeRequests === 1, "subtask metadata");
      await send(app, terminal, "\\u001b");
      terminal.clearOutput();
      types.resolve(response({ issueTypes: [{ id: "11", name: "Subtask", subtask: true }] }));
      await nextTurn();
      await nextTurn();
      const output = terminal.output();
      app.unmount();
      console.log(JSON.stringify({ reopened: output.includes("Create issue") }));
    `,
  );
  expect(result).toEqual({ reopened: false });
});

test("required transition returns to its retained picker and reuses field drafts", async () => {
  const result = await runBoardCase(
    "transition-draft-return",
    `
      let posts = 0;
      globalThis.fetch = async (input, init = {}) => {
        const url = new URL(String(input));
        if (url.pathname === "/rest/api/3/field") return response([]);
        if (url.pathname === "/rest/api/3/myself") return response({ accountId: "me", displayName: "Me" });
        if (url.pathname.endsWith("/configuration")) return boardConfig();
        if (url.pathname.endsWith("/allData.json")) return response({});
        if (url.pathname.endsWith("/user/assignable/search")) return response([]);
        if (url.pathname === "/rest/agile/1.0/board/7/issue") return issuePage(issue("PROJ-1", "Card"));
        if (url.pathname === "/rest/api/3/issue/PROJ-1/transitions" && init.method === "POST") {
          posts++;
          return posts === 1
            ? new Response("transition rejected", { status: 400 })
            : new Response(null, { status: 204 });
        }
        if (url.pathname === "/rest/api/3/issue/PROJ-1/transitions") {
          return response({ transitions: [{
            id: "resolve", name: "Resolve", to: { id: "2" }, fields: {
              customfield_1: { name: "Estimate", required: true, hasDefaultValue: false, schema: { type: "number" } },
            },
          }] });
        }
        if (url.pathname === "/rest/api/3/issue/PROJ-1") {
          const value = issue("PROJ-1", "Card");
          Object.assign(value.fields, { components: [], fixVersions: [], subtasks: [], issuelinks: [], created: "2026-01-01T00:00:00.000Z" });
          return response(value);
        }
        if (url.pathname.endsWith("/comment")) return response({ comments: [] });
        if (url.pathname.endsWith("/editmeta")) return response({ fields: {} });
        throw new Error("unexpected request: " + (init.method ?? "GET") + " " + url);
      };
      const terminal = createTerminal();
      const app = mount(terminal);
      await waitFor(() => terminal.output().includes("Card"), "board");
      await send(app, terminal, "v");
      await waitFor(() => terminal.output().includes("Description"), "detail");
      await send(app, terminal, "t");
      await waitFor(() => terminal.output().includes("Transition PROJ-1"), "transition picker");
      await send(app, terminal, "\\r");
      await waitFor(() => terminal.output().includes("Estimate"), "required screen");
      await send(app, terminal, "\\r");
      await send(app, terminal, "7");
      await send(app, terminal, "\\r");
      await waitFor(() => terminal.output().includes("7"), "field value");
      terminal.clearOutput();
      await send(app, terminal, "\\u001b");
      await waitFor(() => terminal.output().includes("Transition PROJ-1"), "returned picker");
      terminal.clearOutput();
      await send(app, terminal, "\\r");
      await waitFor(() => terminal.output().includes("Estimate"), "reopened required screen");
      const reused = terminal.output().includes("7");
      await send(app, terminal, "s");
      await waitFor(() => terminal.output().includes("Could not save transition"), "transition error");
      const keptAfterFailure = terminal.output().includes("7");
      await send(app, terminal, "s");
      await waitFor(() => posts === 2, "transition retry");
      app.unmount();
      console.log(JSON.stringify({ reused, keptAfterFailure, posts }));
    `,
  );
  expect(result).toEqual({ reused: true, keptAfterFailure: true, posts: 2 });
});

test("required transition clears server validation only after a changed collected value", async () => {
  const result = await runBoardCase(
    "transition-validation-feedback",
    `
      const posts = [];
      globalThis.fetch = async (input, init = {}) => {
        const url = new URL(String(input));
        if (url.pathname === "/rest/api/3/field") return response([]);
        if (url.pathname === "/rest/api/3/myself") return response({ accountId: "me" });
        if (url.pathname.endsWith("/configuration")) return boardConfig();
        if (url.pathname.endsWith("/allData.json")) return response({});
        if (url.pathname.endsWith("/user/assignable/search")) return response([]);
        if (url.pathname === "/rest/agile/1.0/board/7/issue") return issuePage(issue("PROJ-1", "Card"));
        if (url.pathname === "/rest/api/3/issue/PROJ-1/transitions" && init.method === "POST") {
          posts.push(JSON.parse(String(init.body)));
          return new Response("validation rejected", { status: 400 });
        }
        if (url.pathname === "/rest/api/3/issue/PROJ-1/transitions") {
          return response({ transitions: [{
            id: "resolve", name: "Resolve", to: { id: "2" }, fields: {
              customfield_1: { name: "Estimate", required: true, hasDefaultValue: false, schema: { type: "number" } },
            },
          }] });
        }
        if (url.pathname === "/rest/api/3/issue/PROJ-1") {
          const value = issue("PROJ-1", "Card");
          Object.assign(value.fields, { components: [], fixVersions: [], subtasks: [], issuelinks: [], created: "2026-01-01T00:00:00.000Z" });
          return response(value);
        }
        if (url.pathname.endsWith("/comment")) return response({ comments: [] });
        if (url.pathname.endsWith("/editmeta")) return response({ fields: {} });
        throw new Error("unexpected request: " + (init.method ?? "GET") + " " + url);
      };
      const terminal = createTerminal();
      const app = mount(terminal);
      await waitFor(() => terminal.output().includes("Card"), "board");
      await send(app, terminal, "v");
      await waitFor(() => terminal.output().includes("Description"), "detail");
      await send(app, terminal, "t");
      await waitFor(() => terminal.output().includes("Transition PROJ-1"), "transition picker");
      await send(app, terminal, "\\r");
      await waitFor(() => terminal.output().includes("Estimate"), "required screen");
      await send(app, terminal, "\\r");
      await send(app, terminal, "7");
      await send(app, terminal, "\\r");
      await send(app, terminal, "s");
      await waitFor(() => posts.length === 1, "rejected transition post");
      await waitFor(() => terminal.output().includes("Could not save transition"), "server validation");

      let paint = await currentPaint(app, terminal);
      const failedValueKept = /Estimate.*7/.test(paint);
      const failedErrorVisible = paint.includes("Could not save transition");
      const failedReasonVisible = paint.includes("validation rejected");

      await send(app, terminal, "\\r");
      await app.waitUntilRenderFlush();
      await send(app, terminal, "\\u001b");
      paint = await currentPaint(app, terminal);
      const cancelKeptValue = /Estimate.*7/.test(paint);
      const cancelKeptError = paint.includes("Could not save transition");
      const cancelKeptReason = paint.includes("validation rejected");

      await send(app, terminal, "\\r");
      await send(app, terminal, "\\r");
      paint = await currentPaint(app, terminal);
      const unchangedKeptValue = /Estimate.*7/.test(paint);
      const unchangedKeptError = paint.includes("Could not save transition");
      const unchangedKeptReason = paint.includes("validation rejected");
      const postsAfterUnchanged = posts.length;

      await send(app, terminal, "\\r");
      await send(app, terminal, "\\x15");
      await send(app, terminal, "8");
      await send(app, terminal, "\\r");
      paint = await currentPaint(app, terminal);
      const changedValueKept = /Estimate.*8/.test(paint);
      const changedClearedError = !paint.includes("Could not save transition");
      const changedClearedReason = !paint.includes("validation rejected");
      const postsAfterChange = posts.length;
      app.unmount();
      console.log(JSON.stringify({
        failedValueKept,
        failedErrorVisible,
        failedReasonVisible,
        cancelKeptValue,
        cancelKeptError,
        cancelKeptReason,
        unchangedKeptValue,
        unchangedKeptError,
        unchangedKeptReason,
        postsAfterUnchanged,
        changedValueKept,
        changedClearedError,
        changedClearedReason,
        postsAfterChange,
        firstPost: posts[0],
      }));
    `,
  );
  expect(result).toEqual({
    failedValueKept: true,
    failedErrorVisible: true,
    failedReasonVisible: true,
    cancelKeptValue: true,
    cancelKeptError: true,
    cancelKeptReason: true,
    unchangedKeptValue: true,
    unchangedKeptError: true,
    unchangedKeptReason: true,
    postsAfterUnchanged: 1,
    changedValueKept: true,
    changedClearedError: true,
    changedClearedReason: true,
    postsAfterChange: 1,
    firstPost: {
      transition: { id: "resolve" },
      fields: { customfield_1: 7 },
    },
  });
});

test("required move returns to the retained move picker selection", async () => {
  const result = await runBoardCase(
    "move-required-return",
    `
      globalThis.fetch = async (input, init = {}) => {
        const url = new URL(String(input));
        if (url.pathname === "/rest/api/3/field") return response([]);
        if (url.pathname === "/rest/api/3/myself") return response({ accountId: "me", displayName: "Me" });
        if (url.pathname.endsWith("/configuration")) return boardConfig();
        if (url.pathname.endsWith("/allData.json")) return response({});
        if (url.pathname.endsWith("/user/assignable/search")) return response([]);
        if (url.pathname === "/rest/agile/1.0/board/7/issue") return issuePage(issue("PROJ-1", "Card"));
        if (url.pathname === "/rest/api/3/issue/PROJ-1/transitions") {
          return response({ transitions: [{
            id: "resolve", name: "Resolve", to: { id: "2" }, fields: {
              customfield_1: { name: "Estimate", required: true, hasDefaultValue: false, schema: { type: "number" } },
            },
          }] });
        }
        if (url.pathname === "/rest/api/3/issue/PROJ-1") {
          const value = issue("PROJ-1", "Card");
          Object.assign(value.fields, { components: [], fixVersions: [], subtasks: [], issuelinks: [], created: "2026-01-01T00:00:00.000Z" });
          return response(value);
        }
        if (url.pathname.endsWith("/comment")) return response({ comments: [] });
        if (url.pathname.endsWith("/editmeta")) return response({ fields: {} });
        throw new Error("unexpected request: " + (init.method ?? "GET") + " " + url);
      };
      const terminal = createTerminal();
      const app = mount(terminal);
      await waitFor(() => terminal.output().includes("Card"), "board");
      await send(app, terminal, "v");
      await waitFor(() => terminal.output().includes("Description"), "detail");
      await send(app, terminal, "m");
      await waitFor(() => terminal.output().includes("Move PROJ-1"), "move picker");
      await send(app, terminal, "don");
      await send(app, terminal, "\\r");
      await waitFor(() => terminal.output().includes("Estimate"), "required move screen");
      terminal.clearOutput();
      await send(app, terminal, "\\u001b");
      await waitFor(() => terminal.output().includes("Move PROJ-1"), "returned move picker");
      const output = terminal.output();
      app.unmount();
      console.log(JSON.stringify({
        selectedDone: output.includes("> Done"),
        queryKept: output.includes("don"),
      }));
    `,
  );
  expect(result).toEqual({ selectedDone: true, queryKept: true });
});

test("first-load error commands cannot enter an invisible modal", async () => {
  const result = await runBoardCase(
    "first-load-input",
    `
      let configCalls = 0;
      let exits = 0;
      globalThis.fetch = async (input) => {
        const url = new URL(String(input));
        if (url.pathname.endsWith("/configuration")) {
          configCalls++;
          return new Response("configuration unavailable", { status: 503 });
        }
        throw new Error("unexpected request: " + url);
      };
      const terminal = createTerminal();
      const app = mount(terminal, 4, () => exits++);
      await waitFor(() => terminal.output().includes("configuration unavailable"), "load error");
      await send(app, terminal, "?");
      await send(app, terminal, "r");
      await waitFor(() => configCalls === 2, "retry");
      await send(app, terminal, "q");
      app.unmount();
      console.log(JSON.stringify({ configCalls, exits }));
    `,
  );
  expect(result).toEqual({ configCalls: 2, exits: 1 });
});

test("failed quick add keeps its title and blocks duplicate submission", async () => {
  const result = await runBoardCase(
    "quick-add-draft",
    `
      const create = deferred();
      let creates = 0;
      globalThis.fetch = async (input, init = {}) => {
        const url = new URL(String(input));
        if (url.pathname === "/rest/api/3/field") return response([]);
        if (url.pathname.endsWith("/configuration")) return boardConfig();
        if (url.pathname.endsWith("/allData.json")) return response({});
        if (url.pathname.endsWith("/user/assignable/search")) return response([]);
        if (url.pathname === "/rest/agile/1.0/board/7/issue") return issuePage(issue("PROJ-1", "Existing"));
        if (url.pathname === "/rest/api/3/issue/createmeta/PROJ/issuetypes") {
          return response({ issueTypes: [{ id: "1", name: "Task", subtask: false }] });
        }
        if (url.pathname === "/rest/api/3/issue/createmeta/PROJ/issuetypes/1") {
          return response({ fields: [{ fieldId: "summary", name: "Title", required: true, schema: { type: "string" } }] });
        }
        if (url.pathname === "/rest/api/3/issueLinkType") return response({ issueLinkTypes: [] });
        if (url.pathname === "/rest/api/3/issue" && init.method === "POST") {
          creates++;
          return create.promise;
        }
        throw new Error("unexpected request: " + (init.method ?? "GET") + " " + url);
      };
      const terminal = createTerminal();
      const app = mount(terminal);
      await waitFor(() => terminal.output().includes("Existing"), "board");
      await send(app, terminal, "a");
      await waitFor(() => terminal.output().includes("Quick add"), "quick add");
      await send(app, terminal, "Retained title");
      await send(app, terminal, "\\r");
      await waitFor(() => creates === 1, "create request");
      await waitFor(() => terminal.output().includes("Creating issue"), "pending create state");
      const createsAfterFirst = creates;
      await send(app, terminal, "\\r");
      const createsBeforeResolve = creates;
      create.resolve(new Response("synthetic rejection", { status: 400 }));
      await waitFor(() => terminal.output().includes("Could not create issue"), "create error");
      const output = terminal.output();
      app.unmount();
      console.log(JSON.stringify({ creates, createsAfterFirst, createsBeforeResolve, retained: output.includes("Retained title") }));
    `,
  );
  expect(result).toEqual({
    creates: 1,
    createsAfterFirst: 1,
    createsBeforeResolve: 1,
    retained: true,
  });
});

test("wizard metadata failure stays visible and does not retry on the Board toast rerender", async () => {
  const result = await runBoardCase(
    "metadata-error",
    `
      let metadataCalls = 0;
      globalThis.fetch = async (input) => {
        const url = new URL(String(input));
        if (url.pathname === "/rest/api/3/field") return response([]);
        if (url.pathname.endsWith("/configuration")) return boardConfig();
        if (url.pathname.endsWith("/allData.json")) return response({});
        if (url.pathname.endsWith("/user/assignable/search")) return response([]);
        if (url.pathname === "/rest/agile/1.0/board/7/issue") {
          return issuePage(issue("PROJ-1", "Existing card"));
        }
        if (url.pathname === "/rest/api/3/issue/createmeta/PROJ/issuetypes") {
          return response({ issueTypes: [{ id: "1", name: "Task", subtask: false }] });
        }
        if (url.pathname === "/rest/api/3/issueLinkType") return response({ issueLinkTypes: [] });
        if (url.pathname === "/rest/api/3/issue/createmeta/PROJ/issuetypes/1") {
          metadataCalls++;
          return new Response("metadata unavailable", { status: 503 });
        }
        throw new Error("unexpected request: " + url);
      };

      const terminal = createTerminal();
      const app = mount(terminal);
      await waitFor(() => terminal.output().includes("Existing card"), "initial board");
      terminal.clearOutput();
      await send(app, terminal, "c");
      await waitFor(() => terminal.output().includes("Create issue"), "create wizard");
      await send(app, terminal, "\\u001b[B");
      await send(app, terminal, "\\u001b[B");
      await send(app, terminal, "\\r");
      await send(app, terminal, "\\r");
      await waitFor(() => terminal.output().includes("metadata unavailable"), "visible metadata error");
      await nextTurn();
      await app.waitUntilRenderFlush();
      const visible = terminal.output().includes("metadata unavailable");
      app.unmount();
      console.log(JSON.stringify({ metadataCalls, visible }));
    `,
  );

  expect(result).toEqual({ metadataCalls: 1, visible: true });
});

test("relationship partial success stays visible, persists recents, and never recreates", async () => {
  const result = await runBoardCase(
    "relationship-partial",
    `
        let creates = 0;
        let links = 0;
        let boardIssueCalls = 0;
        globalThis.fetch = async (input, init = {}) => {
          const url = new URL(String(input));
          if (url.pathname === "/rest/api/3/field") return response([]);
          if (url.pathname.endsWith("/configuration")) return boardConfig();
          if (url.pathname.endsWith("/allData.json")) return response({});
          if (url.pathname.endsWith("/user/assignable/search")) return response([]);
          if (url.pathname === "/rest/agile/1.0/board/7/issue") {
            boardIssueCalls++;
            return issuePage(
              issue("PROJ-1", "Existing card"),
              ...(boardIssueCalls > 1 ? [issue("PROJ-9", "Linked title")] : []),
            );
          }
          if (url.pathname === "/rest/api/3/issue/createmeta/PROJ/issuetypes") {
            return response({ issueTypes: [
              { id: "1", name: "Work item", subtask: false, hierarchyLevel: 0 },
            ] });
          }
          if (url.pathname === "/rest/api/3/issue/createmeta/PROJ/issuetypes/1") {
            return response({ fields: [
              { fieldId: "summary", name: "Summary", required: true, schema: { type: "string" } },
              { fieldId: "parent", name: "Parent", required: false, schema: { type: "issuelink" } },
            ] });
          }
          if (url.pathname === "/rest/api/3/issueLinkType") {
            return response({ issueLinkTypes: [
              { id: "10", name: "Blocks", outward: "blocks", inward: "is blocked by" },
            ] });
          }
          if (url.pathname === "/rest/api/3/search/jql") {
            return response({ isLast: true, issues: [{
              key: "PROJ-2",
              fields: {
                project: { key: "PROJ" }, summary: "Target",
                issuetype: { id: "1", name: "Work item", subtask: false, hierarchyLevel: 0 },
              },
            }] });
          }
          if (url.pathname === "/rest/api/3/issue" && init.method === "POST") {
            creates++;
            return response({ key: "PROJ-9" }, 201);
          }
          if (url.pathname === "/rest/api/3/issueLink" && init.method === "POST") {
            links++;
            return new Response("link denied", { status: 400 });
          }
          throw new Error("unexpected request: " + (init.method ?? "GET") + " " + url);
        };

        const terminal = createTerminal();
        const app = mount(terminal);
        await waitFor(() => terminal.output().includes("Existing card"), "initial board");
        await send(app, terminal, "c");
        await waitFor(() => terminal.output().includes("Create issue"), "create wizard");

        const originalWhich = Bun.which;
        const originalSpawn = Bun.spawn;
        const originalWrite = process.stdout.write;
        let editorDone = false;
        Bun.which = () => "/mock/editor";
        Bun.spawn = (args) => ({
          exitCode: 0,
          exited: Bun.write(args.at(-1), "Linked title\\n").then(() => {
            editorDone = true;
            return 0;
          }),
        });
        process.stdout.write = () => true;
        try {
          await send(app, terminal, "\\r");
          await waitFor(() => editorDone, "mock editor result");
          await nextTurn();
        } finally {
          process.stdout.write = originalWrite;
          Bun.which = originalWhich;
          Bun.spawn = originalSpawn;
        }

        await send(app, terminal, "\\u001b[B");
        await send(app, terminal, "\\u001b[B");
        await send(app, terminal, "\\r");
        await send(app, terminal, "\\r");
        await send(app, terminal, "\\u001b[B");
        await send(app, terminal, "\\r");
        await send(app, terminal, "\\u001b[B");
        await send(app, terminal, "\\u001b[B");
        await send(app, terminal, "\\r");
        await send(app, terminal, "\\u001b[B");
        await send(app, terminal, "\\r");
        await waitFor(() => terminal.output().includes("PROJ-2"), "link target");
        await send(app, terminal, "\\r");
        await send(app, terminal, "s");
        await waitFor(() => creates === 1, "create request");
        await waitFor(() => links === 1, "link request");
        await waitFor(() => terminal.output().includes("relationship failed"), "visible warning");
        await waitFor(() => boardIssueCalls > 1, "board reload");
        await waitFor(
          async () => (await cache.readRecents(cfg, 7))[0]?.key === "PROJ-9",
          "created issue recents",
        );
        const recents = await cache.readRecents(cfg, 7);
        const output = terminal.output();
        app.unmount();
        console.log(JSON.stringify({
          creates,
          links,
          boardIssueCalls,
          visibleKey: output.includes("Created PROJ-9"),
          visibleWarning: output.includes("relationship failed"),
          recent: recents[0],
        }));
      `,
  );

  expect(result).toEqual({
    creates: 1,
    links: 1,
    boardIssueCalls: 2,
    visibleKey: true,
    visibleWarning: true,
    recent: { key: "PROJ-9", summary: "Linked title" },
  });
}, 20_000);

test("configured estimation field drives requested values and rendered totals", async () => {
  const result = await runBoardCase(
    "configured-estimation",
    `
      let requestedFields = [];
      globalThis.fetch = async (input) => {
        const url = new URL(String(input));
        if (url.pathname === "/rest/api/3/field") return response([]);
        if (url.pathname.endsWith("/configuration")) {
          return response({
            name: "Estimate board",
            location: { key: "PROJ" },
            estimation: { type: "field", field: { fieldId: "customfield_4242" } },
            columnConfig: { columns: [{ name: "To Do", statuses: [{ id: "1" }] }] },
          });
        }
        if (url.pathname.endsWith("/allData.json")) return response({});
        if (url.pathname.endsWith("/user/assignable/search")) return response([]);
        if (url.pathname === "/rest/agile/1.0/board/7/issue") {
          requestedFields = (url.searchParams.get("fields") ?? "").split(",");
          const item = issue("PROJ-1", "Estimated card");
          item.fields.customfield_4242 = 7;
          return issuePage(item);
        }
        throw new Error("unexpected request: " + url);
      };

      const terminal = createTerminal();
      const app = mount(terminal);
      await waitFor(() => terminal.output().includes("Estimated card"), "estimated board");
      const output = terminal.output();
      app.unmount();
      console.log(JSON.stringify({
        requestedConfigured: requestedFields.includes("customfield_4242"),
        requestedDefault: requestedFields.includes("customfield_10016"),
        renderedPoints: output.includes("7p"),
      }));
    `,
  );

  expect(result).toEqual({
    requestedConfigured: true,
    requestedDefault: false,
    renderedPoints: true,
  });
});

test("visible columns are bounded by terminal width and still page with navigation", async () => {
  const result = await runBoardCase(
    "narrow-columns",
    `
      globalThis.fetch = async (input) => {
        const url = new URL(String(input));
        if (url.pathname === "/rest/api/3/field") return response([]);
        if (url.pathname.endsWith("/configuration")) {
          return response({
            name: "Six columns",
            location: { key: "PROJ" },
            columnConfig: { columns: Array.from({ length: 6 }, (_, index) => ({
              name: "C" + (index + 1), statuses: [{ id: String(index + 1) }],
            })) },
          });
        }
        if (url.pathname.endsWith("/allData.json")) return response({});
        if (url.pathname.endsWith("/user/assignable/search")) return response([]);
        if (url.pathname === "/rest/agile/1.0/board/7/issue") return issuePage();
        throw new Error("unexpected request: " + url);
      };

      const originalColumns = process.stdout.columns;
      Object.defineProperty(process.stdout, "columns", { value: 80, configurable: true });
      const terminal = createTerminal(80, 30);
      const app = mount(terminal, 6);
      await waitFor(() => terminal.output().includes("C4"), "width-bounded columns");
      const initial = terminal.output();
      terminal.clearOutput();
      await send(app, terminal, "l");
      await send(app, terminal, "l");
      await send(app, terminal, "l");
      await waitFor(() => terminal.output().includes("C5"), "paged fifth column");
      const paged = terminal.output();
      app.unmount();
      Object.defineProperty(process.stdout, "columns", {
        value: originalColumns,
        configurable: true,
      });
      console.log(JSON.stringify({
        initialHasFour: initial.includes("C4"),
        initialHasFive: initial.includes("C5"),
        pagedHasFive: paged.includes("C5"),
      }));
    `,
  );

  expect(result).toEqual({ initialHasFour: true, initialHasFive: false, pagedHasFive: true });
});

test("card paging reserves header, margin, and scroll indicator rows", async () => {
  const result = await runBoardCase(
    "card-geometry",
    `
      globalThis.fetch = async (input) => {
        const url = new URL(String(input));
        if (url.pathname === "/rest/api/3/field") return response([]);
        if (url.pathname.endsWith("/configuration")) {
          return response({
            name: "Short board", location: { key: "PROJ" },
            columnConfig: { columns: [{ name: "To Do", statuses: [{ id: "1" }] }] },
          });
        }
        if (url.pathname.endsWith("/allData.json")) return response({});
        if (url.pathname.endsWith("/user/assignable/search")) return response([]);
        if (url.pathname === "/rest/agile/1.0/board/7/issue") {
          return issuePage(...Array.from({ length: 5 }, (_, index) =>
            issue("PROJ-" + (index + 1), "Card " + (index + 1)),
          ));
        }
        throw new Error("unexpected request: " + url);
      };

      const originalRows = process.stdout.rows;
      Object.defineProperty(process.stdout, "rows", { value: 18, configurable: true });
      const terminal = createTerminal(80, 18);
      const app = mount(terminal);
      await waitFor(() => terminal.output().includes("Card 1"), "short board");
      const initial = terminal.output();
      terminal.clearOutput();
      await send(app, terminal, "j");
      await waitFor(() => terminal.output().includes("Card 2"), "second paged card");
      const paged = terminal.output();
      app.unmount();
      Object.defineProperty(process.stdout, "rows", { value: originalRows, configurable: true });
      console.log(JSON.stringify({
        initialFirst: initial.includes("Card 1"),
        initialSecond: initial.includes("Card 2"),
        pagedSecond: paged.includes("Card 2"),
        hiddenAbove: paged.includes("^ 1 more"),
        hiddenBelow: paged.includes("v 3 more"),
      }));
    `,
  );

  expect(result).toEqual({
    initialFirst: true,
    initialSecond: false,
    pagedSecond: true,
    hiddenAbove: true,
    hiddenBelow: true,
  });
});

test("minimum-width cards keep three content rows and both scroll indicators", async () => {
  const result = await runBoardCase(
    "minimum-card-width",
    `
      globalThis.fetch = async (input) => {
        const url = new URL(String(input));
        if (url.pathname === "/rest/api/3/field") return response([]);
        if (url.pathname.endsWith("/configuration")) {
          return response({
            name: "Narrow cards", location: { key: "PROJ" },
            columnConfig: { columns: Array.from({ length: 4 }, (_, index) => ({
              name: "C" + (index + 1), statuses: [{ id: String(index + 1) }],
            })) },
          });
        }
        if (url.pathname.endsWith("/allData.json")) return response({});
        if (url.pathname.endsWith("/user/assignable/search")) return response([]);
        if (url.pathname === "/rest/agile/1.0/board/7/issue") {
          const cards = Array.from({ length: 6 }, (_, index) => {
            const item = issue("VERYLONGPROJECT-" + (12345 + index), (index + 1) + " narrow card");
            item.fields.assignee = { displayName: "Alex Smith" };
            item.fields.priority = { name: "Highest" };
            return item;
          });
          return issuePage(...cards);
        }
        throw new Error("unexpected request: " + url);
      };

      const originalColumns = process.stdout.columns;
      const originalRows = process.stdout.rows;
      Object.defineProperty(process.stdout, "columns", { value: 80, configurable: true });
      Object.defineProperty(process.stdout, "rows", { value: 30, configurable: true });
      const terminal = createTerminal(80, 30);
      const app = mount(terminal, 6);
      await waitFor(() => terminal.output().includes("1 narrow"), "minimum-width card");
      const initial = terminal.output();
      terminal.clearOutput();
      await send(app, terminal, "j");
      await send(app, terminal, "j");
      await send(app, terminal, "j");
      await send(app, terminal, "j");
      await waitFor(() => terminal.output().includes("5 narrow"), "fifth narrow card");
      const paged = terminal.output();
      app.unmount();
      Object.defineProperty(process.stdout, "columns", {
        value: originalColumns,
        configurable: true,
      });
      Object.defineProperty(process.stdout, "rows", { value: originalRows, configurable: true });
      console.log(JSON.stringify({
        initialBadge: initial.includes("AS"),
        initialMeta: initial.includes("Alex Smith"),
        initialBelow: initial.includes("v 2 more"),
        pagedKey: paged.includes("5 narrow"),
        pagedAbove: paged.includes("^ 1 more"),
        pagedBelow: paged.includes("v 1 more"),
      }));
    `,
  );

  expect(result).toEqual({
    initialBadge: true,
    initialMeta: true,
    initialBelow: true,
    pagedKey: true,
    pagedAbove: true,
    pagedBelow: true,
  });
});

test("an outside-board JQL issue can move with its own key and project", async () => {
  const result = await runBoardCase(
    "outside-move",
    `
      const userProjects = [];
      const transitionPosts = [];
      globalThis.fetch = async (input, init = {}) => {
        const url = new URL(String(input));
        if (url.pathname === "/rest/api/3/field") return response([]);
        if (url.pathname.endsWith("/configuration")) return boardConfig();
        if (url.pathname.endsWith("/allData.json")) return response({});
        if (url.pathname.endsWith("/user/assignable/search")) {
          userProjects.push(url.searchParams.get("project"));
          return response([{ accountId: "u", displayName: "Outside User" }]);
        }
        if (url.pathname === "/rest/agile/1.0/board/7/issue") {
          return issuePage(issue("PROJ-1", "Board card"));
        }
        if (url.pathname === "/rest/api/3/search/jql") {
          return response({ isLast: true, issues: [{
            key: "OUT-9",
            fields: {
              project: { key: "OUT" }, summary: "Outside card",
              issuetype: { id: "10", name: "Work item", subtask: false, hierarchyLevel: 0 },
            },
          }] });
        }
        if (url.pathname === "/rest/api/3/myself") {
          return response({ accountId: "me", displayName: "Me" });
        }
        if (url.pathname === "/rest/api/3/issue/OUT-9") {
          const detail = issue("OUT-9", "Outside card", "3");
          Object.assign(detail.fields, {
            project: { key: "OUT" },
            issuetype: { id: "10", name: "Work item", subtask: false, hierarchyLevel: 0 },
            components: [], fixVersions: [], subtasks: [], issuelinks: [],
            created: "2026-01-01T00:00:00.000Z",
          });
          return response(detail);
        }
        if (url.pathname.endsWith("/comment")) return response({ comments: [] });
        if (url.pathname.endsWith("/editmeta")) return response({ fields: {} });
        if (url.pathname === "/rest/api/3/issue/OUT-9/transitions" && init.method === undefined) {
          return response({ transitions: [{
            id: "move", name: "Move outside", to: { id: "2" }, fields: {
              customfield_user: {
                name: "Approver", required: true, hasDefaultValue: false,
                schema: { type: "user" },
              },
            },
          }] });
        }
        if (url.pathname === "/rest/api/3/issue/OUT-9/transitions" && init.method === "POST") {
          transitionPosts.push(JSON.parse(String(init.body)));
          return new Response(null, { status: 204 });
        }
        throw new Error("unexpected request: " + (init.method ?? "GET") + " " + url);
      };

      const terminal = createTerminal();
      const app = mount(terminal);
      await waitFor(() => terminal.output().includes("Board card"), "initial board");
      await send(app, terminal, "J");
      await send(app, terminal, "project = OUT");
      await send(app, terminal, "\\r");
      await waitFor(() => terminal.output().includes("Outside card"), "outside JQL result");
      await send(app, terminal, "\\r");
      await waitFor(() => terminal.output().includes("Description"), "outside detail");
      await send(app, terminal, "m");
      await waitFor(() => terminal.output().includes("Move OUT-9 to"), "outside move picker");
      const usablePicker = terminal.output().includes("Done");
      await send(app, terminal, "\\u001b[B");
      await send(app, terminal, "\\r");
      await waitFor(() => terminal.output().includes("Approver"), "outside transition screen");
      await send(app, terminal, "\\r");
      await waitFor(() => userProjects.includes("OUT"), "outside project users");
      await send(app, terminal, "\\r");
      await send(app, terminal, "s");
      await waitFor(() => transitionPosts.length === 1, "outside transition post");
      app.unmount();
      console.log(JSON.stringify({
        usablePicker,
        userProjects,
        transition: transitionPosts[0],
      }));
    `,
  );

  expect(result).toEqual({
    usablePicker: true,
    userProjects: ["PROJ", "OUT"],
    transition: {
      transition: { id: "move" },
      fields: { customfield_user: { accountId: "u" } },
    },
  });
}, 20_000);
