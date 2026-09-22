import { afterEach, expect, test } from "bun:test";
import { PassThrough } from "node:stream";

import { render } from "ink";

import type { JiraConfig } from "../config";
import { createTerminal, deferred, nextTurn, waitFor } from "../test/utils";
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

function renderJql(onPick: (key: string) => void, onCancel: () => void) {
  const { stdin, stdout, output } = createTerminal();
  const cfg: JiraConfig = { server: "https://jql.invalid", authHeader: "Basic test" };
  const app = render(<JqlView cfg={cfg} onPick={onPick} onCancel={onCancel} />, {
    interactive: true,
    stdin: stdin as unknown as typeof process.stdin,
    stdout: stdout as unknown as typeof process.stdout,
    stderr: new PassThrough() as unknown as typeof process.stderr,
    exitOnCtrlC: false,
    patchConsole: false,
  });
  apps.push(app);
  return { stdin, output };
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
