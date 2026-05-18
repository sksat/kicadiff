import { test, expect } from "@playwright/test";
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Integration tests for the kicadiff CLI.
 * These spawn the actual CLI and inspect the generated files.
 * Migrated from test/render.test.sh.
 */

const PROJECT_DIR = path.resolve(__dirname, "..");
const CLI = path.join(PROJECT_DIR, "kicadiff");
// Self-contained fixtures inside kicadiff/ so tests don't depend on
// anything outside the project — the directory is intended to be split
// out into its own repository at some point.
const PROJECT_FIXTURE_DIR = path.join(PROJECT_DIR, "examples/blink");
const PCB_FILE = path.join(PROJECT_FIXTURE_DIR, "blink.kicad_pcb");
const SCH_FILE = path.join(PROJECT_FIXTURE_DIR, "blink.kicad_sch");
const PRO_FILE = path.join(PROJECT_FIXTURE_DIR, "blink.kicad_pro");
// safe names mirror the production safeName(): repo-relative path with
// non-[a-zA-Z0-9._-] replaced by `_`. We compute these dynamically
// because the prefix differs depending on whether kicadiff sits inside
// a parent repo (e.g. `kicadiff_examples_...`) or has been extracted to
// its own repo (`examples_...`).
const _gitTopLevel = execFileSync(
  "git", ["-C", PROJECT_FIXTURE_DIR, "rev-parse", "--show-toplevel"],
  { encoding: "utf8" },
).trim();
const _toSafe = (abs: string) => path.relative(_gitTopLevel, abs).replace(/[^a-zA-Z0-9._-]/g, "_");
const SAFE_PCB = _toSafe(PCB_FILE);
const SAFE_SCH = _toSafe(SCH_FILE);
const PROJECT_HTML = "blink_diff.html"; // combined HTML name from projectSafeName

/** Run kicadiff CLI from PROJECT_DIR (the kicadiff/ directory), so paths
 *  in the test stay inside the project tree. */
function runCli(
  args: string[],
  options: { allowFailure?: boolean; env?: NodeJS.ProcessEnv; input?: string } = {},
): { status: number; stderr: string } {
  const r = spawnSync(CLI, args, {
    cwd: PROJECT_DIR,
    encoding: "utf8",
    // When `input` is provided, spawnSync attaches a writable stdin pipe
    // automatically; otherwise stdin is closed.
    stdio: options.input !== undefined
      ? ["pipe", "pipe", "pipe"]
      : ["ignore", "pipe", "pipe"],
    env: options.env ?? process.env,
    input: options.input,
  });
  const status = r.status ?? 1;
  if (!options.allowFailure && status !== 0) {
    throw new Error(`kicadiff failed (${status}): ${r.stderr}`);
  }
  return { status, stderr: r.stderr ?? "" };
}

/** Create a mock "opener" script that records its argv to a log file.
 *  Returns the script path and the log path. */
function makeOpenerMock(dir: string): { script: string; log: string } {
  const log = path.join(dir, "open.log");
  const script = path.join(dir, "fake-opener.sh");
  fs.writeFileSync(script, `#!/bin/sh\nprintf '%s\\n' "$1" >> "${log}"\n`);
  fs.chmodSync(script, 0o755);
  return { script, log };
}

/** Read the manifest JSON injected into a generated diff HTML. */
function readManifest(htmlPath: string): unknown {
  const html = fs.readFileSync(htmlPath, "utf8");
  // Match: <script>window.MANIFEST = {...};</script>
  const m = html.match(/window\.MANIFEST = (\{.*?\});<\/script>/);
  if (!m) throw new Error("manifest not found in HTML");
  return JSON.parse(m[1]);
}

let outputDir: string;

test.beforeAll(() => {
  // Skip the entire suite if the source PCB isn't available
  if (!fs.existsSync(PCB_FILE)) test.skip(true, `KiCad fixture missing: ${PCB_FILE}`);
});

test.beforeEach(() => {
  outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "kicadiff-test-"));
});

test.afterEach(() => {
  fs.rmSync(outputDir, { recursive: true, force: true });
});

// =============================================================================
// PCB rendering
// =============================================================================

test.describe("PCB rendering", () => {
  test("generates combined PNG with non-zero size", () => {
    runCli([PCB_FILE, "--output-dir", outputDir]);
    const png = path.join(outputDir, `after/${SAFE_PCB}.png`);
    expect(fs.existsSync(png)).toBe(true);
    expect(fs.statSync(png).size).toBeGreaterThan(0);
  });

  test("generates per-layer PNGs for all 5 layers", () => {
    runCli([PCB_FILE, "--output-dir", outputDir]);
    const layersDir = path.join(outputDir, `after/layers_${SAFE_PCB}`);
    const expected = ["F_Cu", "B_Cu", "F_Silkscreen", "B_Silkscreen", "Edge_Cuts"];
    for (const layer of expected) {
      const found = fs.readdirSync(layersDir).find(f => f.endsWith(`-${layer}.png`));
      expect(found, `missing layer ${layer}`).toBeTruthy();
    }
  });

  test("layer PNGs have consistent dimensions and RGBA mode", () => {
    runCli([PCB_FILE, "--output-dir", outputDir]);
    const layersDir = path.join(outputDir, `after/layers_${SAFE_PCB}`);
    const pngs = fs.readdirSync(layersDir).filter(f => f.endsWith(".png"));

    const infos = pngs.map(f => {
      const out = execFileSync("python3", [
        "-c",
        "import sys;from PIL import Image;img=Image.open(sys.argv[1]);print(f'{img.size[0]}x{img.size[1]} {img.mode}')",
        path.join(layersDir, f),
      ], { encoding: "utf8" }).trim();
      return out;
    });

    expect(new Set(infos).size).toBe(1);          // all identical
    expect(infos[0]).toMatch(/RGBA/);              // transparent
  });

  test("generates before image and identical layer PNGs (file unchanged)", () => {
    runCli([PCB_FILE, "--output-dir", outputDir]);
    const beforePng = path.join(outputDir, `before/${SAFE_PCB}.png`);
    expect(fs.existsSync(beforePng)).toBe(true);

    // For an unchanged file, before/after layer PNGs should be byte-identical
    const afterDir = path.join(outputDir, `after/layers_${SAFE_PCB}`);
    const beforeDir = path.join(outputDir, `before/layers_${SAFE_PCB}`);

    for (const f of fs.readdirSync(afterDir).filter(x => x.endsWith(".png"))) {
      const layer = f.split("-").pop();
      const beforeMatch = fs.readdirSync(beforeDir).find(x => x.endsWith(`-${layer}`));
      expect(beforeMatch, `no before match for ${layer}`).toBeTruthy();
      const a = fs.readFileSync(path.join(afterDir, f));
      const b = fs.readFileSync(path.join(beforeDir, beforeMatch!));
      expect(a.equals(b)).toBe(true);
    }
  });

  test("generates per-side diff highlight PNGs", () => {
    // The diff overlay is split per side: deletes go on the before-side
    // PNG (so removed content lights up where it used to be) and adds /
    // changes go on the after-side PNG.
    runCli([PCB_FILE, "--output-dir", outputDir]);
    expect(fs.existsSync(path.join(outputDir, `diff/${SAFE_PCB}-before.png`))).toBe(true);
    expect(fs.existsSync(path.join(outputDir, `diff/${SAFE_PCB}-after.png`))).toBe(true);
  });
});

