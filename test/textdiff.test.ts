import { test, expect } from "@playwright/test";
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  textDiff,
  markdownDiff,
  computeFileDiff,
  extractNets,
  diffNets,
  type NetInfo,
} from "../src/textdiff.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = path.resolve(__dirname, "..");
const CLI = path.join(PROJECT_DIR, "kicadiff");

/** Build a minimal valid-ish `.kicad_pcb` body with the given top-level
 *  net table and footprints. Just enough syntax for the textdiff parser
 *  (it only walks `(net ...)` and `(footprint ...)`).
 *
 *  When `opts.kicad10` is set, emits the KiCad 10 shape: NO top-level net
 *  table, and pad nets use `(net "name")` (no id). When unset, emits the
 *  legacy `(net id "name")` shape with a top-level table. */
function makePcb(
  nets: Array<{ id: number; name: string }>,
  footprints: Array<{
    ref: string;
    value?: string;
    libId?: string;
    pads: Array<{ num: string; net: { id: number; name: string } | null }>;
  }>,
  opts: { kicad10?: boolean } = {},
): string {
  const k10 = !!opts.kicad10;
  // KiCad 10 emits no top-level (net N "name") declarations — connectivity
  // is inferred purely from pad / track entries. Reflect that here so the
  // tests exercise the fallback path.
  const netLines = k10
    ? ""
    : nets.map(n => `\t(net ${n.id} "${n.name}")`).join("\n");
  const fpLines = footprints.map((fp, fpi) => {
    const lib = fp.libId ?? "lib:R";
    const ref = fp.ref;
    const value = fp.value ?? "1k";
    const uuid = `00000000-0000-0000-0000-${String(fpi).padStart(12, "0")}`;
    const padLines = fp.pads.map((p, pi) => {
      const padUuid = `11111111-1111-1111-${String(fpi).padStart(4, "0")}-${String(pi).padStart(12, "0")}`;
      // KiCad 10 dropped the numeric id from the pad's net atom.
      const netSexp = p.net
        ? (k10
          ? `\n\t\t\t(net "${p.net.name}")`
          : `\n\t\t\t(net ${p.net.id} "${p.net.name}")`)
        : "";
      return `\t\t(pad "${p.num}" smd rect\n\t\t\t(at 0 0)\n\t\t\t(size 1 1)\n\t\t\t(layers "F.Cu")${netSexp}\n\t\t\t(uuid "${padUuid}")\n\t\t)`;
    }).join("\n");
    return `\t(footprint "${lib}"\n\t\t(layer "F.Cu")\n\t\t(uuid "${uuid}")\n\t\t(at 100 100)\n\t\t(property "Reference" "${ref}"\n\t\t\t(at 0 -2 0)\n\t\t\t(layer "F.SilkS")\n\t\t\t(uuid "${uuid.replace(/0$/, "a")}")\n\t\t\t(effects (font (size 1 1)))\n\t\t)\n\t\t(property "Value" "${value}"\n\t\t\t(at 0 2 0)\n\t\t\t(layer "F.SilkS")\n\t\t\t(uuid "${uuid.replace(/0$/, "b")}")\n\t\t\t(effects (font (size 1 1)))\n\t\t)\n${padLines}\n\t)`;
  }).join("\n");
  const version = k10 ? "20260206" : "20240108";
  return `(kicad_pcb (version ${version}) (generator "test")\n${netLines}\n${fpLines}\n)\n`;
}

/** Create a temp file containing `body` and return its path. Cleanup is the
 *  caller's responsibility (use try/finally with fs.rmSync on the temp dir). */
function writeTmpPcb(dir: string, name: string, body: string): string {
  const p = path.join(dir, name);
  fs.writeFileSync(p, body);
  return p;
}

/** Compute a textDiff between two on-disk PCB bodies without going through
 *  git: write both into the same dir, swap them in, and diff against the
 *  working tree (fromRef="", toRef=""). We use the trick of computing
 *  before from one file and after from another by feeding them in as a
 *  pair via the lower-level parse/diff API. */
