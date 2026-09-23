import { afterEach, expect, test } from "bun:test";
import { PassThrough } from "node:stream";

import { Box, measureElement, render } from "ink";

import type { JiraConfig } from "../config";
import { createTerminal, deferred, nextTurn, sendInput, waitFor } from "../test/utils";
import { JqlView } from "./JqlView";

const originalFetch = globalThis.fetch;
const apps: ReturnType<typeof render>[] = [];

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const app of apps.splice(0)) app.unmount();
});

function result(key: string, summary: string): Response {
  return Response.json({
    isLast: true,
    issues: [{ key, fields: { summary, issuetype: { name: "Task" } } }],
  });
}

function renderJql(
  onPick: (key: string) => void,
  onCancel: () => void,
  dimensions?: { cols: number; rows: number },
) {
  let currentDimensions = dimensions;
  const terminal = createTerminal(dimensions?.cols, dimensions?.rows);
  const { stdin, stdout, output } = terminal;
  const cfg: JiraConfig = { server: "https://jql.invalid", authHeader: "Basic test" };
  let root: Parameters<typeof measureElement>[0] | undefined;
  const screen = () => (
    <Box
      ref={(value) => {
        root = value ?? undefined;
      }}
    >
      <JqlView
        cfg={cfg}
        onPick={onPick}
        onCancel={onCancel}
        {...(currentDimensions ? { dimensions: currentDimensions } : {})}
      />
    </Box>
  );
  const app = render(screen(), {
    interactive: true,
    stdin: stdin as unknown as typeof process.stdin,
    stdout: stdout as unknown as typeof process.stdout,
    stderr: new PassThrough() as unknown as typeof process.stderr,
    exitOnCtrlC: false,
    patchConsole: false,
  });
  apps.push(app);
  return {
    app,
    stdin,
    output,
    clearOutput: terminal.clearOutput,
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
  view: ReturnType<typeof renderJql>,
  dimensions: { cols: number; rows: number },
): Promise<string> {
  view.resize({ cols: dimensions.cols + 1, rows: dimensions.rows });
  await view.app.waitUntilRenderFlush();
  view.clearOutput();
  view.resize(dimensions);
  await view.app.waitUntilRenderFlush();
  return Bun.stripANSI(view.output());
}

test("editing invalidates an in-flight query before Enter can open its stale result", async () => {
  const searches = [deferred<Response>(), deferred<Response>()];
  const bodies: { jql?: string }[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname !== "/rest/api/3/search/jql" || init?.method !== "POST") {
      throw new Error(`unexpected request: ${init?.method ?? "GET"} ${url}`);
    }
    bodies.push(JSON.parse(String(init?.body)) as { jql?: string });
    return searches[bodies.length - 1]!.promise;
  }) as typeof fetch;
  const picked: string[] = [];
  const view = renderJql(
    (key) => picked.push(key),
    () => {},
  );

  view.stdin.write("project = A");
  await waitFor(() => view.output().includes("project = A"), "first JQL input");
  view.stdin.write("\r");
  await waitFor(() => bodies.length === 1, "first JQL request");
  view.stdin.write("\x15");
  await nextTurn();
  view.stdin.write("project = B");
  await waitFor(() => view.output().includes("project = B"), "second JQL input");
  searches[0]!.resolve(result("A-1", "stale A result"));
  await nextTurn();
  await nextTurn();
  expect(view.output()).not.toContain("stale A result");

  view.stdin.write("\r");
  await waitFor(() => bodies.length === 2, "second JQL request");
  expect(bodies.map((body) => body.jql)).toEqual(["project = A", "project = B"]);
  searches[1]!.resolve(result("B-1", "current B result"));
  await waitFor(() => view.output().includes("current B result"), "current JQL result");
  view.stdin.write("\r");
  await waitFor(() => picked.length === 1, "JQL selection");
  expect(picked).toEqual(["B-1"]);
});

test("cancel invalidates a pending query and fires once", async () => {
  const search = deferred<Response>();
  let searches = 0;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname !== "/rest/api/3/search/jql" || init?.method !== "POST") {
      throw new Error(`unexpected request: ${init?.method ?? "GET"} ${url}`);
    }
    searches++;
    return search.promise;
  }) as unknown as typeof fetch;
  let cancelled = 0;
  const view = renderJql(
    () => {},
    () => {
      cancelled++;
    },
  );

  view.stdin.write("project = A");
  await waitFor(() => view.output().includes("project = A"), "pending JQL input");
  view.stdin.write("\r");
  await waitFor(() => searches === 1, "pending JQL request");
  view.stdin.write("\x1b");
  await waitFor(() => cancelled === 1, "JQL cancellation");
  search.resolve(result("A-1", "late result"));
  await nextTurn();
  await nextTurn();

  expect(cancelled).toBe(1);
  expect(view.output()).not.toContain("late result");
});

test("batched JQL typing and Return submits the latest query", async () => {
  const bodies: { jql?: string }[] = [];
  globalThis.fetch = (async (_input, init) => {
    bodies.push(JSON.parse(String(init?.body)) as { jql?: string });
    return result("B-1", "batched result");
  }) as typeof fetch;
  const view = renderJql(
    () => {},
    () => {},
  );

  view.stdin.write("project = B");
  view.stdin.emit("readable");
  view.stdin.write("\r");
  view.stdin.emit("readable");
  await waitFor(() => bodies.length === 1, "batched JQL request");
  expect(bodies[0]?.jql).toBe("project = B");
});

