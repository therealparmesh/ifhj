import { expect, test } from "bun:test";
import { PassThrough } from "node:stream";

import { render, Text } from "ink";

import { useLoading } from "./hooks";
import { createTerminal, deferred, waitFor } from "./test/utils";

test("useLoading remains busy until all concurrent promises settle", async () => {
  let track!: <T>(promise: Promise<T>) => Promise<T>;
  const terminal = createTerminal();

  function Harness({ probe }: { probe: number }) {
    const loading = useLoading();
    track = loading.track;
    return (
      <Text>
        {loading.busy ? "busy" : "idle"} {probe}
      </Text>
    );
  }

  const app = render(<Harness probe={0} />, {
    interactive: true,
    stdout: terminal.stdout as unknown as typeof process.stdout,
    stderr: new PassThrough() as unknown as typeof process.stderr,
    patchConsole: false,
    debug: true,
  });
  try {
    await app.waitUntilRenderFlush();
    const first = deferred<void>();
    const second = deferred<void>();
    const firstTracked = track(first.promise);
    const secondTracked = track(second.promise);
    await waitFor(() => terminal.output().includes("busy 0"), "concurrent loading frame");

    first.resolve();
    await firstTracked;
    terminal.clearOutput();
    app.rerender(<Harness probe={1} />);
    await waitFor(() => terminal.output().includes("busy 1"), "one-promise-pending frame");
    expect(terminal.output()).toContain("busy 1");

    second.resolve();
    await secondTracked;
    await waitFor(() => terminal.output().includes("idle 1"), "settled loading frame");
    expect(terminal.output()).toContain("idle 1");
  } finally {
    app.unmount();
  }
});
