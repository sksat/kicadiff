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
 *  (it only walks `(net ...)` and `(footprint ...)`). */
function makePcb(
  nets: Array<{ id: number; name: string }>,
  footprints: Array<{
    ref: string;
    value?: string;
    libId?: string;
    pads: Array<{ num: string; net: { id: number; name: string } | null }>;
  }>,
): string {
  const netLines = nets.map(n => `\t(net ${n.id} "${n.name}")`).join("\n");
  const fpLines = footprints.map((fp, fpi) => {
    const lib = fp.libId ?? "lib:R";
    const ref = fp.ref;
    const value = fp.value ?? "1k";
    const uuid = `00000000-0000-0000-0000-${String(fpi).padStart(12, "0")}`;
    const padLines = fp.pads.map((p, pi) => {
      const padUuid = `11111111-1111-1111-${String(fpi).padStart(4, "0")}-${String(pi).padStart(12, "0")}`;
      const netSexp = p.net ? `\n\t\t\t(net ${p.net.id} "${p.net.name}")` : "";
      return `\t\t(pad "${p.num}" smd rect\n\t\t\t(at 0 0)\n\t\t\t(size 1 1)\n\t\t\t(layers "F.Cu")${netSexp}\n\t\t\t(uuid "${padUuid}")\n\t\t)`;
    }).join("\n");
    return `\t(footprint "${lib}"\n\t\t(layer "F.Cu")\n\t\t(uuid "${uuid}")\n\t\t(at 100 100)\n\t\t(property "Reference" "${ref}"\n\t\t\t(at 0 -2 0)\n\t\t\t(layer "F.SilkS")\n\t\t\t(uuid "${uuid.replace(/0$/, "a")}")\n\t\t\t(effects (font (size 1 1)))\n\t\t)\n\t\t(property "Value" "${value}"\n\t\t\t(at 0 2 0)\n\t\t\t(layer "F.SilkS")\n\t\t\t(uuid "${uuid.replace(/0$/, "b")}")\n\t\t\t(effects (font (size 1 1)))\n\t\t)\n${padLines}\n\t)`;
  }).join("\n");
  return `(kicad_pcb (version 20240108) (generator "test")\n${netLines}\n${fpLines}\n)\n`;
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
    expect(info.padNets.get("R1.1")).toBe("VCC");
    expect(info.padNets.get("R1.2")).toBe("GND");
  });

  test("pads with no net stay out of the pad map", () => {
    const src = makePcb(
      [{ id: 0, name: "" }, { id: 1, name: "VCC" }],
      [{ ref: "R1", pads: [{ num: "1", net: null }] }],
    );
    const info = extractNets(src);
    expect(info.padNets.has("R1.1")).toBe(false);
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

  test("ignores pad churn on the unconnected net", () => {
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
    // Moving a pad from "" → VCC counts (gaining a real connection); but moves
    // *to* "" are silently dropped (unconnected churn). Either way nothing
    // involving the empty net name should appear as a named-net entry.
    for (const p of d.padChanges) {
      expect(p.before).not.toBe("");
      expect(p.after).not.toBe("");
    }
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
