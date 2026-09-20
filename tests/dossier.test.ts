import { describe, expect, it } from "vitest";

import { parseDiff } from "../src/server/chunk.js";
import {
  buildThread,
  codeTokens,
  contiguousRanges,
  detectDrift,
  groupCommitsIntoRevisions,
  prNumberFromSubject,
  removedLineRefs,
  summariseDelta,
  symbolsFromDeletedLines,
} from "../src/server/dossier.js";
import type { PrCommit } from "../src/server/github.js";

// The motivating case, reduced to fixtures: PR 1650 wrapped an existing block
// in `#ifdef COCO_HS_UART` (revision 1), then deleted block and guard together
// (revision 2). The 5 wrapped lines came from merged PR #1628.

const BASE_TO_REV1 = [
  "diff --git a/lib/hardware/ESP32UARTChannel.cpp b/lib/hardware/ESP32UARTChannel.cpp",
  "--- a/lib/hardware/ESP32UARTChannel.cpp",
  "+++ b/lib/hardware/ESP32UARTChannel.cpp",
  "@@ -81,6 +81,9 @@ void ESP32UARTChannel::begin(const ChannelConfig& conf)",
  "     }",
  "+#ifdef COCO_HS_UART",
  "+    // Only this board is wired for hardware flow control.",
  "     if (controlPins.rts >= 0 && controlPins.cts >= 0)",
  "     {",
  "         uart_set_hw_flow_ctrl(_uart_num, UART_HW_FLOWCTRL_CTS_RTS, 0);",
  "         Debug_printv(\"RTS/CTS flow control enabled\");",
  "     }",
  "+#endif",
  "",
].join("\n");

const REV1_TO_REV2 = [
  "diff --git a/lib/hardware/ESP32UARTChannel.cpp b/lib/hardware/ESP32UARTChannel.cpp",
  "--- a/lib/hardware/ESP32UARTChannel.cpp",
  "+++ b/lib/hardware/ESP32UARTChannel.cpp",
  "@@ -81,9 +81,1 @@ void ESP32UARTChannel::begin(const ChannelConfig& conf)",
  "     }",
  "-#ifdef COCO_HS_UART",
  "-    // Only this board is wired for hardware flow control.",
  "-    if (controlPins.rts >= 0 && controlPins.cts >= 0)",
  "-    {",
  "-        uart_set_hw_flow_ctrl(_uart_num, UART_HW_FLOWCTRL_CTS_RTS, 0);",
  "-        Debug_printv(\"RTS/CTS flow control enabled\");",
  "-    }",
  "-#endif",
  "",
].join("\n");

const BASE_TO_HEAD = [
  "diff --git a/lib/hardware/ESP32UARTChannel.cpp b/lib/hardware/ESP32UARTChannel.cpp",
  "--- a/lib/hardware/ESP32UARTChannel.cpp",
  "+++ b/lib/hardware/ESP32UARTChannel.cpp",
  "@@ -81,9 +81,4 @@ void ESP32UARTChannel::begin(const ChannelConfig& conf)",
  "         fnSystem.set_pin_mode(controlPins.cts, gpio_mode_t::GPIO_MODE_OUTPUT);",
  "         fnSystem.digital_write(controlPins.cts, DIGI_LOW);",
  "     }",
  "-    if (controlPins.rts >= 0 && controlPins.cts >= 0)",
  "-    {",
  "-        uart_set_hw_flow_ctrl(_uart_num, UART_HW_FLOWCTRL_CTS_RTS, 0);",
  "-        Debug_printv(\"RTS/CTS flow control enabled\");",
  "-    }",
  " ",
  "",
].join("\n");

function commit(sha: string, date: string, subject: string): PrCommit {
  return { sha, date, author: "deltecent", subject, message: subject, url: `https://github.com/x/y/commit/${sha}` };
}

