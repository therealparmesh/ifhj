import { afterEach, expect, test } from "bun:test";
import { PassThrough } from "node:stream";

import { render } from "ink";
import { useState } from "react";

import { createTerminal, nextTurn, sendInput, waitFor } from "../test/utils";
import { FilterPicker } from "./FilterPicker";

const columnsDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "columns");
const rowsDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "rows");
const apps: ReturnType<typeof render>[] = [];

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

afterEach(() => {
  for (const app of apps.splice(0)) app.unmount();
  restoreDimensions();
});

function interactive(node: React.ReactNode, columns = 80, rows = 24) {
  setDimensions(columns, rows);
  const terminal = createTerminal(columns, rows);
  const app = render(node, {
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
  apps.push(app);

  await app.waitUntilRenderFlush();
  terminal.stdin.write("ban");
  terminal.stdin.emit("readable");
  terminal.stdin.write("\r");
  terminal.stdin.emit("readable");
  await waitFor(() => picked.length === 1, "filtered picker submission");
  expect(picked).toEqual(["banana"]);
});

test("pages the result list while Home and End continue to edit query text", async () => {
  const picked: string[] = [];
  const items = Array.from({ length: 30 }, (_, index) => ({
    id: String(index),
    label: `Item ${index}`,
  }));
  const { app, terminal } = interactive(
    <FilterPicker
      title="paging"
      items={items}
      onPick={(id) => picked.push(id)}
      onCancel={() => {}}
    />,
  );
  await app.waitUntilRenderFlush();
  await sendInput(app, terminal.stdin, "abc");
  await sendInput(app, terminal.stdin, "\x1b[H");
  await sendInput(app, terminal.stdin, "\x1b[F");
  terminal.stdin.write("\x15\x1b[6~\r");
  await waitFor(() => picked.length === 1, "filter page navigation");
  expect(picked).toEqual(["10"]);
});

test("resets a changed query before navigation and submission commit", async () => {
  const picked: string[] = [];
  const { app, terminal } = interactive(
    <FilterPicker
      title="letters"
      items={[
        { id: "alpha", label: "Alpha" },
        { id: "amber", label: "Amber" },
        { id: "beta", label: "Beta" },
      ]}
      onPick={(id) => picked.push(id)}
      onCancel={() => {}}
    />,
  );
  await app.waitUntilRenderFlush();
  await sendInput(app, terminal.stdin, "\x1b[B\x1b[B");
  terminal.stdin.write("a");
  terminal.stdin.emit("readable");
  terminal.stdin.write("\r");
  terminal.stdin.emit("readable");
  await waitFor(() => picked.length === 1, "query-reset selection");
  expect(picked).toEqual(["alpha"]);

  await Bun.sleep(0);
  terminal.stdin.write("\x15m");
  terminal.stdin.emit("readable");
  terminal.stdin.write("\x1b[B");
  terminal.stdin.emit("readable");
  terminal.stdin.write("\r");
  terminal.stdin.emit("readable");
  await waitFor(() => picked.length === 2, "query and navigation selection");
  expect(picked[1]).toBe("amber");
});

test("clamps rendered and submitted selection when items shrink", async () => {
  const picked: string[] = [];
  const base = {
    title: "changing",
    onPick: (id: string) => picked.push(id),
    onCancel: () => {},
  };
  const { app, terminal } = interactive(
    <FilterPicker
      {...base}
      items={[
        { id: "one", label: "One" },
        { id: "two", label: "Two" },
        { id: "three", label: "Three" },
      ]}
    />,
  );
  await app.waitUntilRenderFlush();
  await sendInput(app, terminal.stdin, "\x1b[B\x1b[B");
  terminal.clearOutput();
  app.rerender(
    <FilterPicker
      {...base}
      items={[
        { id: "one", label: "One" },
        { id: "two", label: "Two" },
      ]}
    />,
  );
  await app.waitUntilRenderFlush();
  expect(Bun.stripANSI(terminal.output())).toContain("> Two");
  terminal.stdin.write("\x1b[A\r");
  await waitFor(() => picked.length === 1, "shrunken filter movement");
  expect(picked).toEqual(["one"]);
});

test("does not select remote items that belong to an older query", async () => {
  const picked: string[] = [];
  const queries: string[] = [];
  const { app, terminal } = interactive(
    <FilterPicker
      title="remote"
      items={[{ id: "old", label: "Old result" }]}
      itemsQuery=""
      onQueryChange={(query) => queries.push(query)}
      onPick={(id) => picked.push(id)}
      onCancel={() => {}}
    />,
  );
  await app.waitUntilRenderFlush();
  terminal.stdin.write("new\r");
  await Bun.sleep(20);
  expect(picked).toEqual([]);
  expect(queries).toContain("new");
});

test("retries only the matching remote error and retains its query", async () => {
  const retries: string[] = [];
  const picked: string[] = [];

  function Harness() {
    const [result, setResult] = useState<{
      query: string;
      loading: boolean;
      error?: string;
      items: { id: string; label: string }[];
    }>({ query: "", loading: false, items: [] });
    return (
      <FilterPicker
        title="remote"
        items={result.items}
        itemsQuery={result.query}
        loading={result.loading}
        {...(result.error ? { error: result.error } : {})}
        onQueryChange={(query) =>
          setResult({ query, loading: false, error: "Search failed.", items: [] })
        }
        onRetry={(query) => {
          retries.push(query);
          setResult({ query, loading: false, items: [{ id: "ready", label: "Ready" }] });
        }}
        onPick={(id) => picked.push(id)}
        onCancel={() => {}}
      />
    );
  }

  const { app, terminal } = interactive(<Harness />);
  await app.waitUntilRenderFlush();
  await sendInput(app, terminal.stdin, "abc");
  await waitFor(() => Bun.stripANSI(terminal.output()).includes("Search failed."), "remote error");
  terminal.stdin.write("\r");
  terminal.stdin.emit("readable");
  terminal.stdin.write("\r");
  terminal.stdin.emit("readable");
  await waitFor(() => retries.length === 1, "deduplicated retry");
  expect(retries).toEqual(["abc"]);
  expect(Bun.stripANSI(terminal.output())).toContain("abc");
  await Bun.sleep(0);
  await sendInput(app, terminal.stdin, "\r");
  expect(picked).toEqual(["ready"]);
});

test("blocks query edits during a synchronous parent busy handoff", async () => {
  const picked: string[] = [];
  let releaseBusy!: () => void;
  function Harness() {
    const [busy, setBusy] = useState(false);
    releaseBusy = () => setBusy(false);
    return (
      <FilterPicker
        title="busy handoff"
        items={[{ id: "alpha", label: "Alpha" }]}
        busy={busy}
        onPick={(id) => {
          picked.push(id);
          setBusy(true);
        }}
        onCancel={() => {}}
      />
    );
  }
  const { app, terminal } = interactive(<Harness />);
  await app.waitUntilRenderFlush();
  terminal.stdin.write("\r");
  terminal.stdin.emit("readable");
  terminal.stdin.write("a");
  terminal.stdin.emit("readable");
  terminal.stdin.write("\r");
  terminal.stdin.emit("readable");
  expect(picked).toEqual(["alpha"]);
  await nextTurn();
  await app.waitUntilRenderFlush();
  releaseBusy();
  await app.waitUntilRenderFlush();
  await sendInput(app, terminal.stdin, "\r");
  expect(picked).toEqual(["alpha", "alpha"]);
});

test("keeps the selected final option visible after a live resize", async () => {
  const items = Array.from({ length: 100 }, (_, index) => ({
    id: String(index),
    label: `Reviewer ${index}`,
  }));
  const base = {
    title: "resizing",
    currentId: "99",
    onPick: () => {},
    onCancel: () => {},
  };
  const { app, terminal } = interactive(<FilterPicker {...base} items={items} />);
  await app.waitUntilRenderFlush();
  terminal.clearOutput();
  setDimensions(120, 40);
  terminal.stdout.columns = 120;
  terminal.stdout.rows = 40;
  app.rerender(<FilterPicker {...base} items={items.slice(0, 20)} />);
  process.stdout.emit("resize");
  await nextTurn();
  await app.waitUntilRenderFlush();
  const frame = Bun.stripANSI(terminal.output());
  expect(frame).toContain("Reviewer 19");
  expect(frame).toContain("esc cancel");
});

test("bounds multiline headings and long remote errors above the footer", async () => {
  const { app, terminal } = interactive(
    <FilterPicker
      title={`${"界".repeat(100)}\nsecond heading`}
      items={[]}
      itemsQuery=""
      error={`${"Failure details ".repeat(30)}\nsecond error line`}
      onRetry={() => {}}
      onQueryChange={() => {}}
      onPick={() => {}}
      onCancel={() => {}}
    />,
  );
  await app.waitUntilRenderFlush();
  const frame = Bun.stripANSI(terminal.output());
  const lines = frame.split("\n");
  expect(frame).toContain("esc cancel");
  expect(frame).toContain("⏎ retry");
  expect(lines.length).toBeLessThanOrEqual(24);
  expect(Math.max(...lines.map((line) => Bun.stringWidth(line)))).toBeLessThanOrEqual(80);
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
