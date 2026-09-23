import { afterEach, expect, test } from "bun:test";
import { PassThrough } from "node:stream";

import { render } from "ink";
import { useState } from "react";

import type { EditableField, Transition } from "../jira";
import { createTerminal, nextTurn, sendInput, waitFor } from "../test/utils";
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

test("notifies a stateful caller only when a field value changes", async () => {
  const field: EditableField = {
    id: "estimate",
    name: "Estimate",
    kind: "number",
    required: true,
    hasDefaultValue: false,
  };
  const transition: Transition = {
    id: "close",
    name: "Close issue",
    toStatusId: "2",
    requiredFields: [field],
  };
  let edits = 0;
  function Harness() {
    const [error, setError] = useState<string | null>("Estimate must be positive");
    return (
      <TransitionScreenModal
        cfg={{ server: "https://transition-edit.invalid", authHeader: "Basic test" }}
        projectKey="TEST"
        issueKey="TEST-1"
        transition={transition}
        initialValues={{ estimate: -1 }}
        error={error}
        onEdit={() => {
          edits++;
          setError(null);
        }}
        onCancel={() => {}}
        onSubmit={() => {}}
      />
    );
  }
  const terminal = createTerminal();
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

  terminal.clearOutput();
  await sendInput(app, terminal.stdin, "\r");
  terminal.clearOutput();
  await sendInput(app, terminal.stdin, "\u001b");
  await waitFor(() => terminal.output().includes("Close issue"), "form after unchanged cancel");
  expect(edits).toBe(0);
  expect(terminal.output()).toContain("Estimate must be positive");

  terminal.clearOutput();
  await sendInput(app, terminal.stdin, "\r");
  terminal.clearOutput();
  await sendInput(app, terminal.stdin, "\r");
  await waitFor(() => terminal.output().includes("Close issue"), "form after unchanged submit");
  expect(edits).toBe(0);
  expect(terminal.output()).toContain("Estimate must be positive");
  expect(terminal.output()).toMatch(/Estimate\s+-1/);

  terminal.clearOutput();
  await sendInput(app, terminal.stdin, "\r");
  await sendInput(app, terminal.stdin, "\x15");
  await sendInput(app, terminal.stdin, "5");
  terminal.clearOutput();
  await sendInput(app, terminal.stdin, "\r");
  expect(edits).toBe(1);
  expect(terminal.output()).toMatch(/Estimate\s+5/);
  expect(terminal.output()).not.toContain("Estimate must be positive");
});

test("busy transition copy does not advertise disabled actions", async () => {
  const busyTransition: Transition = {
    id: "close",
    name: "Close issue",
    toStatusId: "2",
    requiredFields: [
      {
        id: "root-cause",
        name: "Root cause",
        kind: "unsupported",
        schemaType: "richtext",
        required: true,
        hasDefaultValue: false,
      },
    ],
  };
  const idleTransition: Transition = {
    ...busyTransition,
    requiredFields: [
      {
        id: "estimate",
        name: "Estimate",
        kind: "number",
        required: true,
        hasDefaultValue: false,
      },
    ],
  };
  let cancels = 0;
  let submits = 0;
  let edits = 0;
  let opens = 0;
  const terminal = createTerminal();
  const element = (busy: boolean) => (
    <TransitionScreenModal
      cfg={{ server: "https://transition-busy.invalid", authHeader: "Basic test" }}
      projectKey="TEST"
      issueKey="TEST-1"
      transition={busy ? busyTransition : idleTransition}
      initialValues={busy ? {} : { estimate: 1 }}
      busy={busy}
      onCancel={() => cancels++}
      onSubmit={() => submits++}
      onEdit={() => edits++}
      onOpenIssue={() => opens++}
    />
  );
  const app = render(element(true), {
    interactive: true,
    stdin: terminal.stdin as unknown as typeof process.stdin,
    stdout: terminal.stdout as unknown as typeof process.stdout,
    stderr: new PassThrough() as unknown as typeof process.stderr,
    exitOnCtrlC: false,
    patchConsole: false,
  });
  apps.push(app);
  await app.waitUntilRenderFlush();
  const frame = terminal.output();
  expect(frame).toContain("Saving transition. Inputs are unavailable.");
  expect(frame).toContain("unavailable while saving");
  expect(frame).toContain("Please wait for the save to finish");
  expect(frame).not.toContain("press s to submit");
  expect(frame).not.toContain("press o to open");
  expect(frame).not.toContain("esc cancel");
  expect(frame).not.toContain("s submit");
  await sendInput(app, terminal.stdin, "s");
  await sendInput(app, terminal.stdin, "\r");
  await sendInput(app, terminal.stdin, "o");
  await sendInput(app, terminal.stdin, "\u001b");
  expect({ cancels, submits, edits, opens }).toEqual({
    cancels: 0,
    submits: 0,
    edits: 0,
    opens: 0,
  });

  terminal.clearOutput();
  app.rerender(element(false));
  await waitFor(() => terminal.output().includes("Fill required fields"), "enabled transition");
  await sendInput(app, terminal.stdin, "\r");
  await sendInput(app, terminal.stdin, "\x15");
  await sendInput(app, terminal.stdin, "2");
  await sendInput(app, terminal.stdin, "\r");
  expect(edits).toBe(1);
  await sendInput(app, terminal.stdin, "o");
  await sendInput(app, terminal.stdin, "s");
  await sendInput(app, terminal.stdin, "\u001b");
  expect({ cancels, submits, edits, opens }).toEqual({
    cancels: 1,
    submits: 1,
    edits: 1,
    opens: 1,
  });
});
