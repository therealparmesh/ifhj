import { Box, Text } from "ink";
import type { ReactNode } from "react";

import { useDimensions } from "../hooks";
import { InputScope } from "../input";
import { theme } from "../ui";

const MIN_COLUMNS = 80;
const MIN_ROWS = 24;

/** Keep the active screen mounted during a small-terminal resize, but make it inert. */
export function Viewport({
  children,
  columns,
  rows: rowsOverride,
}: {
  children: ReactNode;
  columns?: number;
  rows?: number;
}) {
  const measured = useDimensions();
  const cols = columns ?? measured.cols;
  const rows = rowsOverride ?? measured.rows;
  const supported = cols >= MIN_COLUMNS && rows >= MIN_ROWS;
  return (
    <>
      <InputScope enabled={supported}>
        <Box display={supported ? "flex" : "none"}>{children}</Box>
      </InputScope>
      {!supported ? (
        <Box width={cols} height={rows} flexDirection="column" justifyContent="center">
          <Text color={theme.warning} bold>
            Terminal too small
          </Text>
          <Text color={theme.muted}>
            Resize to at least {MIN_COLUMNS}x{MIN_ROWS}.
          </Text>
        </Box>
      ) : null}
    </>
  );
}
