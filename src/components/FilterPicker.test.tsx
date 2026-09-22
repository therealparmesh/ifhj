import { expect, test } from "bun:test";
import { PassThrough } from "node:stream";

import { render } from "ink";

import { createTerminal, sendInput, waitFor } from "../test/utils";
import { FilterPicker } from "./FilterPicker";

const columnsDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "columns");
const rowsDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "rows");

function setDimensions(columns: number, rows: number): void {
  Object.defineProperty(process.stdout, "columns", { configurable: true, value: columns });
  Object.defineProperty(process.stdout, "rows", { configurable: true, value: rows });
}

function restoreDimensions(): void {
  if (columnsDescriptor) Object.defineProperty(process.stdout, "columns", columnsDescriptor);
  else delete (process.stdout as unknown as Record<string, unknown>)["columns"];
  if (rowsDescriptor) Object.defineProperty(process.stdout, "rows", rowsDescriptor);
  else delete (process.stdout as unknown as Record<string, unknown>)["rows"];
}

test("local picker selects from the latest batched query", async () => {
  const terminal = createTerminal();
  const picked: string[] = [];
  const app = render(
    <FilterPicker
      title="fruit"
      items={[
        { id: "apple", label: "Apple" },
        { id: "banana", label: "Banana" },
      ]}
      onPick={(id) => picked.push(id)}
      onCancel={() => {}}
    />,
    {
      interactive: true,
      stdin: terminal.stdin as unknown as typeof process.stdin,
      stdout: terminal.stdout as unknown as typeof process.stdout,
      stderr: new PassThrough() as unknown as typeof process.stderr,
      exitOnCtrlC: false,
      patchConsole: false,
    },
  );

  await app.waitUntilRenderFlush();
  terminal.stdin.write("ban");
  terminal.stdin.emit("readable");
  terminal.stdin.write("\r");
  terminal.stdin.emit("readable");
  await waitFor(() => picked.length === 1, "filtered picker submission");
  expect(picked).toEqual(["banana"]);
  app.unmount();
});

test("keeps the selected last option and cancel footer inside standard terminals", async () => {
  const items = Array.from({ length: 100 }, (_, index) => ({
    id: String(index),
    label: `Synthetic reviewer ${index} with a deliberately extended display name`,
    hint: `reviewer-${index}@example.invalid`,
  }));
  try {
    for (const [columns, rows] of [
      [80, 24],
      [120, 40],
    ] as const) {
      setDimensions(columns, rows);
      const terminal = createTerminal(columns, rows);
      const app = render(
        <FilterPicker
          title="Synthetic assignee picker"
          items={items}
          currentId="99"
          onPick={() => {}}
          onCancel={() => {}}
        />,
        {
          interactive: true,
          stdin: terminal.stdin as unknown as typeof process.stdin,
          stdout: terminal.stdout as unknown as typeof process.stdout,
          stderr: new PassThrough() as unknown as typeof process.stderr,
          exitOnCtrlC: false,
          patchConsole: false,
        },
      );
      try {
        await app.waitUntilRenderFlush();
        const frame = Bun.stripANSI(terminal.output());
        const lines = frame.split("\n");
        expect(lines.length).toBeLessThanOrEqual(rows);
        expect(Math.max(...lines.map((line) => Bun.stringWidth(line)))).toBeLessThanOrEqual(
          columns,
        );
        expect(frame).toContain("Synthetic reviewer 99");
        expect(frame).toContain("reviewer-99");
        expect(frame).toContain("(active)");
        expect(frame).toContain("esc cancel");
      } finally {
        app.unmount();
      }
    }
  } finally {
    restoreDimensions();
  }
});

test("shows the edited tail of a long query and submits its matching item", async () => {
  const query = `${"x".repeat(100)}VISIBLE_END`;
  setDimensions(80, 24);
  const terminal = createTerminal(80, 24);
  const picked: string[] = [];
  const app = render(
    <FilterPicker
      title="Synthetic query picker"
      items={[{ id: "match-id", label: query }]}
      onPick={(id) => picked.push(id)}
      onCancel={() => {}}
    />,
    {
      interactive: true,
      stdin: terminal.stdin as unknown as typeof process.stdin,
      stdout: terminal.stdout as unknown as typeof process.stdout,
      stderr: new PassThrough() as unknown as typeof process.stderr,
      exitOnCtrlC: false,
      patchConsole: false,
    },
  );
  try {
    await app.waitUntilRenderFlush();
    terminal.clearOutput();
    await sendInput(app, terminal.stdin, query);
    const rendered = Bun.stripANSI(terminal.output());
    expect(rendered).toContain("VISIBLE_END");
    expect(rendered.split("\n").length).toBeLessThanOrEqual(24);
    expect(
      Math.max(...rendered.split("\n").map((line) => Bun.stringWidth(line))),
    ).toBeLessThanOrEqual(80);

    await sendInput(app, terminal.stdin, "\r");
    await waitFor(() => picked.length === 1, "long-query picker submission");
    expect(picked).toEqual(["match-id"]);
  } finally {
    app.unmount();
    restoreDimensions();
  }
});
