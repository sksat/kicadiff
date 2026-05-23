import { test, expect } from "@playwright/test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Integration tests for the `kicadiff cache` subcommands (`stats` / `prune`).
 *
 * The cache lives at $KICADIFF_CACHE_DIR (or ~/.cache/kicadiff). All tests
 * here point KICADIFF_CACHE_DIR at a freshly-created temp directory and
 * populate it with fake leaf entries — never touch the real user cache.
 */

const PROJECT_DIR = path.resolve(__dirname, "..");
const CLI = path.join(PROJECT_DIR, "kicadiff");

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

function runCli(
  args: string[],
  options: { env?: NodeJS.ProcessEnv; input?: string } = {},
): RunResult {
  const r = spawnSync(CLI, args, {
    cwd: PROJECT_DIR,
    encoding: "utf8",
    stdio: options.input !== undefined
      ? ["pipe", "pipe", "pipe"]
      : ["ignore", "pipe", "pipe"],
    env: options.env ?? process.env,
    input: options.input,
  });
  return {
    status: r.status ?? 1,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
  };
}

/** Create a fake cache leaf entry at `<root>/<hash[0:2]>/<hash[2:]>/combined.png`
 *  with the given byte size and mtime. Returns the leaf directory path. */
function makeEntry(
  root: string,
  hash: string,
  sizeBytes: number,
  mtimeMs: number,
): string {
  const leafDir = path.join(root, hash.slice(0, 2), hash.slice(2));
  fs.mkdirSync(leafDir, { recursive: true });
  const png = path.join(leafDir, "combined.png");
  fs.writeFileSync(png, Buffer.alloc(sizeBytes, 0));
  const svg = path.join(leafDir, "combined.svg");
  fs.writeFileSync(svg, "<svg/>");
  const t = mtimeMs / 1000;
  fs.utimesSync(png, t, t);
  fs.utimesSync(svg, t, t);
  fs.utimesSync(leafDir, t, t);
  return leafDir;
}

let cacheDir: string;

test.beforeEach(() => {
  cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "kicadiff-cache-test-"));
});

test.afterEach(() => {
  fs.rmSync(cacheDir, { recursive: true, force: true });
});

function envWith(): NodeJS.ProcessEnv {
  return { ...process.env, KICADIFF_CACHE_DIR: cacheDir };
}

test.describe("cache stats", () => {
  test("empty / nonexistent cache prints a friendly message and exits 0", () => {
    const missing = path.join(cacheDir, "does-not-exist");
    const r = runCli(["cache", "stats"], {
      env: { ...process.env, KICADIFF_CACHE_DIR: missing },
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(missing);
    expect(r.stdout).toContain("(empty)");
  });

  test("populated cache reports entry count and total size", () => {
    const now = Date.now();
    makeEntry(cacheDir, "aabbccdd11", 1024, now);
    makeEntry(cacheDir, "aabbeeff22", 2048, now);
    makeEntry(cacheDir, "ccddeeff33", 4096, now);

    const r = runCli(["cache", "stats"], { env: envWith() });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`Cache directory: ${cacheDir}`);
    expect(r.stdout).toMatch(/Entries:\s+3\b/);
    // Total size is at least 1024+2048+4096+(2*small svg). Just check it's a
    // human-readable byte string containing the right magnitude.
    expect(r.stdout).toMatch(/Total size:\s+[\d.]+\s*(B|KiB|MiB|GiB)/);
  });
});

test.describe("cache prune", () => {
  test("--older-than X --dry-run reports what would be deleted, deletes nothing", () => {
    const now = Date.now();
    const day = 24 * 60 * 60 * 1000;
    const oldLeaf = makeEntry(cacheDir, "aaaaaaaaaaa", 1024, now - 30 * day);
    const newLeaf = makeEntry(cacheDir, "bbbbbbbbbbb", 1024, now);

    const r = runCli(["cache", "prune", "--older-than", "7d", "--dry-run"], {
      env: envWith(),
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/Would delete:\s+1\b/);
    expect(fs.existsSync(oldLeaf)).toBe(true);
    expect(fs.existsSync(newLeaf)).toBe(true);
  });

  test("--older-than X deletes only entries older than the cutoff", () => {
    const now = Date.now();
    const day = 24 * 60 * 60 * 1000;
    const oldLeaf = makeEntry(cacheDir, "1111111111", 1024, now - 30 * day);
    const newLeaf = makeEntry(cacheDir, "2222222222", 1024, now);

    const r = runCli(["cache", "prune", "--older-than", "7d"], { env: envWith() });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/Deleted:\s+1\b/);
    expect(fs.existsSync(oldLeaf)).toBe(false);
    expect(fs.existsSync(newLeaf)).toBe(true);
  });

  test("--all --yes empties the cache", () => {
    const now = Date.now();
    makeEntry(cacheDir, "aaaaaaaaaa", 100, now);
    makeEntry(cacheDir, "bbbbbbbbbb", 100, now);

    const r = runCli(["cache", "prune", "--all", "--yes"], { env: envWith() });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/Deleted:\s+2\b/);

    // Cache directory may still exist but should have no leaf entries left
    const stats = runCli(["cache", "stats"], { env: envWith() });
    // After --all the directory is removed → "(empty)" message
    expect(stats.stdout).toContain("(empty)");
  });

  test("--all without --yes in non-TTY exits non-zero with a clear message", () => {
    // spawnSync with stdio: ignore => stdin is not a TTY. The command must
    // refuse rather than hang waiting for confirmation.
    const now = Date.now();
    makeEntry(cacheDir, "aaaaaaaaaa", 100, now);

    const r = runCli(["cache", "prune", "--all"], { env: envWith() });
    expect(r.status).not.toBe(0);
    expect(r.stderr.toLowerCase()).toContain("--yes");
  });

  test("prune without --older-than and without --all errors", () => {
    const r = runCli(["cache", "prune"], { env: envWith() });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/--older-than|--all/);
  });

  test("--older-than with bad duration errors", () => {
    const r = runCli(["cache", "prune", "--older-than", "abc"], { env: envWith() });
    expect(r.status).not.toBe(0);
    expect(r.stderr.toLowerCase()).toMatch(/duration|invalid|unit/);
  });

  test("empty bucket dir is removed after pruning all its leaves", () => {
    const now = Date.now();
    const day = 24 * 60 * 60 * 1000;
    // Two leaves, both old, both in bucket "aa" — pruning both must clean
    // up the now-empty bucket directory too.
    makeEntry(cacheDir, "aa11111111", 100, now - 30 * day);
    makeEntry(cacheDir, "aa22222222", 100, now - 30 * day);
    // A leaf in a different bucket that survives
    makeEntry(cacheDir, "bb33333333", 100, now);

    const r = runCli(["cache", "prune", "--older-than", "7d"], { env: envWith() });
    expect(r.status).toBe(0);
    expect(fs.existsSync(path.join(cacheDir, "aa"))).toBe(false);
    expect(fs.existsSync(path.join(cacheDir, "bb"))).toBe(true);
  });
});
