import { type Dispatch, type SetStateAction, useCallback, useRef, useState } from "react";

export function useSelectionIndex(
  initial = 0,
): [number, Dispatch<SetStateAction<number>>, () => number] {
  const latest = useRef(initial);
  const [index, setIndexState] = useState(initial);
  const setIndex = useCallback<Dispatch<SetStateAction<number>>>((next) => {
    const value = typeof next === "function" ? next(latest.current) : next;
    latest.current = value;
    setIndexState(value);
  }, []);
  const getIndex = useCallback(() => latest.current, []);
  return [index, setIndex, getIndex];
}