describe("revision grouping", () => {
  it("splits on a push gap when no head is known (1650: two commits 95 minutes apart)", () => {
    const groups = groupCommitsIntoRevisions(
      [
        commit("e9d16d00", "2026-09-20T15:03:13Z", "[rs232] limit UART RTS/CTS hardware flow control to COCO_HS_UART"),
        commit("78bff043", "2026-09-20T16:38:04Z", "[rs232] don't enable UART RTS/CTS flow control implicitly"),
      ],
      [],
    );
    expect(groups).toHaveLength(2);
    expect(groups[0]![0]!.sha).toBe("e9d16d00");
    expect(groups[1]![0]!.sha).toBe("78bff043");
  });

  it("keeps commits pushed together in one revision", () => {
    const groups = groupCommitsIntoRevisions(
      [
        commit("aaa", "2026-09-20T15:03:13Z", "one"),
        commit("bbb", "2026-09-20T15:04:00Z", "two"),
        commit("ccc", "2026-09-20T15:05:10Z", "three"),
      ],
      [],
    );
    expect(groups).toHaveLength(1);
    expect(groups[0]).toHaveLength(3);
  });

  it("prefers heads the store actually watched over the time heuristic", () => {
    const commits = [
      commit("aaa", "2026-09-20T15:03:13Z", "one"),
      commit("bbb", "2026-09-20T15:04:00Z", "two"),
      commit("ccc", "2026-09-20T17:05:10Z", "three"),
    ];
    // We evaluated at "bbb": that is the revision boundary, not the 2-hour gap.
    const groups = groupCommitsIntoRevisions(commits, ["bbb"]);
    expect(groups.map((g) => g.map((c) => c.sha))).toEqual([["aaa", "bbb"], ["ccc"]]);
  });

  it("returns nothing for a PR with no commits", () => {
    expect(groupCommitsIntoRevisions([], ["aaa"])).toEqual([]);
  });
});

describe("revision delta summary", () => {
  it("says revision 2 removed the guard revision 1 added and the lines it wrapped", () => {
    const delta = summariseDelta({
      fromSha: "e9d16d00",
      toSha: "78bff043",
      diff: REV1_TO_REV2,
      previousDiffFiles: parseDiff(BASE_TO_REV1).files,
      revisionNumber: 2,
    });
    expect(delta.filesTouched).toEqual(["lib/hardware/ESP32UARTChannel.cpp"]);
    expect(delta.linesAddedNowRemoved).toBe(3); // #ifdef, the comment, #endif
    expect(delta.linesRemovedNowRestored).toBe(0);
    expect(delta.summary).toContain("#ifdef COCO_HS_UART");
    expect(delta.summary).toContain("3 guard lines");
    expect(delta.summary).toContain("5 lines they wrapped");
    expect(delta.summary).toContain("lib/hardware/ESP32UARTChannel.cpp");
  });

  it("counts lines the new revision put back", () => {
    const delta = summariseDelta({
      fromSha: "a1b2c3d",
      toSha: "d4e5f60",
      diff: [
        "diff --git a/lib/x.cpp b/lib/x.cpp",
        "--- a/lib/x.cpp",
        "+++ b/lib/x.cpp",
        "@@ -1,2 +1,2 @@",
        "+int keep = 1;",
        "-int added_then_dropped = 2;",
        "",
      ].join("\n"),
      previousDiffFiles: parseDiff(
        [
          "diff --git a/lib/x.cpp b/lib/x.cpp",
          "--- a/lib/x.cpp",
          "+++ b/lib/x.cpp",
          "@@ -1,2 +1,2 @@",
          "-int keep = 1;",
          "+int added_then_dropped = 2;",
          "",
        ].join("\n"),
      ).files,
      revisionNumber: 2,
    });
    expect(delta.linesAddedNowRemoved).toBe(1);
    expect(delta.linesRemovedNowRestored).toBe(1);
    expect(delta.summary).toContain("restored 1 line");
  });

  it("says so when a revision changed nothing", () => {
    const delta = summariseDelta({
      fromSha: "aaaaaaa",
      toSha: "bbbbbbb",
      diff: "",
      previousDiffFiles: [],
      revisionNumber: 3,
    });
    expect(delta.summary).toContain("changed no lines");
  });
});

