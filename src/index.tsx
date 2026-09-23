#!/usr/bin/env bun
import { render, useApp } from "ink";
import { type ReactNode, useState } from "react";

import { BoardView } from "./components/Board";
import { BoardPicker } from "./components/BoardPicker";
import { Viewport } from "./components/Viewport";
import { type Settings, loadConfig, type JiraConfig, loadSettings } from "./config";
import type { Board } from "./jira";
import { errorMessage, setTheme } from "./ui";

type AppProps = { cfg: JiraConfig; settings: Settings };

function App({ cfg, settings }: AppProps) {
  const { exit } = useApp();
  const [board, setBoard] = useState<Board | null>(null);

  return (
    <Viewport>
      {!board ? (
        <BoardPicker cfg={cfg} onPick={setBoard} onQuit={() => exit()} />
      ) : (
        <BoardView
          cfg={cfg}
          board={board}
          maxColumns={settings.maxColumns}
          onExit={() => setBoard(null)}
        />
      )}
    </Viewport>
  );
}

type CliDependencies = {
  loadSettings: typeof loadSettings;
  loadConfig: typeof loadConfig;
  setTheme: typeof setTheme;
  mount: (
    node: ReactNode,
    options: { alternateScreen: boolean },
  ) => { waitUntilExit: () => Promise<unknown> };
};

const defaultDependencies: CliDependencies = {
  loadSettings,
  loadConfig,
  setTheme,
  mount: (node, options) => render(node, options),
};

export async function runCli(deps: CliDependencies = defaultDependencies): Promise<void> {
  const settings = await deps.loadSettings();
  deps.setTheme(settings.theme);
  const loadedConfig = await deps.loadConfig();
  const requests = new AbortController();
  const cfg = { ...loadedConfig, signal: requests.signal };
  try {
    await deps
      .mount(<App cfg={cfg} settings={settings} />, { alternateScreen: true })
      .waitUntilExit();
  } finally {
    requests.abort();
  }
}

if (import.meta.main) {
  try {
    await runCli();
  } catch (error) {
    console.error(`ifhj: ${errorMessage(error)}`);
    process.exitCode = 1;
  }
}
