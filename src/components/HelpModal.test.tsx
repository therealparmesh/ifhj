import { afterEach, expect, test } from "bun:test";
import { PassThrough } from "node:stream";

import { render } from "ink";

import { createTerminal, nextTurn, sendInput } from "../test/utils";
import { HelpModal } from "./HelpModal";

const apps: ReturnType<typeof render>[] = [];
const columnsDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "columns");
const rowsDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "rows");

function setDimensions(columns: number, rows: number): void {
  Object.defineProperty(process.stdout, "columns", { configurable: true, value: columns });
  Object.defineProperty(process.stdout, "rows", { configurable: true, value: rows });
}

function restoreDimension(name: "columns" | "rows", descriptor: PropertyDescriptor | undefined) {
  if (descriptor) Object.defineProperty(process.stdout, name, descriptor);
  else delete (process.stdout as unknown as Record<string, unknown>)[name];
}

afterEach(() => {
  for (const app of apps.splice(0)) app.unmount();
  restoreDimension("columns", columnsDescriptor);
  restoreDimension("rows", rowsDescriptor);
});

function frame(output: string): string {
  return Bun.stripANSI(output).replace(/\n$/, "");
}

function expectBounded(output: string, columns: number, rows: number): void {
  const lines = frame(output).split("\n");
  expect(lines).toHaveLength(rows);
  expect(Math.max(...lines.map((line) => Bun.stringWidth(line)))).toBeLessThanOrEqual(columns);
}

function renderHelp(onClose = () => {}, columns = 80, rows = 24) {
  setDimensions(columns, rows);
  const terminal = createTerminal(columns, rows);
  const app = render(<HelpModal onClose={onClose} />, {
    stdin: terminal.stdin as unknown as typeof process.stdin,
    stdout: terminal.stdout as unknown as typeof process.stdout,
    stderr: new PassThrough() as unknown as typeof process.stderr,
    exitOnCtrlC: false,
    patchConsole: false,
    debug: true,
  });
  apps.push(app);
  return { app, terminal };
}

test("windows every binding with page, endpoint, and resize navigation", async () => {
  const { app, terminal } = renderHelp();
  await app.waitUntilRenderFlush();
  expectBounded(terminal.output(), 80, 24);
  expect(frame(terminal.output())).toContain("help · board");
  expect(frame(terminal.output())).toContain("move between columns");

  terminal.clearOutput();
  await sendInput(app, terminal.stdin, "\x1b[B");
  expectBounded(terminal.output(), 80, 24);
  expect(frame(terminal.output())).toMatch(/help · board\s+2-/);

  terminal.clearOutput();
  await sendInput(app, terminal.stdin, "\x1b[A");
  expect(frame(terminal.output())).toMatch(/help · board\s+1-/);

  terminal.clearOutput();
  await sendInput(app, terminal.stdin, "\x1b[6~");
  expectBounded(terminal.output(), 80, 24);
  expect(frame(terminal.output())).toContain("detail view");

  terminal.clearOutput();
  await sendInput(app, terminal.stdin, "\x1b[5~");
  expectBounded(terminal.output(), 80, 24);
  expect(frame(terminal.output())).toMatch(/help · board\s+1-/);

  terminal.clearOutput();
  setDimensions(80, 40);
  terminal.stdout.rows = 40;
  process.stdout.emit("resize");
  await nextTurn();
  await app.waitUntilRenderFlush();
  expectBounded(terminal.output(), 80, 40);
  expect(frame(terminal.output())).toContain("detail view");

  terminal.clearOutput();
  await sendInput(app, terminal.stdin, "\x1b[F");
  expectBounded(terminal.output(), 80, 40);
  expect(frame(terminal.output())).toContain("help · board");
  expect(frame(terminal.output())).toContain("detail view");
  expect(frame(terminal.output())).toContain("esc / q   close");

  terminal.clearOutput();
  setDimensions(40, 24);
  terminal.stdout.columns = 40;
  terminal.stdout.rows = 24;
  process.stdout.emit("resize");
  await nextTurn();
  await app.waitUntilRenderFlush();
  expectBounded(terminal.output(), 40, 24);
  expect(frame(terminal.output())).toContain("esc/q/?/⏎ close");

  terminal.clearOutput();
  await sendInput(app, terminal.stdin, "\x1b[H");
  expectBounded(terminal.output(), 40, 24);
  expect(frame(terminal.output())).toContain("move between columns");
  expect(frame(terminal.output())).toContain("swim view)");

  terminal.clearOutput();
  setDimensions(80, 24);
  terminal.stdout.columns = 80;
  process.stdout.emit("resize");
  await nextTurn();
  await app.waitUntilRenderFlush();
  expectBounded(terminal.output(), 80, 24);
  expect(frame(terminal.output())).toContain("Home/End jump · esc/q/?/⏎ close");
});

test("preserves Escape, q, question-mark, and Return close keys", async () => {
  for (const key of ["\x1b", "q", "?", "\r"]) {
    let closes = 0;
    const { app, terminal } = renderHelp(() => closes++);
    await app.waitUntilRenderFlush();
    await sendInput(app, terminal.stdin, key);
    expect(closes).toBe(1);
    app.unmount();
    apps.splice(apps.indexOf(app), 1);
  }
});

test("first Up uses the displayed offset after enlarging the viewport", async () => {
  const { app, terminal } = renderHelp(() => {}, 40, 24);
  await app.waitUntilRenderFlush();
  terminal.clearOutput();
  await sendInput(app, terminal.stdin, "\x1b[F");
  expectBounded(terminal.output(), 40, 24);
  expect(frame(terminal.output())).toContain("42-60/60");

  terminal.clearOutput();
  setDimensions(80, 40);
  terminal.stdout.columns = 80;
  terminal.stdout.rows = 40;
  process.stdout.emit("resize");
  await nextTurn();
  await app.waitUntilRenderFlush();
  expectBounded(terminal.output(), 80, 40);
  expect(frame(terminal.output())).toContain("10-44/44");

  terminal.clearOutput();
  await sendInput(app, terminal.stdin, "\x1b[A");
  expectBounded(terminal.output(), 80, 40);
  expect(frame(terminal.output())).toContain("9-43/44");
});
