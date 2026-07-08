#!/usr/bin/env bun
import { Box, Text, render, useApp } from "ink";
import { useEffect, useState } from "react";

import { BoardView } from "./components/Board";
import { BoardPicker } from "./components/BoardPicker";
import { LoadingLine } from "./components/LoadingLine";
import { type Settings, loadConfig, type JiraConfig, loadSettings } from "./config";
import type { Board } from "./jira";
import { errorMessage, setTheme, theme } from "./ui";

let settings: Settings;
let initErr: string | null = null;
try {
  settings = await loadSettings();
  setTheme(settings.theme);
} catch (e) {
  initErr = errorMessage(e);
  settings = { theme: "synthwave", maxColumns: 4 };
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
          <LoadingLine label="loading…" />
        </Box>
      </Box>
    );

  if (!board) return <BoardPicker cfg={cfg} onPick={setBoard} onQuit={() => exit()} />;
  return (
    <BoardView
      cfg={cfg}
      board={board}
      maxColumns={settings.maxColumns}
      onExit={() => setBoard(null)}
    />
  );
}

process.stdout.write("\x1b[?1049h\x1b[H\x1b[2J\x1b[?25l");
const inst = render(<App />);
inst.waitUntilExit().then(() => process.stdout.write("\x1b[?25h\x1b[?1049l"));
