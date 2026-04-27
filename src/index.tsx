#!/usr/bin/env bun
import { Box, Text, render, useApp } from "ink";
import { useEffect, useState } from "react";

import { BoardView } from "./components/Board";
import { BoardPicker } from "./components/BoardPicker";
import { loadConfig, type JiraConfig, loadSettings } from "./config";
import type { Board } from "./jira";
import { errorMessage, setTheme, theme } from "./ui";

// Apply the theme before Ink mounts so the loading screen paints in the
// user's chosen palette, not the default.
let initErr: string | null = null;
try {
  setTheme(loadSettings().theme);
} catch (e) {
  initErr = errorMessage(e);
}

function App() {
  const { exit } = useApp();
  const [cfg, setCfg] = useState<JiraConfig | null>(null);
  const [err, setErr] = useState<string | null>(initErr);
  const [board, setBoard] = useState<Board | null>(null);

  useEffect(() => {
    if (initErr) return;
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
        <Box>
          <Text color={theme.accent} bold>
            ifhj{" "}
          </Text>
          <Text color={theme.muted}>— startup</Text>
        </Box>
        <Box marginTop={1}>
          <Text color={theme.error}>{err}</Text>
        </Box>
      </Box>
    );

  if (!cfg)
    return (
      <Box flexDirection="column" padding={1}>
        <Box>
          <Text color={theme.accent} bold>
            ifhj{" "}
          </Text>
          <Text color={theme.muted}>— startup</Text>
        </Box>
        <Box marginTop={1}>
          <Text color={theme.info}>◴ </Text>
          <Text color={theme.muted}>loading…</Text>
        </Box>
      </Box>
    );

  if (!board) return <BoardPicker cfg={cfg} onPick={setBoard} onQuit={() => exit()} />;
  return <BoardView cfg={cfg} board={board} onExit={() => setBoard(null)} />;
}

process.stdout.write("\x1b[?1049h\x1b[H\x1b[2J\x1b[?25l");
const inst = render(<App />);
inst.waitUntilExit().then(() => process.stdout.write("\x1b[?25h\x1b[?1049l"));
