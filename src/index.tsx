#!/usr/bin/env bun
import { Box, Text, render, useApp } from "ink";
import { useEffect, useState } from "react";

import { BoardView } from "./components/Board";
import { BoardPicker } from "./components/BoardPicker";
import { loadConfig, type JiraConfig } from "./config";
import type { Board } from "./jira";
import { errorMessage, setTheme, theme } from "./ui";

function App() {
  const { exit } = useApp();
  const [cfg, setCfg] = useState<JiraConfig | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [board, setBoard] = useState<Board | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const c = await loadConfig();
        setTheme(c.theme);
        setCfg(c);
      } catch (e) {
        setErr(errorMessage(e));
      }
    })();
  }, []);

  if (err)
    return (
      <Box flexDirection="column" padding={1}>
        <Text color={theme.err}>{err}</Text>
      </Box>
    );

  if (!cfg)
    return (
      <Box padding={1}>
        <Text color={theme.accent}>◴ </Text>
        <Text color={theme.fg}>loading config…</Text>
      </Box>
    );

  if (!board) return <BoardPicker cfg={cfg} onPick={setBoard} onQuit={() => exit()} />;
  return <BoardView cfg={cfg} board={board} onExit={() => setBoard(null)} />;
}

render(<App />);
