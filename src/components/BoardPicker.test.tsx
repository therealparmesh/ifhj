import { afterEach, expect, test } from "bun:test";
import { PassThrough } from "node:stream";

import { render } from "ink";

import type { JiraConfig } from "../config";
import type { Board } from "../jira";
import { createTerminal, deferred, sendInput, waitFor } from "../test/utils";
import { BoardPicker } from "./BoardPicker";

const originalFetch = globalThis.fetch;
const apps: ReturnType<typeof render>[] = [];

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const app of apps.splice(0)) app.unmount();
});

function board(id: number, name: string): Board {
  return { id, name, type: "kanban", projectKey: name.toUpperCase() };
}

function boardResponse(boards: Board[]): Response {
  return Response.json({ values: boards, isLast: true, startAt: 0, maxResults: boards.length });
}

function mount(cfg: JiraConfig, onPick: (value: Board) => void) {
  const terminal = createTerminal();
  const app = render(<BoardPicker cfg={cfg} onPick={onPick} onQuit={() => {}} />, {
    interactive: true,
    stdin: terminal.stdin as unknown as typeof process.stdin,
    stdout: terminal.stdout as unknown as typeof process.stdout,
    stderr: new PassThrough() as unknown as typeof process.stderr,
    exitOnCtrlC: false,
    patchConsole: false,
  });
  apps.push(app);
  return { app, terminal };
}

test("same-batch query and Return select the first new match", async () => {
  globalThis.fetch = (async () =>
    boardResponse([board(1, "Alpha"), board(2, "Beta")])) as unknown as typeof fetch;
  const picked: Board[] = [];
  const cfg = { server: "https://boards.invalid", authHeader: "Basic test" };
  const { app, terminal } = mount(cfg, (value) => picked.push(value));
  await waitFor(() => terminal.output().includes("Beta"), "board list");

  terminal.stdin.write("bet");
  terminal.stdin.emit("readable");
  terminal.stdin.write("\r");
  terminal.stdin.emit("readable");
  await waitFor(() => picked.length === 1, "batched board pick");

  expect(picked.map((value) => value.name)).toEqual(["Beta"]);
  app.unmount();
});

test("unchanged-query submission keeps the current cursor", async () => {
  globalThis.fetch = (async () =>
    boardResponse([board(1, "Alpha"), board(2, "Beta")])) as unknown as typeof fetch;
  const picked: Board[] = [];
  const cfg = { server: "https://boards.invalid", authHeader: "Basic test" };
  const { app, terminal } = mount(cfg, (value) => picked.push(value));
  await waitFor(() => terminal.output().includes("Beta"), "board list");

  await sendInput(app, terminal.stdin, "\u001b[B");
  await sendInput(app, terminal.stdin, "\r");

  expect(picked.map((value) => value.name)).toEqual(["Beta"]);
  app.unmount();
});

test("config changes hide old boards and errors before the new request settles", async () => {
  const nextBoards = deferred<Response>();
  const recoveredBoards = deferred<Response>();
  globalThis.fetch = (async (input) => {
    const host = new URL(String(input)).host;
    if (host === "old.invalid") return boardResponse([board(1, "Old board")]);
    if (host === "error.invalid") return new Response("old failure", { status: 500 });
    return host === "new.invalid" ? nextBoards.promise : recoveredBoards.promise;
  }) as typeof fetch;
  const picked: Board[] = [];
  const oldCfg = { server: "https://old.invalid", authHeader: "Basic old" };
  const errorCfg = { server: "https://error.invalid", authHeader: "Basic error" };
  const newCfg = { server: "https://new.invalid", authHeader: "Basic new" };
  const recoveredCfg = { server: "https://recovered.invalid", authHeader: "Basic recovered" };
  const { app, terminal } = mount(oldCfg, (value) => picked.push(value));
  await waitFor(() => terminal.output().includes("Old board"), "old board");

  app.rerender(
    <BoardPicker cfg={newCfg} onPick={(value) => picked.push(value)} onQuit={() => {}} />,
  );
  terminal.stdin.write("\r");
  terminal.stdin.emit("readable");
  expect(picked).toEqual([]);
  nextBoards.resolve(boardResponse([board(2, "New board")]));
  await waitFor(() => terminal.output().includes("New board"), "new board");

  app.rerender(
    <BoardPicker cfg={errorCfg} onPick={(value) => picked.push(value)} onQuit={() => {}} />,
  );
  await waitFor(() => terminal.output().includes("old failure"), "old config error");

  terminal.clearOutput();
  app.rerender(
    <BoardPicker cfg={recoveredCfg} onPick={(value) => picked.push(value)} onQuit={() => {}} />,
  );
  terminal.stdin.write("\r");
  terminal.stdin.emit("readable");
  expect(terminal.output()).not.toContain("old failure");
  expect(picked).toEqual([]);

  recoveredBoards.resolve(boardResponse([board(3, "Recovered board")]));
  await waitFor(() => terminal.output().includes("Recovered board"), "recovered board");
  await sendInput(app, terminal.stdin, "\r");
  expect(picked.map((value) => value.name)).toEqual(["Recovered board"]);
  app.unmount();
});
