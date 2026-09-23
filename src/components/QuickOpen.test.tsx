import { afterEach, expect, test } from "bun:test";
import { PassThrough } from "node:stream";

import { Box, measureElement, render } from "ink";

import type { RecentIssue } from "../cache";
import type { JiraConfig } from "../config";
import { createTerminal, deferred, sendInput, waitFor } from "../test/utils";
import { QuickOpen } from "./QuickOpen";

const originalFetch = globalThis.fetch;
const apps: ReturnType<typeof render>[] = [];
const cfg: JiraConfig = { server: "https://quick.invalid", authHeader: "Basic test" };

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const app of apps.splice(0)) app.unmount();
});

function searchResponse(key: string, summary: string): Response {
  return Response.json({
    isLast: true,
    issues: [{ key, fields: { summary, issuetype: { name: "Task" } } }],
  });
}

function mount(
  recents: RecentIssue[],
  onPick: (key: string) => void,
  onCancel = () => {},
  dimensions?: { cols: number; rows: number },
) {
  let currentDimensions = dimensions;
  const terminal = createTerminal(dimensions?.cols, dimensions?.rows);
  let root: Parameters<typeof measureElement>[0] | undefined;
  const screen = () => (
    <Box
      ref={(value) => {
        root = value ?? undefined;
      }}
    >
      <QuickOpen
        cfg={cfg}
        recents={recents}
        onPick={onPick}
        onCancel={onCancel}
        {...(currentDimensions ? { dimensions: currentDimensions } : {})}
      />
    </Box>
  );
  const app = render(screen(), {
    interactive: true,
    stdin: terminal.stdin as unknown as typeof process.stdin,
    stdout: terminal.stdout as unknown as typeof process.stdout,
    stderr: new PassThrough() as unknown as typeof process.stderr,
    exitOnCtrlC: false,
    patchConsole: false,
  });
  apps.push(app);
  return {
    app,
    terminal,
    height: () => (root ? measureElement(root).height : 0),
    resize(next: { cols: number; rows: number }) {
      currentDimensions = next;
      terminal.stdout.columns = next.cols;
      terminal.stdout.rows = next.rows;
      app.rerender(screen());
    },
  };
}

async function currentPaint(
  view: ReturnType<typeof mount>,
  dimensions: { cols: number; rows: number },
): Promise<string> {
  view.resize({ cols: dimensions.cols + 1, rows: dimensions.rows });
  await view.app.waitUntilRenderFlush();
  view.terminal.clearOutput();
  view.resize(dimensions);
  await view.app.waitUntilRenderFlush();
  return Bun.stripANSI(view.terminal.output());
}

test("same-batch recent query and Return select only the matching recent", async () => {
  globalThis.fetch = (async () => searchResponse("REMOTE-1", "Remote")) as unknown as typeof fetch;
  const picked: string[] = [];
  const { app, terminal } = mount(
    [
      { key: "A-1", summary: "Alpha" },
      { key: "B-1", summary: "Beta" },
    ],
    (key) => picked.push(key),
  );
  await app.waitUntilRenderFlush();

  terminal.stdin.write("bet");
  terminal.stdin.emit("readable");
  terminal.stdin.write("\r");
  terminal.stdin.emit("readable");
  await waitFor(() => picked.length === 1, "batched recent pick");

  expect(picked).toEqual(["B-1"]);
  app.unmount();
});

test("rapid Down and Enter open the new recent before a render", async () => {
  globalThis.fetch = (async () => searchResponse("REMOTE-1", "Remote")) as unknown as typeof fetch;
  const picked: string[] = [];
  const { app, terminal } = mount(
    [
      { key: "A-1", summary: "Alpha" },
      { key: "B-1", summary: "Beta" },
    ],
    (key) => picked.push(key),
  );
  await app.waitUntilRenderFlush();
  terminal.stdin.write("\u001b[B");
  terminal.stdin.emit("readable");
  terminal.stdin.write("\r");
  terminal.stdin.emit("readable");
  await waitFor(() => picked.length === 1, "rapid recent selection");
  expect(picked).toEqual(["B-1"]);
  app.unmount();
});

test("query then Down and Enter before render open the second matching recent", async () => {
  const request = deferred<Response>();
  globalThis.fetch = (async () => request.promise) as unknown as typeof fetch;
  const picked: string[] = [];
  const { app, terminal } = mount(
    [
      { key: "A-1", summary: "Alpha" },
      { key: "B-1", summary: "Beta One" },
      { key: "B-2", summary: "Beta Two" },
    ],
    (key) => picked.push(key),
  );
  await app.waitUntilRenderFlush();
  terminal.stdin.write("Beta");
  terminal.stdin.emit("readable");
  terminal.stdin.write("\u001b[B");
  terminal.stdin.emit("readable");
  terminal.stdin.write("\r");
  terminal.stdin.emit("readable");
  await waitFor(() => picked.length === 1, "query recent selection");
  expect(picked).toEqual(["B-2"]);
  request.resolve(searchResponse("REMOTE-1", "Remote"));
  app.unmount();
});

