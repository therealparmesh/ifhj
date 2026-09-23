import { afterEach, describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";

import { render } from "ink";
import { useState } from "react";

import type { JiraConfig } from "../config";
import type { EditableField, EditableFieldValue } from "../jira";
import { createTerminal, nextTurn, sendInput, waitFor } from "../test/utils";
import { FieldEditor } from "./FieldEditor";

const cfg: JiraConfig = {
  server: "https://field-editor.invalid",
  authHeader: "Basic test",
};

const originalFetch = globalThis.fetch;
const apps: ReturnType<typeof render>[] = [];

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const app of apps.splice(0)) app.unmount();
});

function renderEditor(
  editableField: EditableField,
  onSubmit: (value: EditableFieldValue | null) => void,
  current?: EditableFieldValue,
  projectKey = "PROJ",
  onCancel: () => void = () => {},
) {
  const { stdin, stdout, output } = createTerminal();
  const app = render(
    <FieldEditor
      cfg={cfg}
      projectKey={projectKey}
      field={editableField}
      {...(current !== undefined ? { current } : {})}
      onSubmit={onSubmit}
      onCancel={onCancel}
    />,
    {
      interactive: true,
      stdin: stdin as unknown as typeof process.stdin,
      stdout: stdout as unknown as typeof process.stdout,
      stderr: new PassThrough() as unknown as typeof process.stderr,
      exitOnCtrlC: false,
      patchConsole: false,
    },
  );
  apps.push(app);
  const send = async (input: string) => {
    await nextTurn();
    await app.waitUntilRenderFlush();
    stdin.write(input);
    await nextTurn();
    await app.waitUntilRenderFlush();
  };
  return { app, send, stdin, output };
}

type FieldSpec<T> = T extends unknown ? Omit<T, "id" | "name" | "hasDefaultValue"> : never;

function makeField(value: FieldSpec<EditableField>): EditableField {
  return {
    id: "customfield_1",
    name: "Test field",
    hasDefaultValue: false,
    ...value,
  } as EditableField;
}