// =============================================================================
// HTML and manifest
// =============================================================================

test.describe("HTML output", () => {
  test("generates diff HTML that contains MANIFEST and viewer content", () => {
    runCli([PCB_FILE, "--output-dir", outputDir]);
    const htmlPath = path.join(outputDir, PROJECT_HTML);
    expect(fs.existsSync(htmlPath)).toBe(true);
    const html = fs.readFileSync(htmlPath, "utf8");
    expect(html).toContain("window.MANIFEST");
    expect(html).toContain("KiCad Diff");
  });

  test("manifest has required keys for PCB", () => {
    runCli(["pcb", PCB_FILE, "--output-dir", outputDir]);
    const m = readManifest(path.join(outputDir, PROJECT_HTML)) as any;
    expect(m.files).toHaveLength(1);
    const pcb = m.files[0];
    expect(pcb.file).toBeTruthy();
    expect(pcb.type).toBe("pcb");
    expect(pcb.hasBefore).toBe(true);
    expect(pcb.after?.combined).toBeTruthy();
    expect(Object.keys(pcb.after?.layers ?? {})).toHaveLength(5);
    expect(pcb.before?.combined).toBeTruthy();
    expect(Object.keys(pcb.before?.layers ?? {})).toHaveLength(5);
    expect(pcb.diff).toBeTruthy();
  });

  test("manifest references .svg for combined and per-layer images", () => {
    // The viewer needs vector sources so users can zoom indefinitely. The
    // diff overlay (M.diff) stays PNG since it's a rasterised tri-colour
    // mask, but every "live" image (combined, layers, sch pages, sym/fp
    // items) must be served as SVG.
    runCli(["pcb", PCB_FILE, "--output-dir", outputDir]);
    const m = readManifest(path.join(outputDir, PROJECT_HTML)) as any;
    const pcb = m.files[0];
    expect(pcb.after.combined).toMatch(/\.svg$/);
    expect(pcb.before.combined).toMatch(/\.svg$/);
    for (const v of Object.values(pcb.after.layers as Record<string, string>)) {
      expect(v).toMatch(/\.svg$/);
    }
    for (const v of Object.values(pcb.before.layers as Record<string, string>)) {
      expect(v).toMatch(/\.svg$/);
    }
    // Diff highlight overlay stays PNG, split per side (delete on before,
    // add+change on after).
    expect(pcb.diff.before).toMatch(/\.png$/);
    expect(pcb.diff.after).toMatch(/\.png$/);
  });

  test("manifest references .svg for schematic combined and pages", () => {
    runCli(["sch", SCH_FILE, "--output-dir", outputDir]);
    const m = readManifest(path.join(outputDir, PROJECT_HTML)) as any;
    const sch = m.files[0];
    expect(sch.after.combined).toMatch(/\.svg$/);
    if (sch.after.pages) {
      for (const p of sch.after.pages) expect(p.image).toMatch(/\.svg$/);
    }
  });
});

// =============================================================================
// CLI behavior
// =============================================================================

test.describe("CLI argument handling", () => {
  test("rejects non-KiCad files", () => {
    const tmp = path.join(outputDir, "not-kicad.txt");
    fs.writeFileSync(tmp, "");
    const r = runCli([tmp, "--output-dir", outputDir], { allowFailure: true });
    expect(r.status).not.toBe(0);
  });

  test("respects --output-dir", () => {
    const customDir = fs.mkdtempSync(path.join(os.tmpdir(), "kicadiff-custom-"));
    try {
      runCli([PCB_FILE, "--output-dir", customDir]);
      expect(fs.existsSync(path.join(customDir, PROJECT_HTML))).toBe(true);
    } finally {
      fs.rmSync(customDir, { recursive: true, force: true });
    }
  });

  test("pcb subcommand rejects .kicad_sch files", () => {
    if (!fs.existsSync(SCH_FILE)) test.skip();
    const r = runCli(["pcb", SCH_FILE, "--output-dir", outputDir], { allowFailure: true });
    expect(r.status).not.toBe(0);
  });

  test("sch subcommand rejects .kicad_pcb files", () => {
    const r = runCli(["sch", PCB_FILE, "--output-dir", outputDir], { allowFailure: true });
    expect(r.status).not.toBe(0);
  });

  test("`schematic` is an alias for `sch`", () => {
    if (!fs.existsSync(SCH_FILE)) test.skip();
    runCli(["schematic", SCH_FILE, "--output-dir", outputDir]);
    expect(fs.existsSync(path.join(outputDir, `after/${SAFE_SCH}.png`))).toBe(true);
  });

  test("`schematic` alias rejects .kicad_pcb", () => {
    const r = runCli(["schematic", PCB_FILE, "--output-dir", outputDir], { allowFailure: true });
    expect(r.status).not.toBe(0);
  });

  test("--images-only skips HTML generation", () => {
    runCli([PCB_FILE, "--output-dir", outputDir, "--images-only"]);
    expect(fs.existsSync(path.join(outputDir, `after/${SAFE_PCB}.png`))).toBe(true);
    expect(fs.existsSync(path.join(outputDir, PROJECT_HTML))).toBe(false);
  });
});

// =============================================================================
// Schematic rendering
// =============================================================================

