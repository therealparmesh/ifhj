import { describe, expect, test } from "bun:test";

import { initials, stickyScroll, truncate } from "./ui";

describe("terminal-width text", () => {
  test("truncates wide and combining graphemes by terminal cells", () => {
    expect(truncate("界界a", 4)).toBe("界…");
    expect(truncate("e\u0301clair", 2)).toBe("e\u0301…");
    expect(Bun.stringWidth(truncate("🙂🙂", 3))).toBe(3);
    expect(truncate("界a", 3)).toBe("界a");
    expect(truncate("anything", 0)).toBe("");
  });
});

describe("sticky scroll bounds", () => {
  test("clamps a stale anchor and keeps the cursor visible", () => {
    expect(stickyScroll(4, 3, 0, 20)).toBe(0);
    expect(stickyScroll(10, 3, 6, 2)).toBe(4);
  });
});

test("initials preserve complete Unicode graphemes", () => {
  expect(initials("👩‍💻 Developer")).toBe("👩‍💻D");
  expect(initials("👨‍👩‍👧‍👦")).toBe("👨‍👩‍👧‍👦");
});
