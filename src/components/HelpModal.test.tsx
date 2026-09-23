import { afterEach, expect, test } from "bun:test";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { render } from "ink";

import {
  createTerminal,
  isolatedEnv,
  makeTempDir,
  nextTurn,
  runScript,
  sendInput,
  waitFor,
} from "../test/utils";
import { HelpModal } from "./HelpModal";

const helpUrl = new URL("./HelpModal.tsx", import.meta.url).href;
const utilsUrl = new URL("../test/utils.ts", import.meta.url).href;

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
    interactive: true,
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
  expect(frame(terminal.output())).toContain("Help · board");
  expect(frame(terminal.output())).toContain("move between columns");

  terminal.clearOutput();
  await sendInput(app, terminal.stdin, "\x1b[B");
  expectBounded(terminal.output(), 80, 24);
  expect(frame(terminal.output())).toMatch(/Help · board\s+2-/);

  terminal.clearOutput();
  await sendInput(app, terminal.stdin, "\x1b[A");
  expect(frame(terminal.output())).toMatch(/Help · board\s+1-/);

  terminal.clearOutput();
  await sendInput(app, terminal.stdin, "\x1b[6~");
  expectBounded(terminal.output(), 80, 24);
  expect(frame(terminal.output())).toContain("Timeline Esc");
  expect(frame(terminal.output())).toContain("Timeline Left/Right or h/l");

  terminal.clearOutput();
  await sendInput(app, terminal.stdin, "\x1b[6~");
  expectBounded(terminal.output(), 80, 24);
  expect(frame(terminal.output())).toContain("detail view");

  terminal.clearOutput();
  await sendInput(app, terminal.stdin, "\x1b[5~");
  terminal.clearOutput();
  await sendInput(app, terminal.stdin, "\x1b[5~");
  expectBounded(terminal.output(), 80, 24);
  expect(frame(terminal.output())).toMatch(/Help · board\s+1-/);

  terminal.clearOutput();
  setDimensions(80, 40);
  terminal.stdout.rows = 40;
  process.stdout.emit("resize");
  await nextTurn();
  await app.waitUntilRenderFlush();
  expectBounded(terminal.output(), 80, 40);
  expect(frame(terminal.output())).toContain("Timeline Left/Right or h/l");

  terminal.clearOutput();
  await sendInput(app, terminal.stdin, "\x1b[F");
  expectBounded(terminal.output(), 80, 40);
  expect(frame(terminal.output())).toContain("Help · board");
  expect(frame(terminal.output())).toContain("detail view");
  expect(frame(terminal.output())).toContain("Esc / q");

  terminal.clearOutput();
  setDimensions(40, 24);
  terminal.stdout.columns = 40;
  terminal.stdout.rows = 24;
  process.stdout.emit("resize");
  await nextTurn();
  await app.waitUntilRenderFlush();
  expectBounded(terminal.output(), 40, 24);
  expect(frame(terminal.output())).toContain("Esc/q/?/Enter close");

  terminal.clearOutput();
  await sendInput(app, terminal.stdin, "\x1b[H");
  expectBounded(terminal.output(), 40, 24);
  expect(frame(terminal.output())).toContain("move");
  expect(frame(terminal.output())).toContain("between");
  expect(frame(terminal.output())).toContain("columns");
  expect(frame(terminal.output())).toContain("swim");

  terminal.clearOutput();
  setDimensions(80, 24);
  terminal.stdout.columns = 80;
  process.stdout.emit("resize");
  await nextTurn();
  await app.waitUntilRenderFlush();
  expectBounded(terminal.output(), 80, 24);
  expect(frame(terminal.output())).toContain("Home/End jump · Esc/q/?/Enter close");
});

test("preserves Escape, q, question-mark, and Return close keys", async () => {
  for (const key of ["\x1b", "q", "?", "\r"]) {
    let closes = 0;
    const { app, terminal } = renderHelp(() => closes++);
    await app.waitUntilRenderFlush();
    await sendInput(app, terminal.stdin, key);
    await waitFor(() => closes > 0, `HelpModal close for ${JSON.stringify(key)}`);
    expect(closes).toBe(1);
    app.unmount();
    apps.splice(apps.indexOf(app), 1);
  }
});

test("Vim-only help clamps a resized end range before moving up one row", async () => {
  const home = await makeTempDir("vim-help");
  const bin = join(home, "bin");
  try {
    await mkdir(bin);
    const vim = join(bin, "vim");
    await writeFile(vim, `#!${process.execPath}\nprocess.exit(0);\n`);
    await chmod(vim, 0o700);
    const source = `
      Object.defineProperty(process.stdout, "columns", { value: 40, configurable: true });
      Object.defineProperty(process.stdout, "rows", { value: 24, configurable: true });
      const React = await import("react");
      const { PassThrough } = await import("node:stream");
      const { render } = await import("ink");
      const { createTerminal, nextTurn, sendInput } = await import(${JSON.stringify(utilsUrl)});
      const { HelpModal } = await import(${JSON.stringify(helpUrl)});
      const terminal = createTerminal(40, 24);
      const app = render(React.createElement(HelpModal, { onClose() {} }), {
        interactive: true,
        stdin: terminal.stdin,
        stdout: terminal.stdout,
        stderr: new PassThrough(),
        exitOnCtrlC: false,
        patchConsole: false,
        debug: true,
      });
      await app.waitUntilRenderFlush();
      const freshFrame = () => Bun.stripANSI(terminal.output()).replace(/\\n$/, "");
      const range = (frame) => {
        const match = frame.match(new RegExp("([0-9]+)-([0-9]+)/([0-9]+)"));
        if (!match) throw new Error("help range not found");
        return match.slice(1).map(Number);
      };
      terminal.clearOutput();
      await sendInput(app, terminal.stdin, "\\x1b[F");
      const narrow = freshFrame();

      terminal.clearOutput();
      Object.defineProperty(process.stdout, "columns", { value: 80, configurable: true });
      Object.defineProperty(process.stdout, "rows", { value: 40, configurable: true });
      terminal.stdout.columns = 80;
      terminal.stdout.rows = 40;
      process.stdout.emit("resize");
      await nextTurn();
      await app.waitUntilRenderFlush();
      const resized = freshFrame();

      terminal.clearOutput();
      await sendInput(app, terminal.stdin, "\\x1b[A");
      const moved = freshFrame();
      app.unmount();
      console.log(JSON.stringify({
        narrow: range(narrow),
        resized: range(resized),
        moved: range(moved),
        resizedFrame: resized,
        movedLines: moved.split("\\n").length,
        movedWidth: Math.max(...moved.split("\\n").map((line) => Bun.stringWidth(line))),
      }));
    `;
    const result = await runScript(source, isolatedEnv(home, { PATH: bin }));
    expect(result.exitCode, result.stderr).toBe(0);
    const rendered = JSON.parse(result.stdout) as {
      narrow: [number, number, number];
      resized: [number, number, number];
      moved: [number, number, number];
      resizedFrame: string;
      movedLines: number;
      movedWidth: number;
    };
    expect(rendered.resizedFrame).toContain("edit description (Vim)");
    expect(rendered.resizedFrame).not.toContain("Neovim");
    expect(rendered.resized[0]).toBeLessThan(rendered.narrow[0]);
    expect(rendered.resized[1]).toBe(rendered.resized[2]);
    expect(rendered.moved).toEqual([
      rendered.resized[0] - 1,
      rendered.resized[1] - 1,
      rendered.resized[2],
    ]);
    expect(rendered.movedLines).toBe(40);
    expect(rendered.movedWidth).toBeLessThanOrEqual(80);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
