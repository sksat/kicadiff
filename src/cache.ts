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
 *   <root>/.kicadiff-cache              # zero-byte sentinel (see below)
 *   <root>/<hash[0:2]>/<hash[2:]>/{combined.png, combined.svg, extras/…}
 *
 * "Entry" here means a leaf directory containing at least `combined.png` —
 * the rest of the files in a leaf belong to the same cached render. The
 * size figure reported by `cache stats` is the sum of regular-file sizes
 * under the cache root (directories themselves contribute 0). Symlinks
 * are skipped (never followed), so the total reflects bytes physically
 * stored under the cache root — close to `du -sb <root>` minus link
 * targets, and never inflated by a link pointing elsewhere.
 *
 * Sentinel: the `.kicadiff-cache` marker at the root exists so the
 * destructive `cache prune --all` cannot wipe a misconfigured
 * KICADIFF_CACHE_DIR that happens to point at an unrelated directory.
 * The marker is dropped on first cache write AND on first read, so
 * pre-sentinel caches auto-upgrade on next use.
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

/** Marker file dropped at the cache root that proves "this directory is
 *  a kicadiff cache". `cache prune --all` refuses to recursively delete
 *  the root unless this file is present, so a stray
 *  `KICADIFF_CACHE_DIR=$HOME` (or similar) can't silently wipe an
 *  unrelated tree. Zero bytes; nothing reads its contents. */
export const SENTINEL_NAME = ".kicadiff-cache";

/** Drop the sentinel at the cache root if the root exists and the file
 *  isn't already there. Best-effort: any I/O failure (read-only FS,
 *  permission denied) is swallowed because the only consequence is that
 *  `cache prune --all` will require the user to drop the marker manually
 *  — strictly safer than aborting the entire read path on an upgrade. */
export function ensureSentinel(cacheDir: string): void {
  try {
    if (!fs.existsSync(cacheDir)) return;
    const marker = path.join(cacheDir, SENTINEL_NAME);
    if (fs.existsSync(marker)) return;
    fs.writeFileSync(marker, "");
  } catch {
    /* best-effort upgrade; ignore */
  }
}

/** Bucket directory names produced by the cache writer: exactly two
 *  lowercase hex chars (`hash[0:2]`). Anything else under the cache root
 *  is foreign — possibly a symlink someone dropped in, a `.tmp` from a
 *  crashed run, or just a stray file — and we refuse to traverse it so
 *  `cache stats` / `cache prune` can never escape the intended layout. */
const BUCKET_NAME_RE = /^[0-9a-f]{2}$/;
/** Leaf directory names produced by the cache writer: the remaining hex
 *  tail of the hash (`hash[2:]`). Same rationale as BUCKET_NAME_RE. */
const LEAF_NAME_RE = /^[0-9a-f]+$/;

export interface WalkResult {
  entries: CacheEntry[];
  /** Sum of regular file bytes contributed by recognised cache content
   *  (bucket subtrees) plus any foreign top-level *files* (sentinel,
   *  stray README, etc.). Foreign top-level **directories** are NOT
   *  traversed — a misconfigured KICADIFF_CACHE_DIR (e.g. pointing at
   *  $HOME) used to make `cache stats` recursively sum every byte in
   *  an unrelated tree and could appear to hang on huge homedirs.
   *  Anything sitting in a non-bucket subtree therefore goes
   *  unaccounted for in this figure (it will still be wiped by
   *  `cache prune --all`, which is documented to reclaim more than
   *  what `stats` reports). */
  totalSize: number;
}

/** Walk the cache and return one CacheEntry per leaf directory plus the
 *  total on-disk size of the cache root. A "leaf" is any
 *  `<bucket>/<rest>/` dir that contains a `combined.png` — that's the
 *  marker render.ts uses for a cache hit, so anything without it is
 *  either incomplete or not ours and we leave it alone (but still count
 *  its bytes towards totalSize).
 *
 *  Single-pass: the previous implementation called `sumDir(leafPath)`
 *  here and `sumDir(cacheDir)` separately from `printStats`, which
 *  doubled filesystem I/O on large caches. We now sum the whole root
 *  once and remember per-leaf subtotals as we go.
 *
 *  Traversal is hardened against escape: bucket/leaf names must match
 *  the hex shape the cache writer emits, and each directory check uses
 *  `lstatSync` so a symlink under the cache root can't redirect the
 *  walk outside it.
 *
 *  Side-effect: drops the `.kicadiff-cache` sentinel if missing, so
 *  pre-sentinel caches auto-upgrade on next read. */
