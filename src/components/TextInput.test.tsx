import { afterEach, describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";

import { render } from "ink";
import { useState } from "react";

import { createTerminal } from "../test/utils";
import { TextInput } from "./TextInput";

const apps: ReturnType<typeof render>[] = [];
const ignoreReplacement = (_next: string) => {};

afterEach(() => {
  for (const app of apps.splice(0)) app.unmount();
});

async function renderInput(initial: string, onSubmit?: (value: string) => void) {
  const { stdin, stdout, output, clearOutput } = createTerminal(80, 20);
  let renderResolve: (() => void) | undefined;
  let value = initial;
  let replace = ignoreReplacement;

  function ControlledInput() {
    const [current, setCurrent] = useState(initial);
    replace = (next) => {
      value = next;
      setCurrent(next);
    };
    return <TextInput value={current} onChange={replace} {...(onSubmit ? { onSubmit } : {})} />;
  }

  const app = render(<ControlledInput />, {
    stdin: stdin as unknown as typeof process.stdin,
    stdout: stdout as unknown as typeof process.stdout,
    stderr: new PassThrough() as unknown as typeof process.stderr,
    exitOnCtrlC: false,
    patchConsole: false,
    onRender: () => {
      renderResolve?.();
      renderResolve = undefined;
    },
  });
  apps.push(app);
  await app.waitUntilRenderFlush();
  return {
    stdin,
    value: () => value,
    replace: (next: string) => replace(next),
    output,
    clearOutput,
    flush: () => app.waitUntilRenderFlush(),
    act: async (action: () => void) => {
      const committed = new Promise<void>((resolve) => {
        renderResolve = resolve;
      });
      action();
      await committed;
      await app.waitUntilRenderFlush();
    },
  };
}

describe("TextInput Unicode editing", () => {
  test("moves over and forward-deletes a complete emoji", async () => {
    const input = await renderInput("A🙂B");
    await input.act(() => input.stdin.write("\x1b[D"));
    await input.act(() => input.stdin.write("\x1b[D"));
    await input.act(() => input.stdin.write("\x1b[3~"));
    expect(input.value()).toBe("AB");
  });

  test("realigns a cursor left inside a replacement grapheme before insertion", async () => {
    const input = await renderInput("abc");
    await input.act(() => input.stdin.write("\x1b[D"));
    await input.act(() => input.replace("A🙂B"));
    await input.act(() => input.stdin.write("X"));
    expect(input.value()).toBe("AX🙂B");
  });

  test("joins combining input, ignores controls, and backspaces the full grapheme", async () => {
    const input = await renderInput("e");
    await input.act(() => input.stdin.write("\u0301"));
    expect(input.value()).toBe("e\u0301");
    input.stdin.write("\t\x07");
    await input.flush();
    expect(input.value()).toBe("e\u0301");
    await input.act(() => input.stdin.write("\x7f"));
    expect(input.value()).toBe("");
  });

  test("applies every backspace event from one held-key input chunk", async () => {
    const input = await renderInput("A🙂B");
    await input.act(() => input.stdin.write("\x7f\x7f"));
    expect(input.value()).toBe("A");
  });

  test("renders a joined emoji as one intact cursor cell", async () => {
    const input = await renderInput("ab");
    input.clearOutput();
    await input.act(() => input.replace("A👨‍👩‍👧‍👦B"));
    expect(input.output()).toContain("👨‍👩‍👧‍👦");
    expect(input.output()).not.toContain("�");
  });

  test("uses synchronous cursor refs across batched moves and submits the edited value", async () => {
    let submit!: (value: string) => void;
    const submitted = new Promise<string>((resolve) => {
      submit = resolve;
    });
    const input = await renderInput("A🙂B", submit);
    await input.act(() => input.stdin.write("\x1b[D\x1b[DX"));
    input.stdin.write("\r");
    expect(await submitted).toBe("AX🙂B");
    await input.flush();
    expect(input.value()).toBe("AX🙂B");
  });
});