describe("FieldEditor", () => {
  test("keeps Escape active when an async user picker replaces its loading screen", async () => {
    globalThis.fetch = (async (_input) =>
      Response.json([{ accountId: "a", displayName: "Synthetic User" }])) as typeof fetch;
    let cancelled = 0;
    const { app, stdin, output } = renderEditor(
      makeField({ kind: "user", required: false }),
      () => {},
      { accountId: "a" },
      "PROJ",
      () => cancelled++,
    );

    await waitFor(() => output().includes("Synthetic User"), "user picker");
    stdin.write("\u001b");
    await waitFor(() => cancelled > 0, "user picker cancellation");
    await app.waitUntilRenderFlush();

    expect(cancelled).toBe(1);
  });

  test("validates a required number, preserves correction input, and submits the fixed value", async () => {
    const terminal = createTerminal();
    const submitted: (EditableFieldValue | null)[] = [];
    let edits = 0;
    function Harness() {
      const [error, setError] = useState<string | undefined>("Rejected old value");
      return (
        <FieldEditor
          cfg={cfg}
          projectKey="PROJ"
          field={makeField({ kind: "number", required: true })}
          error={error}
          onEdit={() => {
            edits++;
            setError(undefined);
          }}
          onSubmit={(value) => submitted.push(value)}
          onCancel={() => {}}
        />
      );
    }
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

    await sendInput(app, terminal.stdin, "\r");
    expect(submitted).toEqual([]);
    expect(terminal.output()).toContain("Test field is required.");

    terminal.clearOutput();
    await sendInput(app, terminal.stdin, "Infinity");
    expect(edits).toBe(1);
    expect(Bun.stripANSI(terminal.output())).toMatch(/›\s+Infinity/);
    expect(terminal.output()).not.toContain("Rejected old value");
    await sendInput(app, terminal.stdin, "\r");
    expect(submitted).toEqual([]);
    expect(terminal.output()).toContain("Enter a finite number.");

    await sendInput(app, terminal.stdin, "\x15");
    await sendInput(app, terminal.stdin, "5");
    await sendInput(app, terminal.stdin, "\r");
    expect(submitted).toEqual([5]);
  });

  test("allows removing the last item from an optional option list", async () => {
    const submitted: (EditableFieldValue | null)[] = [];
    const { send } = renderEditor(
      makeField({
        kind: "option-list",
        required: false,
        allowedValues: [{ id: "a", name: "Alpha" }],
      }),
      (value) => submitted.push(value),
      [{ id: "a" }],
    );

    await send("\r");

    expect(submitted).toEqual([[]]);
  });

  test("keeps the last required option and explains that it must remain", async () => {
    const submitted: (EditableFieldValue | null)[] = [];
    const { send, output } = renderEditor(
      makeField({
        kind: "option-list",
        required: true,
        allowedValues: [
          { id: "a", name: "Alpha" },
          { id: "b", name: "Beta" },
        ],
      }),
      (value) => submitted.push(value),
      [{ id: "a" }],
    );

    expect(output()).toContain("required; keep selected");
    await send("\r");
    expect(submitted).toEqual([]);

    await send("\u001b[B");
    await send("\r");
    expect(submitted).toEqual([[{ id: "a" }, { id: "b" }]]);
  });

  test("keeps the last required user and allows adding another user", async () => {
    globalThis.fetch = (async (input) => {
      const url = new URL(String(input));
      if (url.pathname !== "/rest/api/3/user/assignable/search") {
        throw new Error(`unexpected request: ${url}`);
      }
      return new Response(
        JSON.stringify([
          { accountId: "a", displayName: "Alpha" },
          { accountId: "b", displayName: "Beta" },
        ]),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;
    const submitted: (EditableFieldValue | null)[] = [];
    const { send, output } = renderEditor(
      makeField({ kind: "user-list", required: true }),
      (value) => submitted.push(value),
      [{ accountId: "a" }],
    );

    await waitFor(() => output().includes("required; keep selected"), "required user choices");
    await send("\r");
    expect(submitted).toEqual([]);

    await send("\u001b[B");
    await send("\r");
    expect(submitted).toEqual([[{ accountId: "a" }, { accountId: "b" }]]);
  });

  test("does not expose the clear shortcut for a required option", async () => {
    const submitted: (EditableFieldValue | null)[] = [];
    const { send } = renderEditor(
      makeField({
        kind: "option",
        required: true,
        allowedValues: [{ id: "a", name: "Alpha" }],
      }),
      (value) => submitted.push(value),
      { id: "a" },
    );

    await send("\x18");

    expect(submitted).toEqual([]);
    await send("\r");
    expect(submitted).toEqual([{ id: "a" }]);
  });

  test("ignores users loaded for a previous project and field context", async () => {
    let resolveOld!: (response: Response) => void;
    const oldUsers = new Promise<Response>((resolve) => {
      resolveOld = resolve;
    });
    globalThis.fetch = (async (input) => {
      const url = new URL(String(input));
      if (url.pathname !== "/rest/api/3/user/assignable/search") {
        throw new Error(`unexpected request: ${url}`);
      }
      const project = url.searchParams.get("project");
      if (project === "OLD") return oldUsers;
      return Response.json([{ accountId: "new", displayName: "New User" }]);
    }) as typeof fetch;
    const oldField = makeField({ kind: "user-list", required: false });
    const newField = { ...oldField, id: "customfield_2", name: "New field" };
    const { app, output } = renderEditor(oldField, () => {}, undefined, "OLD");
    await nextTurn();

    app.rerender(
      <FieldEditor
        cfg={cfg}
        projectKey="NEW"
        field={newField}
        onSubmit={() => {}}
        onCancel={() => {}}
      />,
    );
    await waitFor(() => output().includes("New User"), "new project users");

    resolveOld(Response.json([{ accountId: "old", displayName: "Old User" }]));
    await nextTurn();
    await app.waitUntilRenderFlush();
    expect(output()).not.toContain("Old User");
  });

  test("only plain e leaves the picker error screen and Ctrl+P reaches the full reason", async () => {
    const terminal = createTerminal();
    let edits = 0;
    const reason = `${"Detailed validation reason. ".repeat(20)}FINAL_REASON`;
    function Harness() {
      const [error, setError] = useState<string | undefined>(reason);
      return (
        <FieldEditor
          cfg={cfg}
          projectKey="PROJ"
          field={makeField({
            kind: "option",
            required: false,
            allowedValues: [{ id: "a", name: "Alpha" }],
          })}
          error={error}
          onEdit={() => {
            edits++;
            setError(undefined);
          }}
          onSubmit={() => {}}
          onCancel={() => {}}
        />
      );
    }
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

    for (const input of ["x", "\x1b[B", "\x05", "\x1be"]) {
      await sendInput(app, terminal.stdin, input);
      expect(edits).toBe(0);
    }
    expect(outputHas(terminal.output(), "Test field was not saved")).toBe(true);

    for (let page = 0; page < 20 && !terminal.output().includes("FINAL_REASON"); page++) {
      terminal.clearOutput();
      await sendInput(app, terminal.stdin, "\x10");
    }
    expect(terminal.output()).toContain("FINAL_REASON");
    expect(edits).toBe(0);

    terminal.clearOutput();
    await sendInput(app, terminal.stdin, "e");
    expect(edits).toBe(1);
    expect(terminal.output()).toContain("Alpha");
  });
});

function outputHas(output: string, value: string): boolean {
  return Bun.stripANSI(output).includes(value);
}
