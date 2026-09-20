import { describe, expect, it } from "vitest";

import { parseDiff } from "../src/server/chunk.js";
import { runGates, sizeBucketOf } from "../src/server/gates.js";
import type { GateResult } from "../src/shared/types.js";
import { check, diffOf, file, multiFileDiff, policy, snapshot } from "./fixtures.js";

function gates(over: Parameters<typeof snapshot>[0], diff = ""): GateResult[] {
  return runGates(snapshot(over), parseDiff(diff), policy());
}

function get(list: GateResult[], id: string): GateResult {
  const g = list.find((x) => x.id === id);
  if (!g) throw new Error(`no gate ${id}`);
  return g;
}

describe("hard gates", () => {
  it("not_draft", () => {
    expect(get(gates({}), "not_draft").passed).toBe(true);
    const bad = get(gates({ draft: true }), "not_draft");
    expect(bad.passed).toBe(false);
    expect(bad.severity).toBe("hard");
  });

  it("mergeable is hard when false and info when unknown", () => {
    expect(get(gates({ mergeable: true }), "mergeable").passed).toBe(true);
    const failed = get(gates({ mergeable: false, mergeableState: "dirty" }), "mergeable");
    expect([failed.passed, failed.severity]).toEqual([false, "hard"]);
    const unknown = get(gates({ mergeable: null }), "mergeable");
    expect([unknown.passed, unknown.severity]).toEqual([true, "info"]);
  });

  it("ci_green fails on a failing check-run, ci_pending on a queued one", () => {
    const green = gates({ checks: [check("macOS 14 ARM: Target ATARI", "completed", "success")] });
    expect(get(green, "ci_green").passed).toBe(true);
    expect(get(green, "ci_pending").passed).toBe(true);

    const red = gates({ checks: [check("Windows: Target RS232", "completed", "failure")] });
    expect(get(red, "ci_green").passed).toBe(false);
    expect(get(red, "ci_green").evidence).toEqual(["Windows: Target RS232: failure"]);

    const pending = gates({ checks: [check("macOS 14 ARM: Target ATARI", "queued", null)] });
    expect(get(pending, "ci_green").passed).toBe(true);
    expect(get(pending, "ci_pending").passed).toBe(false);
    expect(get(pending, "ci_pending").severity).toBe("soft");

    // action_required means a maintainer must approve the run, not that it failed.
    const needsApproval = gates({ checks: [check("Windows: Target RS232", "completed", "action_required")] });
    expect(get(needsApproval, "ci_green").passed).toBe(true);
    expect(get(needsApproval, "ci_pending").passed).toBe(false);
  });

  it("forbidden_files", () => {
    expect(get(gates({}), "forbidden_files").passed).toBe(true);
    const bad = gates({ files: [file("managed_components/espressif__mdns/mdns.c"), file("platformio.ini")] });
    const g = get(bad, "forbidden_files");
    expect(g.passed).toBe(false);
    expect(g.value).toEqual(["managed_components/espressif__mdns/mdns.c", "platformio.ini"]);
  });

  it("build_ifdef_in_shared_device", () => {
    const ok = gates(
      { files: [file("lib/device/rs232/rs232Disk.cpp")] },
      diffOf("lib/device/rs232/rs232Disk.cpp", ["#ifdef BUILD_RS232", "int x;", "#endif"]),
    );
    expect(get(ok, "build_ifdef_in_shared_device").passed).toBe(true);

    const bad = gates(
      { files: [file("lib/device/fujiDevice/fujiDevice.cpp")] },
      diffOf("lib/device/fujiDevice/fujiDevice.cpp", ["#ifdef BUILD_ATARI", "int x;", "#endif"]),
    );
    const g = get(bad, "build_ifdef_in_shared_device");
    expect(g.passed).toBe(false);
    expect(g.evidence?.[0]).toBe("lib/device/fujiDevice/fujiDevice.cpp:2: #ifdef BUILD_ATARI");
  });

  it("still fires when a preceding added line looks like a diff header", () => {
    // `++ i;` renders as `+++ i;`. The parser used to read that as a new file,
    // so the BUILD_* lines after it were attributed elsewhere and this hard
    // gate passed on a PR that violates the enforced architecture rule.
    const diff = [
      "diff --git a/lib/device/fujiDevice/fujiDevice.cpp b/lib/device/fujiDevice/fujiDevice.cpp",
      "--- a/lib/device/fujiDevice/fujiDevice.cpp",
      "+++ b/lib/device/fujiDevice/fujiDevice.cpp",
      "@@ -10,1 +10,3 @@ void fujiDevice::service()",
      " int i = 0;",
      "+++ i;",
      "+#ifdef BUILD_ATARI",
      "",
    ].join("\n");
    const g = get(gates({ files: [file("lib/device/fujiDevice/fujiDevice.cpp")] }, diff), "build_ifdef_in_shared_device");
    expect(g.passed).toBe(false);
    expect(g.evidence?.[0]).toContain("lib/device/fujiDevice/fujiDevice.cpp");
  });
});

