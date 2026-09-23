import { describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";

import { isolatedEnv, makeTempDir, runScript } from "./test/utils";

const configUrl = new URL("./config.ts", import.meta.url).href;

async function runConfigCase(
  name: string,
  source: string,
  env: Record<string, string | undefined> = {},
): Promise<unknown> {
  const home = await makeTempDir(`config-${name}`);
  const childEnv = isolatedEnv(home, env);
  try {
    const { exitCode, stdout, stderr } = await runScript(source, childEnv);
    expect(exitCode, stderr).toBe(0);
    return JSON.parse(stdout);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

describe("settings validation", () => {
  test("explains accepted theme and column override values", async () => {
    const result = await runConfigCase(
      "strict-columns",
      `
        const { loadSettings } = await import(${JSON.stringify(configUrl)});
        const errors = [];
        process.env.IFHJ_THEME = "blue";
        try { await loadSettings(); } catch (error) { errors.push(String(error.message)); }
        delete process.env.IFHJ_THEME;
        for (const value of ["4junk", "2.5"]) {
          process.env.IFHJ_MAX_COLUMNS = value;
          try { await loadSettings(); } catch (error) { errors.push(String(error.message)); }
        }
        console.log(JSON.stringify(errors));
      `,
    );
    expect(result).toEqual([
      'Invalid IFHJ_THEME. Use "synthwave" or "terminal".',
      "Invalid IFHJ_MAX_COLUMNS. Use a positive whole integer.",
      "Invalid IFHJ_MAX_COLUMNS. Use a positive whole integer.",
    ]);
  });

  test("falls back from invalid file values in an isolated home", async () => {
    const result = await runConfigCase(
      "file-fallback",
      `
        const { mkdir, writeFile } = await import("node:fs/promises");
        const { join } = await import("node:path");
        const dir = join(process.env.HOME, ".config", "ifhj");
        await mkdir(dir, { recursive: true });
        await writeFile(join(dir, "settings.json"), JSON.stringify({ maxColumns: "3x" }));
        const { loadSettings } = await import(${JSON.stringify(configUrl)});
        console.log(JSON.stringify(await loadSettings()));
      `,
    );
    expect(result).toEqual({ theme: "synthwave", maxColumns: 4 });
  });
});

describe("Jira config validation", () => {
  test("parses comments and escaped quoted scalars", async () => {
    const result = await runConfigCase(
      "yaml-scalars",
      `
        const { mkdir, writeFile } = await import("node:fs/promises");
        const { join } = await import("node:path");
        const dir = join(process.env.HOME, ".config", ".jira");
        await mkdir(dir, { recursive: true });
        await writeFile(
          join(dir, ".config.yml"),
          'server: "https://jira.example.test/team\\\\u002Dspace" # server comment\\n' +
            'login: "quoted\\\\u0040example.test" # login comment\\n',
        );
        const { loadConfig } = await import(${JSON.stringify(configUrl)});
        const config = await loadConfig();
        console.log(JSON.stringify({
          server: config.server,
          credentials: Buffer.from(config.authHeader.slice(6), "base64").toString(),
        }));
      `,
      { JIRA_API_TOKEN: "token" },
    );
    expect(result).toEqual({
      server: "https://jira.example.test/team-space",
      credentials: "quoted@example.test:token",
    });
  });

  test("does not consume later lines for blank server or login values", async () => {
    const result = await runConfigCase(
      "yaml-blanks",
      `
        const { mkdir, writeFile } = await import("node:fs/promises");
        const { join } = await import("node:path");
        const dir = join(process.env.HOME, ".config", ".jira");
        const path = join(dir, ".config.yml");
        await mkdir(dir, { recursive: true });
        const { loadConfig } = await import(${JSON.stringify(configUrl)});
        const errors = [];
        await writeFile(path, "server:\\nother: https://wrong.example.test\\nlogin: user@example.test\\n");
        try { await loadConfig(); } catch (error) { errors.push(error.message); }
        process.env.JIRA_SERVER = "https://env.example.test";
        await writeFile(path, "login:\\nother: wrong@example.test\\n");
        try { await loadConfig(); } catch (error) { errors.push(error.message); }
        console.log(JSON.stringify(errors.map((error) => error.replace(process.env.HOME, "<home>"))));
      `,
      { JIRA_API_TOKEN: "token" },
    );
    expect(result).toEqual([
      'Missing Jira server: set JIRA_SERVER or add "server" to <home>/.config/.jira/.config.yml',
      'Missing Jira login: set JIRA_LOGIN or JIRA_EMAIL, or add "login" to <home>/.config/.jira/.config.yml',
    ]);
  });

  test("accepts an empty document and rejects non-mapping roots and typed fields", async () => {
    const result = await runConfigCase(
      "yaml-shapes",
      `
        const { mkdir, writeFile } = await import("node:fs/promises");
        const { join } = await import("node:path");
        const dir = join(process.env.HOME, ".config", ".jira");
        const path = join(dir, ".config.yml");
        await mkdir(dir, { recursive: true });
        const { loadConfig } = await import(${JSON.stringify(configUrl)});
        const errors = [];
        for (const yaml of [
          "",
          "server: [unterminated\\nlogin: hidden@example.test\\n",
          "scalar\\n",
          "- list\\n",
          "server: 42\\nlogin: user@example.test\\n",
          "server: https://jira.example.test\\nlogin: true\\n",
        ]) {
          await writeFile(path, yaml);
          try { await loadConfig(); } catch (error) {
            errors.push(error.message.replace(path, "<path>"));
          }
        }
        console.log(JSON.stringify(errors));
      `,
      { JIRA_API_TOKEN: "token" },
    );
    expect(result).toEqual([
      'Missing Jira server: set JIRA_SERVER or add "server" to <path>',
      "Invalid Jira config <path>: YAML could not be parsed",
      "Invalid Jira config <path>: expected a YAML mapping",
      "Invalid Jira config <path>: expected a YAML mapping",
      "Invalid Jira config <path>: server must be a string",
      "Invalid Jira config <path>: login must be a string",
    ]);
  });

  test("uses the first file and fills only missing environment values", async () => {
    const result = await runConfigCase(
      "yaml-precedence",
      `
        const { mkdir, rm, writeFile } = await import("node:fs/promises");
        const { join } = await import("node:path");
        const first = join(process.env.HOME, ".config", ".jira");
        const second = join(process.env.HOME, ".config", "jira");
        await mkdir(first, { recursive: true });
        await mkdir(second, { recursive: true });
        await writeFile(join(first, ".config.yml"), "server: https://first.example.test\\nlogin: first@example.test\\n");
        await writeFile(join(second, ".config.yml"), "server: https://second.example.test\\nlogin: second@example.test\\n");
        const { loadConfig } = await import(${JSON.stringify(configUrl)});
        const firstFile = await loadConfig();
        await rm(join(first, ".config.yml"));
        const secondFile = await loadConfig();
        await writeFile(join(first, ".config.yml"), "server: https://first.example.test\\nlogin: first@example.test\\n");
        process.env.JIRA_SERVER = "https://env.example.test";
        const envServer = await loadConfig();
        delete process.env.JIRA_SERVER;
        process.env.JIRA_LOGIN = "env@example.test";
        const envLogin = await loadConfig();
        delete process.env.JIRA_LOGIN;
        process.env.JIRA_SERVER = "https://override.example.test";
        await writeFile(join(first, ".config.yml"), "server: 42\\nlogin: selected@example.test\\n");
        const ignoredYamlServer = await loadConfig();
        delete process.env.JIRA_SERVER;
        process.env.JIRA_LOGIN = "override@example.test";
        await writeFile(join(first, ".config.yml"), "server: https://selected.example.test\\nlogin: true\\n");
        const ignoredYamlLogin = await loadConfig();
        console.log(JSON.stringify([firstFile, secondFile, envServer, envLogin, ignoredYamlServer, ignoredYamlLogin].map((config) => ({
          server: config.server,
          credentials: Buffer.from(config.authHeader.slice(6), "base64").toString(),
        }))));
      `,
      { JIRA_API_TOKEN: "token" },
    );
    expect(result).toEqual([
      { server: "https://first.example.test", credentials: "first@example.test:token" },
      { server: "https://second.example.test", credentials: "second@example.test:token" },
      { server: "https://env.example.test", credentials: "first@example.test:token" },
      { server: "https://first.example.test", credentials: "env@example.test:token" },
      {
        server: "https://override.example.test",
        credentials: "selected@example.test:token",
      },
      {
        server: "https://selected.example.test",
        credentials: "override@example.test:token",
      },
    ]);
  });

  test("uses JIRA_EMAIL and does not attempt a config file read with full environment", async () => {
    const result = await runConfigCase(
      "full-env",
      `
        const { loadConfig } = await import(${JSON.stringify(configUrl)});
        const originalFile = Bun.file;
        let reads = 0;
        Bun.file = () => {
          reads++;
          throw new Error("config file read attempted");
        };
        let config;
        try {
          config = await loadConfig();
        } finally {
          Bun.file = originalFile;
        }
        console.log(JSON.stringify({
          server: config.server,
          credentials: Buffer.from(config.authHeader.slice(6), "base64").toString(),
          reads,
        }));
      `,
      {
        JIRA_SERVER: "https://env.example.test",
        JIRA_EMAIL: "env@example.test",
        JIRA_API_TOKEN: "token",
      },
    );
    expect(result).toEqual({
      server: "https://env.example.test",
      credentials: "env@example.test:token",
      reads: 0,
    });
  });

  test("normalizes whitespace and trailing slashes", async () => {
    const result = (await runConfigCase(
      "normalization",
      `
        const { loadConfig } = await import(${JSON.stringify(configUrl)});
        const config = await loadConfig();
        console.log(JSON.stringify({
          server: config.server,
          credentials: Buffer.from(config.authHeader.slice(6), "base64").toString(),
        }));
      `,
      {
        JIRA_SERVER: "  https://jira.example.test/context///  ",
        JIRA_LOGIN: " user@example.test ",
        JIRA_API_TOKEN: " token ",
      },
    )) as { server: string; credentials: string };
    expect(result).toEqual({
      server: "https://jira.example.test/context",
      credentials: "user@example.test:token",
    });
  });

  test("rejects malformed and unsafe server URLs", async () => {
    const result = await runConfigCase(
      "url-validation",
      `
        const { loadConfig } = await import(${JSON.stringify(configUrl)});
        const errors = [];
        for (const server of [
          "jira.example.test",
          "https://user:pass@jira.example.test",
          "file:///tmp/jira",
        ]) {
          process.env.JIRA_SERVER = server;
          try { await loadConfig(); } catch (error) { errors.push(String(error.message)); }
        }
        console.log(JSON.stringify(errors));
      `,
      { JIRA_LOGIN: "user@example.test", JIRA_API_TOKEN: "token" },
    );
    expect(result).toEqual([
      "Invalid Jira server URL from JIRA_SERVER",
      "Jira server URL must not contain credentials, a query, or a fragment",
      'Invalid Jira server URL protocol "file:"',
    ]);
  });

  test("identifies a malformed YAML server by path without repeating its value", async () => {
    const result = await runConfigCase(
      "yaml-server-source",
      `
        const { mkdir, writeFile } = await import("node:fs/promises");
        const { join } = await import("node:path");
        const dir = join(process.env.HOME, ".config", ".jira");
        const path = join(dir, ".config.yml");
        await mkdir(dir, { recursive: true });
        await writeFile(path, "server: not-a-url-with-secret-text\\nlogin: user@example.test\\n");
        const { loadConfig } = await import(${JSON.stringify(configUrl)});
        try { await loadConfig(); } catch (error) {
          console.log(JSON.stringify(error.message.replace(path, "<path>")));
        }
      `,
      { JIRA_API_TOKEN: "token" },
    );
    expect(result).toBe('Invalid Jira server URL from "server" in <path>');
  });
});
