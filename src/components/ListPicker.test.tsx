import { afterEach, expect, test } from "bun:test";
import { PassThrough } from "node:stream";

import { render } from "ink";
import { useState } from "react";

import { createTerminal, nextTurn, sendInput, waitFor } from "../test/utils";
import { ListPicker } from "./ListPicker";

const apps: ReturnType<typeof render>[] = [];
const columnsDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "columns");
const rowsDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "rows");

function setDimensions(columns: number, rows: number): void {
  Object.defineProperty(process.stdout, "columns", { configurable: true, value: columns });
  Object.defineProperty(process.stdout, "rows", { configurable: true, value: rows });
}

afterEach(() => {
  for (const app of apps.splice(0)) app.unmount();
  if (columnsDescriptor) Object.defineProperty(process.stdout, "columns", columnsDescriptor);
  else delete (process.stdout as unknown as Record<string, unknown>)["columns"];
  if (rowsDescriptor) Object.defineProperty(process.stdout, "rows", rowsDescriptor);
  else delete (process.stdout as unknown as Record<string, unknown>)["rows"];
});

function renderPicker(
  props: Partial<Parameters<typeof ListPicker>[0]> = {},
  columns = 80,
  rows = 24,
) {
  setDimensions(columns, rows);
  const terminal = createTerminal(columns, rows);
  const picked: string[] = [];
  const items = Array.from({ length: 100 }, (_, index) => ({
    id: String(index),
    label: `Option ${index} ${"界".repeat(80)}\nsecond line`,
  }));
  const complete = {
    title: `${"界".repeat(100)}\nsecond heading line`,
    items,
    onPick: (id: string) => picked.push(id),
    onCancel: () => {},
    ...props,
  };
  const app = render(<ListPicker {...complete} />, {
    interactive: true,
    stdin: terminal.stdin as unknown as typeof process.stdin,
    stdout: terminal.stdout as unknown as typeof process.stdout,
    stderr: new PassThrough() as unknown as typeof process.stderr,
    exitOnCtrlC: false,
    patchConsole: false,
    debug: true,
  });
  apps.push(app);
  return { app, terminal, picked };
}

test("uses the latest selection for a real Down/Down/Enter input chunk", async () => {
  const { app, terminal, picked } = renderPicker({
    items: [
      { id: "one", label: "One" },
      { id: "two", label: "Two" },
      { id: "three", label: "Three" },
    ],
  });
  await app.waitUntilRenderFlush();
  terminal.stdin.write("\x1b[B\x1b[B\r");
  await waitFor(() => picked.length === 1, "single-chunk list selection");
  expect(picked).toEqual(["three"]);
});

test("clamps a shrunken list before moving up", async () => {
  const base = {
    title: "Shrinking picker",
    onCancel: () => {},
  };
  const picked: string[] = [];
  const { app, terminal } = renderPicker({
    ...base,
    items: [
      { id: "one", label: "One" },
      { id: "two", label: "Two" },
      { id: "three", label: "Three" },
    ],
    onPick: (id) => picked.push(id),
  });
  await app.waitUntilRenderFlush();
  await sendInput(app, terminal.stdin, "\x1b[B\x1b[B");
  app.rerender(
    <ListPicker
      {...base}
      items={[
        { id: "one", label: "One" },
        { id: "two", label: "Two" },
      ]}
      onPick={(id) => picked.push(id)}
    />,
  );
  await app.waitUntilRenderFlush();
  terminal.stdin.write("\x1b[A\r");
  await waitFor(() => picked.length === 1, "shrunken list movement");
  expect(picked).toEqual(["one"]);
});

test("endpoint and page navigation keep the selected row visible across resize", async () => {
  const { app, terminal } = renderPicker();
  const selectedIndex = () => {
    const match = Bun.stripANSI(terminal.output()).match(/> Option (\d+)/);
    if (!match) throw new Error("selected option not rendered");
    return Number(match[1]);
  };
  await app.waitUntilRenderFlush();
  terminal.clearOutput();
  await sendInput(app, terminal.stdin, "\x1b[F");
  let frame = Bun.stripANSI(terminal.output());
  let lines = frame.split("\n");
  expect(frame).toContain("Option 99");
  expect(selectedIndex()).toBe(99);
  expect(frame).toContain("esc cancel");
  expect(lines.length).toBeLessThanOrEqual(24);
  expect(Math.max(...lines.map((line) => Bun.stringWidth(line)))).toBeLessThanOrEqual(80);

  terminal.clearOutput();
  await sendInput(app, terminal.stdin, "\x1b[H");
  expect(selectedIndex()).toBe(0);

  terminal.clearOutput();
  await sendInput(app, terminal.stdin, "\x1b[6~");
  const pageIndex = selectedIndex();
  expect(pageIndex).toBeGreaterThan(0);
  expect(pageIndex).toBeLessThan(99);

  terminal.clearOutput();
  await sendInput(app, terminal.stdin, "\x1b[F");
  expect(selectedIndex()).toBe(99);

  terminal.clearOutput();
  setDimensions(120, 40);
  terminal.stdout.columns = 120;
  terminal.stdout.rows = 40;
  process.stdout.emit("resize");
  await nextTurn();
  await app.waitUntilRenderFlush();
  frame = Bun.stripANSI(terminal.output());
  lines = frame.split("\n");
  expect(frame).toContain("Option 99");
  expect(frame).toContain("esc cancel");
  expect(lines.length).toBeLessThanOrEqual(40);
  expect(Math.max(...lines.map((line) => Bun.stringWidth(line)))).toBeLessThanOrEqual(120);
});

test("keeps selection fixed during a synchronous parent busy handoff", async () => {
  const picked: string[] = [];
  let releaseBusy!: () => void;
  function Harness() {
    const [busy, setBusy] = useState(false);
    releaseBusy = () => setBusy(false);
    return (
      <ListPicker
        title="Busy handoff"
        items={[
          { id: "one", label: "One" },
          { id: "two", label: "Two" },
        ]}
        busy={busy}
        onPick={(id) => {
          picked.push(id);
          setBusy(true);
        }}
        onCancel={() => {}}
      />
    );
  }
  const terminal = createTerminal(80, 24);
  const app = render(<Harness />, {
    interactive: true,
    stdin: terminal.stdin as unknown as typeof process.stdin,
    stdout: terminal.stdout as unknown as typeof process.stdout,
    stderr: new PassThrough() as unknown as typeof process.stderr,
    exitOnCtrlC: false,
    patchConsole: false,
  });
  apps.push(app);
  await app.waitUntilRenderFlush();
  for (const input of ["\r", "\x1b[B", "\r"]) {
    terminal.stdin.write(input);
    terminal.stdin.emit("readable");
  }
  expect(picked).toEqual(["one"]);
  await nextTurn();
  await app.waitUntilRenderFlush();
  releaseBusy();
  await app.waitUntilRenderFlush();
  await sendInput(app, terminal.stdin, "\r");
  expect(picked).toEqual(["one", "one"]);
});

test("empty lists expose no selectable action", async () => {
  let cancelled = 0;
  const { app, terminal, picked } = renderPicker({ items: [], onCancel: () => cancelled++ });
  await app.waitUntilRenderFlush();
  await sendInput(app, terminal.stdin, "\r");
  expect(picked).toEqual([]);
  await sendInput(app, terminal.stdin, "\x1b");
  expect(cancelled).toBe(1);
});