test("rapid Down and Enter open the new JQL result before a render", async () => {
  globalThis.fetch = (async () =>
    Response.json({
      isLast: true,
      issues: [
        { key: "A-1", fields: { summary: "Alpha", issuetype: { name: "Task" } } },
        { key: "B-1", fields: { summary: "Beta", issuetype: { name: "Task" } } },
      ],
    })) as unknown as typeof fetch;
  const picked: string[] = [];
  const view = renderJql(
    (key) => picked.push(key),
    () => {},
  );
  view.stdin.write("project = TEST");
  await waitFor(() => view.output().includes("project = TEST"), "JQL input");
  view.stdin.write("\r");
  await waitFor(() => view.output().includes("Beta"), "JQL results");
  view.stdin.write("\u001b[B");
  view.stdin.emit("readable");
  view.stdin.write("\r");
  view.stdin.emit("readable");
  await waitFor(() => picked.length === 1, "rapid JQL selection");
  expect(picked).toEqual(["B-1"]);
});

test("shows a completed empty result and offers retry", async () => {
  globalThis.fetch = (async () =>
    Response.json({ isLast: true, issues: [] })) as unknown as typeof fetch;
  const view = renderJql(
    () => {},
    () => {},
  );
  view.stdin.write("project = EMPTY");
  await waitFor(() => view.output().includes("project = EMPTY"), "empty JQL input");
  view.stdin.write("\r");
  await waitFor(() => view.output().includes("No issues match this JQL."), "empty JQL result");
  expect(view.output()).toContain("up to 50 results");
});

test("long 80-column JQL results keep the last row and footer within bounds", async () => {
  globalThis.fetch = (async () =>
    Response.json({
      isLast: true,
      issues: Array.from({ length: 20 }, (_, index) => ({
        key: `VERYLONGPROJECTKEY-${index + 1}`,
        fields: {
          summary: `Long synthetic title ${index + 1} ${"word ".repeat(20)}`,
          issuetype: { name: "Very long synthetic issue type" },
        },
      })),
    })) as unknown as typeof fetch;
  for (const dimensions of [
    { cols: 80, rows: 24 },
    { cols: 120, rows: 40 },
  ]) {
    const view = renderJql(
      () => {},
      () => {},
      dimensions,
    );
    view.stdin.write("project = TEST");
    await waitFor(() => view.output().includes("project = TEST"), "long JQL input");
    view.stdin.write("\r");
    await waitFor(() => view.output().includes("VERYLONGPROJECTKEY-1"), "long JQL results");
    expect(view.height()).toBeLessThanOrEqual(dimensions.rows);
    let paint = await currentPaint(view, dimensions);
    expect(paint).toContain("JQL query");
    expect(paint).toContain("> VERYLONGPROJECTKEY-1");
    expect(paint).toContain("esc close");
    for (let index = 0; index < 10; index++) await sendInput(view.app, view.stdin, "\u001b[B");
    expect(view.height()).toBeLessThanOrEqual(dimensions.rows);
    paint = await currentPaint(view, dimensions);
    expect(paint).toContain("> VERYLONGPROJECTKEY-11");
    expect(paint).toContain("JQL query");
    expect(paint).toContain("esc close");
    for (let index = 10; index < 19; index++) await sendInput(view.app, view.stdin, "\u001b[B");
    await waitFor(() => view.output().includes("VERYLONGPROJECTKEY-20"), "last JQL row");
    paint = await currentPaint(view, dimensions);
    expect(paint).toContain("> VERYLONGPROJECTKEY-20");
    expect(paint).toContain("JQL query");
    expect(paint).toContain("esc close");
    expect(view.height()).toBeLessThanOrEqual(dimensions.rows);
    view.app.unmount();
    apps.splice(apps.indexOf(view.app), 1);
  }
});

test("resize preserves JQL query and selected result", async () => {
  globalThis.fetch = (async () =>
    Response.json({
      isLast: true,
      issues: Array.from({ length: 15 }, (_, index) => ({
        key: `RESIZE-${index + 1}`,
        fields: { summary: `Resize ${index + 1}`, issuetype: { name: "Task" } },
      })),
    })) as unknown as typeof fetch;
  const picked: string[] = [];
  const view = renderJql(
    (key) => picked.push(key),
    () => {},
    { cols: 80, rows: 24 },
  );
  view.stdin.write("project = RESIZE");
  await waitFor(() => view.output().includes("project = RESIZE"), "resize JQL input");
  view.stdin.write("\r");
  await waitFor(() => view.output().includes("RESIZE-1"), "resize JQL results");
  for (let index = 0; index < 8; index++) await sendInput(view.app, view.stdin, "\u001b[B");
  view.resize({ cols: 120, rows: 40 });
  await view.app.waitUntilRenderFlush();
  await sendInput(view.app, view.stdin, "\r");
  expect(picked).toEqual(["RESIZE-9"]);
  view.app.unmount();
});
