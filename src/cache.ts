/**
 * Cache management subcommand (`kicadiff cache stats` / `kicadiff cache prune`).
 *
 * The render cache (described in DESIGN.md) is content-addressed and grows
 * unbounded: every kicad-cli version bump, every cache schema bump, and
 * every content edit creates new entries while the old ones linger forever.
 * These subcommands give the user a way to see what's in there and reclaim
 * disk space without resorting to `rm -rf ~/.cache/kicadiff` (which would
 * also nuke entries that *are* still valid and useful).
 *
 * Cache layout (must stay in sync with src/render.ts):
 *   <root>/<hash[0:2]>/<hash[2:]>/{combined.png, combined.svg, extras/…}
 *
 * "Entry" here means a leaf directory containing at least `combined.png` —
 * the rest of the files in a leaf belong to the same cached render. Sizes
 * are summed over every regular file under the root, including the two-char
 * bucket dirs themselves, so the reported total matches `du -sb <root>`.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface CacheEntry {
  /** Absolute path to the leaf cache directory (`<root>/<aa>/<rest>/`). */
  path: string;
  /** Sum of regular file sizes inside this leaf directory, recursive. */
  size: number;
  /** Newest mtime (ms since epoch) of any file in the leaf; falls back to
   *  the leaf directory's own mtime when the leaf is empty. */
  mtimeMs: number;
}

/** Resolve the cache directory the same way render.ts does. Duplicated
 *  here (not imported) so the cache CLI can run without dragging in the
 *  whole render module — useful for fast startup of `cache stats`. The
 *  two implementations are short enough to keep in sync manually. */
export function getCacheDir(): string {
  const env = process.env.KICADIFF_CACHE_DIR;
  if (env) return env;
  const xdg = process.env.XDG_CACHE_HOME;
  const base = xdg ?? path.join(os.homedir(), ".cache");
  return path.join(base, "kicadiff");
}

/** Walk the cache and return one CacheEntry per leaf directory. A "leaf"
 *  is any `<bucket>/<rest>/` dir that contains a `combined.png` — that's
 *  the marker render.ts uses for a cache hit, so anything without it is
 *  either incomplete or not ours and we leave it alone. */
export function walkCache(cacheDir: string): CacheEntry[] {
  if (!fs.existsSync(cacheDir)) return [];
  const out: CacheEntry[] = [];
  let buckets: string[];
  try {
    buckets = fs.readdirSync(cacheDir);
  } catch {
    return out;
  }
  for (const bucket of buckets) {
    const bucketPath = path.join(cacheDir, bucket);
    let bs: fs.Stats;
    try { bs = fs.statSync(bucketPath); } catch { continue; }
    if (!bs.isDirectory()) continue;
    let leaves: string[];
    try { leaves = fs.readdirSync(bucketPath); } catch { continue; }
    for (const leaf of leaves) {
      const leafPath = path.join(bucketPath, leaf);
      let ls: fs.Stats;
      try { ls = fs.statSync(leafPath); } catch { continue; }
      if (!ls.isDirectory()) continue;
      const marker = path.join(leafPath, "combined.png");
      if (!fs.existsSync(marker)) continue;
      const { size, newest } = sumDir(leafPath);
      out.push({
        path: leafPath,
        size,
        mtimeMs: newest > 0 ? newest : ls.mtimeMs,
      });
    }
  }
  return out;
}

/** Recursive sum of regular file sizes under `dir`, plus the newest file
 *  mtime seen. Symlinks are not followed (lstat). */
function sumDir(dir: string): { size: number; newest: number } {
  let size = 0;
  let newest = 0;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return { size, newest };
  }
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      const sub = sumDir(full);
      size += sub.size;
      if (sub.newest > newest) newest = sub.newest;
    } else if (ent.isFile()) {
      try {
        const st = fs.statSync(full);
        size += st.size;
        if (st.mtimeMs > newest) newest = st.mtimeMs;
      } catch { /* ignore */ }
    }
  }
  return { size, newest };
}

/** Sum of every regular file under the cache root (including bucket dirs,
 *  not just leaves). Matches what `du` would report — useful when the
 *  caller wants the on-disk footprint, not just the prunable footprint. */
function totalCacheSize(cacheDir: string): number {
  if (!fs.existsSync(cacheDir)) return 0;
  return sumDir(cacheDir).size;
}

/** Human-readable byte count: 1024-based (KiB / MiB / GiB), one decimal
 *  place when sub-GiB. Matches `du -h` style closely enough for a CLI. */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(1)} ${units[i]}`;
}

/** Format an age in milliseconds as a short human label ("3 days", "5
 *  hours", "just now"). Used in `cache stats` next to oldest/newest. */
export function formatAge(ms: number): string {
  const sec = Math.max(0, Math.floor(ms / 1000));
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} min`;
  const hr = Math.floor(min / 60);
  if (hr < 48) return `${hr} hours`;
  const day = Math.floor(hr / 24);
  return `${day} days`;
}

