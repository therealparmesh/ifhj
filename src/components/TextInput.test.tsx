import { afterEach, describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";

import { render } from "ink";
import { useState } from "react";

import { InputScope } from "../input";
import { createTerminal } from "../test/utils";
import { TextInput } from "./TextInput";

const apps: ReturnType<typeof render>[] = [];
const ignoreReplacement = (_next: string) => {};

afterEach(() => {
  for (const app of apps.splice(0)) app.unmount();
});

async function renderInput(initial: string, onSubmit?: (value: string) => void, width?: number) {
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
    return (
      <TextInput
        value={current}
        onChange={replace}
        {...(onSubmit ? { onSubmit } : {})}
        {...(width === undefined ? {} : { width })}
      />
    );
  }

  const app = render(<ControlledInput />, {
    interactive: true,
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

  test("keeps a long Unicode value and cursor visible while moving across its viewport", async () => {
    const value = `START_界e\u0301👨‍👩‍👧‍👦${"x".repeat(40)}VISIBLE_END`;
    let submit!: (value: string) => void;
    const submitted = new Promise<string>((resolve) => {
      submit = resolve;
    });
    const input = await renderInput(value, submit, 20);
    let rendered = Bun.stripANSI(input.output());
    expect(rendered).toContain("VISIBLE_END");
    expect(
      Math.max(...rendered.split("\n").map((line) => Bun.stringWidth(line))),
    ).toBeLessThanOrEqual(20);

    input.clearOutput();
    await input.act(() => input.stdin.write("\x01"));
    rendered = Bun.stripANSI(input.output());
    expect(rendered).toContain("START_");
    expect(rendered).not.toContain("�");

    await input.act(() => input.stdin.write("\x1b[C"));
    await input.act(() => input.stdin.write("\x1b[D"));
    input.clearOutput();
    await input.act(() => input.stdin.write("\x05"));
    expect(Bun.stripANSI(input.output())).toContain("VISIBLE_END");

    input.stdin.write("\r");
    expect(await submitted).toBe(value);
    expect(input.value()).toBe(value);
  });

  test("supports Home and End without losing the full controlled value", async () => {
    let submitted = "";
    const input = await renderInput("A🙂B", (value) => {
      submitted = value;
    });
    await input.act(() => input.stdin.write("\x1b[H"));
    await input.act(() => input.stdin.write("X"));
    await input.act(() => input.stdin.write("\x1b[F"));
    await input.act(() => input.stdin.write("Y"));
    input.stdin.write("\r");
    await input.flush();
    expect(input.value()).toBe("XA🙂BY");
    expect(submitted).toBe("XA🙂BY");
  });

  test("Ctrl+D deletes one complete joined emoji", async () => {
    const input = await renderInput("A👨‍👩‍👧‍👦B");
    await input.act(() => input.stdin.write("\x1b[H"));
    await input.act(() => input.stdin.write("\x1b[C"));
    await input.act(() => input.stdin.write("\x04"));
    expect(input.value()).toBe("AB");
  });

  test("rejects an edit synchronously and accepts callbacks with other return values", async () => {
    const terminal = createTerminal(80, 20);
    const accepted: string[] = [];
    let submit!: (value: string) => void;
    const submitted = new Promise<string>((resolve) => {
      submit = resolve;
    });
    function ControlledInput() {
      const [value, setValue] = useState("A🙂B");
      return (
        <TextInput
          value={value}
          onChange={(next) => {
            if (next.includes("!")) return false;
            setValue(next);
            return accepted.push(next);
          }}
          onSubmit={submit}
        />
      );
    }
    const app = render(<ControlledInput />, {
      interactive: true,
      stdin: terminal.stdin as unknown as typeof process.stdin,
      stdout: terminal.stdout as unknown as typeof process.stdout,
      stderr: new PassThrough() as unknown as typeof process.stderr,
      exitOnCtrlC: false,
      patchConsole: false,
    });
    apps.push(app);
    await app.waitUntilRenderFlush();
    for (const input of ["!", "X", "\r"]) {
      terminal.stdin.write(input);
      terminal.stdin.emit("readable");
    }
    expect(await submitted).toBe("A🙂BX");
    expect(accepted).toEqual(["A🙂BX"]);
  });

  test("does not edit while its InputScope is disabled", async () => {
    const terminal = createTerminal(80, 20);
    let enabled = false;
    let value = "start";
    const node = () => (
      <InputScope enabled={enabled}>
        <TextInput
          value={value}
          onChange={(next) => {
            value = next;
          }}
        />
      </InputScope>
    );
    const app = render(node(), {
      interactive: true,
      stdin: terminal.stdin as unknown as typeof process.stdin,
      stdout: terminal.stdout as unknown as typeof process.stdout,
      stderr: new PassThrough() as unknown as typeof process.stderr,
      exitOnCtrlC: false,
      patchConsole: false,
    });
    apps.push(app);
    await app.waitUntilRenderFlush();
    terminal.stdin.write("X");
    await Bun.sleep(20);
    expect(value).toBe("start");
    enabled = true;
    app.rerender(node());
    await app.waitUntilRenderFlush();
    terminal.stdin.write("X");
    await Bun.sleep(20);
    expect(value).toBe("startX");
  });
});
