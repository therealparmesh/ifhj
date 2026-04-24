import { describe, expect, test } from "bun:test";
import { parseFlatToml } from "./config";

describe("parseFlatToml", () => {
  test("parses quoted string values", () => {
    const result = parseFlatToml(`server = "https://example.atlassian.net"`);
    expect(result).toEqual({ server: "https://example.atlassian.net" });
  });

  test("parses single-quoted string values", () => {
    const result = parseFlatToml(`server = 'https://example.atlassian.net'`);
    expect(result).toEqual({ server: "https://example.atlassian.net" });
  });

  test("parses numeric values", () => {
    const result = parseFlatToml(`max_columns = 6`);
    expect(result).toEqual({ max_columns: 6 });
  });

  test("strips inline comments from unquoted values", () => {
    const result = parseFlatToml(`max_columns = 6  # visible board columns (default 4)`);
    expect(result).toEqual({ max_columns: 6 });
  });

  test("preserves # inside quoted strings", () => {
    const result = parseFlatToml(`name = "foo # bar"`);
    expect(result).toEqual({ name: "foo # bar" });
  });

  test("strips inline comments after closing quote", () => {
    const result = parseFlatToml(`server = "https://example.com" # my server`);
    expect(result).toEqual({ server: "https://example.com" });
  });

  test("skips full-line comments", () => {
    const result = parseFlatToml(`# this is a comment\nkey = "val"`);
    expect(result).toEqual({ key: "val" });
  });

  test("skips blank lines", () => {
    const result = parseFlatToml(`\n\nkey = "val"\n\n`);
    expect(result).toEqual({ key: "val" });
  });

  test("skips TOML section headers", () => {
    const result = parseFlatToml(`[section]\nkey = "val"`);
    expect(result).toEqual({ key: "val" });
  });

  test("handles single-char quote values without stripping", () => {
    const result = parseFlatToml(`val = "'"`);
    expect(result).toEqual({ val: "'" });
  });

  test("parses the README example config", () => {
    const input = [
      `server = "https://your-company.atlassian.net"`,
      `login = "you@your-company.com"`,
      `max_columns = 6  # visible board columns (default 4)`,
    ].join("\n");
    expect(parseFlatToml(input)).toEqual({
      server: "https://your-company.atlassian.net",
      login: "you@your-company.com",
      max_columns: 6,
    });
  });

  test("handles bare unquoted string values", () => {
    const result = parseFlatToml(`key = hello`);
    expect(result).toEqual({ key: "hello" });
  });
});