describe("deleted-line provenance inputs", () => {
  it("takes removed lines with their line numbers in the old file", () => {
    const refs = removedLineRefs(parseDiff(BASE_TO_HEAD).files);
    expect(refs.map((r) => r.line)).toEqual([84, 85, 86, 87, 88]);
    expect(refs[0]!.path).toBe("lib/hardware/ESP32UARTChannel.cpp");
    expect(refs[2]!.text).toContain("uart_set_hw_flow_ctrl");
  });

  it("groups line numbers into contiguous ranges so blame is called once", () => {
    expect(contiguousRanges([84, 85, 86, 87, 88])).toEqual([[84, 88]]);
    expect(contiguousRanges([3, 1, 2, 9, 10, 40])).toEqual([[1, 3], [9, 10], [40, 40]]);
    expect(contiguousRanges([])).toEqual([]);
    expect(contiguousRanges([7, 7, 7])).toEqual([[7, 7]]);
  });

  it("reads the PR number out of a squash-merge subject", () => {
    expect(prNumberFromSubject("Add COCO_HS_UART support to ESP32UARTChannel; fix DevKitC UART1 RX pin (#1628)")).toBe(1628);
    expect(prNumberFromSubject("[all] fix heap leaks on error paths (#1599)")).toBe(1599);
    expect(prNumberFromSubject("a commit with no pull request")).toBeNull();
    expect(prNumberFromSubject("mentions #1628 but not as a suffix")).toBeNull();
  });
});

describe("cross-reference symbols", () => {
  it("picks calls and macros out of deleted lines and drops keywords", () => {
    const symbols = symbolsFromDeletedLines([
      { text: "    if (controlPins.rts >= 0 && controlPins.cts >= 0)" },
      { text: "        uart_set_hw_flow_ctrl(_uart_num, UART_HW_FLOWCTRL_CTS_RTS, 0);" },
      { text: '        Debug_printv("RTS/CTS flow control enabled");' },
      { text: "    for (int i = 0; i < 4; i++) return printf(\"x\");" },
    ]);
    expect(symbols).toContain("uart_set_hw_flow_ctrl");
    expect(symbols).toContain("UART_HW_FLOWCTRL_CTS_RTS");
    expect(symbols).toContain("Debug_printv");
    expect(symbols).not.toContain("if");
    expect(symbols).not.toContain("for");
    expect(symbols).not.toContain("printf");
    expect(symbols.length).toBeLessThanOrEqual(8);
  });
});