describe("soft gates", () => {
  it("sdkconfig_churn only when config churn rides along with source", () => {
    const deliberate = gates({ files: [file("sdkconfig.fujinet-atari-v1")] });
    expect(get(deliberate, "sdkconfig_churn").passed).toBe(true);

    const swept = gates({ files: [file("sdkconfig.fujinet-atari-v1"), file("lib/device/rs232/rs232Disk.cpp")] });
    expect(get(swept, "sdkconfig_churn").passed).toBe(false);
  });

  it("throw_in_firmware", () => {
    const ok = gates({}, diffOf("lib/device/rs232/rs232Disk.cpp", ["return error_is_true{};"]));
    expect(get(ok, "throw_in_firmware").passed).toBe(true);

    const bad = gates({}, diffOf("lib/device/rs232/rs232Disk.cpp", ["    throw std::runtime_error(\"no\");"]));
    expect(get(bad, "throw_in_firmware").passed).toBe(false);

    const inTests = gates({}, diffOf("tests/mail_tests.cpp", ["    throw std::runtime_error(\"no\");"]));
    expect(get(inTests, "throw_in_firmware").passed).toBe(true);

    // A comment mentioning throw is not a throw.
    const inComment = gates({}, diffOf("lib/device/rs232/rs232Disk.cpp", [
      "// never throw here: exceptions are disabled",
      "/* try { } is also out */",
      " * throw nothing",
    ]));
    expect(get(inComment, "throw_in_firmware").passed).toBe(true);
  });

  it("arduino_string, including brace init but not comments", () => {
    expect(get(gates({}, diffOf("lib/x.cpp", ["std::string name;"])), "arduino_string").passed).toBe(true);
    expect(get(gates({}, diffOf("lib/x.cpp", ["String name = \"a\";"])), "arduino_string").passed).toBe(false);
    expect(get(gates({}, diffOf("lib/x.cpp", ["String name{\"a\"};"])), "arduino_string").passed).toBe(false);
    // Prose about String is not a use of String.
    expect(get(gates({}, diffOf("lib/x.cpp", ["// String name = \"a\"; is banned"])), "arduino_string").passed).toBe(true);
    expect(get(gates({}, diffOf("lib/x.cpp", [" * String name(\"a\") here"])), "arduino_string").passed).toBe(true);
  });

  it("fuji_error_unspecified", () => {
    expect(get(gates({}, diffOf("lib/x.cpp", ["if (err != FUJI_ERROR::NONE) return;"])), "fuji_error_unspecified").passed).toBe(true);
    expect(get(gates({}, diffOf("lib/x.cpp", ["if (err == FUJI_ERROR::UNSPECIFIED) return;"])), "fuji_error_unspecified").passed).toBe(false);
  });

  it("htole_bitshift covers the whole endian family", () => {
    expect(get(gates({}, diffOf("lib/x.cpp", ["u16le_t len;"])), "htole_bitshift").passed).toBe(true);
    for (const call of [
      "htole16", "htole32", "htole64", "htobe16", "htobe32", "htobe64",
      "le16toh", "le32toh", "le64toh", "be16toh", "be32toh", "be64toh",
    ]) {
      expect(get(gates({}, diffOf("lib/x.cpp", [`v = ${call}(n);`])), "htole_bitshift").passed).toBe(false);
    }
  });

  it("dead_test_dir", () => {
    expect(get(gates({ files: [file("tests/mail_tests.cpp")] }), "dead_test_dir").passed).toBe(true);
    expect(get(gates({ files: [file("test/old_unity.cpp")] }), "dead_test_dir").passed).toBe(false);
  });

  it("trailing_whitespace counts and caps evidence at 5", () => {
    expect(get(gates({}, diffOf("lib/x.cpp", ["int clean = 1;"])), "trailing_whitespace").passed).toBe(true);
    const dirty = gates({}, diffOf("lib/x.cpp", Array.from({ length: 8 }, (_, i) => `int v${i} = 1; `)));
    const g = get(dirty, "trailing_whitespace");
    expect(g.passed).toBe(false);
    expect(g.value).toBe(8);
    expect(g.evidence).toHaveLength(5);
  });

  it("has_description", () => {
    expect(get(gates({}), "has_description").passed).toBe(true);
    expect(get(gates({ body: "fix" }), "has_description").passed).toBe(false);
  });
});