/** Parse a duration like "30d", "12h", "45m", "30s" into milliseconds.
 *  The unit is required — bare numbers throw so the user can't accidentally
 *  prune everything by typing `--older-than 7` (would 7 mean seconds?
 *  days?). Returns NaN-free positive integer on success, throws Error on
 *  bad input. */
export function parseDuration(s: string): number {
  const m = /^(\d+)\s*(s|m|h|d)$/.exec(s.trim());
  if (!m) {
    throw new Error(
      `invalid duration "${s}" — expected <number><unit> with unit s/m/h/d (e.g. 30d, 12h, 45m)`,
    );
  }
  const n = Number.parseInt(m[1], 10);
  const unit = m[2];
  const mul: Record<string, number> = {
    s: 1000,
    m: 60 * 1000,
    h: 60 * 60 * 1000,
    d: 24 * 60 * 60 * 1000,
  };
  return n * mul[unit];
}

/** Format an mtime in milliseconds as "YYYY-MM-DD HH:MM UTC". UTC because
 *  the cache is per-user but the host timezone may vary across CI / cron
 *  contexts the cache outlives, and the absolute timestamp is the load-
 *  bearing piece — relative age is shown separately in parentheses. */
function formatTimestamp(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => n.toString().padStart(2, "0");
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`
  );
}

function printStats(cacheDir: string): void {
  if (!fs.existsSync(cacheDir)) {
    console.log(`Cache directory: ${cacheDir} (empty)`);
    return;
  }
  const entries = walkCache(cacheDir);
  if (entries.length === 0) {
    console.log(`Cache directory: ${cacheDir} (empty)`);
    return;
  }
  // Use the total disk footprint (every regular file under root) rather
  // than summing only leaves: bucket dirs are negligible but a stray temp
  // file would otherwise misreport free-space savings.
  const totalSize = totalCacheSize(cacheDir);
  let oldest = entries[0].mtimeMs;
  let newest = entries[0].mtimeMs;
  for (const e of entries) {
    if (e.mtimeMs < oldest) oldest = e.mtimeMs;
    if (e.mtimeMs > newest) newest = e.mtimeMs;
  }
  const now = Date.now();
  console.log(`Cache directory: ${cacheDir}`);
  console.log(`Entries:         ${entries.length}`);
  console.log(`Total size:      ${formatSize(totalSize)}`);
  console.log(`Oldest entry:    ${formatTimestamp(oldest)} (${formatAge(now - oldest)})`);
  console.log(`Newest entry:    ${formatTimestamp(newest)} (${formatAge(now - newest)})`);
}

interface PruneOptions {
  /** Cutoff in ms (delete entries older than this), or "all" to delete
   *  every entry regardless of age. */
  selector: { kind: "olderThan"; ms: number } | { kind: "all" };
  dryRun: boolean;
}

/** Identify the entries to delete, then delete them (or report them, in
 *  dry-run). Returns the counts so the caller can print a uniform summary
 *  line. After deleting leaves we also rmdir any bucket dir that's empty
 *  — the two-level layout is an internal implementation detail and should
 *  not leak empty 2-char dirs into the user's view. */
function pruneEntries(
  cacheDir: string,
  options: PruneOptions,
): { deleted: number; totalSize: number; targets: CacheEntry[] } {
  const entries = walkCache(cacheDir);
  const now = Date.now();
  const targets = entries.filter((e) => {
    if (options.selector.kind === "all") return true;
    return now - e.mtimeMs > options.selector.ms;
  });
  const totalSize = targets.reduce((acc, e) => acc + e.size, 0);
  if (options.dryRun) {
    return { deleted: targets.length, totalSize, targets };
  }
  const touchedBuckets = new Set<string>();
  for (const t of targets) {
    try {
      fs.rmSync(t.path, { recursive: true, force: true });
      touchedBuckets.add(path.dirname(t.path));
    } catch { /* best-effort: skip and continue */ }
  }
  // Remove now-empty bucket dirs so the layout stays tidy. rmdir refuses
  // non-empty dirs, which is exactly what we want.
  for (const b of touchedBuckets) {
    try {
      const remaining = fs.readdirSync(b);
      if (remaining.length === 0) fs.rmdirSync(b);
    } catch { /* ignore */ }
  }
  // If --all and the cache root is now empty, remove it too: `cache stats`
  // will then report "(empty)" cleanly without any leftover bucket detritus.
  if (options.selector.kind === "all") {
    try {
      const remaining = fs.readdirSync(cacheDir);
      if (remaining.length === 0) fs.rmdirSync(cacheDir);
    } catch { /* ignore */ }
  }
  return { deleted: targets.length, totalSize, targets };
}

function pruneHelp(): void {
  console.log(`kicadiff cache — manage the render cache

Usage:
  kicadiff cache stats
  kicadiff cache prune --older-than <duration> [--dry-run]
  kicadiff cache prune --all [--yes] [--dry-run]

Subcommands:
  stats              Print cache directory, entry count, total size, and the
                     age of the oldest / newest entry.

  prune              Delete cache entries.
    --older-than D   Delete entries whose mtime is older than D. D is
                     <number><unit> with unit s/m/h/d (e.g. 30d, 12h, 45m).
                     The unit is required.
    --all            Delete every cache entry. Requires --yes when stdin
                     is not a TTY (so CI doesn't hang on the prompt). Always
                     requires explicit confirmation interactively.
    --dry-run        Print what would be deleted, change nothing on disk.
    --yes, -y        Skip the confirmation prompt for --all.

Env:
  KICADIFF_CACHE_DIR   Override the cache directory (default:
                       \$XDG_CACHE_HOME/kicadiff or ~/.cache/kicadiff).
`);
}

/** Read a single line from stdin synchronously. Used only for the
 *  interactive `--all` confirmation; non-TTY callers must pass `--yes`
 *  upfront so we never reach this path in CI. */
function readConfirm(): string {
  const buf = Buffer.alloc(64);
  let acc = "";
  try {
    for (;;) {
      const n = fs.readSync(0, buf, 0, buf.length, null);
      if (n <= 0) break;
      acc += buf.subarray(0, n).toString("utf8");
      if (acc.includes("\n")) break;
    }
  } catch { /* fall through with whatever we have */ }
  return acc.split("\n")[0].trim().toLowerCase();
}

/** Parse and dispatch `kicadiff cache <action> [...]`. Returns the exit
 *  code so the top-level CLI can `process.exit(runCache(...))` without
 *  needing to know the per-action semantics. */
export function runCache(argv: string[]): number {
  if (argv.length === 0 || argv[0] === "-h" || argv[0] === "--help") {
    pruneHelp();
    return argv.length === 0 ? 1 : 0;
  }
  const action = argv[0];
  const rest = argv.slice(1);

  if (action === "stats") {
    printStats(getCacheDir());
    return 0;
  }
  if (action === "prune") {
    return runPrune(rest);
  }
  console.error(`Error: unknown cache action: ${action}`);
  pruneHelp();
  return 1;
}

function runPrune(argv: string[]): number {
  let olderThan: string | undefined;
  let all = false;
  let dryRun = false;
  let yes = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--older-than") {
      if (i + 1 >= argv.length) {
        console.error("Error: --older-than requires a value (e.g. 30d)");
        return 1;
      }
      olderThan = argv[++i];
    } else if (a.startsWith("--older-than=")) {
      olderThan = a.slice("--older-than=".length);
    } else if (a === "--all") {
      all = true;
    } else if (a === "--dry-run") {
      dryRun = true;
    } else if (a === "--yes" || a === "-y") {
      yes = true;
    } else if (a === "-h" || a === "--help") {
      pruneHelp();
      return 0;
    } else {
      console.error(`Error: unknown option to \`cache prune\`: ${a}`);
      return 1;
    }
  }

  if (!olderThan && !all) {
    console.error("Error: `cache prune` requires --older-than <duration> or --all");
    return 1;
  }
  if (olderThan && all) {
    console.error("Error: --older-than and --all are mutually exclusive");
    return 1;
  }

  const cacheDir = getCacheDir();
  if (!fs.existsSync(cacheDir)) {
    console.log(`Cache directory: ${cacheDir} (empty)`);
    return 0;
  }

  let selector: PruneOptions["selector"];
  if (all) {
    selector = { kind: "all" };
    // Destructive: require explicit confirmation. In non-TTY environments
    // we refuse rather than prompt — silently hanging in CI is the worst
    // possible behaviour for a cache management command.
    if (!yes && !dryRun) {
      const isTty = !!process.stdin.isTTY;
      if (!isTty) {
        console.error(
          "Error: `cache prune --all` in a non-TTY environment requires --yes (refusing to prompt)",
        );
        return 1;
      }
      process.stdout.write(
        `About to delete EVERY entry in ${cacheDir}. Type 'yes' to confirm: `,
      );
      const ans = readConfirm();
      if (ans !== "yes") {
        console.log("Aborted.");
        return 1;
      }
    }
    console.log(`Pruning all entries from ${cacheDir}`);
  } else {
    let ms: number;
    try {
      ms = parseDuration(olderThan!);
    } catch (e) {
      console.error(`Error: ${(e as Error).message}`);
      return 1;
    }
    selector = { kind: "olderThan", ms };
    console.log(`Pruning entries older than ${olderThan} from ${cacheDir}`);
  }

  const result = pruneEntries(cacheDir, { selector, dryRun });
  const label = dryRun ? "Would delete:" : "Deleted:";
  // Pad label so the value column lines up with `cache stats` output.
  console.log(`${label.padEnd(13)} ${result.deleted} entries, ${formatSize(result.totalSize)}${dryRun ? "  (dry-run)" : ""}`);
  return 0;
}
