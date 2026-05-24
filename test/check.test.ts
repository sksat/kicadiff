import { test, expect } from "@playwright/test";
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import {
  diffViolations,
  signatureOf,
  formatCheckDiff,
  runDrc,
  runErc,
  type Violation,
} from "../src/check.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PROJECT_DIR = path.resolve(__dirname, "..");
const CLI = path.join(PROJECT_DIR, "kicadiff");
const BLINK_FIXTURE_DIR = path.join(PROJECT_DIR, "examples/blink");
const BLINK_PCB = path.join(BLINK_FIXTURE_DIR, "blink.kicad_pcb");
const BLINK_SCH = path.join(BLINK_FIXTURE_DIR, "blink.kicad_sch");

// =============================================================================
// Unit tests for the violation differ.
// These test the format-agnostic core, with hand-rolled Violation arrays.
// =============================================================================

function v(
  type: string,
  description: string,
  items: { description: string; uuid?: string; pos?: { x: number; y: number } }[],
  severity: "error" | "warning" | "exclusion" = "error",
): Violation {
  return { type, severity, description, items };
}

test.describe("signatureOf", () => {
  test("two violations with the same type and item descriptions match", () => {
    const a = v("clearance", "Clearance violation", [
      { description: "Pad 1 of R1" },
      { description: "Pad 1 of R2" },
    ]);
    const b = v("clearance", "Clearance violation", [
      { description: "Pad 1 of R1" },
      { description: "Pad 1 of R2" },
    ]);
    expect(signatureOf(a)).toBe(signatureOf(b));
  });

  test("identity is independent of item order (so KiCad's traversal order doesn't break matching)", () => {
    const a = v("clearance", "Clearance violation", [
      { description: "Pad 1 of R1" },
      { description: "Pad 1 of R2" },
    ]);
    const b = v("clearance", "Clearance violation", [
      { description: "Pad 1 of R2" },
      { description: "Pad 1 of R1" },
    ]);
    expect(signatureOf(a)).toBe(signatureOf(b));
  });

  test("different type produces a different signature", () => {
    const a = v("clearance", "x", [{ description: "Pad 1 of R1" }]);
    const b = v("courtyards_overlap", "x", [{ description: "Pad 1 of R1" }]);
    expect(signatureOf(a)).not.toBe(signatureOf(b));
  });

  test("different referenced items produce a different signature", () => {
    const a = v("clearance", "x", [{ description: "Pad 1 of R1" }]);
    const b = v("clearance", "x", [{ description: "Pad 1 of R5" }]);
    expect(signatureOf(a)).not.toBe(signatureOf(b));
  });

  test("uuid changes alone do NOT break matching (uuids may be regenerated)", () => {
    const a = v("clearance", "x", [{ description: "Pad 1 of R1", uuid: "aaa" }]);
    const b = v("clearance", "x", [{ description: "Pad 1 of R1", uuid: "bbb" }]);
    expect(signatureOf(a)).toBe(signatureOf(b));
  });

  test("position changes do NOT break matching (small moves should track)", () => {
    const a = v("clearance", "x",
      [{ description: "Pad 1 of R1", pos: { x: 100, y: 50 } }]);
    const b = v("clearance", "x",
      [{ description: "Pad 1 of R1", pos: { x: 101, y: 51 } }]);
    expect(signatureOf(a)).toBe(signatureOf(b));
  });
});

test.describe("diffViolations", () => {
  test("empty before + empty after → empty diff", () => {
    const d = diffViolations([], []);
    expect(d.added).toEqual([]);
    expect(d.removed).toEqual([]);
    expect(d.unchanged).toEqual([]);
  });

  test("identical before & after → all unchanged", () => {
    const a = v("clearance", "x", [{ description: "Pad 1 of R1" }]);
    const d = diffViolations([a], [a]);
    expect(d.added).toEqual([]);
    expect(d.removed).toEqual([]);
    expect(d.unchanged.length).toBe(1);
  });

  test("new violation appears in `added`", () => {
    const a = v("clearance", "x", [{ description: "Pad 1 of R1" }]);
    const b = v("courtyards_overlap", "x", [{ description: "Pad 1 of R2" }]);
    const d = diffViolations([a], [a, b]);
    expect(d.added.length).toBe(1);
    expect(d.added[0].type).toBe("courtyards_overlap");
    expect(d.removed).toEqual([]);
    expect(d.unchanged.length).toBe(1);
  });

  test("fixed violation appears in `removed`", () => {
    const a = v("clearance", "x", [{ description: "Pad 1 of R1" }]);
    const b = v("courtyards_overlap", "x", [{ description: "Pad 1 of R2" }]);
    const d = diffViolations([a, b], [a]);
    expect(d.removed.length).toBe(1);
    expect(d.removed[0].type).toBe("courtyards_overlap");
    expect(d.added).toEqual([]);
    expect(d.unchanged.length).toBe(1);
  });

  test("duplicate violations on each side are counted separately", () => {
    // KiCad sometimes reports the same logical violation twice (e.g. two
    // unconnected-items entries for the same net). We treat each entry as
    // distinct so the +/- numbers aren't silently collapsed.
    const a = v("unconnected_items", "x", [{ description: "Pad 1 of R1" }]);
    const d = diffViolations([a], [a, a]);
    expect(d.added.length).toBe(1);
    expect(d.unchanged.length).toBe(1);
  });
});

