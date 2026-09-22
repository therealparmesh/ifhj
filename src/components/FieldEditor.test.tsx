import { afterEach, describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";

import { render } from "ink";

import type { JiraConfig } from "../config";
import type { EditableField, EditableFieldValue } from "../jira";
import { createTerminal, nextTurn, waitFor } from "../test/utils";
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
) {
  const { stdin, stdout, output } = createTerminal();
  const app = render(
    <FieldEditor
      cfg={cfg}
      projectKey={projectKey}
      field={editableField}
      {...(current !== undefined ? { current } : {})}
      onSubmit={onSubmit}
      onCancel={() => {}}
    />,
    {
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
  return { app, send, output };
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
  test("rejects non-finite numbers instead of submitting JSON null", async () => {
    const submitted: (EditableFieldValue | null)[] = [];
    const { send } = renderEditor(makeField({ kind: "number", required: false }), (value) =>
      submitted.push(value),
    );

    await send("Infinity");
    await send("\r");

    expect(submitted).toEqual([]);
  });

  test("submits a finite number through the same input path", async () => {
    const submitted: (EditableFieldValue | null)[] = [];
    const { send } = renderEditor(makeField({ kind: "number", required: false }), (value) =>
      submitted.push(value),
    );

    await send("42.5");
    await send("\r");

    expect(submitted).toEqual([42.5]);
  });

  test("does not clear a required scalar with empty input", async () => {
    const submitted: (EditableFieldValue | null)[] = [];
    const { send } = renderEditor(makeField({ kind: "number", required: true }), (value) =>
      submitted.push(value),
    );

    await send("\r");

    expect(submitted).toEqual([]);
  });

  test("removes one selected option while preserving the other values", async () => {
    const submitted: (EditableFieldValue | null)[] = [];
    const { send } = renderEditor(
      makeField({
        kind: "option-list",
        required: false,
        allowedValues: [
          { id: "a", name: "Alpha" },
          { id: "b", name: "Beta" },
        ],
      }),
      (value) => submitted.push(value),
      [{ id: "a" }, { id: "b" }],
    );

    await send("\r");

    expect(submitted).toEqual([[{ id: "b" }]]);
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

  test("allows removing one item when a required option list has another value", async () => {
    const submitted: (EditableFieldValue | null)[] = [];
    const { send } = renderEditor(
      makeField({
        kind: "option-list",
        required: true,
        allowedValues: [
          { id: "a", name: "Alpha" },
          { id: "b", name: "Beta" },
        ],
      }),
      (value) => submitted.push(value),
      [{ id: "a" }, { id: "b" }],
    );

    await send("\r");
    expect(submitted).toEqual([[{ id: "b" }]]);
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

  test("allows removing the last user from an optional user list", async () => {
    globalThis.fetch = (async (input) => {
      const url = new URL(String(input));
      if (url.pathname !== "/rest/api/3/user/assignable/search") {
        throw new Error(`unexpected request: ${url}`);
      }
      return new Response(JSON.stringify([{ accountId: "a", displayName: "Alpha" }]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;
    const submitted: (EditableFieldValue | null)[] = [];
    const { send, output } = renderEditor(
      makeField({ kind: "user-list", required: false }),
      (value) => submitted.push(value),
      [{ accountId: "a" }],
    );

    await waitFor(() => output().includes("Alpha"), "optional user choices");
    await send("\r");
    expect(submitted).toEqual([[]]);
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
});