test.describe("Schematic rendering", () => {
  test("generates combined PNG and HTML with type=sch", () => {
    if (!fs.existsSync(SCH_FILE)) test.skip();
    runCli(["sch", SCH_FILE, "--output-dir", outputDir]);

    const png = path.join(outputDir, `after/${SAFE_SCH}.png`);
    const html = path.join(outputDir, PROJECT_HTML);
    expect(fs.existsSync(png)).toBe(true);
    expect(fs.statSync(png).size).toBeGreaterThan(0);
    expect(fs.existsSync(html)).toBe(true);

    const m = readManifest(html) as any;
    expect(m.files[0].type).toBe("sch");
  });
});

// =============================================================================
// Git ref handling (--from / --to)
// =============================================================================

test.describe("Git ref handling", () => {
  test("--from HEAD --to working tree (default) works", () => {
    runCli([PCB_FILE, "--output-dir", outputDir]);
    expect(fs.existsSync(path.join(outputDir, `before/${SAFE_PCB}.png`))).toBe(true);
    expect(fs.existsSync(path.join(outputDir, `after/${SAFE_PCB}.png`))).toBe(true);
  });

  test("explicit --from HEAD produces same result as default", () => {
    runCli([PCB_FILE, "--from", "HEAD", "--output-dir", outputDir]);
    const m = readManifest(path.join(outputDir, PROJECT_HTML)) as any;
    expect(m.files.every((f: any) => f.hasBefore === true)).toBe(true);
  });
});

// =============================================================================
// git diff-compatible positional ref syntax
// =============================================================================

test.describe("git diff compatible CLI", () => {
  test("single positional ref: `kicadiff <ref> <file>`", () => {
    runCli(["HEAD", PCB_FILE, "--output-dir", outputDir]);
    const m = readManifest(path.join(outputDir, PROJECT_HTML)) as any;
    expect(m.files.every((f: any) => f.hasBefore === true)).toBe(true);
  });

  test("two positional refs: `kicadiff <r1> <r2> <file>`", () => {
    runCli(["HEAD", "HEAD", PCB_FILE, "--output-dir", outputDir]);
    const m = readManifest(path.join(outputDir, PROJECT_HTML)) as any;
    // Both sides rendered from HEAD — should match
    expect(m.files.every((f: any) => f.hasBefore === true)).toBe(true);
  });

  test("`..` range syntax: `kicadiff <r1>..<r2> <file>`", () => {
    runCli(["HEAD..HEAD", PCB_FILE, "--output-dir", outputDir]);
    const m = readManifest(path.join(outputDir, PROJECT_HTML)) as any;
    expect(m.files.every((f: any) => f.hasBefore === true)).toBe(true);
  });

  test("`--` separator: `kicadiff <ref> -- <file>`", () => {
    // Flags must come before `--` (everything after `--` is a path)
    runCli(["--output-dir", outputDir, "HEAD", "--", PCB_FILE]);
    const m = readManifest(path.join(outputDir, PROJECT_HTML)) as any;
    expect(m.files.every((f: any) => f.hasBefore === true)).toBe(true);
  });

  test("rejects three positional refs", () => {
    const r = runCli(
      ["HEAD", "HEAD", "HEAD", PCB_FILE, "--output-dir", outputDir],
      { allowFailure: true },
    );
    expect(r.status).not.toBe(0);
  });

  test("rejects bad ref", () => {
    const r = runCli(
      ["this-ref-does-not-exist", PCB_FILE, "--output-dir", outputDir],
      { allowFailure: true },
    );
    expect(r.status).not.toBe(0);
  });
});

// =============================================================================
// --open flag and KICADIFF_OPEN_CMD mock
// =============================================================================

test.describe("auto-open behavior", () => {
  test("default: no open command is invoked", () => {
    const { script, log } = makeOpenerMock(outputDir);
    runCli([PCB_FILE, "--output-dir", outputDir], {
      env: { ...process.env, KICADIFF_OPEN_CMD: script },
    });
    // Without --open, the command should never run regardless of env
    expect(fs.existsSync(log)).toBe(false);
  });

  test("--open invokes the configured opener", () => {
    const { script, log } = makeOpenerMock(outputDir);
    runCli([PCB_FILE, "--output-dir", outputDir, "--open"], {
      env: { ...process.env, KICADIFF_OPEN_CMD: script },
    });
    expect(fs.existsSync(log)).toBe(true);
    expect(fs.readFileSync(log, "utf8")).toContain(PROJECT_HTML);
  });

  test("--open vscode is parsed as a known target", () => {
    const { script, log } = makeOpenerMock(outputDir);
    runCli([PCB_FILE, "--output-dir", outputDir, "--open", "vscode"], {
      env: { ...process.env, KICADIFF_OPEN_CMD: script },
    });
    expect(fs.existsSync(log)).toBe(true);
  });

  test("--open=<cmd> accepts arbitrary command via `=` syntax", () => {
    const { script, log } = makeOpenerMock(outputDir);
    // Explicitly clear KICADIFF_OPEN_CMD (which global-setup sets to "" as a
    // safety default) so that the CLI's --open=<cmd> resolution kicks in.
    const env = { ...process.env };
    delete env.KICADIFF_OPEN_CMD;
    runCli([PCB_FILE, "--output-dir", outputDir, `--open=${script}`], { env });
    expect(fs.existsSync(log)).toBe(true);
  });

  test("KICADIFF_OPEN_CMD='' suppresses open even with --open", () => {
    const log = path.join(outputDir, "open.log");
    runCli([PCB_FILE, "--output-dir", outputDir, "--open"], {
      env: { ...process.env, KICADIFF_OPEN_CMD: "" },
    });
    expect(fs.existsSync(log)).toBe(false);
  });

  test("--images-only does not produce HTML or trigger open", () => {
    const { script, log } = makeOpenerMock(outputDir);
    runCli([PCB_FILE, "--output-dir", outputDir, "--open", "--images-only"], {
      env: { ...process.env, KICADIFF_OPEN_CMD: script },
    });
    expect(fs.existsSync(log)).toBe(false);
    expect(fs.existsSync(path.join(outputDir, PROJECT_HTML))).toBe(false);
  });
});

// =============================================================================
// Combined mode: render both PCB and schematic together when no subcommand
// =============================================================================