test("a new-query Return cannot select an old global result", async () => {
  const requests: { body: { jql: string }; response: ReturnType<typeof deferred<Response>> }[] = [];
  globalThis.fetch = (async (_input, init) => {
    const response = deferred<Response>();
    requests.push({ body: JSON.parse(String(init?.body)) as { jql: string }, response });
    return response.promise;
  }) as typeof fetch;
  const picked: string[] = [];
  const { app, terminal } = mount([], (key) => picked.push(key));

  await sendInput(app, terminal.stdin, "alpha");
  await waitFor(() => requests.length === 1, "alpha search");
  requests[0]!.response.resolve(searchResponse("A-1", "Alpha result"));
  await waitFor(() => terminal.output().includes("Alpha result"), "alpha result");

  terminal.stdin.write("\x15");
  terminal.stdin.emit("readable");
  terminal.stdin.write("beta");
  terminal.stdin.emit("readable");
  terminal.stdin.write("\r");
  terminal.stdin.emit("readable");
  await Bun.sleep(30);
  expect(picked).toEqual([]);

  await waitFor(() => requests.length === 2, "beta search");
  requests[1]!.response.resolve(searchResponse("B-1", "Beta result"));
  await waitFor(() => terminal.output().includes("Beta result"), "beta result");
  await sendInput(app, terminal.stdin, "\r");
  expect(picked).toEqual(["B-1"]);
  app.unmount();
});

test("matching recents remain selectable while global search is loading", async () => {
  const request = deferred<Response>();
  globalThis.fetch = (async () => request.promise) as unknown as typeof fetch;
  const picked: string[] = [];
  const { app, terminal } = mount([{ key: "REC-1", summary: "Needle" }], (key) => picked.push(key));

  await sendInput(app, terminal.stdin, "needle");
  await waitFor(() => terminal.output().includes("Searching"), "loading search");
  await sendInput(app, terminal.stdin, "\r");

  expect(picked).toEqual(["REC-1"]);
  request.resolve(searchResponse("REMOTE-1", "Needle remote"));
  app.unmount();
});

test("cancel and unmount invalidate late responses, while type-delete-back keeps its request", async () => {
  const requests: ReturnType<typeof deferred<Response>>[] = [];
  globalThis.fetch = (async () => {
    const request = deferred<Response>();
    requests.push(request);
    return request.promise;
  }) as unknown as typeof fetch;
  let cancelled = 0;
  const first = mount(
    [],
    () => {},
    () => {
      cancelled++;
    },
  );

  await sendInput(first.app, first.terminal.stdin, "alpha");
  await waitFor(() => requests.length === 1, "first alpha search");
  first.terminal.stdin.write("x");
  first.terminal.stdin.emit("readable");
  first.terminal.stdin.write("\x7f");
  first.terminal.stdin.emit("readable");
  await Bun.sleep(250);
  expect(requests).toHaveLength(1);
  requests[0]!.resolve(searchResponse("A-1", "Alpha current"));
  await waitFor(() => first.terminal.output().includes("Alpha current"), "retained alpha result");

  await sendInput(first.app, first.terminal.stdin, "\x15");
  await sendInput(first.app, first.terminal.stdin, "cancel-me");
  await waitFor(() => requests.length === 2, "cancelled search");
  first.terminal.clearOutput();
  await sendInput(first.app, first.terminal.stdin, "\u001b");
  await waitFor(() => cancelled === 1, "cancel callback");
  requests[1]!.resolve(searchResponse("CANCEL-1", "Cancelled late response"));
  await Bun.sleep(30);
  expect(first.terminal.output()).not.toContain("Cancelled late response");
  first.app.unmount();

  const second = mount([], () => {});
  await sendInput(second.app, second.terminal.stdin, "late");
  await waitFor(() => requests.length === 3, "unmounted search");
  second.app.unmount();
  requests[2]!.resolve(searchResponse("LATE-1", "Late response"));
  await Bun.sleep(30);
  expect(second.terminal.output()).not.toContain("Late response");
});