test.describe("formatCheckDiff", () => {
  test("reports +N -M =K summary line", () => {
    const same = v("clearance", "Clearance violation", [{ description: "Pad 1 of R1" }]);
    const added = v("courtyards_overlap", "Overlap", [{ description: "footprint R5 / R6" }]);
    const removed = v("lengths_match", "Length mismatch", [{ description: "diff pair" }]);
    const diff = diffViolations([same, removed], [same, added]);
    const out = formatCheckDiff("foo.kicad_pcb", "drc", diff);
    const head = out.split("\n")[0];
    expect(head).toContain("foo.kicad_pcb");
    expect(head).toContain("(drc)");
    expect(head).toContain("+1");
    expect(head).toContain("-1");
    expect(head).toContain("=1");
  });

  test("lists added violations with `+` prefix", () => {
    const added = v("courtyards_overlap", "Overlap", [{ description: "footprint R5" }]);
    const out = formatCheckDiff("foo.kicad_pcb", "drc", diffViolations([], [added]));
    expect(out).toMatch(/^\s*\+\s+courtyards_overlap/m);
  });

  test("lists removed violations with `-` prefix", () => {
    const removed = v("clearance", "Clearance", [{ description: "Pad 1 of R1" }]);
    const out = formatCheckDiff("foo.kicad_pcb", "drc", diffViolations([removed], []));
    expect(out).toMatch(/^\s*-\s+clearance/m);
  });
});

// =============================================================================
// runDrc / runErc surface launch failures with actionable diagnostics.
// Without this, a missing kicad-cli on PATH degrades to a generic
// "report file missing" error that hides ENOENT.
// =============================================================================