describe("drift detection", () => {
  const diffText = parseDiff(BASE_TO_HEAD)
    .files.flatMap((f) => [f.path, ...f.hunks.flatMap((h) => [h.header, ...h.lines.map((l) => l.text)])])
    .join("\n");

  it("flags body tokens the current diff does not contain", () => {
    const drift = detectDrift({
      title: "[rs232] don't enable UART RTS/CTS hardware flow control implicitly",
      body: "There are no per-platform `#ifdef`s in `ESP32UARTChannel`. `coco_devkitc.h` is the only `COCO_HS_UART` board, and `rs232_rev0.h` defines `PIN_RS232_RTS`.",
      diffText,
      commitSubjects: ["[rs232] don't enable UART RTS/CTS flow control implicitly"],
      headMoved: false,
    });
    const body = drift.find((d) => d.kind === "body_mentions_absent_token");
    expect(body).toBeDefined();
    expect(body!.evidence).toContain("#ifdef");
    expect(body!.evidence).toContain("COCO_HS_UART");
    expect(body!.evidence).toContain("coco_devkitc.h");
    // A token that *is* in the diff is not drift.
    expect(body!.evidence).not.toContain("uart_set_hw_flow_ctrl");
  });

  it("flags the revision 1 subject when the title was rewritten around it", () => {
    const drift = detectDrift({
      title: "[rs232] don't enable UART RTS/CTS hardware flow control implicitly",
      body: "no code tokens here at all",
      diffText,
      commitSubjects: ["[rs232] limit UART RTS/CTS hardware flow control to COCO_HS_UART"],
      firstRevisionSubject: "[rs232] limit UART RTS/CTS hardware flow control to COCO_HS_UART",
      headMoved: true,
    });
    const title = drift.find((d) => d.kind === "title_mentions_absent_token");
    expect(title).toBeDefined();
    expect(title!.evidence).toEqual(["COCO_HS_UART"]);
    expect(title!.detail).toContain("revision 1 commit subject");
  });

  it("does not flag a description that matches the diff", () => {
    const drift = detectDrift({
      title: "Remove the implicit uart_set_hw_flow_ctrl call",
      body: "Removes the `uart_set_hw_flow_ctrl` call and its `Debug_printv`.",
      diffText,
      commitSubjects: ["Remove the implicit uart_set_hw_flow_ctrl call"],
      headMoved: false,
    });
    expect(drift.filter((d) => d.kind.endsWith("absent_token"))).toEqual([]);
  });

  it("flags a body that did not move when the head did — only when the old body is known", () => {
    const common = {
      title: "t",
      body: "same body",
      diffText,
      commitSubjects: ["t and some words about rts cts uart"],
      headMoved: true,
    };
    expect(detectDrift({ ...common, previousBody: "same body" }).some((d) => d.kind === "body_predates_push")).toBe(true);
    expect(detectDrift({ ...common, previousBody: "an older body" }).some((d) => d.kind === "body_predates_push")).toBe(false);
    // Unknown previous body: we do not claim it.
    expect(detectDrift({ ...common, previousBody: null }).some((d) => d.kind === "body_predates_push")).toBe(false);
    expect(detectDrift({ ...common, headMoved: false, previousBody: "same body" }).some((d) => d.kind === "body_predates_push")).toBe(false);
  });

  it("flags commit subjects that share nothing with the title", () => {
    const drift = detectDrift({
      title: "Fix RS232 flow control regression",
      body: "",
      diffText,
      commitSubjects: ["wip", "more stuff", "address review"],
      headMoved: false,
    });
    expect(drift.some((d) => d.kind === "commit_subject_disagrees_with_title")).toBe(true);

    const agreeing = detectDrift({
      title: "Fix RS232 flow control regression",
      body: "",
      diffText,
      commitSubjects: ["Fix the RS232 flow control regression on boot"],
      headMoved: false,
    });
    expect(agreeing.some((d) => d.kind === "commit_subject_disagrees_with_title")).toBe(false);
  });
});

describe("code token extraction", () => {
  it("splits backticked spans into identifier-shaped pieces", () => {
    const tokens = codeTokens("`uart_param_config()` already applies `conf.uart_config.flow_ctrl`, see `lib/x.cpp`.");
    expect(tokens).toContain("uart_param_config");
    expect(tokens).toContain("lib/x.cpp");
    expect(tokens.some((t) => t.includes("("))).toBe(false);
  });

  it("ranks preprocessor directives and macros first", () => {
    const tokens = codeTokens("see `some/path.cpp`, `MY_MACRO_NAME`, and `#ifdef`");
    expect(tokens[0]).toBe("#ifdef");
    expect(tokens[1]).toBe("MY_MACRO_NAME");
  });

  it("ignores plain prose", () => {
    expect(codeTokens("This change fixes the boot hang that the maintainer reported.")).toEqual([]);
  });
});

