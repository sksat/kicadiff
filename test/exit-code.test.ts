import { test, expect } from "@playwright/test";
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Integration tests for the `--exit-code` flag.
 *
 * Mirrors `git diff --exit-code` semantics: exit 1 if any change exists,
 * 0 otherwise. Errors (bad ref, missing input, etc.) still exit non-zero
 * as today — `--exit-code` only affects the success / no-change boundary.
 */

const PROJECT_DIR = path.resolve(__dirname, "..");
const CLI = path.join(PROJECT_DIR, "kicadiff");
const PROJECT_FIXTURE_DIR = path.join(PROJECT_DIR, "examples/blink");
const PCB_FILE = path.join(PROJECT_FIXTURE_DIR, "blink.kicad_pcb");

/** Initialise a git repo at `dir`, copy the blink fixture in, commit, and
 *  return the resulting commit SHA. Matches the pattern used by other
 *  tests in test/render.test.ts. */
function initRepoWithBlink(dir: string): string {
  fs.cpSync(PROJECT_FIXTURE_DIR, dir, { recursive: true });
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
  if (!fs.existsSync(PCB_FILE)) test.skip(true, `KiCad fixture missing: ${PCB_FILE}`);
});

test.describe("--exit-code flag", () => {
  test("default mode (no --exit-code): exits 0 even when changes exist", () => {
    // Regression guard: the old behavior must be preserved when the user
    // hasn't opted into the git-diff-compatible exit semantics.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kicadiff-exit-default-"));
    try {
      initRepoWithBlink(tmp);
      const pcbInTmp = path.join(tmp, path.basename(PCB_FILE));
      fs.writeFileSync(pcbInTmp,
        fs.readFileSync(pcbInTmp, "utf8").replace(/"330"/g, '"470"'));

      const outDir = path.join(tmp, "out");
      const r = spawnSync(CLI, ["pcb", pcbInTmp, "--output-dir", outDir], {
        cwd: tmp, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
      });
      expect(r.status).toBe(0);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("--exit-code with no changes: exits 0", () => {
    // HEAD vs HEAD — no possible change. --exit-code must report success.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kicadiff-exit-clean-"));
    try {
      initRepoWithBlink(tmp);
      const pcbInTmp = path.join(tmp, path.basename(PCB_FILE));

      const outDir = path.join(tmp, "out");
      const r = spawnSync(CLI, [
        "pcb", "HEAD", "HEAD", pcbInTmp, "--exit-code", "--output-dir", outDir,
      ], { cwd: tmp, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      expect(r.status).toBe(0);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("--exit-code with a structural change: exits 1", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kicadiff-exit-changed-"));
    try {
      initRepoWithBlink(tmp);
      const pcbInTmp = path.join(tmp, path.basename(PCB_FILE));
      fs.writeFileSync(pcbInTmp,
        fs.readFileSync(pcbInTmp, "utf8").replace(/"330"/g, '"470"'));

      const outDir = path.join(tmp, "out");
      const r = spawnSync(CLI, [
        "pcb", pcbInTmp, "--exit-code", "--output-dir", outDir,
      ], { cwd: tmp, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      expect(r.status).toBe(1);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("--exit-code --text-only with no changes: exits 0", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kicadiff-exit-text-clean-"));
    try {
      initRepoWithBlink(tmp);
      const pcbInTmp = path.join(tmp, path.basename(PCB_FILE));

      const r = spawnSync(CLI, [
        "--text-only", "--exit-code", "HEAD", "HEAD", pcbInTmp,
      ], { cwd: tmp, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      expect(r.status).toBe(0);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("--exit-code --text-only with a structural change: exits 1", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kicadiff-exit-text-changed-"));
    try {
      initRepoWithBlink(tmp);
      const pcbInTmp = path.join(tmp, path.basename(PCB_FILE));
      fs.writeFileSync(pcbInTmp,
        fs.readFileSync(pcbInTmp, "utf8").replace(/"330"/g, '"470"'));

      const r = spawnSync(CLI, [
        "--text-only", "--exit-code", pcbInTmp,
      ], { cwd: tmp, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      expect(r.status).toBe(1);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("--exit-code --md with a structural change: exits 1", () => {
    // Markdown path uses buildMarkdownReport (which is also where the
    // hasChanges definition lives). Make sure --exit-code observes the
    // same definition when the user is producing a markdown report.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kicadiff-exit-md-changed-"));
    try {
      initRepoWithBlink(tmp);
      const pcbInTmp = path.join(tmp, path.basename(PCB_FILE));
      fs.writeFileSync(pcbInTmp,
        fs.readFileSync(pcbInTmp, "utf8").replace(/"330"/g, '"470"'));

      const outDir = path.join(tmp, "out");
      const r = spawnSync(CLI, [
        "pcb", pcbInTmp, "--md", "--exit-code", "--output-dir", outDir,
      ], { cwd: tmp, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      expect(r.status).toBe(1);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("--exit-code --images-only with a structural change: exits 1", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kicadiff-exit-img-changed-"));
    try {
      initRepoWithBlink(tmp);
      const pcbInTmp = path.join(tmp, path.basename(PCB_FILE));
      fs.writeFileSync(pcbInTmp,
        fs.readFileSync(pcbInTmp, "utf8").replace(/"330"/g, '"470"'));

      const outDir = path.join(tmp, "out");
      const r = spawnSync(CLI, [
        "pcb", pcbInTmp, "--images-only", "--exit-code", "--output-dir", outDir,
      ], { cwd: tmp, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      expect(r.status).toBe(1);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("--exit-code does not change errors: bad ref still exits non-zero", () => {
    const r = spawnSync(CLI, [
      "this-ref-does-not-exist", PCB_FILE, "--exit-code",
    ], { cwd: PROJECT_DIR, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    expect(r.status).not.toBe(0);
  });
});
