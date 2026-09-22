import { afterEach, expect, test } from "bun:test";
import { PassThrough } from "node:stream";

import { render } from "ink";

import type { EditableField, Transition } from "../jira";
import { createTerminal, nextTurn, sendInput } from "../test/utils";
import { TransitionScreenModal } from "./TransitionScreenModal";

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

test("windows required fields and keeps the selected last field reachable", async () => {
  const fields: EditableField[] = Array.from({ length: 30 }, (_, index) => ({
    id: `field-${index}`,
    name: `Synthetic field ${index}`,
    kind: "number",
    required: true,
    hasDefaultValue: false,
  }));
  const transition: Transition = {
    id: "1",
    name: "Synthetic transition requiring review from the extended review team",
    toStatusId: "2",
    requiredFields: fields,
  };

  for (const [columns, rows] of [
    [80, 24],
    [120, 40],
  ] as const) {
    const initialColumns = columns === 80 ? 120 : 80;
    const initialRows = rows === 24 ? 40 : 24;
    setDimensions(initialColumns, initialRows);
    const terminal = createTerminal(initialColumns, initialRows);
    const app = render(
      <TransitionScreenModal
        cfg={{ server: "https://transition.invalid", authHeader: "Basic test" }}
        projectKey="TEST"
        issueKey="TEST-1"
        transition={transition}
        onCancel={() => {}}
        onSubmit={() => {}}
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
    apps.push(app);
    await app.waitUntilRenderFlush();
    const initial = Bun.stripANSI(terminal.output());
    const lines = initial.split("\n");
    expect(lines.length).toBeLessThanOrEqual(initialRows);
    expect(Math.max(...lines.map((line) => Bun.stringWidth(line)))).toBeLessThanOrEqual(
      initialColumns,
    );
    expect(initial).toContain("esc cancel");
    expect(initial).toContain("TEST-1");

    for (let index = 0; index < fields.length - 1; index++) {
      await sendInput(app, terminal.stdin, "\x1b[B");
    }
    terminal.clearOutput();
    setDimensions(columns, rows);
    terminal.stdout.columns = columns;
    terminal.stdout.rows = rows;
    process.stdout.emit("resize");
    await nextTurn();
    await app.waitUntilRenderFlush();
    const lastSelection = Bun.stripANSI(terminal.output());
    const finalLines = lastSelection.split("\n");
    expect(finalLines.length).toBeLessThanOrEqual(rows);
    expect(Math.max(...finalLines.map((line) => Bun.stringWidth(line)))).toBeLessThanOrEqual(
      columns,
    );
    expect(lastSelection).toContain("Synthetic field 29");
    expect(lastSelection).toContain("30/30");
    expect(lastSelection).toContain("esc cancel");

    app.unmount();
    apps.splice(apps.indexOf(app), 1);
  }
});
