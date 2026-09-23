import { expect, test } from "bun:test";
import { rm } from "node:fs/promises";

import { isolatedEnv, makeTempDir, runScript } from "../test/utils";

const boardUrl = new URL("./Board.tsx", import.meta.url).href;
const viewportUrl = new URL("./Viewport.tsx", import.meta.url).href;
const cacheUrl = new URL("../cache.ts", import.meta.url).href;
const utilsUrl = new URL("../test/utils.ts", import.meta.url).href;

async function runTimelineCase(name: string, setup: string, body: string): Promise<unknown> {
  const home = await makeTempDir(`timeline-${name}`);
  try {
    const result = await runScript(
      `
        const React = await import("react");
        const { PassThrough } = await import("node:stream");
        const { render } = await import("ink");
        const RealDate = globalThis.Date;
        const fixedNow = RealDate.parse("2026-09-23T12:00:00Z");
        globalThis.Date = class extends RealDate {
          constructor(...args) { super(...(args.length === 0 ? [fixedNow] : args)); }
          static now() { return fixedNow; }
        };
        const { BoardView } = await import(${JSON.stringify(boardUrl)});
        const { Viewport } = await import(${JSON.stringify(viewportUrl)});
        const cache = await import(${JSON.stringify(cacheUrl)});
        const { createTerminal, deferred, nextTurn, sendInput, waitFor } = await import(${JSON.stringify(utilsUrl)});
        const cfg = { server: "https://${name}.timeline.invalid", authHeader: "Basic test" };
        const response = (value, status = 200) => Response.json(value, { status });
        const opened = [];
        const transitionGets = [];
        const transitionPosts = [];
        let rankCalls = 0;
        let createMetaCalls = 0;
        let createCalls = 0;
        let boardCalls = 0;
        let swim = true;
        let fieldFailure = false;
        let transitionGate = null;
        let transitionLookupGate = null;
        let rankGate = null;
        let transitionStatus = "2";
        const issue = (key, summary, startDate, dueDate, assignee = "Alpha", statusId = "1") => ({
          id: Number(key.split("-").at(-1)) || 1,
          key,
          fields: {
            summary, description: null, updated: "2026-09-01T00:00:00Z",
            status: { id: statusId, name: statusId === "1" ? "To Do" : "Done", statusCategory: { key: statusId === "1" ? "new" : "done" } },
            issuetype: { id: "1", name: "Task", subtask: false }, labels: [],
            project: { key: key.split("-")[0] }, assignee: { accountId: assignee.toLowerCase(), displayName: assignee },
            customfield_1: startDate, duedate: dueDate,
            components: [], fixVersions: [], subtasks: [], issuelinks: [],
            created: "2026-01-01T00:00:00Z", watches: { isWatching: false },
          },
        });
        const page = (items) => response({ startAt: 0, maxResults: items.length, total: items.length, isLast: true, issues: items });
        const config = () => response({
          name: "Timeline fixture", location: { key: "PROJ" },
          columnConfig: { columns: [
            { name: "To Do", statuses: [{ id: "1" }] },
            { name: "Done", statuses: [{ id: "2" }] },
          ] },
        });
        let issueSets = [[
          issue("PROJ-01", "First Alpha", "2026-09-01", "2026-09-03", "Alpha"),
          issue("PROJ-02", "Second Beta", "2026-09-04", "2026-09-05", "Beta"),
          issue("PROJ-03", "Third Alpha", undefined, undefined, "Alpha"),
        ]];
        const outside = issue("EXT-99", "Outside board", "2026-09-20", "2026-09-21", "External");
        ${setup}
        globalThis.fetch = async (input, init = {}) => {
          const url = new URL(String(input));
          const method = init.method ?? "GET";
          if (url.pathname === "/rest/api/3/field") {
            if (fieldFailure) throw new Error("field metadata unavailable");
            return response([{ id: "customfield_1", name: "Start date", schema: { type: "date" } }]);
          }
          if (url.pathname.endsWith("/configuration")) return config();
          if (url.pathname.endsWith("/allData.json")) return response(swim ? { swimlanesData: { swimlaneStrategy: "assignee" } } : {});
          if (url.pathname.endsWith("/user/assignable/search")) return response([]);
          if (url.pathname === "/rest/agile/1.0/board/7/issue") {
            boardCalls++;
            const value = issueSets[Math.min(boardCalls - 1, issueSets.length - 1)];
            return value && typeof value.then === "function" ? value.then(page) : page(value);
          }
          if (url.pathname === "/rest/api/3/search/jql") return response({ issues: [outside], isLast: true });
          const transitionKey = url.pathname.match(/\\/rest\\/api\\/3\\/issue\\/([^/]+)\\/transitions$/)?.[1];
          if (transitionKey && method === "GET") {
            transitionGets.push(transitionKey);
            const value = response({ transitions: [{ id: "done", name: "Done", to: { id: transitionStatus }, fields: {} }] });
            return transitionLookupGate ? transitionLookupGate.promise : value;
          }
          if (transitionKey && method === "POST") {
            transitionPosts.push(transitionKey);
            return transitionGate ? transitionGate.promise : new Response(null, { status: 204 });
          }
          if (url.pathname.endsWith("/rank") && method === "PUT") {
            rankCalls++;
            return rankGate ? rankGate.promise : new Response(null, { status: 204 });
          }
          if (url.pathname.endsWith("/watchers") && (method === "POST" || method === "DELETE")) {
            return new Response(null, { status: 204 });
          }
          if (url.pathname.endsWith("/createmeta/PROJ/issuetypes")) {
            createMetaCalls++;
            return response({ issueTypes: [{ id: "1", name: "Task", subtask: false }] });
          }
          if (url.pathname.endsWith("/createmeta/PROJ/issuetypes/1")) {
            createMetaCalls++;
            return response({ fields: [{ fieldId: "summary", name: "Summary", required: true, schema: { type: "string" } }] });
          }
          if (url.pathname === "/rest/api/3/issueLinkType") return response({ issueLinkTypes: [] });
          if (url.pathname === "/rest/api/3/issue" && method === "POST") {
            createCalls++;
            return response({ key: "PROJ-9" }, 201);
          }
          if (
            url.pathname === "/rest/api/3/issue/PROJ-9" &&
            method === "GET" &&
            url.searchParams.get("fields") === "status"
          ) {
            return response(issue("PROJ-9", "Created focus", undefined, undefined, "Alpha", "2"));
          }
          if (url.pathname === "/rest/api/3/myself") return response({ accountId: "me", displayName: "Me" });
          if (url.pathname.endsWith("/comment")) return response({ comments: [] });
          if (url.pathname.endsWith("/editmeta")) return response({ fields: {} });
          const detailKey = url.pathname.match(/\\/rest\\/api\\/3\\/issue\\/([^/]+)$/)?.[1];
          if (detailKey && method === "GET") {
            opened.push(detailKey);
            const all = issueSets.flatMap((set) => Array.isArray(set) ? set : []);
            return response(
              detailKey === "EXT-99"
                ? outside
                : detailKey === "PROJ-9"
                  ? issue("PROJ-9", "Created focus", undefined, undefined, "Alpha", "2")
                  : all.find((item) => item.key === detailKey),
            );
          }
          throw new Error("unexpected request: " + method + " " + url);
        };
        Object.defineProperty(process.stdout, "columns", { value: 80, configurable: true });
        Object.defineProperty(process.stdout, "rows", { value: 24, configurable: true });
        const terminal = createTerminal(80, 24);
        const boardNode = React.createElement(BoardView, {
          cfg, board: { id: 7, name: "Timeline fixture" }, maxColumns: 4, onExit() {},
        });
        const app = render(React.createElement(Viewport, null, boardNode), {
          interactive: true, stdin: terminal.stdin, stdout: terminal.stdout,
          stderr: new PassThrough(), exitOnCtrlC: false, patchConsole: false,
        });
        const send = (value) => sendInput(app, terminal.stdin, value);
        const resize = async (columns, rows) => {
          Object.defineProperty(process.stdout, "columns", { value: columns, configurable: true });
          Object.defineProperty(process.stdout, "rows", { value: rows, configurable: true });
          terminal.stdout.columns = columns; terminal.stdout.rows = rows;
          process.stdout.emit("resize"); await nextTurn(); await app.waitUntilRenderFlush();
        };
        const fresh = async () => {
          const columns = terminal.stdout.columns; const rows = terminal.stdout.rows;
          await resize(columns + 1, rows); terminal.clearOutput(); await resize(columns, rows);
          return Bun.stripANSI(terminal.output()).replace(/\\n$/, "");
        };
        const bounded = (paint, columns, rows) => {
          const lines = paint.split("\\n");
          return lines.length <= rows && Math.max(...lines.map((line) => Bun.stringWidth(line))) <= columns;
        };
        ${body}
      `,
      isolatedEnv(home, { TZ: "UTC" }),
      undefined,
      20_000,
    );
    expect(result.exitCode, result.stderr).toBe(0);
    return JSON.parse(result.stdout);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

test("Timeline navigation, filters, modal and size retention, swimlanes, and blocked keys", async () => {
  const result = await runTimelineCase(
    "navigation",
    `
      issueSets = [Array.from({ length: 18 }, (_, index) => {
        const number = String(index + 1).padStart(2, "0");
        const assigned = index % 2 === 0 ? "Alpha" : "Beta";
        return issue(
          "PROJ-" + number,
          assigned + " row " + number,
          index === 0 ? "2023-01-31" : index < 12 ? "2026-09-" + String(index + 1).padStart(2, "0") : undefined,
          index === 0 ? "2023-01-31" : index < 12 ? "2026-09-" + String(index + 2).padStart(2, "0") : undefined,
          assigned,
        );
      })];
    `,
    `
      await waitFor(() => terminal.output().includes("First") || terminal.output().includes("Alpha row"), "board");
      await waitFor(() => terminal.output().includes("swimlanes"), "swimlane metadata");
      terminal.stdin.write("T"); terminal.stdin.emit("readable");
      terminal.stdin.write("a"); terminal.stdin.emit("readable");
      await waitFor(() => terminal.output().includes("Timeline"), "rapid Timeline entry");
      let paint80 = await fresh();
      const range = (paint) => paint.match(/\\d{4}-\\d{2}-\\d{2} to \\d{4}-\\d{2}-\\d{2}/)?.[0];
      await send("-"); const monthJanuary = await fresh();
      await send("l"); const monthFebruary = await fresh();
      await send("h"); const monthJanuaryAgain = await fresh();
      await send("+"); await send("+"); const dayJanuary = await fresh();
      await send("\\x1b[6~"); const detailParentBefore = await fresh(); await send("v");
      await waitFor(() => opened.length === 1, "page down detail");
      const pageDownOpened = opened[0]; await send("\\x1b"); const detailEscParent = await fresh();
      await send("\\x1b[5~"); await send("v");
      await waitFor(() => opened.length === 2, "page up detail");
      const pageUpOpened = opened[1]; await send("q");
      await send("G"); await send("v");
      await waitFor(() => opened.length === 3, "last row detail");
      const lastOpened = opened[2];
      await send("q");
      const beforeDismiss = await fresh(); await send("\\x07"); const afterDismiss = await fresh();

      const guidance = [];
      for (const key of ["a", "[", "]", "<", ">"] ) {
        await send(key); guidance.push(await fresh());
      }
      const blockedCalls = { rankCalls, createMetaCalls, transitionGets: [...transitionGets], transitionPosts: [...transitionPosts] };

      await send("f"); await send("\\r"); await send("\\r");
      const filtered = await fresh();
      await send("f"); await send("\\r"); await send("\\x1b");
      const filterParent = await fresh();
      await send("\\x1b");
      const cancelled = await fresh();
      await send("F");

      const childParentBefore = await fresh();
      await send("\\r"); await send("\\x1b"); const actionEscParent = await fresh();
      await send("m"); await send("\\x1b"); const moveEscParent = await fresh();
      await send("t"); await waitFor(() => terminal.output().includes("Transition PROJ"), "transition child");
      await send("\\x1b"); const transitionEscParent = await fresh();

      await send("+"); await send("l");
      const beforeHelp = await fresh();
      await send("?"); await waitFor(() => terminal.output().includes("Help · board"), "help");
      await send("\\x1b");
      const afterHelp = await fresh();

      await send("\\x1b"); const flatFromEsc = await fresh();
      await send("\\x1b"); const flatAfterSecondEsc = await fresh();
      await send("T"); const timelineAfterFlat = await fresh();

      await resize(60, 20); const small = Bun.stripANSI(terminal.output());
      await send("G"); await send("l"); await send("+"); await send("T");
      await resize(80, 24); const restored = await fresh();
      await resize(120, 40); const paint120 = await fresh();

      await send("s"); const lanes = await fresh();
      await send("T"); const fromLanes = await fresh();
      await send("\\x1b"); const backToLanes = await fresh();
      await send("T"); const timelineAfterSwim = await fresh();
      app.unmount();
      const selectedSummary = (paint) => paint.split("\\n").find((line) => line.includes(" · Task · "));
      const visibleKeys = (paint) => [...paint.matchAll(/PROJ-\\d{2}/g)].map((match) => match[0]);
      console.log(JSON.stringify({
        bounded80: bounded(paint80, 80, 24), bounded120: bounded(paint120, 120, 40),
        monthRoundTrip: range(monthJanuary) === range(monthJanuaryAgain) && range(monthJanuary) !== range(monthFebruary),
        zoomKeptDay: range(dayJanuary) === "2023-01-19 to 2023-02-11",
        pageDownOpened, pageUpOpened, lastOpened,
        dismissKept: selectedSummary(beforeDismiss) === selectedSummary(afterDismiss),
        blocked: blockedCalls,
        guidance: guidance.every((value) => value.includes("disabled in Timeline") || value.includes("Quick add needs a column")),
        filtered: bounded(filtered, 80, 24) && filtered.includes("9/18 issues") && !filtered.includes("Beta row") && filtered.includes("PROJ-17 · Task"),
        cancelKept: filterParent.includes("Filters") && !filterParent.includes("Timeline ·") && cancelled.includes("9/18 issues") && selectedSummary(cancelled) === selectedSummary(filtered) && range(cancelled) === range(filtered),
        detailEscKept: detailEscParent.includes("Timeline · Days") && selectedSummary(detailEscParent) === selectedSummary(detailParentBefore) && range(detailEscParent) === range(detailParentBefore),
        childEscKept: [actionEscParent, moveEscParent, transitionEscParent].every((paint) => paint.includes("Timeline · Days") && selectedSummary(paint) === selectedSummary(childParentBefore) && range(paint) === range(childParentBefore)),
        modalKept: beforeHelp.includes("Timeline · Days") && afterHelp.includes("Timeline · Days") && range(beforeHelp) === range(afterHelp),
        flatEsc: flatFromEsc.includes("col 1/2") && flatFromEsc.includes("To Do") && !flatFromEsc.includes("Timeline ·") && flatAfterSecondEsc.includes("col 1/2") && !flatAfterSecondEsc.includes("Timeline ·") && timelineAfterFlat.includes("Timeline · Days") && range(timelineAfterFlat) === range(afterHelp) && selectedSummary(timelineAfterFlat) === selectedSummary(afterHelp),
        sizeKept: small.includes("Terminal too small") && selectedSummary(restored) === selectedSummary(afterHelp) && range(restored) === range(afterHelp) && JSON.stringify(visibleKeys(restored)) === JSON.stringify(visibleKeys(afterHelp)),
        swimRoundTrip: lanes.includes("assignee lanes") && fromLanes.includes("Timeline · Days") && backToLanes.includes("assignee lanes") && !backToLanes.includes("Timeline ·") && timelineAfterSwim.includes("Timeline · Days") && range(timelineAfterSwim) === range(fromLanes) && selectedSummary(timelineAfterSwim) === selectedSummary(fromLanes),
      }));
    `,
  );
  expect(result).toEqual({
    bounded80: true,
    bounded120: true,
    monthRoundTrip: true,
    zoomKeptDay: true,
    pageDownOpened: "PROJ-08",
    pageUpOpened: "PROJ-01",
    lastOpened: "PROJ-18",
    dismissKept: true,
    blocked: { rankCalls: 0, createMetaCalls: 0, transitionGets: [], transitionPosts: [] },
    guidance: true,
    filtered: true,
    cancelKept: true,
    detailEscKept: true,
    childEscKept: true,
    modalKept: true,
    flatEsc: true,
    sizeKept: true,
    swimRoundTrip: true,
  });
}, 25_000);

test("Timeline keeps current targets through refresh, reordering, transitions, and outside detail", async () => {
  const result = await runTimelineCase(
    "actions",
    `
      transitionGate = deferred();
      transitionStatus = "9";
      const longTitle = "Rapid target " + "wide界 ".repeat(120) + "TITLEEND";
      issueSets = [
        [issue("PROJ-01", "First", "2026-09-10", "2026-09-11"), issue("PROJ-02", longTitle, "2026-09-20", "2026-09-21")],
        [issue("PROJ-02", longTitle, "2026-10-20", "2026-10-21"), issue("PROJ-01", "First", "2026-09-01", "2026-09-02")],
        [issue("PROJ-01", "First", "2026-09-01", "2026-09-02", "Alpha", "9"), issue("PROJ-02", longTitle, "2026-10-20", "2026-10-21")],
        [issue("PROJ-01", "First", "2026-09-01", "2026-09-02"), issue("PROJ-02", longTitle, "2026-10-20", "2026-10-21")],
        [issue("PROJ-01", "First", "2026-09-01", "2026-09-02"), issue("PROJ-02", longTitle, "2026-10-20", "2026-10-21")],
      ];
    `,
    `
      await waitFor(() => terminal.output().includes("Rapid target"), "board");
      terminal.stdin.write("\\x1b[B"); terminal.stdin.emit("readable");
      terminal.stdin.write("T"); terminal.stdin.emit("readable");
      terminal.stdin.write("v"); terminal.stdin.emit("readable");
      await waitFor(() => opened.length === 1, "rapid board Timeline detail");
      const detailBeforeScroll = await fresh();
      let fullTitleReachable = detailBeforeScroll.includes("TITLEEND");
      for (let row = 0; row < 40 && !fullTitleReachable; row++) {
        await send("j");
        fullTitleReachable = Bun.stripANSI(terminal.output()).includes("TITLEEND");
      }
      await send("w"); await waitFor(() => boardCalls >= 2, "detail action date refresh");
      await send("q");
      const reordered = await fresh();
      await send("."); const focused = await fresh();

      terminal.stdin.write("\\x1b[At"); terminal.stdin.emit("readable");
      await waitFor(() => transitionGets.length === 1, "rapid transition target");
      await send("\\r");
      await waitFor(() => transitionPosts.length === 1, "transition post");
      const pending = await fresh();
      await send("j"); const selectedWhilePending = await fresh();
      transitionGate.resolve(new Response(null, { status: 204 }));
      await waitFor(() => boardCalls >= 3, "transition refresh");
      const settled = await fresh();

      await send("r"); await waitFor(() => boardCalls >= 4, "unrelated refresh");
      await send("v"); await waitFor(() => opened.length === 3, "selection after unrelated refresh");
      await send("q");

      await send("R"); await send("EXT-99");
      await waitFor(() => terminal.output().includes("Outside board"), "outside result");
      await send("\\r"); await waitFor(() => opened.includes("EXT-99"), "outside detail");
      await send("t"); await waitFor(() => transitionGets.includes("EXT-99"), "outside action target");
      await send("\\r"); await waitFor(() => transitionPosts.includes("EXT-99"), "outside transition post");
      await waitFor(() => boardCalls >= 5, "outside transition refresh");
      const returned = await fresh();
      app.unmount();
      console.log(JSON.stringify({
        opened, transitionGets, transitionPosts,
        fullTitleSection: detailBeforeScroll.includes("Full title"),
        fullTitleReachable: !detailBeforeScroll.includes("TITLEEND") && fullTitleReachable,
        selectedAfterReorder: reordered.includes("PROJ-02 · Task · Rapid target") && reordered.includes("Start 2026-10-20; Due 2026-10-21"),
        focusedRange: focused.includes("2026-10"),
        pendingVisible: pending.includes("~PROJ-01") || pending.includes("updating"),
        selectedWhilePending: selectedWhilePending.includes("PROJ-02 · Task · Rapid target"),
        settledTimeline: settled.includes("Timeline") && settled.includes("PROJ-02 · Task · Rapid target"),
        outsideReturn: returned.includes("Timeline") && returned.includes("PROJ-02"),
      }));
    `,
  );
  expect(result).toEqual({
    opened: ["PROJ-02", "PROJ-02", "PROJ-02", "EXT-99"],
    transitionGets: ["PROJ-01", "EXT-99"],
    transitionPosts: ["PROJ-01", "EXT-99"],
    fullTitleSection: true,
    fullTitleReachable: true,
    selectedAfterReorder: true,
    focusedRange: true,
    pendingVisible: true,
    selectedWhilePending: true,
    settledTimeline: true,
    outsideReturn: true,
  });
}, 25_000);

test("later flat navigation wins over delayed rerank and optimistic transition focus", async () => {
  const result = await runTimelineCase(
    "flat-focus-generation",
    `
      swim = false;
      rankGate = deferred();
      transitionLookupGate = deferred();
      issueSets = [
        [issue("PROJ-01", "First", "2026-09-01", "2026-09-02"), issue("PROJ-02", "Later selection", "2026-09-03", "2026-09-04")],
        [issue("PROJ-01", "First", "2026-09-01", "2026-09-02"), issue("PROJ-02", "Later selection", "2026-09-03", "2026-09-04")],
        [issue("PROJ-01", "First", "2026-09-01", "2026-09-02", "Alpha", "2"), issue("PROJ-02", "Later selection", "2026-09-03", "2026-09-04")],
      ];
    `,
    `
      await waitFor(() => terminal.output().includes("Later selection"), "flat board");
      await send("]"); await waitFor(() => rankCalls === 1, "pending rank");
      await send("j"); rankGate.resolve(new Response(null, { status: 204 }));
      await waitFor(() => boardCalls >= 2, "rank refresh");
      await send("v"); await waitFor(() => opened.length === 1, "selection after rank"); await send("q");

      await send("g"); await send(">"); await waitFor(() => transitionGets.length === 1, "pending transition lookup");
      await send("j");
      transitionLookupGate.resolve(response({ transitions: [{ id: "done", name: "Done", to: { id: "2" }, fields: {} }] }));
      await waitFor(() => transitionPosts.length === 1 && boardCalls >= 3, "transition confirmation");
      await send("v"); await waitFor(() => opened.length === 2, "selection after transition");
      app.unmount();
      console.log(JSON.stringify({ opened, rankCalls, transitionGets, transitionPosts }));
    `,
  );
  expect(result).toEqual({
    opened: ["PROJ-02", "PROJ-02"],
    rankCalls: 1,
    transitionGets: ["PROJ-01"],
    transitionPosts: ["PROJ-01"],
  });
}, 25_000);

test("new quick-add focus cannot be replaced by an older transition completion", async () => {
  const result = await runTimelineCase(
    "creation-focus-order",
    `
      swim = false;
      transitionGate = deferred();
      const creationRead = deferred();
      const oldTransitionRead = deferred();
      const finalRows = [
        issue("PROJ-01", "First", "2026-09-01", "2026-09-02", "Alpha", "2"),
        issue("PROJ-02", "Second", "2026-09-03", "2026-09-04"),
        issue("PROJ-9", "Created focus", undefined, undefined, "Alpha", "2"),
      ];
      issueSets = [
        [issue("PROJ-01", "First", "2026-09-01", "2026-09-02"), issue("PROJ-02", "Second", "2026-09-03", "2026-09-04")],
        creationRead.promise,
        oldTransitionRead.promise,
      ];
    `,
    `
      await waitFor(() => terminal.output().includes("Second"), "creation focus board");
      await send(">"); await waitFor(() => transitionPosts.length === 1, "old transition post");
      await send("a"); await waitFor(() => terminal.output().includes("Quick add"), "quick add");
      await send("Created focus"); await send("\\r");
      await waitFor(() => createCalls === 1 && boardCalls >= 2, "creation confirmation read");
      transitionGate.resolve(new Response(null, { status: 204 }));
      await waitFor(() => boardCalls >= 3, "old transition confirmation read");
      creationRead.resolve(finalRows); oldTransitionRead.resolve(finalRows);
      await waitFor(() => terminal.output().includes("Created focus"), "created issue board");
      await send("v"); await waitFor(() => opened.length === 1, "created issue focus");
      app.unmount();
      console.log(JSON.stringify({ opened, createCalls, transitionPosts, boardCalls }));
    `,
  );
  expect(result).toEqual({
    opened: ["PROJ-9"],
    createCalls: 1,
    transitionPosts: ["PROJ-01"],
    boardCalls: 3,
  });
}, 25_000);

test("filter selection remains authoritative after an older Timeline transition completes", async () => {
  const result = await runTimelineCase(
    "filter-focus-generation",
    `
      swim = false;
      transitionStatus = "9";
      transitionGate = deferred();
      issueSets = [
        [issue("PROJ-01", "Alpha issue", "2026-09-01", "2026-09-02", "Alpha"), issue("PROJ-02", "Beta issue", "2026-09-03", "2026-09-04", "Beta")],
        [issue("PROJ-01", "Alpha issue", "2026-09-01", "2026-09-02", "Alpha", "9"), issue("PROJ-02", "Beta issue", "2026-09-03", "2026-09-04", "Beta")],
      ];
    `,
    `
      await waitFor(() => terminal.output().includes("Beta issue"), "filter focus board");
      await send("T"); await send("t"); await waitFor(() => transitionGets.length === 1, "transition picker");
      await send("\\r"); await waitFor(() => transitionPosts.length === 1, "pending transition");
      await send("f"); await send("\\r"); await send("\\x1b[B"); await send("\\r");
      await waitFor(() => terminal.output().includes("1/2 issues"), "Beta filter");
      await send("F"); await send("v"); await waitFor(() => opened.length === 1, "filtered selection detail");
      await send("q"); transitionGate.resolve(new Response(null, { status: 204 }));
      await waitFor(() => boardCalls >= 2, "transition reload");
      await send("v"); await waitFor(() => opened.length === 2, "selection after completion");
      app.unmount();
      console.log(JSON.stringify({ opened, transitionPosts }));
    `,
  );
  expect(result).toEqual({ opened: ["PROJ-02", "PROJ-02"], transitionPosts: ["PROJ-01"] });
}, 25_000);

test("Timeline and flat round trips keep fallback selection over an older off-column completion", async () => {
  const result = await runTimelineCase(
    "view-focus-generation",
    `
      swim = false;
      transitionStatus = "10";
      transitionGate = deferred();
      issueSets = [
        [issue("PROJ-01", "Timeline only", "2026-09-01", "2026-09-02", "Alpha", "9"), issue("PROJ-02", "Flat fallback", "2026-09-03", "2026-09-04")],
        [issue("PROJ-01", "Timeline only", "2026-09-01", "2026-09-02", "Alpha", "10"), issue("PROJ-02", "Flat fallback", "2026-09-03", "2026-09-04")],
      ];
    `,
    `
      await waitFor(() => terminal.output().includes("Flat fallback"), "view focus board");
      await send("T"); await send("g"); await send("t");
      await waitFor(() => transitionGets.length === 1, "off-column transition picker");
      await send("\\r"); await waitFor(() => transitionPosts.length === 1, "off-column transition post");
      await send("T"); const flat = await fresh();
      await send("T"); await send("v"); await waitFor(() => opened.length === 1, "fallback before completion");
      await send("q"); transitionGate.resolve(new Response(null, { status: 204 }));
      await waitFor(() => boardCalls >= 2, "old off-column completion");
      await send("v"); await waitFor(() => opened.length === 2, "fallback after completion");
      app.unmount();
      console.log(JSON.stringify({ opened, flatFallback: flat.includes("PROJ-02 · Task · Flat fallback") }));
    `,
  );
  expect(result).toEqual({ opened: ["PROJ-02", "PROJ-02"], flatFallback: true });
}, 25_000);

test("Timeline highlight navigation targets matched rows from unmatched selections", async () => {
  const result = await runTimelineCase(
    "highlight",
    `
      swim = false;
      issueSets = [
        [
          issue("PROJ-1", "Needle 1", "2026-01-01", "2026-01-01"),
          issue("PROJ-2", "Needle 2", "2026-01-02", "2026-01-02"),
          issue("PROJ-3", "Needle 3", "2026-01-03", "2026-01-03"),
          issue("PROJ-4", "Unmatched later", "2026-01-04", "2026-01-04"),
        ],
        [
          issue("PROJ-0", "Needle off window", "1990-01-01", "1990-01-02"),
          issue("PROJ-1", "Needle 1", "2026-01-01", "2026-01-01"),
          issue("PROJ-2", "Needle 2", "2026-01-02", "2026-01-02"),
          issue("PROJ-3", "Needle 3", "2026-01-03", "2026-01-03"),
          issue("PROJ-6", "Needle outside column", "2026-01-04", "2026-01-04", "Alpha", "9"),
          issue("PROJ-4", "Unmatched later", "2026-01-05", "2026-01-05"),
          issue("PROJ-5", "Needle unscheduled"),
          issue("PROJ-99", "Unmatched final"),
        ],
      ];
    `,
    `
      await waitFor(() => terminal.output().includes("Needle 2"), "highlight board");
      await send("T"); await send("/"); await send("Needle"); await send("\\r");
      await send("G"); await send("N"); await send("v");
      await waitFor(() => opened.length === 1, "previous match from unmatched row");
      await send("q"); await send("r"); await waitFor(() => boardCalls >= 2, "expanded matches");

      await send("G"); await send("N"); await send("v");
      await waitFor(() => opened.length === 2, "unscheduled previous match");
      await send("q");
      terminal.stdin.write("N"); terminal.stdin.emit("readable");
      terminal.stdin.write("v"); terminal.stdin.emit("readable");
      await waitFor(() => opened.length === 3, "rapid outside-column match");
      await send("q"); await send("G"); await send("n");
      const offWindow = await fresh(); await send("v");
      await waitFor(() => opened.length === 4, "off-window match"); await send("q");

      await send("/"); await send("Missing"); await send("\\r");
      const noMatches = await fresh(); await send("n"); await send("v");
      await waitFor(() => opened.length === 5, "no-match selection retained");
      app.unmount();
      const offLine = offWindow.split("\\n").find((line) => line.includes("PROJ-0")) ?? "";
      console.log(JSON.stringify({
        opened,
        offWindow: opened[3] === "PROJ-0" && offLine.includes("<"),
        noMatches: noMatches.includes("no matches") && opened[4] === "PROJ-0",
      }));
    `,
  );
  expect(result).toEqual({
    opened: ["PROJ-3", "PROJ-5", "PROJ-6", "PROJ-0", "PROJ-0"],
    offWindow: true,
    noMatches: true,
  });
}, 25_000);

test("cached date absence remains unconfirmed until fresh board dates arrive", async () => {
  const result = await runTimelineCase(
    "cache",
    `
      let rejectFresh;
      const failedFresh = new Promise((_, reject) => { rejectFresh = reject; });
      await cache.writeBoardCache(cfg, 7,
        { name: "Timeline fixture", projectKey: "PROJ", columns: [{ name: "To Do", statusIds: ["1"] }, { name: "Done", statusIds: ["2"] }] },
        [{ id: 1, key: "PROJ-01", summary: "Cached row", description: "", statusId: "1", statusName: "To Do", statusCategory: "new", updated: "", issueType: "Task", labels: [] }],
      );
      issueSets = [
        failedFresh,
        [issue("PROJ-01", "Historical dated row", "1999-01-02", "1999-01-03")],
        [issue("PROJ-01", "Changed historical row", "1980-02-02", "1980-02-03")],
      ];
    `,
    `
      await waitFor(() => terminal.output().includes("Cached row"), "cached board");
      await send("T"); const cached = await fresh();
      rejectFresh(new Error("synthetic fresh failure"));
      await waitFor(() => terminal.output().includes("fresh refresh failed"), "failed refresh notice");
      const failed = await fresh();
      await send("r"); await waitFor(() => terminal.output().includes("Historical dated row"), "historical fresh board");
      const historical = await fresh();
      await send("+"); await send("l"); const manual = await fresh();
      await send("r"); await waitFor(() => terminal.output().includes("Changed historical row"), "changed fresh board");
      const changed = await fresh();
      app.unmount();
      const range = (paint) => paint.match(/\\d{4}-\\d{2}-\\d{2} to \\d{4}-\\d{2}-\\d{2}/)?.[0];
      console.log(JSON.stringify({
        cachedHonest: cached.includes("Dates unconfirmed") && cached.includes("? unconfirmed") && cached.includes("date absence is unconfirmed") && !cached.includes("All filtered issues are unscheduled"),
        failedHonest: failed.includes("fresh refresh failed") && failed.includes("Press r to retry") && !failed.includes("while fresh data loads"),
        historicalFocused: historical.includes("Historical dated row") && range(historical)?.includes("1999"),
        manualKept: manual.includes("Timeline · Days") && changed.includes("Timeline · Days") && range(manual) === range(changed),
      }));
    `,
  );
  expect(result).toEqual({
    cachedHonest: true,
    failedHonest: true,
    historicalFocused: true,
    manualKept: true,
  });
}, 25_000);

test("manual calendar input on an empty cache survives the first historical rows", async () => {
  const result = await runTimelineCase(
    "empty-cache-touch",
    `
      const freshRows = deferred();
      await cache.writeBoardCache(cfg, 7,
        { name: "Timeline fixture", projectKey: "PROJ", columns: [{ name: "To Do", statusIds: ["1"] }, { name: "Done", statusIds: ["2"] }] },
        [],
      );
      issueSets = [freshRows.promise];
    `,
    `
      await waitFor(() => terminal.output().includes("No issues on this board"), "empty cached board");
      await send("T"); await send("+"); await send("l");
      const manual = await fresh();
      freshRows.resolve([issue("PROJ-01", "Historical first row", undefined, "1999-01-03")]);
      await waitFor(() => terminal.output().includes("Historical first row"), "historical first rows");
      const loaded = await fresh();
      app.unmount();
      const range = (paint) => paint.match(/\\d{4}-\\d{2}-\\d{2} to \\d{4}-\\d{2}-\\d{2}/)?.[0];
      console.log(JSON.stringify({
        manualRange: range(manual),
        loadedRange: range(loaded),
        selected: loaded.includes("PROJ-01 · Task · Historical first row"),
      }));
    `,
  );
  expect(result).toEqual({
    manualRange: "2026-09-12 to 2026-10-05",
    loadedRange: "2026-09-12 to 2026-10-05",
    selected: true,
  });
}, 25_000);

test("metadata failure keeps Due dates but never confirms an issue as unscheduled", async () => {
  const result = await runTimelineCase(
    "metadata",
    `
      fieldFailure = true;
      swim = false;
      const longIssue = issue("PROJECT-12345", "Readable selected title", undefined, "2026-09-23");
      longIssue.fields.issuetype.name = "Long custom Jira issue type ".repeat(3);
      issueSets = [[longIssue]];
    `,
    `
      await waitFor(() => terminal.output().includes("Readable selected title"), "fresh issue");
      await send("T"); const paint = await fresh();
      app.unmount();
      console.log(JSON.stringify({
        notice: paint.includes("Start date metadata is unavailable"),
        diagnostic: paint.includes("Due only: 2026-09-23; Start unavailable"),
        honest: !paint.includes("All filtered issues are unscheduled"),
        bounded: bounded(paint, 80, 24) && paint.includes("PROJECT-12345") && paint.includes("Readable selected title"),
      }));
    `,
  );
  expect(result).toEqual({ notice: true, diagnostic: true, honest: true, bounded: true });
}, 25_000);

test("wrong-typed API dates keep trustworthy opposite endpoint markers", async () => {
  const result = await runTimelineCase(
    "invalid-date-states",
    `
      swim = false;
      issueSets = [[
        issue("PROJ-01", "Invalid Start mapping", { wrong: true }, "2026-09-23"),
        issue("PROJ-02", "Invalid Due mapping", "2026-09-22", 42),
      ]];
    `,
    `
      await waitFor(() => terminal.output().includes("Invalid Due mapping"), "mapped invalid dates");
      await send("T"); const invalidStart = await fresh();
      await send("k"); const invalidDue = await fresh();
      app.unmount();
      const rowPlot = (paint, key) => (paint.split("\\n").find((line) => line.includes(key)) ?? "").slice(32);
      console.log(JSON.stringify({
        invalidStart: invalidStart.includes("Invalid Start date; Due 2026-09-23") && rowPlot(invalidStart, "PROJ-01").includes("D"),
        invalidDue: invalidDue.includes("Start 2026-09-22; Invalid Due date") && rowPlot(invalidDue, "PROJ-02").includes("S"),
      }));
    `,
  );
  expect(result).toEqual({ invalidStart: true, invalidDue: true });
}, 25_000);

test("fresh Timeline copy distinguishes all undated, all filtered out, and no issues", async () => {
  const result = await runTimelineCase(
    "empty-states",
    `
      swim = false;
      const alpha = issue("PROJ-01", "Alpha undated", undefined, undefined, "Alpha");
      const beta = issue("PROJ-02", "Beta undated", undefined, undefined, "Beta");
      beta.fields.issuetype.name = "Bug";
      issueSets = [[alpha, beta], []];
    `,
    `
      await waitFor(() => terminal.output().includes("Alpha undated"), "undated board");
      await send("T"); const undated = await fresh();
      await send("f"); await send("\\r"); await send("\\r");
      await send("f"); await send("\\x1b[B"); await send("\\r"); await send("\\r");
      const filtered = await fresh();
      await send("F"); await send("r"); await waitFor(() => boardCalls >= 2, "empty refresh");
      const empty = await fresh();
      app.unmount();
      console.log(JSON.stringify({
        undated: undated.includes("All filtered issues are unscheduled") && undated.includes("? unscheduled") && undated.includes("Unscheduled"),
        filtered: filtered.includes("No issues match the active filters"),
        empty: empty.includes("No issues on this board") && !empty.includes("No issues match the active filters"),
      }));
    `,
  );
  expect(result).toEqual({ undated: true, filtered: true, empty: true });
}, 25_000);
