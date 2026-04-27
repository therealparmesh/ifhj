import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { ThemeName } from "./ui";

export type JiraConfig = {
  server: string;
  authHeader: string;
};

/**
 * User preferences persisted at ~/.config/ifhj/settings.json. Every field
 * has a default, so on-disk settings may omit any subset of keys. Add a
 * new setting by extending this type, adding its default to DEFAULTS, and
 * adding a parser to PARSERS — TS will force the latter two.
 */
export type Settings = {
  theme: ThemeName;
};

const SETTINGS_PATH = join(homedir(), ".config", "ifhj", "settings.json");

const DEFAULTS: Settings = {
  theme: "synthwave",
};

/**
 * One parser per Settings field. Returns the value when it fits the
 * field's type, or undefined to reject it. Keyed by `keyof Settings` so
 * the type system enforces completeness.
 */
const PARSERS: { [K in keyof Settings]: (v: unknown) => Settings[K] | undefined } = {
  theme: (v) => (v === "synthwave" || v === "terminal" ? v : undefined),
};

/**
 * Optional env-var override per setting. Env var wins over the file; its
 * value runs through the same PARSERS entry, so validation is identical.
 * Partial — not every setting needs or deserves an env override.
 */
const ENV_OVERRIDES: Partial<Record<keyof Settings, string>> = {
  theme: "IFHJ_THEME",
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * Load settings from ~/.config/ifhj/settings.json, then overlay env
 * overrides. Unknown keys in the file are ignored; invalid values fall
 * back to defaults so the app always boots. Env var values are strict:
 * an invalid override throws so the user notices the typo immediately.
 *
 * Synchronous so callers can apply settings (e.g. `setTheme`) *before*
 * the first Ink render — otherwise the loading screen paints in the
 * default theme and we get a one-frame flash on terminal-themed setups.
 */
export function loadSettings(): Settings {
  let raw: Record<string, unknown> = {};
  try {
    if (existsSync(SETTINGS_PATH)) {
      const parsed: unknown = JSON.parse(readFileSync(SETTINGS_PATH, "utf8"));
      if (isRecord(parsed)) raw = parsed;
    }
  } catch {
    // malformed JSON — fall through to defaults
  }
  const settings: Settings = { ...DEFAULTS };
  // The loop below writes back under each parser's narrowed return type.
  // TS can't express "PARSERS[k]'s return type matches settings[k]" when k
  // is unioned at the call site, so we widen to a bag and trust the
  // mapped-type constraint on PARSERS.
  const bag = settings as Record<string, unknown>;
  for (const key of Object.keys(PARSERS) as (keyof Settings)[]) {
    const parse = PARSERS[key] as (v: unknown) => unknown;
    const parsed = parse(raw[key]);
    if (parsed !== undefined) bag[key] = parsed;
    const envName = ENV_OVERRIDES[key];
    if (envName === undefined) continue;
    const envValue = Bun.env[envName];
    if (envValue === undefined) continue;
    const envParsed = parse(envValue);
    if (envParsed === undefined) {
      throw new Error(`Invalid ${envName} "${envValue}"`);
    }
    bag[key] = envParsed;
  }
  return settings;
}

export async function saveSettings(settings: Settings): Promise<void> {
  const { mkdirSync } = await import("node:fs");
  mkdirSync(join(homedir(), ".config", "ifhj"), { recursive: true });
  await Bun.write(SETTINGS_PATH, JSON.stringify(settings, null, 2) + "\n");
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