export function walkCache(cacheDir: string): WalkResult {
  if (!fs.existsSync(cacheDir)) return { entries: [], totalSize: 0 };
  const entries: CacheEntry[] = [];
  let totalSize = 0;
  let topLevel: fs.Dirent[];
  try {
    topLevel = fs.readdirSync(cacheDir, { withFileTypes: true });
  } catch {
    return { entries, totalSize };
  }
  for (const top of topLevel) {
    const topPath = path.join(cacheDir, top.name);
    let topSt: fs.Stats;
    try { topSt = fs.lstatSync(topPath); } catch { continue; }
    // Symlinks at the top level: skip entirely (don't count, don't walk).
    if (topSt.isSymbolicLink()) continue;
    if (topSt.isFile()) {
      // Foreign file at the cache root (sentinel, stray README, etc.) —
      // counted towards totalSize so `cache stats` matches what `--all`
      // will actually reclaim.
      totalSize += topSt.size;
      continue;
    }
    if (!topSt.isDirectory()) continue;
    if (!BUCKET_NAME_RE.test(top.name)) {
      // Foreign top-level directory: don't traverse it at all. The cache
      // layout is strict (`<hash[0:2]>/<hash[2:]>/`), so a non-hex dir
      // is not ours. The previous behaviour recursively summed it for
      // `totalSize`, which on a misconfigured KICADIFF_CACHE_DIR (e.g.
      // $HOME) could walk a huge unrelated tree and appear to hang.
      // `cache prune --all` will still wipe the dir via the recursive
      // root rm — `stats` just under-reports its bytes by design.
      continue;
    }
    const bucketPath = topPath;
    let leaves: string[];
    try { leaves = fs.readdirSync(bucketPath); } catch { continue; }
    for (const leaf of leaves) {
      const leafPath = path.join(bucketPath, leaf);
      let ls: fs.Stats;
      try { ls = fs.lstatSync(leafPath); } catch { continue; }
      if (ls.isSymbolicLink()) continue;
      // Sum the bytes regardless of whether the name validates — they
      // sit under the cache root and contribute to disk usage.
      if (ls.isFile()) {
        totalSize += ls.size;
        continue;
      }
      if (!ls.isDirectory()) continue;
      // Validate the leaf name AND the combined.png marker BEFORE
      // recursing with sumDir. The previous order called sumDir first,
      // so a foreign directory living under a valid 2-hex bucket name
      // (e.g. a user's pre-existing `aa/some-non-hex-name/` if
      // KICADIFF_CACHE_DIR was misrouted) still triggered a full
      // recursive scan. Mirrors the foreign top-level-dir skip pattern
      // above: anything that doesn't pass the shape check is not ours,
      // so don't pay the I/O. `cache prune --all` will still wipe it
      // via the recursive root rm — `stats` just under-reports its
      // bytes by design.
      if (!LEAF_NAME_RE.test(leaf)) continue;
      const marker = path.join(leafPath, "combined.png");
      // Marker existence: lstat so a symlinked combined.png doesn't trick
      // the walker into treating the leaf as a real entry.
      let markerSt: fs.Stats;
      try { markerSt = fs.lstatSync(marker); } catch { continue; }
      if (!markerSt.isFile()) continue;
      const { size: leafSize, newest } = sumDir(leafPath);
      totalSize += leafSize;
      entries.push({
        path: leafPath,
        size: leafSize,
        mtimeMs: newest > 0 ? newest : ls.mtimeMs,
      });
    }
  }
  // Auto-upgrade pre-sentinel caches: if we recognised at least one
  // leaf, this is unambiguously a kicadiff cache and dropping the
  // marker makes future `cache prune --all` runs work without a manual
  // step. If there were zero leaves we leave the dir alone so the
  // safety guard can still refuse an unrelated directory.
  if (entries.length > 0) ensureSentinel(cacheDir);
  return { entries, totalSize };
}

/** Enumerate top-level entries under `cacheDir` that are NOT recognised
 *  cache content — i.e. anything other than a valid 2-hex bucket
 *  directory or the sentinel marker. Returns just the *names* (with a
 *  trailing `/` on directories) so the caller can list / count them
 *  without ever recursing — the whole point is to surface what
 *  `cache prune --all` would also wipe, without re-introducing the
 *  "could hang on huge unrelated trees" cost the bucket-name guard
 *  exists to avoid.
 *
 *  Symlinks are reported by name (they're real top-level entries that
 *  `--all` will remove), but their targets are NOT traversed. The
 *  sentinel file is filtered out — it's an implementation detail of
 *  the safety guard, not user-visible foreign content. */