describe("thread merge", () => {
  const at = (s: string): string => `2026-09-20T${s}Z`;

  it("orders every source by time and badges maintainers by association", () => {
    const thread = buildThread(
      [{ author: "someone", association: "NONE", at: at("15:00:00"), body: "drive-by", url: "u1" }],
      [
        {
          author: "FozzTexx",
          association: "MEMBER",
          at: at("16:12:22"),
          body: "Do not put per platform `#ifdefs` in this file.",
          url: "u2",
          path: "lib/hardware/ESP32UARTChannel.cpp",
          line: 86,
        },
        { author: "deltecent", association: "CONTRIBUTOR", at: at("16:40:24"), body: "Agreed, thanks.", url: "u3" },
      ],
      [
        { author: "FozzTexx", association: "MEMBER", at: at("16:12:22"), body: "", url: "u4", state: "COMMENTED" },
        { author: "FozzTexx", association: "MEMBER", at: at("17:30:00"), body: "Needs a config option.", url: "u5", state: "CHANGES_REQUESTED" },
      ],
      [commit("78bff043", at("16:38:04"), "[rs232] don't enable UART RTS/CTS flow control implicitly")],
    );

    expect(thread.map((t) => t.at)).toEqual([
      at("15:00:00"),
      at("16:12:22"),
      at("16:38:04"),
      at("16:40:24"),
      at("17:30:00"),
    ]);
    expect(thread.map((t) => t.kind)).toEqual([
      "issue_comment",
      "review_comment",
      "commit",
      "review_comment",
      "review",
    ]);

    const fozz = thread.filter((t) => t.author === "FozzTexx");
    expect(fozz.every((t) => t.isMaintainer)).toBe(true);
    expect(thread.find((t) => t.author === "deltecent" && t.kind === "review_comment")!.isMaintainer).toBe(false);
    expect(thread.find((t) => t.author === "someone")!.isMaintainer).toBe(false);

    // The empty COMMENTED review is dropped; its review comment already carries it.
    expect(thread.filter((t) => t.kind === "review")).toHaveLength(1);
    expect(thread.find((t) => t.kind === "review")!.state).toBe("CHANGES_REQUESTED");

    const inline = thread[1]!;
    expect(inline.path).toBe("lib/hardware/ESP32UARTChannel.cpp");
    expect(inline.line).toBe(86);
  });

  it("treats OWNER and COLLABORATOR as maintainers too", () => {
    const thread = buildThread(
      [
        { author: "owner", association: "OWNER", at: at("10:00:00"), body: "x", url: "u" },
        { author: "collab", association: "COLLABORATOR", at: at("11:00:00"), body: "y", url: "u" },
        { author: "outsider", association: "FIRST_TIME_CONTRIBUTOR", at: at("12:00:00"), body: "z", url: "u" },
      ],
      [],
      [],
      [],
    );
    expect(thread.filter((t) => t.isMaintainer).map((t) => t.author)).toEqual(["owner", "collab"]);
  });
});

describe("tool revision defaults", () => {
  it("names the revision each file tool reads, and its default", async () => {
    const { DEEP_TOOLS, DEEP_SYSTEM_PROMPT } = await import("../src/server/deep.js");
    const byName = new Map(DEEP_TOOLS.map((t) => [t.function.name, t.function]));

    for (const name of ["read_file", "grep", "git_blame", "list_dir"]) {
      const fn = byName.get(name)!;
      const props = fn.parameters["properties"] as Record<string, { enum?: string[]; description?: string }>;
      expect(props["rev"], `${name} should take rev`).toBeDefined();
      expect(props["rev"]!.enum).toEqual(["head", "base"]);
      // The description states the default in words, not just in the schema.
      expect(fn.description).toMatch(/rev=(head|base)/);
    }
    expect(byName.get("read_file")!.description).toContain("Reads at the PR head (rev=head)");
    expect(byName.get("grep")!.description).toContain("base commit (rev=base)");
    expect(byName.get("git_blame")!.description).toContain("base commit (rev=base)");
    expect(byName.get("list_dir")!.description).toContain("PR head (rev=head)");

    // And the prompt explains what the two revisions are.
    expect(DEEP_SYSTEM_PROMPT).toContain("REVISIONS");
    expect(DEEP_SYSTEM_PROMPT).toContain("this pull request as it stands now");
    expect(DEEP_SYSTEM_PROMPT).toContain("master as the pull request is against it");
  });
});
