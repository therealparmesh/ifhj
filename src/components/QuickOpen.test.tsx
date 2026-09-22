import { afterEach, expect, test } from "bun:test";
import { PassThrough } from "node:stream";

import { render } from "ink";

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

function mount(recents: RecentIssue[], onPick: (key: string) => void, onCancel = () => {}) {
  const terminal = createTerminal();
  const app = render(
    <QuickOpen cfg={cfg} recents={recents} onPick={onPick} onCancel={onCancel} />,
    {
      stdin: terminal.stdin as unknown as typeof process.stdin,
      stdout: terminal.stdout as unknown as typeof process.stdout,
      stderr: new PassThrough() as unknown as typeof process.stderr,
      exitOnCtrlC: false,
      patchConsole: false,
    },
  );
  apps.push(app);
  return { app, terminal };
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
  await waitFor(() => terminal.output().includes("searching"), "loading search");
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
