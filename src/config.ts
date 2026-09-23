import { homedir } from "node:os";
import { join } from "node:path";

import type { ThemeName } from "./ui";

export type JiraConfig = {
  server: string;
  authHeader: string;
  signal?: AbortSignal;
};

/**
 * User preferences persisted at ~/.config/ifhj/settings.json. Every field
 * has a default, so on-disk settings may omit any subset of keys.
 */
export type Settings = {
  theme: ThemeName;
  maxColumns: number;
};

function parseTheme(v: unknown): ThemeName | undefined {
  return v === "synthwave" || v === "terminal" ? v : undefined;
}

function parseMaxColumns(v: unknown): number | undefined {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN;
  return Number.isSafeInteger(n) && n >= 1 ? n : undefined;
}

// Read an env override, running it through the same parser as the file. An
// invalid value throws so the user notices the typo instead of getting a
// silent fallback. Absent → undefined so the caller can fall through.
function strictEnv<T>(
  name: string,
  parse: (v: unknown) => T | undefined,
  expected: string,
): T | undefined {
  const v = Bun.env[name];
  if (v === undefined) return undefined;
  const parsed = parse(v);
  if (parsed === undefined) throw new Error(`Invalid ${name}. ${expected}`);
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
    const parsed: unknown = await Bun.file(
      join(homedir(), ".config", "ifhj", "settings.json"),
    ).json();
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      raw = parsed as Record<string, unknown>;
    }
  } catch {
    // Missing or malformed settings fall through to defaults.
  }
  return {
    theme:
      strictEnv("IFHJ_THEME", parseTheme, 'Use "synthwave" or "terminal".') ??
      parseTheme(raw["theme"]) ??
      "synthwave",
    maxColumns:
      strictEnv("IFHJ_MAX_COLUMNS", parseMaxColumns, "Use a positive whole integer.") ??
      parseMaxColumns(raw["maxColumns"]) ??
      4,
  };
}

async function readConfigYaml(): Promise<{ server?: string; login?: string; path?: string }> {
  const paths = [
    join(homedir(), ".config", ".jira", ".config.yml"),
    join(homedir(), ".config", "jira", ".config.yml"),
  ];
  for (const p of paths) {
    const f = Bun.file(p);
    if (!(await f.exists())) continue;
    let parsed: unknown;
    try {
      parsed = Bun.YAML.parse(await f.text());
    } catch {
      throw new Error(`Invalid Jira config ${p}: YAML could not be parsed`);
    }
    if (parsed === null || parsed === undefined) return { path: p };
    if (typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`Invalid Jira config ${p}: expected a YAML mapping`);
    }
    const raw = parsed as Record<string, unknown>;
    const out: { server?: string; login?: string; path: string } = { path: p };
    for (const key of ["server", "login"] as const) {
      const value = raw[key];
      if (value === null || value === undefined) continue;
      if (typeof value !== "string") {
        throw new Error(`Invalid Jira config ${p}: ${key} must be a string`);
      }
      out[key] = value;
    }
    return out;
  }
  return {};
}

export async function loadConfig(): Promise<JiraConfig> {
  const env = Bun.env;
  const envServer = env["JIRA_SERVER"];
  const envLogin = env["JIRA_LOGIN"] || env["JIRA_EMAIL"];
  const yaml = envServer && envLogin ? {} : await readConfigYaml();
  const serverValue = envServer || yaml.server;
  const email = (envLogin || yaml.login)?.trim();
  const token = env["JIRA_API_TOKEN"]?.trim();
  const configPath = yaml.path ?? join(homedir(), ".config", ".jira", ".config.yml");
  if (!serverValue?.trim()) {
    throw new Error(`Missing Jira server: set JIRA_SERVER or add "server" to ${configPath}`);
  }
  if (!email) {
    throw new Error(
      `Missing Jira login: set JIRA_LOGIN or JIRA_EMAIL, or add "login" to ${configPath}`,
    );
  }
  if (!token) throw new Error("Missing JIRA_API_TOKEN environment variable");

  const serverSource = envServer ? "JIRA_SERVER" : `"server" in ${configPath}`;
  let url: URL;
  try {
    url = new URL(serverValue.trim());
  } catch {
    throw new Error(`Invalid Jira server URL from ${serverSource}`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`Invalid Jira server URL protocol "${url.protocol}"`);
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("Jira server URL must not contain credentials, a query, or a fragment");
  }
  url.pathname = url.pathname.replace(/\/+$/, "");
  const server = url.toString().replace(/\/$/, "");
  const authHeader = "Basic " + Buffer.from(`${email}:${token}`).toString("base64");
  return { server, authHeader };
}