test.describe("combined PCB + schematic", () => {
  test("project directory input renders both files", () => {
    runCli([PROJECT_FIXTURE_DIR, "--output-dir", outputDir]);
    expect(fs.existsSync(path.join(outputDir, `after/${SAFE_PCB}.png`))).toBe(true);
    expect(fs.existsSync(path.join(outputDir, `after/${SAFE_SCH}.png`))).toBe(true);
  });

  test("`.kicad_pro` input renders both siblings", () => {
    if (!fs.existsSync(PRO_FILE)) test.skip();
    runCli([PRO_FILE, "--output-dir", outputDir]);
    expect(fs.existsSync(path.join(outputDir, `after/${SAFE_PCB}.png`))).toBe(true);
    expect(fs.existsSync(path.join(outputDir, `after/${SAFE_SCH}.png`))).toBe(true);
  });

  test("single .kicad_pcb auto-includes sibling .kicad_sch", () => {
    runCli([PCB_FILE, "--output-dir", outputDir]);
    expect(fs.existsSync(path.join(outputDir, `after/${SAFE_PCB}.png`))).toBe(true);
    expect(fs.existsSync(path.join(outputDir, `after/${SAFE_SCH}.png`))).toBe(true);
  });

  test("`pcb` subcommand scopes to PCB only (no sch rendered)", () => {
    runCli(["pcb", PCB_FILE, "--output-dir", outputDir]);
    expect(fs.existsSync(path.join(outputDir, `after/${SAFE_PCB}.png`))).toBe(true);
    expect(fs.existsSync(path.join(outputDir, `after/${SAFE_SCH}.png`))).toBe(false);
  });

  test("`sch` subcommand scopes to schematic only (no pcb rendered)", () => {
    runCli(["sch", SCH_FILE, "--output-dir", outputDir]);
    expect(fs.existsSync(path.join(outputDir, `after/${SAFE_SCH}.png`))).toBe(true);
    expect(fs.existsSync(path.join(outputDir, `after/${SAFE_PCB}.png`))).toBe(false);
  });

  test("combined HTML manifest contains files array with both entries", () => {
    runCli([PROJECT_FIXTURE_DIR, "--output-dir", outputDir]);
    // Find any *_diff.html in the output (project-level entry)
    const htmls = fs.readdirSync(outputDir).filter(f => f.endsWith("_diff.html"));
    expect(htmls.length).toBeGreaterThan(0);
    const html = fs.readFileSync(path.join(outputDir, htmls[0]), "utf8");
    const m = html.match(/window\.MANIFEST = (\{.*?\});<\/script>/);
    expect(m).not.toBeNull();
    const parsed = JSON.parse(m![1]);
    expect(Array.isArray(parsed.files)).toBe(true);
    const types = parsed.files.map((f: any) => f.type).sort();
    expect(types).toEqual(["pcb", "sch"]);
  });
});

// =============================================================================
// hasDiff flag — set on each FileManifest based on byte-level PNG comparison
// =============================================================================

