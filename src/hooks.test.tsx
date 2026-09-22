import { expect, test } from "bun:test";
import { PassThrough } from "node:stream";

import { render, Text } from "ink";
import { useEffect } from "react";

import { useLoading } from "./hooks";
import { deferred } from "./test/utils";

test("useLoading remains busy until all concurrent promises settle", async () => {
  const states: boolean[] = [];
  let track!: <T>(promise: Promise<T>) => Promise<T>;
  let busy = false;
  let renderResolve: (() => void) | undefined;

  function Harness() {
    const loading = useLoading();
    track = loading.track;
    busy = loading.busy;
    useEffect(() => {
      states.push(loading.busy);
    }, [loading.busy]);
    return <Text>{loading.busy ? "busy" : "idle"}</Text>;
  }

  const app = render(<Harness />, {
    stdout: new PassThrough() as unknown as typeof process.stdout,
    stderr: new PassThrough() as unknown as typeof process.stderr,
    patchConsole: false,
    onRender: () => {
      renderResolve?.();
      renderResolve = undefined;
    },
  });
  const nextRender = () =>
    new Promise<void>((resolve) => {
      renderResolve = resolve;
    });
  try {
    await app.waitUntilRenderFlush();
    const first = deferred<void>();
    const second = deferred<void>();
    let committed = nextRender();
    const firstTracked = track(first.promise);
    const secondTracked = track(second.promise);
    await committed;
    await app.waitUntilRenderFlush();
    expect(busy).toBe(true);

    committed = nextRender();
    first.resolve();
    await firstTracked;
    await committed;
    await app.waitUntilRenderFlush();
    expect(busy).toBe(true);

    committed = nextRender();
    second.resolve();
    await secondTracked;
    await committed;
    await app.waitUntilRenderFlush();
    expect(busy).toBe(false);
    expect(states).toEqual([false, true, false]);
  } finally {
    app.unmount();
  }
});
