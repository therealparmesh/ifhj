import { useEffect, useState } from "react";

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
