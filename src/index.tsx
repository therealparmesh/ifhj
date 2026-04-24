#!/usr/bin/env bun
import { Box, Text, render, useApp } from "ink";
import { useEffect, useState } from "react";

import { BoardView } from "./components/Board";
import { BoardPicker } from "./components/BoardPicker";
import { loadConfig, type JiraConfig } from "./config";
import type { Board } from "./jira";
import { errorMessage, theme } from "./ui";

function App() {
  const { exit } = useApp();
  const [cfg, setCfg] = useState<JiraConfig | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [board, setBoard] = useState<Board | null>(null);

  useEffect(() => {
    (async () => {
      try {
        setCfg(await loadConfig());
      } catch (e) {
        setErr(errorMessage(e));
      }
    })();
  }, []);

  if (err)
    return (
      <Box flexDirection="column" padding={1}>
        <Text color={theme.accent} bold>
          ifhj
        </Text>
        <Box marginTop={1}>
          <Text color={theme.err}>{err}</Text>
        </Box>
      </Box>
    );

  if (!cfg)
    return (
      <Box flexDirection="column" padding={1}>
        <Text color={theme.accent} bold>
          ifhj
        </Text>
        <Box marginTop={1}>
          <Text color={theme.cyan}>◴ </Text>
          <Text color={theme.muted}>loading…</Text>
        </Box>
      </Box>
    );

  if (!board) return <BoardPicker cfg={cfg} onPick={setBoard} onQuit={() => exit()} />;
  return <BoardView cfg={cfg} board={board} onExit={() => setBoard(null)} />;
}

render(<App />);
