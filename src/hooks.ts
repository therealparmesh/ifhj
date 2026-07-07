import { useCallback, useEffect, useState } from "react";

function readSize() {
  return {
    cols: process.stdout.columns || 120,
    rows: process.stdout.rows || 40,
  };
}

export function useDimensions(): { cols: number; rows: number } {
  const [d, setD] = useState(readSize);
  useEffect(() => {
    const on = () => setD(readSize());
    process.stdout.on("resize", on);
    return () => {
      process.stdout.off("resize", on);
    };
  }, []);
  return d;
}

/**
 * Tracks in-flight background work as a reference count. `busy` is true while
 * any tracked promise is pending; `track` wraps a promise so the count rises
 * on start and falls when it settles (success or failure). Counting rather
 * than a boolean means overlapping loads (e.g. a board reload racing a
 * swimlane fetch) stay "busy" until the last one finishes.
 */
export function useLoading(): { busy: boolean; track: <T>(p: Promise<T>) => Promise<T> } {
  const [count, setCount] = useState(0);
  const track = useCallback(<T>(p: Promise<T>): Promise<T> => {
    setCount((c) => c + 1);
    return p.finally(() => setCount((c) => Math.max(0, c - 1)));
  }, []);
  return { busy: count > 0, track };
}