describe("info gates", () => {
  it("size_bucket follows the thresholds", () => {
    expect(sizeBucketOf(20)).toBe("tiny");
    expect(sizeBucketOf(21)).toBe("small");
    expect(sizeBucketOf(150)).toBe("small");
    expect(sizeBucketOf(600)).toBe("medium");
    expect(sizeBucketOf(2000)).toBe("large");
    expect(sizeBucketOf(2001)).toBe("huge");
    expect(get(gates({ additions: 5, deletions: 2 }), "size_bucket").value).toBe("tiny");
  });

  it("shared_code_touched", () => {
    expect(get(gates({ files: [file("lib/device/rs232/rs232Disk.cpp")] }), "shared_code_touched").value).toBe("no");
    expect(get(gates({ files: [file("lib/device/fujiDevice/fujiDevice.cpp")] }), "shared_code_touched").value).toBe("yes");
    expect(get(gates({ files: [file("src/main.cpp")] }), "shared_code_touched").value).toBe("yes");
  });

  it("platform_scope from paths and BUILD_ tokens", () => {
    const g = get(
      gates(
        { files: [file("lib/bus/rs232/rs232.cpp"), file("lib/device/coco/cocoDisk.cpp")] },
        diffOf("lib/bus/rs232/rs232.cpp", ["#ifdef BUILD_LYNX"]),
      ),
      "platform_scope",
    );
    expect(g.value).toEqual(["coco", "lynx", "rs232"]);
    expect(get(gates({ files: [file("README.md")] }), "platform_scope").value).toEqual([]);
  });

  it("age_days marks stale", () => {
    const old = gates({ createdAt: new Date(Date.now() - 200 * 86_400_000).toISOString() });
    expect(get(old, "age_days").detail).toContain("stale");
    expect(get(gates({}), "age_days").detail).not.toContain("stale");
  });

  it("has_unresolved_reviews", () => {
    expect(get(gates({}), "has_unresolved_reviews").passed).toBe(true);
    const blocked = gates({ latestReviewStates: { alice: "CHANGES_REQUESTED", bob: "APPROVED" } });
    const g = get(blocked, "has_unresolved_reviews");
    expect(g.passed).toBe(false);
    expect(g.value).toEqual(["alice"]);
  });
});

describe("policy overrides", () => {
  it("can downgrade or turn off a gate", () => {
    const list = runGates(
      snapshot({ draft: true }),
      parseDiff(""),
      policy({ gates: { not_draft: "info", trailing_whitespace: "off" } }),
    );
    expect(get(list, "not_draft").severity).toBe("info");
    expect(get(list, "trailing_whitespace").severity).toBe("off");
  });
});

describe("evidence format", () => {
  it("is path:line: text", () => {
    const list = gates(
      { files: [file("lib/a.cpp"), file("lib/b.cpp")] },
      multiFileDiff([
        { path: "lib/a.cpp", added: ["String s;"] },
        { path: "lib/b.cpp", added: ["String t;"] },
      ]),
    );
    expect(get(list, "arduino_string").evidence).toEqual([
      "lib/a.cpp:2: String s;",
      "lib/b.cpp:2: String t;",
    ]);
  });
});