export function listForeignTopLevel(cacheDir: string): string[] {
  if (!fs.existsSync(cacheDir)) return [];
  let topLevel: fs.Dirent[];
  try {
    topLevel = fs.readdirSync(cacheDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const foreign: string[] = [];
  for (const top of topLevel) {
    if (top.name === SENTINEL_NAME) continue;
    const topPath = path.join(cacheDir, top.name);
    let st: fs.Stats;
    try { st = fs.lstatSync(topPath); } catch { continue; }
    if (st.isDirectory()) {
      if (BUCKET_NAME_RE.test(top.name)) continue; // recognised bucket
      foreign.push(`${top.name}/`);
    } else {
      // Regular file or symlink at the top level: not part of the cache
      // layout, so it's foreign. Don't follow symlinks.
      foreign.push(top.name);
    }
  }
  return foreign;
}

/** Recursive sum of regular file sizes under `dir`, plus the newest file
 *  mtime seen. Uses `lstatSync` throughout: symlinks (file or dir) are
 *  skipped entirely — their target sizes are NOT counted. This matches
 *  `du -sb` minus link targets (i.e. `du -sb` without `-L`, where symlink
 *  sizes themselves are 0 in our accounting). The intent is filesystem-
 *  content-only reporting so a self-referential or external symlink can
 *  never inflate the total. */
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
    let st: fs.Stats;
    try { st = fs.lstatSync(full); } catch { continue; }
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) {
      const sub = sumDir(full);
      size += sub.size;
      if (sub.newest > newest) newest = sub.newest;
    } else if (st.isFile()) {
      size += st.size;
      if (st.mtimeMs > newest) newest = st.mtimeMs;
    }
  }
  return { size, newest };
}

/** Human-readable byte count: 1024-based (KiB / MiB / GiB / TiB), one
 *  decimal place for KiB and above (bytes are printed as an integer).
 *  Matches `du -h` style closely enough for a CLI. */
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
 *  hours", "just now"). Used in `cache stats` next to oldest/newest.
 *  Anything under a minute collapses to "just now" — second-precision
 *  ages aren't actionable for cache management and "0s" reads as a bug.
 *
 *  Long-form unit names (matches the "just now" sibling) and
 *  singularised when the value is exactly 1 — `1 hours` / `1 days`
 *  reads as a grammar bug in user-facing output. */