test.describe("hasDiff flag", () => {
  test("unchanged file → hasDiff is false", () => {
    runCli([PCB_FILE, "--output-dir", outputDir]);
    const m = readManifest(path.join(outputDir, PROJECT_HTML)) as any;
    // PicoBridge is committed to git and untouched → no visual diff
    const pcb = m.files.find((f: any) => f.type === "pcb");
    expect(pcb.hasDiff).toBe(false);
  });

  test("schematic edit visible on render → hasDiff is true", () => {
    if (!fs.existsSync(SCH_FILE)) test.skip();
    // Spin up an isolated repo so we can mutate the schematic without
    // dirtying the working tree.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kicadiff-hasdiff-"));
    try {
      fs.cpSync(path.dirname(SCH_FILE), tmp, { recursive: true });
      execFileSync("git", ["init", "-q", "-b", "main"], { cwd: tmp });
      execFileSync("git", [
        "-c", "commit.gpgsign=false", "-c", "user.email=t@t",
        "-c", "user.name=t", "add", ".",
      ], { cwd: tmp });
      execFileSync("git", [
        "-c", "commit.gpgsign=false", "-c", "user.email=t@t",
        "-c", "user.name=t", "commit", "-q", "-m", "init",
      ], { cwd: tmp });
      const schInTmp = path.join(tmp, path.basename(SCH_FILE));
      // Schematic value text IS rendered, so an edit produces a visual diff.
      // The blink fixture has the resistor value "330" — bumping it changes
      // the rendered text and therefore the PNG bytes.
      const orig = fs.readFileSync(schInTmp, "utf8");
      fs.writeFileSync(schInTmp, orig.replace(/"330"/g, '"470"'));

      const r = spawnSync(CLI, ["sch", schInTmp, "--output-dir", outputDir], {
        cwd: tmp, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
      });
      expect(r.status).toBe(0);
      const m = readManifest(path.join(outputDir, PROJECT_HTML)) as any;
      expect(m.files[0].hasDiff).toBe(true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// =============================================================================
// Multi-sheet schematic — pages field in manifest (length >= 1, root first)
// =============================================================================

test.describe("schematic pages", () => {
  test("manifest includes a pages array with the root sheet", () => {
    if (!fs.existsSync(SCH_FILE)) test.skip();
    runCli(["sch", SCH_FILE, "--output-dir", outputDir]);
    const m = readManifest(path.join(outputDir, PROJECT_HTML)) as any;
    const sch = m.files.find((f: any) => f.type === "sch");
    expect(sch).toBeTruthy();
    expect(Array.isArray(sch.after.pages)).toBe(true);
    expect(sch.after.pages.length).toBeGreaterThanOrEqual(1);
    // Root page name = schematic basename
    expect(sch.after.pages[0].name).toBe("blink");
  });

  test("before- and after-side page names match (stable across temp files)", () => {
    if (!fs.existsSync(SCH_FILE)) test.skip();
    runCli(["sch", SCH_FILE, "--output-dir", outputDir]);
    const m = readManifest(path.join(outputDir, PROJECT_HTML)) as any;
    const sch = m.files[0];
    if (!sch.before?.pages) return;
    const after = sch.after.pages.map((p: any) => p.name);
    const before = sch.before.pages.map((p: any) => p.name);
    expect(before).toEqual(after);
  });
});

// =============================================================================
// --output flag: HTML at custom path, image paths rewritten to relative
// =============================================================================

test.describe("--output flag", () => {
  test("writes HTML to the specified path with relative image paths", () => {
    const htmlPath = path.join(outputDir, "custom/diff.html");
    runCli([PCB_FILE, "--output-dir", outputDir, "--output", htmlPath]);
    expect(fs.existsSync(htmlPath)).toBe(true);
    // Default location should NOT be used
    expect(fs.existsSync(path.join(outputDir, PROJECT_HTML))).toBe(false);
    const m = readManifest(htmlPath) as any;
    // Image paths must resolve from the HTML's directory ("../after/...")
    expect(m.files[0].after.combined).toMatch(/^\.\.\/after\//);
  });

  test("--output=<path> works via `=` syntax", () => {
    const htmlPath = path.join(outputDir, "diff.html");
    runCli([PCB_FILE, "--output-dir", outputDir, `--output=${htmlPath}`]);
    expect(fs.existsSync(htmlPath)).toBe(true);
  });

  test("-o is an alias for --output", () => {
    const htmlPath = path.join(outputDir, "diff.html");
    runCli([PCB_FILE, "--output-dir", outputDir, "-o", htmlPath]);
    expect(fs.existsSync(htmlPath)).toBe(true);
  });

  test("accepts a directory and uses the default filename inside it", () => {
    // An existing directory: HTML should land at <dir>/<safe>_diff.html
    const dir = path.join(outputDir, "into-dir");
    fs.mkdirSync(dir);
    runCli([PCB_FILE, "--output-dir", outputDir, "--output", dir]);
    expect(fs.existsSync(path.join(dir, PROJECT_HTML))).toBe(true);
  });

  test("trailing slash is treated as a directory even if it doesn't exist yet", () => {
    // Non-existent path with trailing slash: kicadiff should mkdir and use default name
    const dir = path.join(outputDir, "new-dir/");
    runCli([PCB_FILE, "--output-dir", outputDir, "--output", dir]);
    expect(fs.existsSync(path.join(dir, PROJECT_HTML))).toBe(true);
  });

  test("--md --output <dir> writes <safe>_diff.md inside the directory", () => {
    const dir = path.join(outputDir, "md-dir");
    fs.mkdirSync(dir);
    runCli([PCB_FILE, "--output-dir", outputDir, "--md", "--output", dir]);
    const expected = PROJECT_HTML.replace(/_diff\.html$/, "_diff.md");
    expect(fs.existsSync(path.join(dir, expected))).toBe(true);
  });
});

// =============================================================================
// Markdown templating: --md-template / --md-file-template
// =============================================================================

test.describe("--md templating", () => {
  /** Run kicadiff and capture the generated markdown report. Refs (if any)
   *  go before the input; everything else goes after. */
  function runMd(args: string[], refs: string[] = []): string {
    const dir = path.join(outputDir, "md-out");
    fs.mkdirSync(dir);
    runCli([...refs, PCB_FILE, "--output-dir", outputDir, "--md", "--output", dir, ...args]);
    const reportName = PROJECT_HTML.replace(/_diff\.html$/, "_diff.md");
    return fs.readFileSync(path.join(dir, reportName), "utf8");
  }

  test("default templates produce the bundled report layout", () => {
    const md = runMd([]);
    // Sanity check the recognizable structure of the bundled default:
    // a `## ` heading per file, the side-by-side image table.
    expect(md).toMatch(/^## `.+\.kicad_pcb` \(pcb\)/m);
    expect(md).toMatch(/\| Before \(HEAD\) \| After \(working tree\) \|/);
    // Trailing newline (so the file has a clean POSIX-style ending).
    expect(md.endsWith("\n")).toBe(true);
  });

  test("--md-template lets a project template wrap the file sections", () => {
    const tplPath = path.join(outputDir, "proj.tpl");
    fs.writeFileSync(
      tplPath,
      "# Diff: {{from_label}} → {{to_label}}\n\nfile_count={{file_count}}\n\n{{file_sections}}\n",
    );
    const md = runMd(["--md-template", tplPath]);
    expect(md).toContain("# Diff: HEAD → working tree");
    expect(md).toContain("file_count=2");
    // Default file template is still in effect, so the side-by-side table
    // should still appear inside the wrapped output.
    expect(md).toMatch(/\| Before \(HEAD\) \| After \(working tree\) \|/);
  });

  test("--md-file-template overrides per-file rendering", () => {
    const tplPath = path.join(outputDir, "file.tpl");
    fs.writeFileSync(tplPath, "FILE: {{path}} ({{type}})");
    const md = runMd(["--md-file-template", tplPath]);
    expect(md).toMatch(/^FILE: .+\.kicad_pcb \(pcb\)$/m);
    expect(md).toMatch(/^FILE: .+\.kicad_sch \(sch\)$/m);
    // Default project template just emits {{file_sections}}, so the
    // side-by-side table from the bundled default file template is gone.
    expect(md).not.toContain("| --- | --- |");
  });

  test("inverted section in template renders only when value is falsy", () => {
    const tplPath = path.join(outputDir, "file.tpl");
    fs.writeFileSync(
      tplPath,
      "{{path}}: {{#structural_diff}}HAS{{/structural_diff}}{{^structural_diff}}NONE{{/structural_diff}}",
    );
    const md = runMd(["--md-file-template", tplPath]);
    // PCB/SCH always have a structural body (counts line) even when nothing
    // changed, so every line should contain HAS, not NONE. (Verifies that
    // the template engine treats non-empty strings as truthy.)
    expect(md).toContain("HAS");
    expect(md).not.toContain("NONE");
  });

  test("has_structural_diff means real component changes, not body presence", () => {
    // HEAD vs HEAD = zero component changes. has_structural_diff must be
    // false even though structural_diff still contains the `+0 -0 ~0 =N`
    // summary. This locks in the semantic distinction.
    const tplPath = path.join(outputDir, "file.tpl");
    fs.writeFileSync(
      tplPath,
      "{{path}}|sd={{#has_structural_diff}}1{{/has_structural_diff}}{{^has_structural_diff}}0{{/has_structural_diff}}",
    );
    const md = runMd(["--md-file-template", tplPath], ["HEAD"]);
    expect(md.match(/\|sd=0/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
    expect(md).not.toContain("|sd=1");
  });

  test("project has_changes is false when all files are unchanged", () => {
    const tplPath = path.join(outputDir, "proj.tpl");
    fs.writeFileSync(
      tplPath,
      "{{#has_changes}}CHANGED{{/has_changes}}{{^has_changes}}CLEAN{{/has_changes}}\n",
    );
    const md = runMd(["--md-template", tplPath], ["HEAD"]);
    expect(md.trim()).toBe("CLEAN");
  });

  test("count fields are exposed and reflect the structural diff", () => {
    const tplPath = path.join(outputDir, "file.tpl");
    fs.writeFileSync(
      tplPath,
      "{{path}}|+{{added_count}}|-{{removed_count}}|~{{changed_count}}|={{unchanged_count}}",
    );
    const md = runMd(["--md-file-template", tplPath], ["HEAD"]);
    // Each rendered file becomes one non-empty line; the default project
    // template joins sections with blank lines, so filter those out before
    // asserting the per-file pattern.
    const lines = md.trim().split("\n").filter((l) => l !== "");
    expect(lines.length).toBeGreaterThanOrEqual(2);
    for (const line of lines) {
      expect(line).toMatch(/\|\+0\|-0\|~0\|=\d+$/);
    }
  });

  test("missing template path produces a clear error", () => {
    const r = runCli(
      [PCB_FILE, "--output-dir", outputDir, "--md", "--md-template", "/nonexistent/x.tpl"],
      { allowFailure: true },
    );
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/nonexistent\/x\.tpl|ENOENT/);
  });
});

// =============================================================================
// --text-only: structural text diff (no SVG/PNG/HTML)
// =============================================================================

test.describe("--text-only", () => {
  /** Run CLI capturing stdout (--text-only writes the diff there). */
  function runWithStdout(args: string[]): { status: number; stdout: string } {
    const r = spawnSync(CLI, args, {
      cwd: PROJECT_DIR,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: r.status ?? 1, stdout: r.stdout ?? "" };
  }

  test("prints summary line for PCB and skips HTML/PNG generation", () => {
    const r = runWithStdout(["--text-only", PCB_FILE]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/blink\.kicad_pcb \(pcb\): \+\d+ -\d+ ~\d+ =\d+/);
    // No images or HTML produced
    expect(fs.existsSync(path.join(outputDir, PROJECT_HTML))).toBe(false);
  });

  test("detects value changes in modified PCB", () => {
    // Create an isolated git repo with a modified PCB to verify diff detection
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kicadiff-textdiff-"));
    try {
      fs.cpSync(path.dirname(PCB_FILE), tmp, { recursive: true });
      execFileSync("git", ["init", "-q", "-b", "main"], { cwd: tmp });
      execFileSync("git", ["-c", "commit.gpgsign=false", "-c", "user.email=t@t",
        "-c", "user.name=t", "add", "."], { cwd: tmp });
      execFileSync("git", ["-c", "commit.gpgsign=false", "-c", "user.email=t@t",
        "-c", "user.name=t", "commit", "-q", "-m", "init"], { cwd: tmp });
      const pcbInTmp = path.join(tmp, path.basename(PCB_FILE));
      const orig = fs.readFileSync(pcbInTmp, "utf8");
      // Resistor R1 in the blink fixture has value "330"; bumping it produces
      // a structural diff with a single ~ entry on R1.
      fs.writeFileSync(pcbInTmp, orig.replace(/"330"/g, '"470"'));

      const r = spawnSync(CLI, ["--text-only", pcbInTmp], {
        cwd: tmp, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
      });
      expect(r.status).toBe(0);
      expect(r.stdout).toMatch(/~\s*R1\s+value: 330 → 470/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// =============================================================================
// Symbol library (.kicad_sym) and footprint (.kicad_mod) rendering
// =============================================================================

const SYM_LIB = path.join(PROJECT_DIR, "examples/lib/example.kicad_sym");
const FP_FILE = path.join(PROJECT_DIR, "examples/lib/example.pretty/R_0805.kicad_mod");

test.describe("symbol library rendering", () => {
  test("`sym` subcommand renders one PNG per symbol", () => {
    if (!fs.existsSync(SYM_LIB)) test.skip();
    runCli(["sym", SYM_LIB, "--output-dir", outputDir]);
    const safe = _toSafe(SYM_LIB);
    const itemsDir = path.join(outputDir, `after/items_${safe}`);
    expect(fs.existsSync(itemsDir)).toBe(true);
    const pngs = fs.readdirSync(itemsDir).filter(f => f.endsWith(".png"));
    expect(pngs.length).toBeGreaterThan(1);
  });

  test("manifest exposes pages list for sym file type", () => {
    if (!fs.existsSync(SYM_LIB)) test.skip();
    runCli(["sym", SYM_LIB, "--output-dir", outputDir]);
    const htmls = fs.readdirSync(outputDir).filter(f => f.endsWith("_diff.html"));
    const m = readManifest(path.join(outputDir, htmls[0])) as any;
    expect(m.files[0].type).toBe("sym");
    expect(Array.isArray(m.files[0].after.pages)).toBe(true);
    expect(m.files[0].after.pages.length).toBeGreaterThan(1);
  });

  test("`symbol` is an alias for `sym`", () => {
    if (!fs.existsSync(SYM_LIB)) test.skip();
    runCli(["symbol", SYM_LIB, "--output-dir", outputDir]);
    const htmls = fs.readdirSync(outputDir).filter(f => f.endsWith("_diff.html"));
    expect(htmls.length).toBeGreaterThan(0);
  });
});

test.describe("footprint rendering", () => {
  test("`fp` subcommand renders a single .kicad_mod", () => {
    if (!fs.existsSync(FP_FILE)) test.skip();
    runCli(["fp", FP_FILE, "--output-dir", outputDir]);
    const safe = _toSafe(FP_FILE);
    expect(fs.existsSync(path.join(outputDir, `after/${safe}.png`))).toBe(true);
    const itemsDir = path.join(outputDir, `after/items_${safe}`);
    expect(fs.existsSync(path.join(itemsDir, "R_0805.png"))).toBe(true);
  });

  test("`footprint` is an alias for `fp`", () => {
    if (!fs.existsSync(FP_FILE)) test.skip();
    runCli(["footprint", FP_FILE, "--output-dir", outputDir]);
    const htmls = fs.readdirSync(outputDir).filter(f => f.endsWith("_diff.html"));
    expect(htmls.length).toBeGreaterThan(0);
  });

  test("`fp` subcommand accepts a .pretty directory and renders all footprints", () => {
    const prettyDir = path.dirname(FP_FILE);
    if (!fs.existsSync(prettyDir)) test.skip();
    runCli(["fp", prettyDir, "--output-dir", outputDir]);
    const htmls = fs.readdirSync(outputDir).filter(f => f.endsWith("_diff.html"));
    expect(htmls.length).toBeGreaterThan(0);
    const m = readManifest(path.join(outputDir, htmls[0])) as any;
    // Multiple .kicad_mod files = multiple file entries
    expect(m.files.length).toBeGreaterThan(1);
    expect(m.files.every((f: any) => f.type === "fp")).toBe(true);
  });
});

// =============================================================================
// `hook` subcommand: read PostToolUse JSON from stdin, render only when the
// edited file is .kicad_pcb / .kicad_sch. Replaces the small bash wrapper
// users would otherwise have to write under .claude/hooks/.
// =============================================================================

test.describe("hook subcommand", () => {
  /** Build a PostToolUse-shaped JSON payload. We mirror the fields Claude Code
   *  actually sends so the test exercises the same parsing path the wrapper
   *  used to do in shell. */
  const hookInput = (filePath: string) =>
    JSON.stringify({ tool_name: "Edit", tool_input: { file_path: filePath } });

  test("non-KiCad file → exits 0 without rendering", () => {
    const r = runCli(["hook", "--output-dir", outputDir], {
      input: hookInput("src/index.ts"),
      env: { ...process.env, KICADIFF_OPEN_CMD: "" },
    });
    expect(r.status).toBe(0);
    // outputDir must remain empty — no render, no opener invocation.
    expect(fs.readdirSync(outputDir)).toHaveLength(0);
  });

  test("missing file_path → exits 0 without rendering", () => {
    const r = runCli(["hook", "--output-dir", outputDir], {
      input: JSON.stringify({ tool_name: "Edit", tool_input: {} }),
      env: { ...process.env, KICADIFF_OPEN_CMD: "" },
    });
    expect(r.status).toBe(0);
    expect(fs.readdirSync(outputDir)).toHaveLength(0);
  });

  test("file_path pointing at a non-existent KiCad file → exits 0", () => {
    // Edge case: Claude Code reports the path of a *new* Write that hasn't
    // been flushed yet, or a delete. Either way: no file = nothing to render.
    const r = runCli(["hook", "--output-dir", outputDir], {
      input: hookInput("/tmp/does-not-exist.kicad_pcb"),
      env: { ...process.env, KICADIFF_OPEN_CMD: "" },
    });
    expect(r.status).toBe(0);
    expect(fs.readdirSync(outputDir)).toHaveLength(0);
  });

  test("invalid JSON on stdin → exits non-zero with a helpful error", () => {
    const r = runCli(["hook"], {
      input: "this is not json",
      allowFailure: true,
    });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/json/i);
  });

  test(".kicad_pcb file_path triggers the normal render", () => {
    const r = runCli(["hook", "--output-dir", outputDir], {
      input: hookInput(PCB_FILE),
      env: { ...process.env, KICADIFF_OPEN_CMD: "" },
    });
    expect(r.status).toBe(0);
    const png = path.join(outputDir, `after/${SAFE_PCB}.png`);
    expect(fs.existsSync(png)).toBe(true);
    expect(fs.existsSync(path.join(outputDir, PROJECT_HTML))).toBe(true);
  });

  test(".kicad_sch file_path triggers the normal render", () => {
    const r = runCli(["hook", "--output-dir", outputDir], {
      input: hookInput(SCH_FILE),
      env: { ...process.env, KICADIFF_OPEN_CMD: "" },
    });
    expect(r.status).toBe(0);
    const png = path.join(outputDir, `after/${SAFE_SCH}.png`);
    expect(fs.existsSync(png)).toBe(true);
  });

  test("default opener is invoked (vscode-equivalent) for KiCad files", () => {
    const { script, log } = makeOpenerMock(outputDir);
    // The default `kicadiff hook` behavior matches the original shell wrapper:
    // render and auto-open, so the user gets a Live Preview tab without doing
    // anything else. We exercise that by routing the open through a mock.
    runCli(["hook", "--output-dir", outputDir], {
      input: hookInput(PCB_FILE),
      env: { ...process.env, KICADIFF_OPEN_CMD: script },
    });
    expect(fs.existsSync(log)).toBe(true);
    expect(fs.readFileSync(log, "utf8")).toContain(PROJECT_HTML);
  });

  test("explicit --open=<cmd> overrides the default opener", () => {
    const { script, log } = makeOpenerMock(outputDir);
    // Clear KICADIFF_OPEN_CMD so the per-invocation --open=<cmd> takes effect.
    const env = { ...process.env };
    delete env.KICADIFF_OPEN_CMD;
    runCli(["hook", `--open=${script}`, "--output-dir", outputDir], {
      input: hookInput(PCB_FILE),
      env,
    });
    expect(fs.existsSync(log)).toBe(true);
  });
});

// =============================================================================
// --watch: re-render on input file change. Spawns the CLI in the background,
// waits for the initial render, mutates the source, and confirms the rendered
// PNG mtime advanced.
// =============================================================================

test.describe("--watch", () => {
  test("modifying the input file re-renders the output", async () => {
    // Work in an isolated tmp project so we don't touch the repo's blink
    // fixture (and the watcher gets a clean filesystem to operate on).
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kicadiff-watch-"));
    try {
      const blinkSrc = path.dirname(SCH_FILE);
      fs.cpSync(blinkSrc, tmp, { recursive: true });
      // The watcher uses cache-on rerun, so a fresh git repo here is fine —
      // we don't need any commits, just an existing on-disk file to render.
      const outDir = path.join(tmp, "out");
      const target = path.join(tmp, path.basename(SCH_FILE));

      // Spawn the CLI in the background. We can't use spawnSync because
      // --watch never returns; capture stdout/stderr so we can assert
      // visible progress lines.
      const { spawn } = await import("node:child_process");
      const proc = spawn(CLI, [target, "--watch", "--output-dir", outDir], {
        cwd: tmp,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, KICADIFF_OPEN_CMD: "" },
      });
      let stdout = "";
      let stderr = "";
      proc.stdout.on("data", (b) => { stdout += b.toString(); });
      proc.stderr.on("data", (b) => { stderr += b.toString(); });
      try {
        // Wait for the initial render to finish — the watcher prints
        // "watching <file>" once it's set up.
        await waitFor(() => stdout.includes("watching"), 8000, "initial render");

        // Snapshot mtime of any rendered PNG — re-render must bump it.
        const pngs = fs.readdirSync(path.join(outDir, "after")).filter((f) => f.endsWith(".png"));
        expect(pngs.length).toBeGreaterThan(0);
        const samplePng = path.join(outDir, "after", pngs[0]);
        const mtimeBefore = fs.statSync(samplePng).mtimeMs;

        // Mutate the schematic. The blink fixture has resistor value "330";
        // bumping it changes the rendered text and forces a different hash,
        // which in turn evicts cache and produces fresh PNGs.
        const orig = fs.readFileSync(target, "utf8");
        fs.writeFileSync(target, orig.replace(/"330"/g, '"470"'));

        // The watcher polls at 1 s + rerender takes another second, give
        // it 6 s before giving up. Look for the explicit log line so we
        // know the watcher fired (avoids false positives from clock skew).
        await waitFor(
          () => /re-rendered in \d+ms/.test(stdout),
          6000,
          "re-render trigger",
        );
        const mtimeAfter = fs.statSync(samplePng).mtimeMs;
        expect(mtimeAfter).toBeGreaterThan(mtimeBefore);
      } finally {
        proc.kill("SIGTERM");
        await new Promise<void>((resolve) => proc.once("exit", () => resolve()));
        // Surface anything that went wrong.
        if (stderr.trim()) console.error("watcher stderr:", stderr);
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

/** Block until `predicate()` returns true or `timeoutMs` elapses. Polls
 *  every 100 ms. Throws with a helpful message on timeout so test failures
 *  show what condition wasn't met. */
async function waitFor(predicate: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error(`waitFor: ${label} did not happen within ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

// =============================================================================
// Ref pinning: mutable refs (branch / tag / HEAD) are resolved to a concrete
// commit SHA at render entry so every git read (.kicad_pcb, sibling
// .kicad_pro / .kicad_prl, temp staging) sees the same snapshot — even if
// the ref moves underneath the running process. The manifest also records
// the pinned SHA so the report is reproducible after the branch advances.
// =============================================================================

test.describe("ref pinning", () => {
  /** Initialise a fresh git repo under `dir` with the blink fixture, commit
   *  it, and return the resulting commit SHA. */
  function initRepoAt(dir: string, label: string): string {
    fs.cpSync(path.dirname(PCB_FILE), dir, { recursive: true });
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
    execFileSync("git", ["-c", "commit.gpgsign=false", "-c", "user.email=t@t",
      "-c", "user.name=t", "add", "."], { cwd: dir });
    execFileSync("git", ["-c", "commit.gpgsign=false", "-c", "user.email=t@t",
      "-c", "user.name=t", "commit", "-q", "-m", label], { cwd: dir });
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();
  }

  test("resolveRefToSha returns a 40-char SHA for HEAD, branches, and tags", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kicadiff-pin-unit-"));
    try {
      const headSha = initRepoAt(tmp, "init");
      execFileSync("git", ["branch", "feat"], { cwd: tmp });
      execFileSync("git", ["tag", "v1"], { cwd: tmp });

      const { resolveRefToSha } = await import("../src/render.ts");
      expect(resolveRefToSha(tmp, "HEAD")).toBe(headSha);
      expect(resolveRefToSha(tmp, "main")).toBe(headSha);
      expect(resolveRefToSha(tmp, "feat")).toBe(headSha);
      expect(resolveRefToSha(tmp, "v1")).toBe(headSha);
      // Idempotent on an already-resolved SHA.
      expect(resolveRefToSha(tmp, headSha)).toBe(headSha);
      // Working-tree markers pass through.
      expect(resolveRefToSha(tmp, "")).toBe("");
      expect(resolveRefToSha(tmp, "working")).toBe("working");
      // Non-existent refs throw a clear error.
      expect(() => resolveRefToSha(tmp, "no-such-ref")).toThrow(/cannot resolve ref/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("manifest records the pinned commit SHA, not the branch name", () => {
    // When the user passes `--from feat`, the rendered output should be
    // anchored to whatever commit `feat` pointed at when the render started.
    // Recording the branch name in the manifest would be a foot-gun: someone
    // reading the report later (after `feat` has moved) would have no way to
    // tell which commit was actually compared. So the manifest stores the
    // resolved 40-char SHA; the viewer/markdown templates shorten it to 7
    // chars for display.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kicadiff-pin-manifest-"));
    try {
      const initSha = initRepoAt(tmp, "init");
      execFileSync("git", ["branch", "feat"], { cwd: tmp });
      // Move HEAD forward by editing a value; `feat` stays at initSha.
      const pcbInTmp = path.join(tmp, path.basename(PCB_FILE));
      const orig = fs.readFileSync(pcbInTmp, "utf8");
      fs.writeFileSync(pcbInTmp, orig.replace(/"330"/g, '"470"'));
      execFileSync("git", ["-c", "commit.gpgsign=false", "-c", "user.email=t@t",
        "-c", "user.name=t", "commit", "-q", "-am", "bump R1"], { cwd: tmp });
      const headSha = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: tmp, encoding: "utf8",
      }).trim();

      const outDir = path.join(tmp, "out");
      const r = spawnSync(CLI, [
        "pcb", pcbInTmp, "--from", "feat", "--to", "HEAD",
        "--output-dir", outDir,
      ], { cwd: tmp, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      if (r.status !== 0) throw new Error(`kicadiff failed: ${r.stderr}`);

      const htmls = fs.readdirSync(outDir).filter(f => f.endsWith("_diff.html"));
      const m = readManifest(path.join(outDir, htmls[0])) as any;
      const pcb = m.files[0];
      expect(pcb.fromRef).toBe(initSha);
      expect(pcb.toRef).toBe(headSha);
      // Sanity: SHA, not the user-typed names
      expect(pcb.fromRef).not.toBe("feat");
      expect(pcb.toRef).not.toBe("HEAD");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("all files in a multi-file project pin to the same SHA", () => {
    // renderProject pins once up front so the .kicad_pcb and .kicad_sch
    // entries in a single report agree on which commit they were compared
    // against — without this, a fast-moving branch could land on different
    // commits between the two parallel renders.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kicadiff-pin-project-"));
    try {
      const sha = initRepoAt(tmp, "init");
      execFileSync("git", ["branch", "feat"], { cwd: tmp });

      const outDir = path.join(tmp, "out");
      const r = spawnSync(CLI, [
        tmp, "--from", "feat", "--output-dir", outDir,
      ], { cwd: tmp, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      if (r.status !== 0) throw new Error(`kicadiff failed: ${r.stderr}`);

      const htmls = fs.readdirSync(outDir).filter(f => f.endsWith("_diff.html"));
      const m = readManifest(path.join(outDir, htmls[0])) as any;
      expect(m.files.length).toBeGreaterThanOrEqual(2);
      for (const f of m.files) {
        expect(f.fromRef).toBe(sha);
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
