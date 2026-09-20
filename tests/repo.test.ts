import { afterEach, describe, expect, it, vi } from "vitest";

import {
  GuardError,
  assertPathShape,
  assertRev,
  blame,
  diffRange,
  grep,
  logSearch,
  parseBlamePorcelain,
  parseGrep,
  readFile,
  setGitRunner,
  type GitRunner,
} from "../src/server/repo.js";

/** Records every argv git would have been called with. */
function spyRunner(stdout = ""): { calls: string[][]; restore: () => void } {
  const calls: string[][] = [];
  const fake: GitRunner = (args) => {
    calls.push(args);
    // `grep` materialises the tree first; that checkout must also succeed.
    return Promise.resolve({ stdout, stderr: "" });
  };
  const previous = setGitRunner(fake);
  return { calls, restore: () => void setGitRunner(previous) };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("rev guard", () => {
  it("accepts object ids, our PR refs and origin/master", () => {
    expect(assertRev("209b0e0e158f1244b52e8b04ecfdda94ede8cb94")).toBeTruthy();
    expect(assertRev("b3dcff67d")).toBeTruthy();
    expect(assertRev("refs/pr/1650")).toBeTruthy();
    expect(assertRev("refs/prev/1650")).toBeTruthy();
    expect(assertRev("origin/master")).toBeTruthy();
  });

  it("rejects anything else, including option-looking and injection-looking revs", () => {
    for (const bad of [
      "master",
      "HEAD",
      "--upload-pack=touch /tmp/pwned",
      "refs/heads/../../etc",
      "209b0e0e; rm -rf /",
      "refs/pr/1650; ls",
      "",
      "0123456", // 7 hex is fine…
    ].slice(0, 7)) {
      expect(() => assertRev(bad)).toThrow(GuardError);
    }
    expect(assertRev("0123456")).toBe("0123456");
  });
});

describe("path guard", () => {
  it("rejects absolute paths, traversal, NUL and leading dashes", () => {
    for (const bad of [
      "/etc/passwd",
      "C:\\Windows\\system32",
      "../../etc/passwd",
      "lib/../../etc/passwd",
      "lib/./x.cpp",
      "--output=/tmp/x",
      "-n",
      "lib/x\0.cpp",
      "",
    ]) {
      expect(() => assertPathShape(bad)).toThrow(GuardError);
    }
  });

  it("accepts ordinary repository paths", () => {
    expect(assertPathShape("lib/hardware/ESP32UARTChannel.cpp")).toBe("lib/hardware/ESP32UARTChannel.cpp");
    expect(assertPathShape("README.md")).toBe("README.md");
  });
});

describe("argv construction", () => {
  it("never interpolates user text into an argument git could read as an option", async () => {
    const { calls, restore } = spyRunner("");
    try {
      // A pattern that is entirely option-shaped must still arrive as an operand.
      await grep("--max-count=999", "refs/pr/1650", undefined, 5);
      const grepCall = calls.find((c) => c[0] === "grep")!;
      expect(grepCall).toBeDefined();
      // -e separates the pattern from the options, so the text is never parsed.
      const eIndex = grepCall.indexOf("-e");
      expect(eIndex).toBeGreaterThan(0);
      expect(grepCall[eIndex + 1]).toBe("--max-count=999");
      // The only --max-count in option position is ours; the look-alike sits
      // after -e, where git reads it as the pattern operand.
      expect(grepCall.slice(0, eIndex).filter((a) => a.startsWith("--max-count="))).toEqual(["--max-count=5"]);

      await logSearch("-S--not-an-option", "origin/master", 3);
      const logCall = calls.find((c) => c[0] === "log")!;
      const sIndex = logCall.indexOf("-S");
      expect(logCall[sIndex + 1]).toBe("-S--not-an-option");

      // Every argument is its own argv entry: no shell string anywhere.
      for (const call of calls) {
        expect(Array.isArray(call)).toBe(true);
        expect(call.every((a) => typeof a === "string")).toBe(true);
        expect(call.some((a) => a.includes("&&") || a.includes("|") || a.includes(";"))).toBe(false);
      }
    } finally {
      restore();
    }
  });

  it("puts the path after -- so a dashed path cannot become an option", async () => {
    const { calls, restore } = spyRunner("");
    try {
      await blame("lib/x.cpp", "refs/pr/1650", 84, 88);
      const call = calls[0]!;
      expect(call.slice(0, 2)).toEqual(["blame", "-L"]);
      expect(call[2]).toBe("84,88");
      expect(call.indexOf("--")).toBe(call.length - 2);
      expect(call.at(-1)).toBe("lib/x.cpp");
    } finally {
      restore();
    }
  });

  it("refuses guarded arguments before git is ever run", async () => {
    const { calls, restore } = spyRunner("");
    try {
      await expect(blame("../../etc/passwd", "refs/pr/1650", 1, 2)).rejects.toThrow(GuardError);
      await expect(blame("lib/x.cpp", "master", 1, 2)).rejects.toThrow(GuardError);
      await expect(blame("lib/x.cpp", "refs/pr/1650", 0, 2)).rejects.toThrow(GuardError);
      await expect(blame("lib/x.cpp", "refs/pr/1650", 9, 2)).rejects.toThrow(GuardError);
      await expect(readFile("refs/pr/1650", "/etc/passwd")).rejects.toThrow(GuardError);
      await expect(diffRange("refs/pr/1650", "; rm -rf /")).rejects.toThrow(GuardError);
      await expect(grep("x".repeat(500), "refs/pr/1650")).rejects.toThrow(GuardError);
      expect(calls).toHaveLength(0);
    } finally {
      restore();
    }
  });
});

describe("blame porcelain parsing", () => {
  it("carries header fields forward to later lines of the same commit", () => {
    const porcelain = [
      "b3dcff67d1111111111111111111111111111111 84 84 5",
      "author wdathing",
      "author-mail <w@example.com>",
      "author-time 1758153600",
      "author-tz +0000",
      "summary Add COCO_HS_UART support to ESP32UARTChannel (#1628)",
      "filename lib/hardware/ESP32UARTChannel.cpp",
      "\tif (controlPins.rts >= 0 && controlPins.cts >= 0)",
      "b3dcff67d1111111111111111111111111111111 85 85",
      "\t{",
      "b3dcff67d1111111111111111111111111111111 86 86",
      "\t    uart_set_hw_flow_ctrl(_uart_num, UART_HW_FLOWCTRL_CTS_RTS, 0);",
      "0000000000000000000000000000000000000000 87 87",
      "author Not Committed Yet",
      "author-time 1758240000",
      "summary uncommitted",
      "\t    Debug_printv(\"x\");",
      "",
    ].join("\n");

    const lines = parseBlamePorcelain(porcelain);
    expect(lines).toHaveLength(4);
    expect(lines[0]!.sha).toBe("b3dcff67d1111111111111111111111111111111");
    expect(lines[0]!.author).toBe("wdathing");
    expect(lines[0]!.summary).toContain("#1628");
    expect(lines[0]!.line).toBe(84);
    expect(lines[0]!.text).toBe("if (controlPins.rts >= 0 && controlPins.cts >= 0)");

    // Lines 85 and 86 repeat only the SHA; the author must carry forward.
    expect(lines[1]!.author).toBe("wdathing");
    expect(lines[2]!.summary).toContain("#1628");
    expect(lines[2]!.line).toBe(86);
    expect(lines[1]!.date).toBe(lines[0]!.date);

    // A different commit brings its own header.
    expect(lines[3]!.author).toBe("Not Committed Yet");
  });

  it("returns nothing for empty output", () => {
    expect(parseBlamePorcelain("")).toEqual([]);
  });
});

describe("grep output parsing", () => {
  it("splits path, line and text, and tolerates colons in the text", () => {
    const hits = parseGrep(
      [
        "lib/hardware/ESP32UARTChannel.cpp:86:        uart_set_hw_flow_ctrl(_uart_num, UART_HW_FLOWCTRL_CTS_RTS, 0);",
        "lib/bus/drivewire/drivewire.cpp:826:#ifdef COCO_HS_UART",
        "",
      ].join("\n"),
    );
    expect(hits).toEqual([
      {
        path: "lib/hardware/ESP32UARTChannel.cpp",
        line: 86,
        text: "        uart_set_hw_flow_ctrl(_uart_num, UART_HW_FLOWCTRL_CTS_RTS, 0);",
      },
      { path: "lib/bus/drivewire/drivewire.cpp", line: 826, text: "#ifdef COCO_HS_UART" },
    ]);
  });

  it("strips the rev prefix git adds when grepping a revision", async () => {
    const rev = "209b0e0e158f1244b52e8b04ecfdda94ede8cb94";
    const { restore } = spyRunner(`${rev}:lib/x.cpp:12:int x;\n`);
    try {
      const hits = await grep("int x", rev, undefined, 5);
      expect(hits).toEqual([{ path: "lib/x.cpp", line: 12, text: "int x;" }]);
    } finally {
      restore();
    }
  });
});