export function formatAge(ms: number): string {
  const sec = Math.max(0, Math.floor(ms / 1000));
  if (sec < 60) return "just now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} ${min === 1 ? "minute" : "minutes"}`;
  const hr = Math.floor(min / 60);
  if (hr < 48) return `${hr} ${hr === 1 ? "hour" : "hours"}`;
  const day = Math.floor(hr / 24);
  return `${day} ${day === 1 ? "day" : "days"}`;
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
  // Single traversal: walkCache returns both the per-entry list and the
  // total on-disk size so large caches don't pay 2x filesystem I/O for
  // `cache stats`.
  const { entries, totalSize } = walkCache(cacheDir);
  if (entries.length === 0) {
    console.log(`Cache directory: ${cacheDir} (empty)`);
    return;
  }
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

interface PruneResult {
  /** Number of entries actually removed (or, in dry-run, that would be). */
  deleted: number;
  /** Total bytes removed (sum of `size` over deleted entries). */
  totalSize: number;
  /** Targets selected for deletion (returned for caller-side reporting). */
  targets: CacheEntry[];
  /** Number of deletions that failed (rmSync threw). The caller surfaces
   *  this as a non-zero exit code so CI can flag a partial cleanup. */
  failed: number;
}

/** Identify the entries to delete, then delete them (or report them, in
 *  dry-run). Returns the counts so the caller can print a uniform summary
 *  line. After deleting leaves we also rmdir any bucket dir that's empty
 *  — the two-level layout is an internal implementation detail and should
 *  not leak empty 2-char dirs into the user's view.
 *
 *  For `--all`, after per-entry deletion succeeds we recursively remove
 *  the cache root itself so foreign files (a stray README, a `.tmp` from
 *  a crashed run) are wiped along with the registered entries — that's
 *  what the flag advertises. */
function pruneEntries(
  cacheDir: string,
  options: PruneOptions,
): PruneResult {
  const { entries } = walkCache(cacheDir);
  const now = Date.now();
  const targets = entries.filter((e) => {
    if (options.selector.kind === "all") return true;
    return now - e.mtimeMs > options.selector.ms;
  });
  const totalSize = targets.reduce((acc, e) => acc + e.size, 0);
  if (options.dryRun) {
    return { deleted: targets.length, totalSize, targets, failed: 0 };
  }
  let deleted = 0;
  let failed = 0;
  const touchedBuckets = new Set<string>();
  for (const t of targets) {
    try {
      fs.rmSync(t.path, { recursive: true, force: true });
      deleted++;
      touchedBuckets.add(path.dirname(t.path));
    } catch (e) {
      // Surface the failure so it shows up in CI logs — silently swallowing
      // here is how the original "Deleted: N" line ended up lying.
      console.error(`Error: failed to delete ${t.path}: ${(e as Error).message}`);
      failed++;
    }
  }
  // Remove now-empty bucket dirs so the layout stays tidy. rmdir refuses
  // non-empty dirs, which is exactly what we want.
  for (const b of touchedBuckets) {
    try {
      const remaining = fs.readdirSync(b);
      if (remaining.length === 0) fs.rmdirSync(b);
    } catch { /* ignore */ }
  }
  // --all advertises wiping the whole cache: blow away the root recursively
  // so foreign files at the top level (a leftover README, partial entries
  // that didn't have a combined.png, anything with a non-hex name we
  // refused to walk into) go too. Only do this when no per-entry deletion
  // failed; otherwise we'd be hiding the failure by deleting everything
  // around the offending path.
  if (options.selector.kind === "all" && failed === 0) {
    try {
      fs.rmSync(cacheDir, { recursive: true, force: true });
    } catch (e) {
      console.error(`Error: failed to remove cache root ${cacheDir}: ${(e as Error).message}`);
      failed++;
    }
  }
  return { deleted, totalSize, targets, failed };
}

/** Help text for `kicadiff cache …`. Covers both `stats` and `prune` —
 *  the name reflects that (was previously `pruneHelp`, back when only
 *  `prune` had documentable options). */
function cacheHelp(): void {
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
    --all            Delete every cache entry AND the cache root itself
                     (so any foreign files dropped under the root are also
                     wiped). Confirmation prompt unless --yes is provided;
                     --yes is required in non-TTY environments (CI) so the
                     prompt can't hang a build. Refuses if the cache root
                     has neither a .kicadiff-cache marker (auto-dropped on
                     first cache write / read) nor any recognised entries
                     — protects against a misconfigured KICADIFF_CACHE_DIR
                     wiping an unrelated directory.
    --dry-run        Print what would be deleted, change nothing on disk.
    --yes, -y        Skip the confirmation prompt for --all (required in
                     non-TTY environments).

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
    cacheHelp();
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
  cacheHelp();
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
      cacheHelp();
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
    // Safety guard: `--all` recursively deletes the cache root. A
    // misconfigured `KICADIFF_CACHE_DIR` (e.g. pointing at $HOME by
    // mistake) must not silently wipe an unrelated directory. We
    // require a `.kicadiff-cache` sentinel at the root.
    //
    // Important: this check uses fs.existsSync directly rather than
    // calling walkCache. Even a hostile root (a giant unrelated tree)
    // must not make the guard scan anything — the check has to be
    // O(1) so the guard always completes promptly. Pre-sentinel
    // caches auto-upgrade via any prior `cache stats` / cache read,
    // which drops the sentinel; users on a pre-sentinel cache who
    // jump straight to `--all` need to either run `cache stats` first
    // or `touch <root>/.kicadiff-cache` to opt in.
    //
    // dry-run skips the guard so users can preview what `--all` would
    // do without first having to mark the directory.
    if (!dryRun) {
      const sentinel = path.join(cacheDir, SENTINEL_NAME);
      if (!fs.existsSync(sentinel)) {
        console.error(
          `Error: refusing to recursively delete ${cacheDir} — it has no ${SENTINEL_NAME} marker.`,
        );
        console.error(
          "This guard exists so a misconfigured KICADIFF_CACHE_DIR can't silently wipe an unrelated directory.",
        );
        console.error(
          `If this is a pre-existing kicadiff cache, run \`kicadiff cache stats\` once to auto-install the marker, then retry.`,
        );
        console.error(
          `If you really mean to delete this directory, run \`rm -rf ${cacheDir}\` manually.`,
        );
        return 1;
      }
    }
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
  // For `--all --dry-run`, the summary above is derived only from
  // recognised cache entries — but the real `--all` recursively wipes
  // the cache root, taking any foreign top-level files / directories
  // with it. Surface those by name (and count) so the dry-run preview
  // doesn't mislead the user about the true reclaim. We only enumerate
  // top-level entries here (no recursion) — that's deliberate: the
  // bucket-name guard in walkCache exists so `cache stats` doesn't
  // appear to hang on a huge unrelated tree, and we must not reintroduce
  // that cost just to get a more precise byte count.
  if (dryRun && all) {
    const foreign = listForeignTopLevel(cacheDir);
    if (foreign.length > 0) {
      const listing = foreign.slice(0, 10).join(", ");
      const suffix = foreign.length > 10 ? ", ..." : "";
      console.log(
        `Would also wipe: ${foreign.length} foreign top-level entr${
          foreign.length === 1 ? "y" : "ies"
        } (--all removes the cache root): ${listing}${suffix}`,
      );
    }
  }
  if (result.failed > 0) {
    console.error(`Error: ${result.failed} deletion(s) failed; cache is partially pruned`);
    return 1;
  }
  return 0;
}