test("Enter retries a failed server search only when no recent issue is selectable", async () => {
  let requests = 0;
  globalThis.fetch = (async () => {
    requests++;
    if (requests === 1) throw new Error("temporary search failure");
    return searchResponse("REMOTE-1", "Recovered result");
  }) as unknown as typeof fetch;
  const picked: string[] = [];
  const { app, terminal } = mount([], (key) => picked.push(key));
  await sendInput(app, terminal.stdin, "recover");
  await waitFor(() => terminal.output().includes("Search failed"), "failed search");
  await sendInput(app, terminal.stdin, "\r");
  await waitFor(() => requests === 2, "search retry");
  await waitFor(() => terminal.output().includes("Recovered result"), "retried result");
  expect(picked).toEqual([]);
  app.unmount();
});

test("failed global search keeps recent open and exposes a separate retry row", async () => {
  let requests = 0;
  globalThis.fetch = (async () => {
    requests++;
    throw new Error("search unavailable");
  }) as unknown as typeof fetch;
  const picked: string[] = [];
  const { app, terminal } = mount([{ key: "REC-1", summary: "Needle" }], (key) => picked.push(key));
  await sendInput(app, terminal.stdin, "needle");
  await waitFor(() => terminal.output().includes("Retry server search"), "retry row");
  await sendInput(app, terminal.stdin, "\r");
  expect(picked).toEqual(["REC-1"]);

  const retry = mount([{ key: "REC-1", summary: "Needle" }], () => {});
  await sendInput(retry.app, retry.terminal.stdin, "needle");
  await waitFor(() => retry.terminal.output().includes("Retry server search"), "second retry row");
  await sendInput(retry.app, retry.terminal.stdin, "\u001b[B");
  await sendInput(retry.app, retry.terminal.stdin, "\r");
  await waitFor(() => requests >= 3, "separate retry action");
  app.unmount();
  retry.app.unmount();
});

test("20 matching recents and a long server error fit supported roots", async () => {
  globalThis.fetch = (async () => {
    throw new Error(`Synthetic failure ${"unbroken".repeat(40)} END_REASON`);
  }) as unknown as typeof fetch;
  const recents = Array.from({ length: 20 }, (_, index) => ({
    key: `REC-${index + 1}`,
    summary: `Synthetic recent ${index + 1}`,
  }));
  for (const dimensions of [
    { cols: 80, rows: 24 },
    { cols: 120, rows: 40 },
  ]) {
    const view = mount(
      recents,
      () => {},
      () => {},
      dimensions,
    );
    await sendInput(view.app, view.terminal.stdin, "Synthetic");
    await waitFor(() => view.terminal.output().includes("Synthetic failure"), "long search error");
    expect(view.height()).toBeLessThanOrEqual(dimensions.rows);
    let paint = await currentPaint(view, dimensions);
    expect(paint).toContain("Quick open");
    expect(paint).toContain("> REC-1");
    expect(paint).toContain("Synthetic failure");
    expect(paint).toContain("esc cancel");
    for (let index = 0; index < 10; index++)
      await sendInput(view.app, view.terminal.stdin, "\u001b[B");
    expect(view.height()).toBeLessThanOrEqual(dimensions.rows);
    paint = await currentPaint(view, dimensions);
    expect(paint).toContain("> REC-11");
    expect(paint).toContain("Quick open");
    expect(paint).toContain("esc cancel");
    for (let index = 10; index < 20; index++)
      await sendInput(view.app, view.terminal.stdin, "\u001b[B");
    expect(view.height()).toBeLessThanOrEqual(dimensions.rows);
    paint = await currentPaint(view, dimensions);
    expect(paint).toContain("> Retry server search");
    expect(paint).toContain("Quick open");
    expect(paint).toContain("esc cancel");
    view.app.unmount();
    apps.splice(apps.indexOf(view.app), 1);
  }
});

test("resize preserves Quick Open query and selected recent", async () => {
  globalThis.fetch = (async () => {
    throw new Error("synthetic search unavailable");
  }) as unknown as typeof fetch;
  const recents = Array.from({ length: 15 }, (_, index) => ({
    key: `REC-${index + 1}`,
    summary: `Resize match ${index + 1}`,
  }));
  const picked: string[] = [];
  const view = mount(
    recents,
    (key) => picked.push(key),
    () => {},
    { cols: 80, rows: 24 },
  );
  await sendInput(view.app, view.terminal.stdin, "Resize");
  for (let index = 0; index < 8; index++)
    await sendInput(view.app, view.terminal.stdin, "\u001b[B");
  view.terminal.clearOutput();
  view.resize({ cols: 120, rows: 40 });
  await view.app.waitUntilRenderFlush();
  expect(view.terminal.output()).toContain("Resize");
  await sendInput(view.app, view.terminal.stdin, "\r");
  expect(picked).toEqual(["REC-9"]);
  view.app.unmount();
});
