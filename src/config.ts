import { homedir } from "node:os";
import { join } from "node:path";

import type { ThemeName } from "./ui";

export type JiraConfig = {
  server: string;
  authHeader: string;
};

/**
 * User preferences persisted at ~/.config/ifhj/settings.json. Every field
 * has a default, so on-disk settings may omit any subset of keys.
 */
export type Settings = {
  theme: ThemeName;
  maxColumns: number;
};

const SETTINGS_PATH = join(homedir(), ".config", "ifhj", "settings.json");

function parseTheme(v: unknown): ThemeName | undefined {
  return v === "synthwave" || v === "terminal" ? v : undefined;
}

function parseMaxColumns(v: unknown): number | undefined {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number.parseInt(v, 10) : NaN;
  return Number.isFinite(n) && n >= 1 ? n : undefined;
}

// Read an env override, running it through the same parser as the file. An
// invalid value throws so the user notices the typo instead of getting a
// silent fallback. Absent → undefined so the caller can fall through.
function strictEnv<T>(name: string, parse: (v: unknown) => T | undefined): T | undefined {
  const v = Bun.env[name];
  if (v === undefined) return undefined;
  const parsed = parse(v);
  if (parsed === undefined) throw new Error(`Invalid ${name} "${v}"`);
  return parsed;
}

/**
 * Load settings from ~/.config/ifhj/settings.json, then overlay env
 * overrides (which win over the file). Invalid file values fall back to
 * defaults so the app always boots. Env values are strict: an invalid
 * override throws so the user notices the typo immediately.
 */
export async function loadSettings(): Promise<Settings> {
  let raw: Record<string, unknown> = {};
  try {
    const f = Bun.file(SETTINGS_PATH);
    if (await f.exists()) {
      const parsed: unknown = await f.json();
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        raw = parsed as Record<string, unknown>;
      }
    }
  } catch {
    // malformed JSON — fall through to defaults
  }
  return {
    theme: strictEnv("IFHJ_THEME", parseTheme) ?? parseTheme(raw["theme"]) ?? "synthwave",
    maxColumns:
      strictEnv("IFHJ_MAX_COLUMNS", parseMaxColumns) ?? parseMaxColumns(raw["maxColumns"]) ?? 4,
  };
}

// Strip matching single or double quotes around a YAML scalar.
function unquote(s: string): string {
  const t = s.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))
    return t.slice(1, -1);
  return t;
}

async function readConfigYaml(): Promise<{ server?: string; login?: string }> {
  const paths = [
    join(homedir(), ".config", ".jira", ".config.yml"),
    join(homedir(), ".config", "jira", ".config.yml"),
  ];
  for (const p of paths) {
    const f = Bun.file(p);
    if (!(await f.exists())) continue;
    const text = await f.text();
    const out: { server?: string; login?: string } = {};
    const server = /^server:\s*(.+)$/m.exec(text)?.[1];
    const login = /^login:\s*(.+)$/m.exec(text)?.[1];
    if (server) out.server = unquote(server);
    if (login) out.login = unquote(login);
    return out;
  }
  return {};
}

export async function loadConfig(): Promise<JiraConfig> {
  const env = Bun.env;
  const yaml = await readConfigYaml();
  const server = env["JIRA_SERVER"] || yaml.server;
  const email = env["JIRA_LOGIN"] || env["JIRA_EMAIL"] || yaml.login;
  const token = env["JIRA_API_TOKEN"];
  if (!server)
    throw new Error("Missing Jira server (set JIRA_SERVER or ~/.config/.jira/.config.yml)");
  if (!email)
    throw new Error("Missing Jira login email (set JIRA_LOGIN or ~/.config/.jira/.config.yml)");
  if (!token) throw new Error("Missing JIRA_API_TOKEN environment variable");
  const authHeader = "Basic " + Buffer.from(`${email}:${token}`).toString("base64");
  return { server: server.replace(/\/$/, ""), authHeader };
}