test.describe("runDrc / runErc error surfacing", () => {
  test("runDrc: missing kicad-cli surfaces ENOENT / launch error", () => {
    // Tmpdir name avoids substrings that would collide with the diagnostic
    // regex below (no "enoent", "not found", "PATH") — we want the assertion
    // to pin on the *thrown message text*, not on the fixture path.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kicadiff-check-drc-fail-"));
    const origPath = process.env.PATH;
    try {
      // Wipe PATH so `kicad-cli` is unresolvable — spawnSync should populate
      // r.error with ENOENT. The previous implementation only checked the
      // output file existence and threw a generic "drc failed" message.
      process.env.PATH = "/nonexistent-kicadiff-test";
      const fakePcb = path.join(tmp, "fake.kicad_pcb");
      fs.writeFileSync(fakePcb, "");
      const reportPath = path.join(tmp, "report.json");
      let caught: Error | null = null;
      try {
        runDrc(fakePcb, reportPath);
      } catch (e) {
        caught = e as Error;
      }
      expect(caught).not.toBeNull();
      // The error must mention either ENOENT or "not found" / "PATH" so the
      // user can act on it; the bare "drc failed" message is what we're
      // replacing.
      expect(caught!.message).toMatch(/ENOENT|not found|PATH/i);
    } finally {
      process.env.PATH = origPath;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("runErc: missing kicad-cli surfaces ENOENT / launch error", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kicadiff-check-erc-fail-"));
    const origPath = process.env.PATH;
    try {
      process.env.PATH = "/nonexistent-kicadiff-test";
      const fakeSch = path.join(tmp, "fake.kicad_sch");
      fs.writeFileSync(fakeSch, "");
      const reportPath = path.join(tmp, "report.json");
      let caught: Error | null = null;
      try {
        runErc(fakeSch, reportPath);
      } catch (e) {
        caught = e as Error;
      }
      expect(caught).not.toBeNull();
      expect(caught!.message).toMatch(/ENOENT|not found|PATH/i);
    } finally {
      process.env.PATH = origPath;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("runDrc: non-zero exit from kicad-cli includes the exit status", () => {
    // Stand up a `kicad-cli` shim that exits non-zero without writing a
    // report file. The error message must include the exit status so the
    // user can distinguish "tool refused the file" (e.g. exit 2 = bad input)
    // from "tool crashed".
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kicadiff-check-exit-"));
    const origPath = process.env.PATH;
    try {
      const shim = path.join(tmp, "kicad-cli");
      fs.writeFileSync(shim, "#!/bin/sh\necho 'simulated drc failure' >&2\nexit 2\n");
      fs.chmodSync(shim, 0o755);
      process.env.PATH = tmp;
      const fakePcb = path.join(tmp, "fake.kicad_pcb");
      fs.writeFileSync(fakePcb, "");
      const reportPath = path.join(tmp, "report.json");
      let caught: Error | null = null;
      try {
        runDrc(fakePcb, reportPath);
      } catch (e) {
        caught = e as Error;
      }
      expect(caught).not.toBeNull();
      // The exit status (2) must appear somewhere in the diagnostic.
      expect(caught!.message).toMatch(/\b2\b/);
    } finally {
      process.env.PATH = origPath;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// =============================================================================
// Integration tests for the `kicadiff check` subcommand.
//
// `examples/blink/blink.kicad_pcb` is DRC-clean (no violations).
// `examples/blink/blink.kicad_sch` has 5 ERC violations (pre-existing).
// We exercise both directions: a no-op compare and a compare that introduces
// changes.
// =============================================================================

function initRepoWithBlink(dir: string): string {
  fs.cpSync(BLINK_FIXTURE_DIR, dir, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  execFileSync("git", [
    "-c", "commit.gpgsign=false", "-c", "user.email=t@t", "-c", "user.name=t",
    "add", ".",
  ], { cwd: dir });
  execFileSync("git", [
    "-c", "commit.gpgsign=false", "-c", "user.email=t@t", "-c", "user.name=t",
    "commit", "-q", "-m", "init",
  ], { cwd: dir });
  return execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: dir, encoding: "utf8",
  }).trim();
}

test.beforeAll(() => {
  if (!fs.existsSync(BLINK_PCB)) test.skip(true, `KiCad fixture missing: ${BLINK_PCB}`);
});

test.describe("kicadiff check (integration)", () => {
  test("HEAD vs HEAD on a DRC-clean PCB: exits 0, reports +0 -0", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kicadiff-check-clean-"));
    try {
      initRepoWithBlink(tmp);
      const pcbInTmp = path.join(tmp, path.basename(BLINK_PCB));
      const r = spawnSync(CLI, ["check", "HEAD", "HEAD", pcbInTmp], {
        cwd: tmp, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
      });
      expect(r.status).toBe(0);
      expect(r.stdout).toContain("(drc)");
      expect(r.stdout).toMatch(/\+0\b/);
      expect(r.stdout).toMatch(/-0\b/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("introducing an ERC violation: exits 1, reports +N new", () => {
    // The blink schematic already has 5 ERC violations (pin_not_connected on
    // ERC markers). Removing a wire segment from a net is a heavy-handed but
    // deterministic way to add a new dangling-pin / no-connect-style violation
    // on top of the existing baseline; here we take the simpler approach of
    // deleting an unrelated junction by stripping a `(no_connect ...)` from
    // the schematic — every NC marker that disappears flips a previously-
    // suppressed pin back into a "Pin not connected" error.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kicadiff-check-erc-"));
    try {
      initRepoWithBlink(tmp);
      const schInTmp = path.join(tmp, path.basename(BLINK_SCH));
      const src = fs.readFileSync(schInTmp, "utf8");
      // Strip one wire from the schematic — removing a wire that connected
      // two pins introduces dangling-wire / pin-not-connected ERC errors
      // that weren't present at HEAD. We scan for `(wire ` then walk the
      // parens to find the matching `)`, because the wire block contains
      // nested groups (`(stroke …)`, `(uuid …)`, `(pts …)`) and a naive
      // regex would close at the first `)`.
      const start = src.indexOf("(wire ");
      let mutated = src;
      if (start >= 0) {
        let depth = 0;
        let end = -1;
        for (let i = start; i < src.length; i++) {
          if (src[i] === "(") depth++;
          else if (src[i] === ")") {
            depth--;
            if (depth === 0) { end = i + 1; break; }
          }
        }
        if (end > start) mutated = src.slice(0, start) + src.slice(end);
      }
      if (mutated === src) test.skip(true, "could not perturb the schematic to introduce an ERC violation");
      fs.writeFileSync(schInTmp, mutated);

      const r = spawnSync(CLI, ["check", "HEAD", schInTmp], {
        cwd: tmp, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
      });
      expect(r.stdout).toContain("(erc)");
      // Exit 1 because there are NEW violations on the `to` side.
      expect(r.status).toBe(1);
      // The summary must show at least one added violation.
      expect(r.stdout).toMatch(/\+[1-9]\d*\b/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("aggregates unsupported-file skips into a single summary line", () => {
    // A .pretty/ footprint library can contain dozens of .kicad_mod files.
    // resolveInputs auto-includes them when handed the parent project, and
    // the previous implementation printed one stderr line per skipped file —
    // which floods CI logs. The skip notices must collapse to a single
    // summary line regardless of how many footprints live in the library.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kicadiff-check-pretty-"));
    try {
      initRepoWithBlink(tmp);
      // Build a sibling <project>.pretty/ library with several .kicad_mod
      // files. They share the project basename so `scanProjectSiblings`
      // auto-picks them up during `resolveInputs`.
      const projBase = path.basename(BLINK_PCB, ".kicad_pcb");
      const prettyDir = path.join(tmp, `${projBase}.pretty`);
      fs.mkdirSync(prettyDir, { recursive: true });
      const modCount = 5;
      for (let i = 0; i < modCount; i++) {
        fs.writeFileSync(
          path.join(prettyDir, `stub_${i}.kicad_mod`),
          "(footprint stub (version 20240108) (generator kicadiff_test))",
        );
      }
      execFileSync("git", [
        "-c", "commit.gpgsign=false", "-c", "user.email=t@t", "-c", "user.name=t",
        "add", ".",
      ], { cwd: tmp });
      execFileSync("git", [
        "-c", "commit.gpgsign=false", "-c", "user.email=t@t", "-c", "user.name=t",
        "commit", "-q", "-m", "add pretty",
      ], { cwd: tmp });

      // Hand the project directory to `check` — resolveInputs will fold in
      // all the .kicad_mod files alongside the .kicad_pcb / .kicad_sch.
      const r = spawnSync(CLI, ["check", "HEAD", "HEAD", tmp], {
        cwd: tmp, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
      });
      expect(r.status).toBe(0);
      // Count the per-file skip lines. The fix collapses these into ONE
      // summary line ("Skipped N unsupported files…"); the regression we're
      // guarding against would emit one such line per .kicad_mod.
      const perFileSkipLines = (r.stderr ?? "")
        .split("\n")
        .filter((l) => /skipping unsupported file type/.test(l));
      expect(perFileSkipLines.length).toBeLessThanOrEqual(1);
      // And we should still get *some* indication that files were skipped
      // — either the per-file (<=1) message or a summary count.
      const skippedSummary = (r.stderr ?? "").match(/[Ss]kipped\s+\d+/);
      expect(perFileSkipLines.length + (skippedSummary ? 1 : 0)).toBeGreaterThan(0);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("skips unsupported file types with a friendly note", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kicadiff-check-skip-"));
    try {
      initRepoWithBlink(tmp);
      // Drop a .kicad_sym next to the project — `check` doesn't run on
      // symbol libs, so it should be silently or politely skipped.
      const symFile = path.join(tmp, "stub.kicad_sym");
      fs.writeFileSync(symFile, "(kicad_symbol_lib (version 20211014) (generator kicadiff_test))");
      execFileSync("git", [
        "-c", "commit.gpgsign=false", "-c", "user.email=t@t", "-c", "user.name=t",
        "add", "stub.kicad_sym",
      ], { cwd: tmp });
      execFileSync("git", [
        "-c", "commit.gpgsign=false", "-c", "user.email=t@t", "-c", "user.name=t",
        "commit", "-q", "-m", "add sym",
      ], { cwd: tmp });

      const r = spawnSync(CLI, ["check", "HEAD", "HEAD", symFile], {
        cwd: tmp, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
      });
      // Skipping is fine; the only requirement is that the command doesn't
      // crash and doesn't report a phantom violation.
      expect(r.status).toBe(0);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