function diffPcbBodies(beforeBody: string, afterBody: string): {
  text: string; md: string; fd: ReturnType<typeof computeFileDiff>;
} {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kicadiff-textdiff-unit-"));
  try {
    // Use a git repo so computeFileDiff can read "before" from HEAD and
    // "after" from the working tree.
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
    const pcbPath = path.join(dir, "x.kicad_pcb");
    fs.writeFileSync(pcbPath, beforeBody);
    execFileSync("git", ["-c", "commit.gpgsign=false", "-c", "user.email=t@t",
      "-c", "user.name=t", "add", "."], { cwd: dir });
    execFileSync("git", ["-c", "commit.gpgsign=false", "-c", "user.email=t@t",
      "-c", "user.name=t", "commit", "-q", "-m", "init"], { cwd: dir });
    fs.writeFileSync(pcbPath, afterBody);
    const text = textDiff(pcbPath, "HEAD", "", dir);
    const md = markdownDiff(pcbPath, "HEAD", "", dir);
    const fd = computeFileDiff(pcbPath, "HEAD", "", dir);
    return { text, md, fd };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// =============================================================================
// Unit tests: net extraction + diff
// =============================================================================

test.describe("extractNets", () => {
  test("collects top-level net table and pad memberships", () => {
    const src = makePcb(
      [{ id: 0, name: "" }, { id: 1, name: "VCC" }, { id: 2, name: "GND" }],
      [{
        ref: "R1", pads: [
          { num: "1", net: { id: 1, name: "VCC" } },
          { num: "2", net: { id: 2, name: "GND" } },
        ],
      }],
    );
    const info: NetInfo = extractNets(src);
    expect(info.names.has("VCC")).toBe(true);
    expect(info.names.has("GND")).toBe(true);
    // Unconnected net "" is excluded (noisy, churns on every save)
    expect(info.names.has("")).toBe(false);
    expect(info.padNets.get("R1")?.get("1")).toBe("VCC");
    expect(info.padNets.get("R1")?.get("2")).toBe("GND");
  });

  test("pads with no net stay out of the pad map", () => {
    const src = makePcb(
      [{ id: 0, name: "" }, { id: 1, name: "VCC" }],
      [{ ref: "R1", pads: [{ num: "1", net: null }] }],
    );
    const info = extractNets(src);
    // Either no entry for R1 at all, or R1 exists but has no pad "1".
    expect(info.padNets.get("R1")?.has("1") ?? false).toBe(false);
  });
});

test.describe("diffNets", () => {
  test("detects added nets", () => {
    const before = extractNets(makePcb(
      [{ id: 1, name: "VCC" }],
      [{ ref: "R1", pads: [{ num: "1", net: { id: 1, name: "VCC" } }] }],
    ));
    const after = extractNets(makePcb(
      [{ id: 1, name: "VCC" }, { id: 2, name: "/LED_OUT" }],
      [{
        ref: "R1", pads: [
          { num: "1", net: { id: 1, name: "VCC" } },
          { num: "2", net: { id: 2, name: "/LED_OUT" } },
        ],
      }],
    ));
    const d = diffNets(before, after);
    expect(d.added).toContain("/LED_OUT");
    expect(d.removed).toHaveLength(0);
  });

  test("detects removed nets", () => {
    const before = extractNets(makePcb(
      [{ id: 1, name: "VCC" }, { id: 2, name: "GND" }],
      [{ ref: "R1", pads: [{ num: "1", net: { id: 2, name: "GND" } }] }],
    ));
    const after = extractNets(makePcb(
      [{ id: 1, name: "VCC" }],
      [{ ref: "R1", pads: [{ num: "1", net: { id: 1, name: "VCC" } }] }],
    ));
    const d = diffNets(before, after);
    expect(d.removed).toContain("GND");
  });

  test("detects pad moving between nets", () => {
    const before = extractNets(makePcb(
      [{ id: 1, name: "VCC" }, { id: 2, name: "GND" }],
      [{
        ref: "R1", pads: [
          { num: "1", net: { id: 1, name: "VCC" } },
          { num: "2", net: { id: 2, name: "GND" } },
        ],
      }],
    ));
    const after = extractNets(makePcb(
      [{ id: 1, name: "VCC" }, { id: 2, name: "GND" }],
      [{
        ref: "R1", pads: [
          { num: "1", net: { id: 1, name: "VCC" } },
          { num: "2", net: { id: 1, name: "VCC" } },
        ],
      }],
    ));
    const d = diffNets(before, after);
    const padChange = d.padChanges.find(p => p.pad === "R1.2");
    expect(padChange).toBeDefined();
    expect(padChange?.before).toBe("GND");
    expect(padChange?.after).toBe("VCC");
  });

  test("reports pad transitions to/from the unconnected net as real changes", () => {
    // Pulling a pad off GND or attaching an NC pad to VCC is an electrical
    // change worth surfacing. Only the *name set* filters out "" (because
    // the unconnected "net" itself churns constantly); pad-level changes
    // involving it must still appear.
    const before = extractNets(makePcb(
      [{ id: 0, name: "" }, { id: 1, name: "VCC" }],
      [{
        ref: "R1", pads: [
          { num: "1", net: { id: 1, name: "VCC" } },
          { num: "2", net: { id: 0, name: "" } },
        ],
      }],
    ));
    const after = extractNets(makePcb(
      [{ id: 0, name: "" }, { id: 1, name: "VCC" }],
      [{
        ref: "R1", pads: [
          { num: "1", net: { id: 0, name: "" } },
          { num: "2", net: { id: 1, name: "VCC" } },
        ],
      }],
    ));
    const d = diffNets(before, after);
    const r1_1 = d.padChanges.find(p => p.pad === "R1.1");
    const r1_2 = d.padChanges.find(p => p.pad === "R1.2");
    expect(r1_1).toMatchObject({ before: "VCC", after: "" });
    expect(r1_2).toMatchObject({ before: "", after: "VCC" });
    // The empty name itself must NOT appear in the added/removed net list —
    // only the *name set* filter survives.
    expect(d.added).not.toContain("");
    expect(d.removed).not.toContain("");
  });

  test("pads on an added/removed footprint are not reported individually", () => {
    const before = extractNets(makePcb(
      [{ id: 1, name: "VCC" }],
      [{ ref: "R1", pads: [{ num: "1", net: { id: 1, name: "VCC" } }] }],
    ));
    const after = extractNets(makePcb(
      [{ id: 1, name: "VCC" }, { id: 2, name: "GND" }],
      [
        { ref: "R1", pads: [{ num: "1", net: { id: 1, name: "VCC" } }] },
        { ref: "R2", pads: [{ num: "1", net: { id: 2, name: "GND" } }] },
      ],
    ));
    // The diff itself reports R2.1 → GND, but the renderer suppresses pad
    // changes that belong to a footprint listed as added/removed. So we test
    // that suppression at the textDiff layer below; here just confirm raw
    // data is present.
    const d = diffNets(before, after);
    expect(d.added).toContain("GND");
  });
});

// =============================================================================
// Output rendering: text + markdown
// =============================================================================

test.describe("textDiff with nets", () => {
  test("net added produces a Nets subsection with a `+ NAME` line", () => {
    const before = makePcb(
      [{ id: 1, name: "VCC" }],
      [{ ref: "R1", pads: [{ num: "1", net: { id: 1, name: "VCC" } }] }],
    );
    const after = makePcb(
      [{ id: 1, name: "VCC" }, { id: 2, name: "/LED_OUT" }],
      [{
        ref: "R1", pads: [
          { num: "1", net: { id: 1, name: "VCC" } },
          { num: "2", net: { id: 2, name: "/LED_OUT" } },
        ],
      }],
    );
    const { text } = diffPcbBodies(before, after);
    expect(text).toMatch(/Nets:/);
    expect(text).toMatch(/\+ \/LED_OUT/);
  });

  test("net removed produces a `- NAME` line under Nets", () => {
    const before = makePcb(
      [{ id: 1, name: "VCC" }, { id: 2, name: "GND" }],
      [{
        ref: "R1", pads: [
          { num: "1", net: { id: 1, name: "VCC" } },
          { num: "2", net: { id: 2, name: "GND" } },
        ],
      }],
    );
    const after = makePcb(
      [{ id: 1, name: "VCC" }],
      [{ ref: "R1", pads: [{ num: "1", net: { id: 1, name: "VCC" } }] }],
    );
    const { text } = diffPcbBodies(before, after);
    expect(text).toMatch(/Nets:/);
    expect(text).toMatch(/- GND/);
  });

  test("pad moved between nets shows `R1.2: GND → VCC` line", () => {
    const before = makePcb(
      [{ id: 1, name: "VCC" }, { id: 2, name: "GND" }],
      [{
        ref: "R1", pads: [
          { num: "1", net: { id: 1, name: "VCC" } },
          { num: "2", net: { id: 2, name: "GND" } },
        ],
      }],
    );
    const after = makePcb(
      [{ id: 1, name: "VCC" }, { id: 2, name: "GND" }],
      [{
        ref: "R1", pads: [
          { num: "1", net: { id: 1, name: "VCC" } },
          { num: "2", net: { id: 1, name: "VCC" } },
        ],
      }],
    );
    const { text } = diffPcbBodies(before, after);
    expect(text).toMatch(/Nets:/);
    expect(text).toMatch(/R1\.2.*GND.*→.*VCC/);
  });

  test("no net changes → no Nets subsection", () => {
    const before = makePcb(
      [{ id: 1, name: "VCC" }],
      [{ ref: "R1", value: "330", pads: [{ num: "1", net: { id: 1, name: "VCC" } }] }],
    );
    // Change only the resistor value — connectivity stays identical.
    const after = makePcb(
      [{ id: 1, name: "VCC" }],
      [{ ref: "R1", value: "470", pads: [{ num: "1", net: { id: 1, name: "VCC" } }] }],
    );
    const { text } = diffPcbBodies(before, after);
    expect(text).not.toMatch(/Nets:/);
    expect(text).toMatch(/value: 330 → 470/);
  });

  test("footprint change and net change appear in the same output", () => {
    const before = makePcb(
      [{ id: 1, name: "VCC" }, { id: 2, name: "GND" }],
      [{
        ref: "R1", value: "330", pads: [
          { num: "1", net: { id: 1, name: "VCC" } },
          { num: "2", net: { id: 2, name: "GND" } },
        ],
      }],
    );
    const after = makePcb(
      [{ id: 1, name: "VCC" }, { id: 2, name: "GND" }, { id: 3, name: "/SIG" }],
      [{
        ref: "R1", value: "470", pads: [
          { num: "1", net: { id: 1, name: "VCC" } },
          { num: "2", net: { id: 3, name: "/SIG" } },
        ],
      }],
    );
    const { text } = diffPcbBodies(before, after);
    expect(text).toMatch(/~\s*R1\s+value: 330 → 470/);
    expect(text).toMatch(/Nets:/);
    expect(text).toMatch(/\+ \/SIG/);
    expect(text).toMatch(/R1\.2.*GND.*→.*\/SIG/);
  });

  test("unconnected net `\"\"` is ignored end-to-end", () => {
    const before = makePcb(
      [{ id: 0, name: "" }, { id: 1, name: "VCC" }],
      [{
        ref: "R1", pads: [
          { num: "1", net: { id: 1, name: "VCC" } },
          { num: "2", net: { id: 0, name: "" } },
        ],
      }],
    );
    // Renumber the empty net to a different id; nothing real changed.
    const after = makePcb(
      [{ id: 0, name: "" }, { id: 1, name: "VCC" }],
      [{
        ref: "R1", pads: [
          { num: "1", net: { id: 1, name: "VCC" } },
          { num: "2", net: { id: 0, name: "" } },
        ],
      }],
    );
    const { text } = diffPcbBodies(before, after);
    expect(text).not.toMatch(/Nets:/);
  });

  test("pad changes on added/removed footprints are not duplicated", () => {
    // R2 is added with a pad on GND. The output should mention R2 once
    // (in the footprint section) but NOT also as an R2.1 pad-move line.
    const before = makePcb(
      [{ id: 1, name: "VCC" }],
      [{ ref: "R1", pads: [{ num: "1", net: { id: 1, name: "VCC" } }] }],
    );
    const after = makePcb(
      [{ id: 1, name: "VCC" }, { id: 2, name: "GND" }],
      [
        { ref: "R1", pads: [{ num: "1", net: { id: 1, name: "VCC" } }] },
        { ref: "R2", pads: [{ num: "1", net: { id: 2, name: "GND" } }] },
      ],
    );
    const { text } = diffPcbBodies(before, after);
    expect(text).toMatch(/\+ R2/);     // footprint-level
    expect(text).not.toMatch(/R2\.1/); // no individual pad line for it
  });
});

// =============================================================================
// KiCad 10 net atom shape: `(net "name")` (no numeric id) + no top-level
// net table. The fixture `examples/mcu-board/mcu-board.kicad_pcb` uses this
// shape; the legacy `(net id "name")` parser silently misses it.
// =============================================================================

test.describe("KiCad 10 net atom shape", () => {
  test("extractNets derives the name set from pad nets when no top-level table exists", () => {
    const src = makePcb(
      [{ id: 1, name: "VCC" }, { id: 2, name: "GND" }],
      [{
        ref: "R1", pads: [
          { num: "1", net: { id: 1, name: "VCC" } },
          { num: "2", net: { id: 2, name: "GND" } },
        ],
      }],
      { kicad10: true },
    );
    const info = extractNets(src);
    expect(info.names.has("VCC")).toBe(true);
    expect(info.names.has("GND")).toBe(true);
    expect(info.padNets.get("R1")?.get("1")).toBe("VCC");
    expect(info.padNets.get("R1")?.get("2")).toBe("GND");
  });

  test("extractNets reads pad net name when atom is `(net \"name\")` (KiCad 10)", () => {
    // Minimal hand-rolled fixture: no top-level table, single footprint
    // with the modern pad-net shape.
    const src = `(kicad_pcb (version 20260206) (generator "pcbnew")
\t(footprint "lib:R"
\t\t(layer "F.Cu")
\t\t(uuid "11111111-1111-1111-1111-111111111111")
\t\t(at 0 0)
\t\t(property "Reference" "R7"
\t\t\t(at 0 -2 0)
\t\t\t(layer "F.SilkS")
\t\t\t(uuid "22222222-2222-2222-2222-222222222222")
\t\t)
\t\t(property "Value" "10k"
\t\t\t(at 0 2 0)
\t\t\t(layer "F.SilkS")
\t\t\t(uuid "33333333-3333-3333-3333-333333333333")
\t\t)
\t\t(pad "1" smd rect
\t\t\t(at 0 0)
\t\t\t(size 1 1)
\t\t\t(layers "F.Cu")
\t\t\t(net "+3V3")
\t\t\t(uuid "44444444-4444-4444-4444-444444444444")
\t\t)
\t)
)
`;
    const info = extractNets(src);
    expect(info.padNets.get("R7")?.get("1")).toBe("+3V3");
    expect(info.names.has("+3V3")).toBe(true);
  });

  test("net diff catches a pad-rewire on a KiCad 10 fixture", () => {
    const before = makePcb(
      [{ id: 1, name: "+3V3" }, { id: 2, name: "GND" }],
      [{
        ref: "R1", pads: [
          { num: "1", net: { id: 1, name: "+3V3" } },
          { num: "2", net: { id: 2, name: "GND" } },
        ],
      }],
      { kicad10: true },
    );
    const after = makePcb(
      [{ id: 1, name: "+3V3" }, { id: 2, name: "GND" }, { id: 3, name: "/LED" }],
      [{
        ref: "R1", pads: [
          { num: "1", net: { id: 1, name: "+3V3" } },
          { num: "2", net: { id: 3, name: "/LED" } },
        ],
      }],
      { kicad10: true },
    );
    const { text } = diffPcbBodies(before, after);
    expect(text).toMatch(/Nets:/);
    expect(text).toMatch(/\+ \/LED/);
    expect(text).toMatch(/- GND/);
    expect(text).toMatch(/R1\.2.*GND.*→.*\/LED/);
  });

  test("real mcu-board fixture: pad rewire is surfaced", () => {
    // Smoke test against the actual KiCad 10 fixture shipped with the repo.
    // Without KiCad-10 atom support, extractNets returns empty sets and this
    // edit goes completely silent.
    const fixtureSrc = fs.readFileSync(
      path.join(PROJECT_DIR, "examples/mcu-board/mcu-board.kicad_pcb"),
      "utf8",
    );
    // Sanity-check the fixture really uses the modern shape (no `(net N "x")`).
    expect(fixtureSrc).toMatch(/\(net "GND"\)/);

    // Rewire the first pad currently on "GND" to "+3V3". This is text-level
    // surgery so we don't have to invoke kicad-cli.
    const edited = fixtureSrc.replace(/\(net "GND"\)/, '(net "+3V3")');
    expect(edited).not.toBe(fixtureSrc);

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kicadiff-mcu-net-"));
    try {
      execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
      const pcbPath = path.join(dir, "mcu-board.kicad_pcb");
      fs.writeFileSync(pcbPath, fixtureSrc);
      execFileSync("git", ["-c", "commit.gpgsign=false", "-c", "user.email=t@t",
        "-c", "user.name=t", "add", "."], { cwd: dir });
      execFileSync("git", ["-c", "commit.gpgsign=false", "-c", "user.email=t@t",
        "-c", "user.name=t", "commit", "-q", "-m", "init"], { cwd: dir });
      fs.writeFileSync(pcbPath, edited);
      const text = textDiff(pcbPath, "HEAD", "", dir);
      expect(text).toMatch(/Nets:/);
      // The pad whose net string we changed should appear in the pad-change list.
      expect(text).toMatch(/GND.*→.*\+3V3/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// =============================================================================
// Pad transitions into/out of the unconnected net are real electrical
// changes; only the *named* unconnected net "" is filtered from the name
// set, never the pad-change lines themselves.
// =============================================================================

test.describe("pad ↔ unconnected transitions", () => {
  test("pad disconnected from a named net (GND → unconnected) is reported", () => {
    const before = extractNets(makePcb(
      [{ id: 0, name: "" }, { id: 1, name: "GND" }],
      [{ ref: "R1", pads: [{ num: "2", net: { id: 1, name: "GND" } }] }],
    ));
    const after = extractNets(makePcb(
      [{ id: 0, name: "" }, { id: 1, name: "GND" }],
      [{ ref: "R1", pads: [{ num: "2", net: { id: 0, name: "" } }] }],
    ));
    const d = diffNets(before, after);
    const change = d.padChanges.find(p => p.pad === "R1.2");
    expect(change).toBeDefined();
    expect(change?.before).toBe("GND");
    expect(change?.after).toBe("");
  });

  test("pad newly connected to a named net (unconnected → +3V3) is reported", () => {
    const before = extractNets(makePcb(
      [{ id: 0, name: "" }, { id: 1, name: "+3V3" }],
      [{ ref: "R7", pads: [{ num: "1", net: { id: 0, name: "" } }] }],
    ));
    const after = extractNets(makePcb(
      [{ id: 0, name: "" }, { id: 1, name: "+3V3" }],
      [{ ref: "R7", pads: [{ num: "1", net: { id: 1, name: "+3V3" } }] }],
    ));
    const d = diffNets(before, after);
    const change = d.padChanges.find(p => p.pad === "R7.1");
    expect(change).toBeDefined();
    expect(change?.before).toBe("");
    expect(change?.after).toBe("+3V3");
  });

  test("named ↔ named rewire still works (regression for the existing behavior)", () => {
    const before = extractNets(makePcb(
      [{ id: 1, name: "VCC" }, { id: 2, name: "GND" }],
      [{ ref: "R1", pads: [{ num: "2", net: { id: 2, name: "GND" } }] }],
    ));
    const after = extractNets(makePcb(
      [{ id: 1, name: "VCC" }, { id: 2, name: "GND" }],
      [{ ref: "R1", pads: [{ num: "2", net: { id: 1, name: "VCC" } }] }],
    ));
    const d = diffNets(before, after);
    expect(d.padChanges).toHaveLength(1);
    expect(d.padChanges[0]).toMatchObject({ pad: "R1.2", before: "GND", after: "VCC" });
  });

  test("name set still excludes \"\" even when present as a pad net", () => {
    const info = extractNets(makePcb(
      [{ id: 0, name: "" }, { id: 1, name: "VCC" }],
      [{
        ref: "R1", pads: [
          { num: "1", net: { id: 1, name: "VCC" } },
          { num: "2", net: { id: 0, name: "" } },
        ],
      }],
      // KiCad 10 path — name set must be derived from pad nets, and "" must
      // still be filtered out so it doesn't appear as a fake added/removed net.
      { kicad10: true },
    ));
    expect(info.names.has("")).toBe(false);
    expect(info.names.has("VCC")).toBe(true);
  });
});

test.describe("markdownDiff with nets", () => {
  test("renders a `### Nets` subsection with backtick-wrapped names", () => {
    const before = makePcb(
      [{ id: 1, name: "VCC" }],
      [{ ref: "R1", pads: [{ num: "1", net: { id: 1, name: "VCC" } }] }],
    );
    const after = makePcb(
      [{ id: 1, name: "VCC" }, { id: 2, name: "/LED_OUT" }],
      [{
        ref: "R1", pads: [
          { num: "1", net: { id: 1, name: "VCC" } },
          { num: "2", net: { id: 2, name: "/LED_OUT" } },
        ],
      }],
    );
    const { md } = diffPcbBodies(before, after);
    expect(md).toMatch(/### Nets/);
    expect(md).toMatch(/`\/LED_OUT`/);
  });

  test("omits the Nets subsection when there are no net-level changes", () => {
    const before = makePcb(
      [{ id: 1, name: "VCC" }],
      [{ ref: "R1", value: "330", pads: [{ num: "1", net: { id: 1, name: "VCC" } }] }],
    );
    const after = makePcb(
      [{ id: 1, name: "VCC" }],
      [{ ref: "R1", value: "470", pads: [{ num: "1", net: { id: 1, name: "VCC" } }] }],
    );
    const { md } = diffPcbBodies(before, after);
    expect(md).not.toMatch(/### Nets/);
  });
});

test.describe("computeFileDiff exposes nets shape", () => {
  test("returns a `nets` field alongside the existing diff", () => {
    const before = makePcb(
      [{ id: 1, name: "VCC" }],
      [{ ref: "R1", pads: [{ num: "1", net: { id: 1, name: "VCC" } }] }],
    );
    const after = makePcb(
      [{ id: 1, name: "VCC" }, { id: 2, name: "GND" }],
      [{
        ref: "R1", pads: [
          { num: "1", net: { id: 1, name: "VCC" } },
          { num: "2", net: { id: 2, name: "GND" } },
        ],
      }],
    );
    const { fd } = diffPcbBodies(before, after);
    // Existing shape preserved
    expect(Array.isArray(fd.diff.added)).toBe(true);
    expect(Array.isArray(fd.diff.removed)).toBe(true);
    expect(Array.isArray(fd.diff.changed)).toBe(true);
    expect(typeof fd.diff.unchanged).toBe("number");
    // New nets field
    expect(fd.nets).toBeDefined();
    expect(fd.nets?.added).toContain("GND");
  });
});

// =============================================================================
// CLI integration: --text-only end-to-end with a real git commit
// =============================================================================

test.describe("--text-only with net changes (CLI)", () => {
  test("includes a Nets subsection when a pad moves between nets", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kicadiff-netdiff-cli-"));
    try {
      const before = makePcb(
        [{ id: 1, name: "VCC" }, { id: 2, name: "GND" }],
        [{
          ref: "R1", value: "330", pads: [
            { num: "1", net: { id: 1, name: "VCC" } },
            { num: "2", net: { id: 2, name: "GND" } },
          ],
        }],
      );
      const after = makePcb(
        [{ id: 1, name: "VCC" }, { id: 2, name: "GND" }, { id: 3, name: "/SIG" }],
        [{
          ref: "R1", value: "330", pads: [
            { num: "1", net: { id: 1, name: "VCC" } },
            { num: "2", net: { id: 3, name: "/SIG" } },
          ],
        }],
      );
      const pcbPath = path.join(tmp, "board.kicad_pcb");
      fs.writeFileSync(pcbPath, before);
      execFileSync("git", ["init", "-q", "-b", "main"], { cwd: tmp });
      execFileSync("git", ["-c", "commit.gpgsign=false", "-c", "user.email=t@t",
        "-c", "user.name=t", "add", "."], { cwd: tmp });
      execFileSync("git", ["-c", "commit.gpgsign=false", "-c", "user.email=t@t",
        "-c", "user.name=t", "commit", "-q", "-m", "init"], { cwd: tmp });
      fs.writeFileSync(pcbPath, after);

      const r = spawnSync(CLI, ["--text-only", "HEAD", pcbPath], {
        cwd: tmp, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
      });
      expect(r.status).toBe(0);
      expect(r.stdout).toMatch(/Nets:/);
      expect(r.stdout).toMatch(/\+ \/SIG/);
      expect(r.stdout).toMatch(/R1\.2.*GND.*→.*\/SIG/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// =============================================================================
// Net name derivation must include ALL non-empty (net ...) memberships on the
// PCB, not just pads. KiCad 10 has no top-level net table and copper objects
// (segments, vias, zones) carry the only authoritative net references for any
// net that doesn't currently land on a pad. If we only scan pads, a net used
// solely on copper is invisible — and a later pad attaching to it shows up as
// a spurious "added net".
// =============================================================================

test.describe("extractNets covers segments / vias / zones (KiCad 10 fallback)", () => {
  test("a net that only appears on a (segment ...) lands in the name set", () => {
    const src = `(kicad_pcb (version 20260206) (generator "pcbnew")
\t(segment
\t\t(start 0 0)
\t\t(end 1 1)
\t\t(width 0.25)
\t\t(layer "F.Cu")
\t\t(net "ONLY_SEGMENT")
\t\t(uuid "11111111-1111-1111-1111-111111111111")
\t)
)
`;
    const info = extractNets(src);
    expect(info.names.has("ONLY_SEGMENT")).toBe(true);
    // padNets stays scoped to pads
    expect(info.padNets.size).toBe(0);
  });

  test("a net that only appears on a (via ...) lands in the name set", () => {
    const src = `(kicad_pcb (version 20260206) (generator "pcbnew")
\t(via
\t\t(at 1 1)
\t\t(size 0.6)
\t\t(drill 0.3)
\t\t(layers "F.Cu" "B.Cu")
\t\t(net "ONLY_VIA")
\t\t(uuid "22222222-2222-2222-2222-222222222222")
\t)
)
`;
    const info = extractNets(src);
    expect(info.names.has("ONLY_VIA")).toBe(true);
    expect(info.padNets.size).toBe(0);
  });

  test("a net that only appears on a (zone ...) lands in the name set", () => {
    const src = `(kicad_pcb (version 20260206) (generator "pcbnew")
\t(zone
\t\t(net 0)
\t\t(net "ONLY_ZONE")
\t\t(layer "F.Cu")
\t\t(polygon (pts (xy 0 0) (xy 10 0) (xy 10 10) (xy 0 10)))
\t)
)
`;
    const info = extractNets(src);
    expect(info.names.has("ONLY_ZONE")).toBe(true);
    expect(info.padNets.size).toBe(0);
  });

  test("bare (net N) reference (e.g. zone (net 0)) is NOT mistaken for a KiCad 10 name", () => {
    // Some zone declarations include a bare `(net 0)` atom — a numeric ID
    // reference, NOT a name. Post-parse (the parser strips quotes) it looks
    // identical to KiCad 10's `(net "0")` would, but the latter would never
    // appear in real files: net names are quoted KiCad strings, and KiCad
    // would never emit a name that's just a bare integer. The old netName
    // logic stringified the numeric ID and added it to the name set,
    // producing fake added/removed nets whenever zone IDs were renumbered.
    const src = `(kicad_pcb (version 20260206) (generator "pcbnew")
\t(zone
\t\t(net 0)
\t\t(layer "F.Cu")
\t)
\t(zone
\t\t(net 1)
\t\t(layer "F.Cu")
\t)
\t(footprint "lib:R"
\t\t(layer "F.Cu")
\t\t(uuid "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa")
\t\t(at 0 0)
\t\t(property "Reference" "R1"
\t\t\t(at 0 -2 0)
\t\t\t(layer "F.SilkS")
\t\t\t(uuid "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb")
\t\t)
\t\t(property "Value" "10k"
\t\t\t(at 0 2 0)
\t\t\t(layer "F.SilkS")
\t\t\t(uuid "cccccccc-cccc-cccc-cccc-cccccccccccc")
\t\t)
\t\t(pad "1" smd rect
\t\t\t(at 0 0)
\t\t\t(size 1 1)
\t\t\t(layers "F.Cu")
\t\t\t(net "GND")
\t\t\t(uuid "dddddddd-dddd-dddd-dddd-dddddddddddd")
\t\t)
\t)
)
`;
    const info = extractNets(src);
    // Real net name appears as expected.
    expect(info.names.has("GND")).toBe(true);
    // Bare numeric ID references must NOT pollute the name set.
    expect(info.names.has("0")).toBe(false);
    expect(info.names.has("1")).toBe(false);
  });

  test("legacy (net 0 \"\") (unconnected) is still excluded by the empty-name filter", () => {
    // Regression: the bare-ID fix must not break the legacy 3-atom path.
    // `(net 0 "")` is the unconnected net (id 0, empty quoted name) and
    // gets filtered by the existing `name !== ""` check, not by the new
    // numeric-only check (which only applies to the 2-atom shape).
    const src = makePcb(
      [{ id: 0, name: "" }, { id: 1, name: "VCC" }],
      [{ ref: "R1", pads: [{ num: "1", net: { id: 1, name: "VCC" } }] }],
    );
    const info = extractNets(src);
    expect(info.names.has("")).toBe(false);
    expect(info.names.has("0")).toBe(false);
    expect(info.names.has("VCC")).toBe(true);
  });

  test("legacy (net 1 \"VCC\") is still parsed as VCC (3-atom regression)", () => {
    const src = makePcb(
      [{ id: 1, name: "VCC" }],
      [{ ref: "R1", pads: [{ num: "1", net: { id: 1, name: "VCC" } }] }],
    );
    const info = extractNets(src);
    expect(info.names.has("VCC")).toBe(true);
    expect(info.names.has("1")).toBe(false);
  });

  test("KiCad 10 (net \"GND\") (quoted name) is still parsed as GND", () => {
    // The 2-atom name shape must continue to work — only numeric-only
    // atoms in the 2-atom shape are skipped.
    const src = `(kicad_pcb (version 20260206) (generator "pcbnew")
\t(zone
\t\t(net "GND")
\t\t(layer "F.Cu")
\t)
)
`;
    const info = extractNets(src);
    expect(info.names.has("GND")).toBe(true);
  });

  test("real mcu-board fixture: every name appearing in any (net \"X\") atom is captured", () => {
    const fixtureSrc = fs.readFileSync(
      path.join(PROJECT_DIR, "examples/mcu-board/mcu-board.kicad_pcb"),
      "utf8",
    );
    const info = extractNets(fixtureSrc);
    // Grep the fixture and confirm the name set matches: every distinct
    // `(net "X")` value (except "") should be present.
    const matches = Array.from(fixtureSrc.matchAll(/\(net "([^"]*)"\)/g));
    const expected = new Set<string>();
    for (const m of matches) {
      if (m[1] !== "") expected.add(m[1]);
    }
    expect(expected.size).toBeGreaterThan(0);
    for (const name of expected) {
      expect(info.names.has(name)).toBe(true);
    }
    // And the inverse: nothing in info.names that isn't actually in the file.
    for (const n of info.names) {
      expect(expected.has(n)).toBe(true);
    }
  });

  test("net used only on copper is NOT reported as added when a pad later attaches", () => {
    // before: net "RAILS" exists on a (segment ...) only, no pad.
    // after : the same net "RAILS" is now also on R1.1.
    // The user-observable rule: this should NOT show up as `+ RAILS` in the
    // diff, because the net already existed in `before` (just not on a pad).
    const before = `(kicad_pcb (version 20260206) (generator "pcbnew")
\t(footprint "lib:R"
\t\t(layer "F.Cu")
\t\t(uuid "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa")
\t\t(at 0 0)
\t\t(property "Reference" "R1"
\t\t\t(at 0 -2 0)
\t\t\t(layer "F.SilkS")
\t\t\t(uuid "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb")
\t\t)
\t\t(property "Value" "10k"
\t\t\t(at 0 2 0)
\t\t\t(layer "F.SilkS")
\t\t\t(uuid "cccccccc-cccc-cccc-cccc-cccccccccccc")
\t\t)
\t\t(pad "1" smd rect
\t\t\t(at 0 0)
\t\t\t(size 1 1)
\t\t\t(layers "F.Cu")
\t\t\t(uuid "dddddddd-dddd-dddd-dddd-dddddddddddd")
\t\t)
\t)
\t(segment
\t\t(start 0 0)
\t\t(end 1 1)
\t\t(width 0.25)
\t\t(layer "F.Cu")
\t\t(net "RAILS")
\t\t(uuid "11111111-1111-1111-1111-111111111111")
\t)
)
`;
    const after = `(kicad_pcb (version 20260206) (generator "pcbnew")
\t(footprint "lib:R"
\t\t(layer "F.Cu")
\t\t(uuid "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa")
\t\t(at 0 0)
\t\t(property "Reference" "R1"
\t\t\t(at 0 -2 0)
\t\t\t(layer "F.SilkS")
\t\t\t(uuid "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb")
\t\t)
\t\t(property "Value" "10k"
\t\t\t(at 0 2 0)
\t\t\t(layer "F.SilkS")
\t\t\t(uuid "cccccccc-cccc-cccc-cccc-cccccccccccc")
\t\t)
\t\t(pad "1" smd rect
\t\t\t(at 0 0)
\t\t\t(size 1 1)
\t\t\t(layers "F.Cu")
\t\t\t(net "RAILS")
\t\t\t(uuid "dddddddd-dddd-dddd-dddd-dddddddddddd")
\t\t)
\t)
\t(segment
\t\t(start 0 0)
\t\t(end 1 1)
\t\t(width 0.25)
\t\t(layer "F.Cu")
\t\t(net "RAILS")
\t\t(uuid "11111111-1111-1111-1111-111111111111")
\t)
)
`;
    const { fd } = diffPcbBodies(before, after);
    expect(fd.nets?.added ?? []).not.toContain("RAILS");
    expect(fd.nets?.removed ?? []).not.toContain("RAILS");
  });
});

// =============================================================================
// Pad key collision: the previous "${ref}.${padNum}" single-string key is
// ambiguous because both ref and padNum are quoted KiCad strings and can
// contain dots. Structured keys (ref + padNum stored separately) avoid the
// collision and remove the need to recover the ref by split('.').
// =============================================================================

test.describe("pad identity keeps ref and padNum separate", () => {
  test("ref containing a dot does not collide with a different ref + dotted pad", () => {
    // Hand-built fixture with two footprints whose stringified "ref.padNum"
    // would collide under the old keying scheme:
    //   ref="U1.A", padNum="1"  →  "U1.A.1"
    //   ref="U1",   padNum="A.1" → "U1.A.1"
    // They are *different* physical pads on different parts, on different
    // nets, and must be reported independently.
    const src = `(kicad_pcb (version 20260206) (generator "pcbnew")
\t(footprint "lib:R"
\t\t(layer "F.Cu")
\t\t(uuid "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa")
\t\t(at 0 0)
\t\t(property "Reference" "U1.A"
\t\t\t(at 0 -2 0)
\t\t\t(layer "F.SilkS")
\t\t\t(uuid "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb")
\t\t)
\t\t(property "Value" "x"
\t\t\t(at 0 2 0)
\t\t\t(layer "F.SilkS")
\t\t\t(uuid "cccccccc-cccc-cccc-cccc-cccccccccccc")
\t\t)
\t\t(pad "1" smd rect
\t\t\t(at 0 0)
\t\t\t(size 1 1)
\t\t\t(layers "F.Cu")
\t\t\t(net "NET_A")
\t\t\t(uuid "dddddddd-dddd-dddd-dddd-dddddddddddd")
\t\t)
\t)
\t(footprint "lib:R"
\t\t(layer "F.Cu")
\t\t(uuid "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee")
\t\t(at 10 10)
\t\t(property "Reference" "U1"
\t\t\t(at 0 -2 0)
\t\t\t(layer "F.SilkS")
\t\t\t(uuid "ffffffff-ffff-ffff-ffff-ffffffffffff")
\t\t)
\t\t(property "Value" "y"
\t\t\t(at 0 2 0)
\t\t\t(layer "F.SilkS")
\t\t\t(uuid "11112222-3333-4444-5555-666677778888")
\t\t)
\t\t(pad "A.1" smd rect
\t\t\t(at 0 0)
\t\t\t(size 1 1)
\t\t\t(layers "F.Cu")
\t\t\t(net "NET_B")
\t\t\t(uuid "99990000-aaaa-bbbb-cccc-dddddddddddd")
\t\t)
\t)
)
`;
    const info = extractNets(src);
    // Both pads must be present with their own net assignment. Under the
    // old "U1.A.1" single-key scheme one of them silently overwrote the
    // other (whichever came second).
    expect(info.padNets.get("U1.A")?.get("1")).toBe("NET_A");
    expect(info.padNets.get("U1")?.get("A.1")).toBe("NET_B");
    // Two distinct outer keys — different refs do not collide.
    expect(info.padNets.size).toBe(2);
  });

  test("suppression of pad-changes for added footprints handles dotted refs", () => {
    // R1.A is "added" in after (existed nowhere in before). Under the old
    // split(".")[0] suppression, the recovered ref would be "R1", not
    // "R1.A", so the suppression wouldn't match — and a pad-change line
    // for R1.A.1 would leak through alongside the footprint-level `+ R1.A`.
    const before = `(kicad_pcb (version 20260206) (generator "pcbnew")
)
`;
    const after = `(kicad_pcb (version 20260206) (generator "pcbnew")
\t(footprint "lib:R"
\t\t(layer "F.Cu")
\t\t(uuid "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa")
\t\t(at 0 0)
\t\t(property "Reference" "R1.A"
\t\t\t(at 0 -2 0)
\t\t\t(layer "F.SilkS")
\t\t\t(uuid "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb")
\t\t)
\t\t(property "Value" "10k"
\t\t\t(at 0 2 0)
\t\t\t(layer "F.SilkS")
\t\t\t(uuid "cccccccc-cccc-cccc-cccc-cccccccccccc")
\t\t)
\t\t(pad "1" smd rect
\t\t\t(at 0 0)
\t\t\t(size 1 1)
\t\t\t(layers "F.Cu")
\t\t\t(net "VCC")
\t\t\t(uuid "dddddddd-dddd-dddd-dddd-dddddddddddd")
\t\t)
\t)
)
`;
    const { text, fd } = diffPcbBodies(before, after);
    // Footprint-level line must appear once
    expect(text).toMatch(/\+ R1\.A/);
    // No raw pad-change line for the freshly added footprint should leak
    // through. After suppression, the Nets pad-change list should be empty
    // for this pad regardless of the rendering format.
    const padChanges = fd.nets?.padChanges ?? [];
    const leaked = padChanges.find(p =>
      // Old behaviour: "R1.A.1" or any key starting with R1.A. New behaviour:
      // the structured shape exposes the ref separately, but the renderer
      // still flattens it to a display string. Either way: there must be
      // *no* pad-change entry for the added footprint.
      (typeof p.pad === "string" && p.pad.startsWith("R1.A")));
    expect(leaked).toBeUndefined();
  });
});
