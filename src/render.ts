/**
 * kicadiff core rendering logic.
 *
 * Generates Before/After images and diff HTML for a KiCad file.
 * Migrated from render.sh — see git history for the bash version.
 */

import { execFileSync, spawn, spawnSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { fileURLToPath } from "node:url";
import which from "which";
import VIEWER_HTML from "./viewer-content.ts";
import type { FileType, Manifest, ProjectManifest, SideManifest } from "./types.ts";
import { splitDiff } from "./diff-overlay.ts";
import { compositePcbLayers } from "./composite.ts";
import { Resvg } from "@resvg/resvg-js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** SVG → PNG conversion. Replaces the previous shellout to `rsvg-convert`,
 *  so the runtime no longer needs librsvg installed. resvg is a Rust SVG
 *  rasteriser exposed via `@resvg/resvg-js`; we instantiate one Resvg per
 *  call (cheap) and let it pick the right native binding for the host. */
function rasterise(svgPath: string, pngPath: string, widthPx: number): void {
  const svg = fs.readFileSync(svgPath);
  const resvg = new Resvg(svg, {
    fitTo: { mode: "width", value: widthPx },
  });
  fs.writeFileSync(pngPath, resvg.render().asPng());
}

const PCB_LAYERS = "F.Cu,B.Cu,F.Silkscreen,B.Silkscreen,Edge.Cuts";
// python3 used to be required by an earlier bash-era hook; the TS render
// path doesn't shell out to it, so requiring it would needlessly fail on
// machines that have kicad-cli but no Python.
const REQUIRED_TOOLS = ["kicad-cli"] as const;

export interface RenderOptions {
  /** Path to .kicad_pcb or .kicad_sch file (absolute or relative) */
  filePath: string;
  /** Output directory (defaults to <repo>/.claude/preview) */
  outputDir?: string;
  /** Skip HTML generation and VSCode auto-open */
  imagesOnly?: boolean;
  /** "Before" git ref. Default: "HEAD".
   *  Special value "" or "working" means use the working tree (no before render). */
  fromRef?: string;
  /** "After" git ref. Default: "" (working tree). Use a ref name to compare two commits. */
  toRef?: string;
  /** Open the resulting HTML after rendering.
   *   - undefined: don't auto-open (default)
   *   - "xdg": xdg-open (system default)
   *   - "vscode": `code -r` (VSCode tab)
   *   - any other string: treated as an executable name (e.g. "firefox",
   *     "chromium"); spawned with the HTML path as its argument.
   *  Override with KICADIFF_OPEN_CMD env var (full command, html path appended). */
  open?: string;
  /** Disable the per-side render cache. Default: cache enabled.
   *  When false, the rendered PNGs are also persisted to ~/.cache/kicadiff/
   *  so that subsequent runs against the same content return near-instantly. */
  noCache?: boolean;
}

export interface RenderResult {
  filePath: string;
  relPath: string;
  fileType: FileType;
  outputDir: string;
  afterPng: string;
  beforePng?: string;
  diffPng?: string;
  diffHtml?: string;
  manifest: Manifest;
}

// =============================================================================
// Helpers
// =============================================================================

/** Check if a command is available on $PATH (uses npm `which`). */
function hasCommand(cmd: string): boolean {
  return which.sync(cmd, { nothrow: true }) !== null;
}

function checkDependencies(): void {
  for (const tool of REQUIRED_TOOLS) {
    if (!hasCommand(tool)) {
      throw new Error(`required command not found: ${tool}`);
    }
  }
}

/** Run a command async, throwing on non-zero exit. stderr is inherited so
 *  diagnostics surface. Suitable for Promise.all parallelization. */
function run(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "ignore", "inherit"] });
    child.on("error", reject);
    child.on("close", code => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} failed (exit ${code}): ${args.join(" ")}`));
    });
  });
}

/** Run a command async, ignoring failures (used for optional tools). */
function tryRun(cmd: string, args: string[]): Promise<boolean> {
  return new Promise(resolve => {
    const child = spawn(cmd, args, { stdio: ["ignore", "ignore", "ignore"] });
    child.on("error", () => resolve(false));
    child.on("close", code => resolve(code === 0));
  });
}

/** Sanitize a path into an allowlisted filename. */
function safeName(relPath: string): string {
  return relPath.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function getRepoRoot(filePath: string): string | null {
  // Walk up from the file's parent until we find an existing directory —
  // when a file (or its directory) was deleted in the working tree, the
  // immediate parent may not exist anymore even though the repo does.
  // Using `git -C <missing-dir>` would fail there and we'd lose the ability
  // to resolve refs for the deleted-file flow.
  let dir = path.dirname(filePath);
  while (!fs.existsSync(dir)) {
    const parent = path.dirname(dir);
    if (parent === dir) break; // hit filesystem root
    dir = parent;
  }
  const r = spawnSync("git", ["-C", dir, "rev-parse", "--show-toplevel"], {
    encoding: "utf8",
  });
  return r.status === 0 ? r.stdout.trim() : null;
}

function gitHasFileAtRef(repoRoot: string, ref: string, relPath: string): boolean {
  const r = spawnSync("git", ["-C", repoRoot, "cat-file", "-e", `${ref}:${relPath}`]);
  return r.status === 0;
}

/** Read `<ref>:<relPath>` content as a Buffer. Returns null if the path does
 *  not exist at that ref. */
function gitReadAtRef(repoRoot: string, ref: string, relPath: string): Buffer | null {
  if (!gitHasFileAtRef(repoRoot, ref, relPath)) return null;
  return execFileSync("git", ["-C", repoRoot, "show", `${ref}:${relPath}`], {
    maxBuffer: 32 * 1024 * 1024,
  });
}

/** Pin a (possibly mutable) ref to its current commit SHA.
 *  Branch names, tag names, "HEAD", "HEAD~1", … all point at commits that
 *  can move between separate `git show` invocations during a single render
 *  (someone pushes to the branch, `git fetch` updates a remote-tracking
 *  branch, a tag is force-recreated, …). Within one render we call git
 *  several times — once for the .kicad_pcb/.kicad_sch content, then again
 *  for each sibling .kicad_pro / .kicad_prl, then a third time when writing
 *  the temp files kicad-cli reads. If the ref moves between those calls we
 *  silently mix bytes from two different commits.
 *
 *  Resolving the ref to a 40-char SHA up front and passing that SHA into
 *  every subsequent `git show` makes the render atomic against branch
 *  movement: even if the branch advances mid-render, we keep reading from
 *  the snapshot we pinned on entry.
 *
 *  `""` / `"working"` (the working-tree marker) pass through unchanged. */
export function resolveRefToSha(repoRoot: string, ref: string): string {
  if (ref === "" || ref === "working") return ref;
  const r = spawnSync("git", ["-C", repoRoot, "rev-parse", "--verify", "--quiet", `${ref}^{commit}`], {
    encoding: "utf8",
  });
  if (r.status !== 0) throw new Error(`cannot resolve ref to commit: ${ref}`);
  return r.stdout.trim();
}

// =============================================================================
// Render output cache
//
// Rendering kicad-cli + resvg is the slow part of this tool (seconds
// per file), but the result is fully determined by the file's content + the
// kicad-cli version. We hash both into a content-addressed cache so repeated
// runs against the same git ref / unchanged working tree are near-instant.
//
// Cache layout:
//   <root>/<2-char hash prefix>/<rest of hash>/
//     combined.png          ← the side's primary image
//     extras/               ← layers/ (pcb), pages/ (sch), or items/ (sym/fp)
//
// Cache scope: per-side (before and after each get their own entry, keyed by
// their respective source content). Identical content (e.g. unchanged file
// across before/after) hits the same entry.
// =============================================================================

let cachedKicadVersion: string | null = null;

function getKicadCliVersion(): string {
  if (cachedKicadVersion !== null) return cachedKicadVersion;
  try {
    const r = spawnSync("kicad-cli", ["--version"], { encoding: "utf8" });
    cachedKicadVersion = (r.stdout ?? "").trim() || "unknown";
  } catch {
    cachedKicadVersion = "unknown";
  }
  return cachedKicadVersion;
}

function getCacheRoot(): string {
  const env = process.env.KICADIFF_CACHE_DIR;
  if (env) return env;
  const xdg = process.env.XDG_CACHE_HOME;
  const base = xdg ?? path.join(os.homedir(), ".cache");
  return path.join(base, "kicadiff");
}

/** Pre-fetched project sibling content used by the cache key. The caller
 *  is responsible for reading from the right source — disk for working
 *  tree, `git show` for ref renders — so the cache key matches what the
 *  actual rendering will see. */
interface ProjectSibling {
  name: string;        // basename, e.g. "PicoBridge.kicad_pro"
  content: Buffer;
}

/** Read sibling .kicad_pro / .kicad_prl for a pcb/sch file. Returns content
 *  from disk in working-tree mode, from `git show` for a specific ref.
 *  Sym/fp files have no project context, so the result is empty for those. */
function readProjectSiblings(
  filePath: string,
  fileType: FileType,
  ref: string,
  repoRoot: string | null,
): ProjectSibling[] {
  if (fileType !== "pcb" && fileType !== "sch") return [];
  const out: ProjectSibling[] = [];
  const origExt = path.extname(filePath);
  const origStem = filePath.slice(0, -origExt.length);
  const fromWorkingTree = ref === "" || ref === "working";
  for (const sibExt of [".kicad_pro", ".kicad_prl"]) {
    const sibPath = origStem + sibExt;
    let content: Buffer | null = null;
    if (fromWorkingTree) {
      if (fs.existsSync(sibPath)) {
        try { content = fs.readFileSync(sibPath); } catch { /* ignore */ }
      }
    } else if (repoRoot) {
      const sibRel = path.relative(repoRoot, sibPath);
      content = gitReadAtRef(repoRoot, ref, sibRel);
    }
    if (content !== null) {
      out.push({ name: path.basename(sibPath), content });
    }
  }
  return out;
}

function cacheKeyFor(
  content: Buffer,
  fileType: FileType,
  filePath: string,
  siblings: ProjectSibling[],
): string {
  const h = crypto.createHash("sha256");
  // Bumping any of these ingredients invalidates old cache entries:
  //   - kicadiff cache schema version (bump if directory layout changes)
  //   - kicad-cli version (output may change between releases)
  //   - file type (pcb/sch/sym/fp: different render args, different outputs)
  //   - file path (different files at different paths get different caches
  //     even if content is identical — paranoid by design, since kicad-cli's
  //     output may also depend on sibling project files like .kicad_pro)
  //   - sibling .kicad_pro / .kicad_prl content (theme/variant settings that
  //     KiCad reads from the project root affect rendering even when the
  //     .kicad_pcb / .kicad_sch content is unchanged); read from the same
  //     source as the file content (working tree vs. git ref) so the key
  //     matches what kicad-cli will actually see.
  //   - source content
  // Bumped to v4 when SVG → PNG switched from rsvg-convert to
  // @resvg/resvg-js: rasteriser output bytes differ slightly even for
  // visually-identical inputs, so old v3 PNG cache entries would
  // confuse the byte-level hasDiff check.
  // Bump on every change that alters the bytes we cache. v5: PCB
  // combined PNG is now alpha-composited from the per-layer PNGs
  // (viewer-equivalent translucency, F.Cu on top) instead of a flat
  // raster of kicad-cli's combined SVG.
  h.update("kicadiff-cache-v5\0");
  h.update(getKicadCliVersion());
  h.update("\0");
  h.update(fileType);
  h.update("\0");
  h.update(path.resolve(filePath));
  h.update("\0");

  for (const { name, content: c } of siblings) {
    h.update(name);
    h.update("\0");
    h.update(c);
    h.update("\0");
  }

  h.update(content);
  return h.digest("hex");
}

function cachePathFor(hash: string): string {
  // Two-level dir to avoid millions of siblings in one folder
  return path.join(getCacheRoot(), hash.slice(0, 2), hash.slice(2));
}

function extrasDirName(fileType: FileType, safe: string): string {
  if (fileType === "pcb") return `layers_${safe}`;
  if (fileType === "sch") return `sch_pages_${safe}`;
  return `items_${safe}`; // sym, fp
}

/** Try to populate `<sideDir>/<safe>.{png,svg}` and the type-specific extras
 *  dir from a cached render. Returns true on cache hit, false on miss.
 *
 *  Both the PNG and the SVG must be cached for a hit — older cache entries
 *  (PNG-only) miss so the SVG manifest target gets repopulated. */
function loadFromCache(
  hash: string,
  sideDir: string,
  safe: string,
  fileType: FileType,
): boolean {
  const cacheDir = cachePathFor(hash);
  const cachedPng = path.join(cacheDir, "combined.png");
  const cachedSvg = path.join(cacheDir, "combined.svg");
  if (!fs.existsSync(cachedPng) || !fs.existsSync(cachedSvg)) return false;
  fs.mkdirSync(sideDir, { recursive: true });
  fs.copyFileSync(cachedPng, path.join(sideDir, `${safe}.png`));
  fs.copyFileSync(cachedSvg, path.join(sideDir, `${safe}.svg`));
  const cachedExtras = path.join(cacheDir, "extras");
  if (fs.existsSync(cachedExtras)) {
    const targetExtras = path.join(sideDir, extrasDirName(fileType, safe));
    fs.cpSync(cachedExtras, targetExtras, { recursive: true });
  }
  return true;
}

/** Persist a freshly-rendered side into the cache. Best-effort: failures
 *  (disk full, perms) are ignored — the user's render still succeeds. */
function saveToCache(
  hash: string,
  sideDir: string,
  safe: string,
  fileType: FileType,
): void {
  const targetPng = path.join(sideDir, `${safe}.png`);
  const targetSvg = path.join(sideDir, `${safe}.svg`);
  if (!fs.existsSync(targetPng)) return;
  const cacheDir = cachePathFor(hash);
  try {
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.copyFileSync(targetPng, path.join(cacheDir, "combined.png"));
    if (fs.existsSync(targetSvg)) {
      fs.copyFileSync(targetSvg, path.join(cacheDir, "combined.svg"));
    }
    const extrasSrc = path.join(sideDir, extrasDirName(fileType, safe));
    if (fs.existsSync(extrasSrc)) {
      fs.cpSync(extrasSrc, path.join(cacheDir, "extras"), { recursive: true });
    }
  } catch {
    // Cache write failures are non-fatal — the user has the rendered output already
  }
}

/** Write `content` to a temp file beside `nearFile`, preserving its extension.
 *  Used to give kicad-cli an on-disk path for git-extracted content (it can't
 *  read from stdin). O_EXCL avoids races between parallel renders that share
 *  a directory (notably `.pretty/` libraries with many footprints). */
function writeContentToTempBeside(content: Buffer, nearFile: string): string {
  const dir = path.dirname(nearFile);
  const ext = path.extname(nearFile);
  for (let attempt = 0; attempt < 5; attempt++) {
    const rand = Math.random().toString(36).slice(2, 8);
    const tmp = path.join(dir, `preview_${rand}${ext}`);
    try {
      const fd = fs.openSync(tmp, "wx");
      fs.writeSync(fd, content);
      fs.closeSync(fd);
      return tmp;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
  }
  throw new Error("failed to create temp file beside " + nearFile);
}

// =============================================================================
// Rendering primitives
// =============================================================================

async function renderPcbCombined(input: string, outputSvg: string): Promise<void> {
  await run("kicad-cli", [
    "pcb", "export", "svg",
    "--mode-single",
    "--layers", PCB_LAYERS,
    "--page-size-mode", "2",
    "--exclude-drawing-sheet",
    "-o", outputSvg,
    input,
  ]);
}

async function renderPcbLayers(input: string, outputDir: string): Promise<void> {
  fs.mkdirSync(outputDir, { recursive: true });
  await run("kicad-cli", [
    "pcb", "export", "svg",
    "--mode-multi",
    "--layers", PCB_LAYERS,
    "--page-size-mode", "2",
    "--exclude-drawing-sheet",
    "-o", `${outputDir}/`,
    input,
  ]);
  // Convert each generated SVG to PNG (preserves alpha). resvg-js is
  // synchronous so there's no async to await, but we still touch every SVG
  // sequentially — kicad-cli is the heavy step, not this.
  for (const f of fs.readdirSync(outputDir)) {
    if (!f.endsWith(".svg")) continue;
    const svg = path.join(outputDir, f);
    rasterise(svg, svg.replace(/\.svg$/, ".png"), 1600);
  }
}

/** Render a schematic. For multi-sheet (hierarchical) schematics, kicad-cli
 *  emits one SVG per sheet: `<basename>.svg` (root) + `<basename>-<sub>.svg`.
 *
 *  Output layout:
 *    <sideDir>/<safe>.png            ← root sheet PNG (compatibility, "combined")
 *    <sideDir>/sch_pages_<safe>/     ← per-page PNGs, named by sheet
 *      <rootName>.png
 *      <subsheet1>.png
 *      ...
 *
 *  Returns the list of pages, sorted with root first. The root entry's `png`
 *  field points to the side-level `<safe>.png` (same content, two locations
 *  for backward-compat with the manifest's `combined` field). */
async function renderSch(
  input: string,
  sideDir: string,
  rootPng: string,
  pagesDir: string,
  rootName: string,
): Promise<{ name: string; image: string }[]> {
  fs.mkdirSync(sideDir, { recursive: true });
  fs.mkdirSync(pagesDir, { recursive: true });
  // Export all sheets to pagesDir so they don't collide with PCB outputs
  // when both file types render into the same side directory.
  await run("kicad-cli", [
    "sch", "export", "svg",
    "--exclude-drawing-sheet",
    "--no-background-color",
    "-o", pagesDir,
    input,
  ]);

  // kicad-cli names the root output after the input filename's basename,
  // not after the project's basename. We pass rootName so before/after sides
  // (which may use a temp file from `git show`) produce identically-named
  // pages. The actual input basename used by kicad-cli:
  const inputBaseName = path.basename(input, ".kicad_sch");

  // Collect all SVGs anchored to inputBaseName (root + `<base>-*.svg` subsheets)
  const svgFiles = fs.readdirSync(pagesDir)
    .filter(f => f.endsWith(".svg"))
    .filter(f => f === `${inputBaseName}.svg` || f.startsWith(`${inputBaseName}-`));

  // Map kicad-cli output names → stable page names. The root page uses the
  // caller-provided `rootName` (the project basename) so before/after sides
  // produce identically-named pages even when the before-side rendered from
  // a temp file with a different basename. We also record the *stable* SVG
  // path (renamed below) since that is what the manifest references.
  const pages: { name: string; rawSvg: string; svg: string; png: string }[] = svgFiles.map(f => {
    const stem = f.slice(0, -".svg".length);
    const name = stem === inputBaseName
      ? rootName
      : stem.slice(inputBaseName.length + 1);
    return {
      name,
      rawSvg: path.join(pagesDir, f),
      svg: path.join(pagesDir, `${name}.svg`),
      png: path.join(pagesDir, `${name}.png`),
    };
  });
  // Sort: root first, then alphabetical
  pages.sort((a, b) => {
    if (a.name === rootName) return -1;
    if (b.name === rootName) return 1;
    return a.name.localeCompare(b.name);
  });

  // Rename each kicad-cli SVG to its stable page name. We use rename rather
  // than copy + delete so the result is atomic and we don't briefly hold two
  // copies of every sheet on disk. After this, `pagesDir` only contains the
  // stable-named SVGs (plus the PNGs we'll generate next), so buildSchPages
  // can scan for `.svg` without filtering temp-prefix files.
  for (const p of pages) {
    if (p.rawSvg !== p.svg) fs.renameSync(p.rawSvg, p.svg);
  }

  // Convert SVGs to PNG. PNGs are still needed for hasDiff byte-level
  // comparison and for the tri-colour diff overlay; the manifest references
  // the SVGs (so the viewer can zoom indefinitely without rasterisation).
  for (const p of pages) rasterise(p.svg, p.png, 1600);

  // Copy root page artefacts to the side-level "combined" locations.
  const root = pages.find(p => p.name === rootName);
  if (root) {
    fs.copyFileSync(root.png, rootPng);
    fs.copyFileSync(root.svg, rootPng.replace(/\.png$/, ".svg"));
  }

  return pages.map(({ name, svg }) => ({ name, image: svg }));
}

async function svgToPng(svg: string, png: string): Promise<void> {
  if (fs.existsSync(svg)) rasterise(svg, png, 1600);
}

/** Render a symbol library file (.kicad_sym). Each contained symbol becomes
 *  a "page" entry, so the viewer shows a tab strip for selection just like
 *  a multi-sheet schematic. kicad-cli emits one SVG per symbol unit named
 *  `<symbol>_unit<N>.svg`; we currently only surface unit 1 to keep the
 *  page list compact. (Most KiCad symbols have a single unit; multi-unit
 *  parts like opamps or relays are uncommon and can be added later.) */
async function renderSymLib(
  input: string,
  rootPng: string,
  pagesDir: string,
): Promise<{ name: string; image: string }[]> {
  fs.mkdirSync(pagesDir, { recursive: true });
  await run("kicad-cli", [
    "sym", "export", "svg",
    "-o", pagesDir,
    input,
  ]);
  // Filenames look like "<symbol>_unit1.svg"
  const rawSvgs = fs.readdirSync(pagesDir)
    .filter(f => f.endsWith(".svg") && f.endsWith("_unit1.svg"));
  const pages = rawSvgs.map(f => {
    const name = f.slice(0, -"_unit1.svg".length);
    return {
      name,
      rawSvg: path.join(pagesDir, f),
      svg: path.join(pagesDir, `${name}.svg`),
      png: path.join(pagesDir, `${name}.png`),
    };
  });
  pages.sort((a, b) => a.name.localeCompare(b.name));

  // Rename each `<symbol>_unit1.svg` to `<symbol>.svg` so manifest scanning
  // can ignore the kicad-cli unit suffix and the same name reaches both the
  // SVG (manifest target) and the PNG (diff/hasDiff target).
  for (const p of pages) fs.renameSync(p.rawSvg, p.svg);

  for (const p of pages) rasterise(p.svg, p.png, 800);
  // For root/combined: use the first symbol if any.
  if (pages.length > 0) {
    fs.copyFileSync(pages[0].png, rootPng);
    fs.copyFileSync(pages[0].svg, rootPng.replace(/\.png$/, ".svg"));
  }
  return pages.map(({ name, svg }) => ({ name, image: svg }));
}

/** Render a single footprint file (.kicad_mod). kicad-cli scans the entire
 *  containing directory looking for footprints by name, which causes problems
 *  when (a) multiple parallel renders place temp .kicad_mod files in the same
 *  .pretty/ directory, and (b) those temp files contain the same internal
 *  footprint name as the original. Both pollute the library and cause
 *  "Unable to load library" errors.
 *
 *  Workaround: always render against an isolated single-file lib directory.
 *  We copy `input` into a `<pagesDir>/lib.pretty/<name>.kicad_mod` and point
 *  kicad-cli there. This costs one file copy but eliminates the race. */
async function renderFootprint(
  input: string,
  rootPng: string,
  pagesDir: string,
  stableName: string,
): Promise<{ name: string; image: string }[]> {
  fs.mkdirSync(pagesDir, { recursive: true });
  const isolatedLib = path.join(pagesDir, "lib.pretty");
  fs.mkdirSync(isolatedLib, { recursive: true });
  // Copy input into isolated lib using stableName as the filename. kicad-cli
  // identifies footprints by FILENAME within the .pretty library (not by the
  // internal `(footprint NAME ...)` / `(module NAME ...)` header), so the
  // copied filename here is what we pass to --footprint.
  const isolatedFile = path.join(isolatedLib, `${stableName}.kicad_mod`);
  fs.copyFileSync(input, isolatedFile);

  await run("kicad-cli", [
    "fp", "export", "svg",
    "--footprint", stableName,
    "-o", pagesDir,
    isolatedLib,
  ]);
  // kicad-cli emits `<stableName>.svg` since that's the lib filename
  const stableSvg = path.join(pagesDir, `${stableName}.svg`);
  const stablePng = path.join(pagesDir, `${stableName}.png`);
  rasterise(stableSvg, stablePng, 1200);
  // Side-level "combined" gets both the PNG (diff overlay / hasDiff input)
  // and the SVG (manifest target).
  fs.copyFileSync(stablePng, rootPng);
  fs.copyFileSync(stableSvg, rootPng.replace(/\.png$/, ".svg"));

  // Clean up isolated lib (small, but accumulates over many renders)
  fs.rmSync(isolatedLib, { recursive: true, force: true });
  return [{ name: stableName, image: stableSvg }];
}

// =============================================================================
// Output path resolution
// =============================================================================

/** Resolve `--output <arg>` to an absolute file path. If `arg` points at an
 *  existing directory, or ends with a path separator, treat it as a directory
 *  and append `defaultName` inside; otherwise treat it as a file path. The
 *  trailing-separator branch lets users say `--output ./reports/` even when
 *  the directory does not yet exist (we mkdir later). */
export function resolveOutputPath(arg: string, defaultName: string): string {
  const looksLikeDir = arg.endsWith("/") || arg.endsWith(path.sep);
  const resolved = path.resolve(arg);
  let isDir = looksLikeDir;
  if (!isDir) {
    try { isDir = fs.statSync(resolved).isDirectory(); } catch { /* missing → treat as file */ }
  }
  return isDir ? path.join(resolved, defaultName) : resolved;
}

// =============================================================================
// Manifest construction
// =============================================================================

function buildLayerMap(layersDir: string, side: "before" | "after", safe: string): Record<string, string> {
  const map: Record<string, string> = {};
  if (!fs.existsSync(layersDir)) return map;
  const files = fs.readdirSync(layersDir).filter(f => f.endsWith(".svg")).sort();
  for (const f of files) {
    // Filename like "BoardName-F_Cu.svg" — extract layer after last hyphen
    const stem = f.replace(/\.svg$/, "");
    const layerToken = stem.split("-").pop() ?? stem;
    const layerName = layerToken.replace(/_/g, ".");
    map[layerName] = `${side}/layers_${safe}/${f}`;
  }
  return map;
}

/** Scan the schematic per-page directory and return a sorted page list.
 *  The root sheet (matching the schematic basename) is always first; that
 *  basename is recovered by finding the SVG whose name matches the project.
 *  Each page entry's `image` is an SVG so the viewer can zoom in indefinitely. */
function buildSchPages(
  pagesDir: string,
  side: "before" | "after",
  safe: string,
  rootName: string,
): { name: string; image: string }[] {
  if (!fs.existsSync(pagesDir)) return [];
  // Stable-named SVGs are produced by renderSch alongside the kicad-cli
  // outputs. Filter on those so we don't pick up the temp-prefix originals.
  const all = fs.readdirSync(pagesDir).filter(f => f.endsWith(".svg"));
  // The page index uses stable names — see renderSch which copies each page
  // SVG to ${name}.svg. Filter to those (skip kicad-cli's `preview_xxxx.svg`
  // intermediates) by checking the matching `${name}.svg` exists.
  const pages = all.map(f => ({
    name: f.slice(0, -".svg".length),
    image: `${side}/sch_pages_${safe}/${f}`,
  }));
  pages.sort((a, b) => {
    if (a.name === rootName) return -1;
    if (b.name === rootName) return 1;
    return a.name.localeCompare(b.name);
  });
  return pages;
}

/** Scan an items directory (sym/fp) and return entries as pages.
 *  Used for symbol libraries and footprint files where each contained
 *  symbol/footprint becomes a selectable page in the viewer. Surfaces SVG
 *  paths so the viewer can zoom without rasterisation artefacts. */
function buildItemPages(itemsDir: string, side: "before" | "after", safe: string): { name: string; image: string }[] {
  if (!fs.existsSync(itemsDir)) return [];
  const svgs = fs.readdirSync(itemsDir).filter(f => f.endsWith(".svg")).sort();
  return svgs.map(f => ({
    name: f.slice(0, -".svg".length),
    image: `${side}/items_${safe}/${f}`,
  }));
}

function buildManifest(args: {
  relPath: string;
  fileType: FileType;
  outputDir: string;
  safe: string;
  hasBefore: boolean;
  hasAfter: boolean;
  hasDiff?: boolean;
  diffBeforePng?: string;
  diffAfterPng?: string;
  schRootName?: string;
  fromRef?: string;
  toRef?: string;
}): Manifest {
  const {
    relPath, fileType, outputDir, safe, hasBefore, hasAfter, hasDiff,
    diffBeforePng, diffAfterPng, schRootName, fromRef, toRef,
  } = args;

  function buildSide(side: "before" | "after"): SideManifest {
    // Side-level "combined" points at the rendered SVG so the viewer's main
    // image scales without pixelation. The matching PNG still lives next to
    // it (used for hasDiff comparison and the diff highlight overlay).
    const out: SideManifest = { combined: `${side}/${safe}.svg` };
    if (fileType === "pcb") {
      out.layers = buildLayerMap(path.join(outputDir, `${side}/layers_${safe}`), side, safe);
    } else if (fileType === "sch" && schRootName) {
      const pages = buildSchPages(path.join(outputDir, `${side}/sch_pages_${safe}`), side, safe, schRootName);
      if (pages.length > 0) out.pages = pages;
    } else if (fileType === "sym" || fileType === "fp") {
      const pages = buildItemPages(path.join(outputDir, `${side}/items_${safe}`), side, safe);
      if (pages.length > 0) out.pages = pages;
    }
    return out;
  }

  const m: Manifest = { file: relPath, type: fileType, hasBefore };
  if (hasAfter) m.after = buildSide("after");
  if (hasBefore) m.before = buildSide("before");
  // Always echo hasAfter so the viewer can branch on it (hasBefore was
  // already required, but hasAfter is a recent addition — emit it
  // explicitly so older manifests aren't ambiguous).
  m.hasAfter = hasAfter;
  if (hasDiff !== undefined) m.hasDiff = hasDiff;
  if (fromRef !== undefined) m.fromRef = fromRef;
  if (toRef !== undefined) m.toRef = toRef;
  // Per-side diff overlays. Both must exist to set m.diff; the viewer keys
  // off m.diff to enable the highlight toggle and assumes both sides are
  // present together.
  if (
    diffBeforePng && fs.existsSync(diffBeforePng) &&
    diffAfterPng && fs.existsSync(diffAfterPng)
  ) {
    m.diff = {
      before: `diff/${safe}-before.png`,
      after: `diff/${safe}-after.png`,
    };
  }

  // Per-page hasDiff: when the file has selectable pages (multi-sheet sch,
  // sym/fp libraries with multiple items), mark each page (on both sides)
  // with whether its rendered PNG differs from the same-named page on the
  // opposite side. We deliberately compare PNGs (byte-stable rasters), not
  // SVGs (which can wiggle due to whitespace / ordering differences even
  // when the rendered picture is identical). `page.image` is the SVG path
  // we serve to the viewer; `pngFor()` derives the matching PNG sibling.
  const pngFor = (image: string) => image.replace(/\.svg$/, ".png");
  if (m.after?.pages && m.before?.pages) {
    const beforeByName = new Map(m.before.pages.map(p => [p.name, p.image]));
    const afterByName = new Map(m.after.pages.map(p => [p.name, p.image]));
    for (const page of m.after.pages) {
      const beforeRel = beforeByName.get(page.name);
      if (!beforeRel) { page.hasDiff = true; continue; } // page added in after
      try {
        const a = fs.readFileSync(path.join(outputDir, pngFor(page.image)));
        const b = fs.readFileSync(path.join(outputDir, pngFor(beforeRel)));
        page.hasDiff = !a.equals(b);
      } catch {
        page.hasDiff = true;
      }
    }
    for (const page of m.before.pages) {
      // Pages that exist only on the before side were removed at the
      // target ref — definitely a diff.
      if (!afterByName.has(page.name)) page.hasDiff = true;
    }
  } else if (m.after?.pages && !m.before?.pages) {
    // No before context → every page is "new"
    for (const page of m.after.pages) page.hasDiff = true;
  } else if (m.before?.pages && !m.after?.pages) {
    // No after context (file deleted at target ref) → every page is "removed"
    for (const page of m.before.pages) page.hasDiff = true;
  }

  return m;
}

/** Inject the manifest into viewer.html as a <script> tag.
 *  </script> in JSON is escaped to prevent breaking out of the script tag. */
/** Returns the viewer.html content, embedded at build-time as a TS string
 *  (see scripts/embed-viewer.mjs). Bundling this way lets bun --compile
 *  produce a fully self-contained binary with no external assets. */
function readViewerHtml(): string {
  return VIEWER_HTML;
}

function buildHtml(_viewerPath: string, manifest: Manifest): string {
  const json = JSON.stringify(manifest).replace(/<\//g, "<\\/");
  return `<script>window.MANIFEST = ${json};</script>\n${readViewerHtml()}`;
}

// =============================================================================
// Main entry
// =============================================================================

export async function render(opts: RenderOptions): Promise<RenderResult> {
  checkDependencies();

  // --- Resolve absolute file path ---
  let filePath = opts.filePath;
  if (!path.isAbsolute(filePath)) filePath = path.resolve(process.cwd(), filePath);
  // Note: we do NOT check fs.existsSync(filePath) here. The file may have been
  // deleted from the working tree but still exist at one of the refs we're
  // diffing against — renderSide() will pull from git in that case. If the
  // file is missing on both sides, the per-side renders return false and the
  // outer "neither side rendered" check below raises a clear error.

  // --- Determine file type from extension ---
  let fileType: FileType;
  if (filePath.endsWith(".kicad_pcb")) fileType = "pcb";
  else if (filePath.endsWith(".kicad_sch")) fileType = "sch";
  else if (filePath.endsWith(".kicad_sym")) fileType = "sym";
  else if (filePath.endsWith(".kicad_mod")) fileType = "fp";
  else throw new Error(`not a KiCad file: ${filePath}`);

  // --- Determine repo root and relative path ---
  const repoRoot = getRepoRoot(filePath);
  const relPath = repoRoot
    ? path.relative(repoRoot, filePath)
    : path.basename(filePath);

  // --- Determine output directory ---
  const outputDir = opts.outputDir
    ? path.resolve(opts.outputDir)
    : repoRoot
      ? path.join(repoRoot, ".claude/preview")
      : path.join(os.tmpdir(), "kicadiff-preview");

  fs.mkdirSync(path.join(outputDir, "before"), { recursive: true });
  fs.mkdirSync(path.join(outputDir, "after"), { recursive: true });

  const safe = safeName(relPath);
  const afterSvg = path.join(outputDir, `after/${safe}.svg`);
  const afterPng = path.join(outputDir, `after/${safe}.png`);
  const beforeSvg = path.join(outputDir, `before/${safe}.svg`);
  const beforePng = path.join(outputDir, `before/${safe}.png`);

  // --- Resolve refs (git-diff-like semantics) ---
  // Default: from=HEAD, to=working tree.
  // Pin mutable refs (branch / tag / HEAD / HEAD~N) to a concrete commit
  // SHA before doing anything else with git. This render touches git
  // several times — the file content, each sibling .kicad_pro / .kicad_prl
  // for the cache key, then those siblings again when staging temps for
  // kicad-cli. If the ref moves between calls (`git fetch` racing in
  // another process, a force-push to the branch, …) we'd silently mix
  // bytes from two commits and feed kicad-cli an inconsistent project,
  // and the cache entry written from that render would be tainted.
  // Resolving once and threading the SHA through guarantees every git
  // read sees the same snapshot, regardless of what the ref does next.
  // renderProject pins too so all parallel renders share one snapshot;
  // the second resolution here is idempotent on an already-resolved SHA.
  const fromRef = repoRoot
    ? resolveRefToSha(repoRoot, opts.fromRef ?? "HEAD")
    : (opts.fromRef ?? "HEAD");
  const toRef = repoRoot
    ? resolveRefToSha(repoRoot, opts.toRef ?? "")
    : (opts.toRef ?? "");
  const isWorkingTree = (ref: string) => ref === "" || ref === "working";

  /** Render one side. If `ref` is working tree, render filePath directly.
   *  Otherwise extract from git into a temp file and render that.
   *  For PCB, the combined and per-layer kicad-cli calls run in parallel. */
  async function renderSide(
    ref: string,
    side: "before" | "after",
    targetSvg: string,
    targetPng: string,
  ): Promise<boolean> {
    const layersDir = path.join(outputDir, `${side}/layers_${safe}`);

    const sideDir = path.join(outputDir, side);
    const schPagesDir = path.join(sideDir, `sch_pages_${safe}`);
    const itemPagesDir = path.join(sideDir, `items_${safe}`);

    // Wipe any stale per-file outputs from a previous run before rendering /
    // restoring from cache. Without this, a sheet (or sym/fp item) that was
    // present last time but has since been removed or renamed would still
    // surface as a tab (buildSchPages / buildItemPages list the dir
    // contents). Same logic: a previous render might have left a different
    // file's outputs at the same paths.
    {
      // Clear both the PNG (used for diff overlay / hasDiff) and the SVG
      // (referenced by the manifest) so a previously-rendered file that
      // has since been removed or renamed doesn't surface as a stale tab.
      for (const ext of [".png", ".svg"]) {
        const combined = path.join(sideDir, `${safe}${ext}`);
        if (fs.existsSync(combined)) try { fs.unlinkSync(combined); } catch { /* */ }
      }
      for (const dir of [layersDir, schPagesDir, itemPagesDir]) {
        if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
      }
    }

    // Use the original schematic basename for stable page names across sides
    // (before-side may render from a temp file with a different basename).
    const schRootName = fileType === "sch"
      ? path.basename(filePath, ".kicad_sch")
      : "";

    async function renderFromSource(src: string): Promise<void> {
      if (fileType === "pcb") {
        // Combined and layered exports are independent → run in parallel
        await Promise.all([
          renderPcbCombined(src, targetSvg),
          renderPcbLayers(src, layersDir),
        ]);
        // Build the side-level combined PNG by alpha-compositing the
        // per-layer PNGs at viewer-equivalent opacity / z-order
        // (F.Cu on top, all layers at 0.6) so PR-embedded thumbnails
        // and the HTML viewer agree visually. Falls back to a flat
        // raster of the kicad-cli combined SVG if compositing can't
        // proceed — typically when the layers dir is empty for some
        // reason.
        if (!compositePcbLayers(layersDir, targetPng)) {
          await svgToPng(targetSvg, targetPng);
        }
      } else if (fileType === "sch") {
        // renderSch produces rootPng directly (and per-page PNGs in schPagesDir)
        await renderSch(src, sideDir, targetPng, schPagesDir, schRootName);
      } else if (fileType === "sym") {
        await renderSymLib(src, targetPng, itemPagesDir);
      } else if (fileType === "fp") {
        // Stable name = original file's basename (so before/after sides
        // produce identically-named pages even when before renders from a
        // temp file with a different basename).
        await renderFootprint(src, targetPng, itemPagesDir, path.basename(filePath, ".kicad_mod"));
      }
    }

    // Cache: hash the source content so we hit even when rendering the same
    // blob via a different ref or location. We read the content here both
    // for hashing and (in the git-ref case) to avoid a second `git show`
    // when writing the temp file.
    const useCache = !opts.noCache;
    let content: Buffer | null = null;
    if (isWorkingTree(ref)) {
      if (!fs.existsSync(filePath)) return false;
      if (useCache) content = fs.readFileSync(filePath);
    } else {
      if (!repoRoot) return false;
      content = gitReadAtRef(repoRoot, ref, relPath);
      if (content === null) return false;
    }

    // Sibling project files for the cache key — read from the same source
    // as `content` (working tree or git ref) so the key reflects what
    // kicad-cli will actually see during the render below.
    const siblings = useCache && content !== null
      ? readProjectSiblings(filePath, fileType, ref, repoRoot)
      : [];
    const cacheHash = (useCache && content !== null)
      ? cacheKeyFor(content, fileType, filePath, siblings)
      : null;

    if (cacheHash && loadFromCache(cacheHash, sideDir, safe, fileType)) {
      return fs.existsSync(targetPng);
    }

    if (isWorkingTree(ref)) {
      // kicad-cli writes/updates a sibling .kicad_prl every time it touches
      // a .kicad_pcb / .kicad_sch — even when we're rendering a working-tree
      // file in place. Snapshot it first and restore (or delete) afterwards
      // so the user's repo stays clean. This matters especially for the
      // post-edit hook flow, where every save would otherwise dirty the
      // project file.
      let prlSnap: { path: string; existed: boolean; content: Buffer | null } | null = null;
      if (fileType === "pcb" || fileType === "sch") {
        const ext = path.extname(filePath);
        const stem = filePath.slice(0, -ext.length);
        const prl = stem + ".kicad_prl";
        prlSnap = {
          path: prl,
          existed: fs.existsSync(prl),
          content: fs.existsSync(prl) ? fs.readFileSync(prl) : null,
        };
      }
      try {
        await renderFromSource(filePath);
      } finally {
        if (prlSnap) {
          if (prlSnap.existed && prlSnap.content) {
            try { fs.writeFileSync(prlSnap.path, prlSnap.content); } catch { /* ignore */ }
          } else if (fs.existsSync(prlSnap.path)) {
            try { fs.unlinkSync(prlSnap.path); } catch { /* ignore */ }
          }
        }
      }
    } else {
      // We already have content in memory — write to temp without a second
      // git invocation.
      const tempFile = writeContentToTempBeside(content!, filePath);
      const cleanupPaths: string[] = [tempFile];
      try {
        // For pcb/sch, kicad-cli reads sibling .kicad_pro / .kicad_prl from
        // the same dir for theme / project settings. Without this block,
        // a commit-to-commit render would use whatever is in the WORKING
        // TREE, which is misleading when project settings changed across
        // revisions. Extract those siblings at the same ref alongside the
        // temp KiCad file (matched by basename so kicad-cli picks them up).
        if (fileType === "pcb" || fileType === "sch") {
          const ext = path.extname(tempFile);
          const tempStem = tempFile.slice(0, -ext.length);
          const origExt = path.extname(filePath);
          const origStem = filePath.slice(0, -origExt.length);
          for (const sibExt of [".kicad_pro", ".kicad_prl"]) {
            const origSib = origStem + sibExt;
            const sibRel = repoRoot ? path.relative(repoRoot, origSib) : "";
            if (sibRel && repoRoot && gitHasFileAtRef(repoRoot, ref, sibRel)) {
              const sibContent = gitReadAtRef(repoRoot, ref, sibRel);
              if (sibContent) {
                const sibTemp = tempStem + sibExt;
                fs.writeFileSync(sibTemp, sibContent);
                cleanupPaths.push(sibTemp);
              }
            }
          }
        }
        await renderFromSource(tempFile);
      } finally {
        for (const p of cleanupPaths) {
          if (fs.existsSync(p)) {
            try { fs.unlinkSync(p); } catch { /* ignore */ }
          }
        }
        // kicad-cli writes a sibling .kicad_prl next to .kicad_pcb / .kicad_sch
        // even if we didn't pre-write one — clean that up too. (No-op if our
        // pre-extracted .kicad_prl already covered the same path.)
        const ext = path.extname(tempFile);
        if (ext === ".kicad_pcb" || ext === ".kicad_sch") {
          const tempPrl = tempFile.slice(0, -ext.length) + ".kicad_prl";
          if (fs.existsSync(tempPrl)) {
            try { fs.unlinkSync(tempPrl); } catch { /* ignore */ }
          }
        }
      }
    }

    if (cacheHash && fs.existsSync(targetPng)) {
      saveToCache(cacheHash, sideDir, safe, fileType);
    }
    return fs.existsSync(targetPng);
  }

  // --- Render after (target) and before (base) in parallel ---
  // Each side runs combined||layers internally for further speedup.
  const [hasAfter, hasBefore] = await Promise.all([
    renderSide(toRef, "after", afterSvg, afterPng),
    renderSide(fromRef, "before", beforeSvg, beforePng),
  ]);
  // A file deleted at the target ref still produces a usable diff: render
  // the before side and show that, with the viewer marking it as "deleted".
  // We only fail when neither side rendered (file missing at both refs).
  if (!hasAfter && !hasBefore) {
    throw new Error(`failed to render either side (file may not exist at any of the refs)`);
  }

  // --- Tri-colour diff overlay, split per side ---
  // Each pixel is classified as ADD (green), DELETE (red), CHANGE (amber),
  // or no-change (transparent). DELETE goes on a before-side mask so the
  // removed content lights up where it actually used to be; ADD/CHANGE go
  // on an after-side mask so they sit on top of the new state. See
  // src/diff-overlay.ts for the classifier; it handles transparent-bg
  // renders (sch / per-layer PCB) and solid-bg renders (PCB combined PNG).
  let diffBeforePng: string | undefined;
  let diffAfterPng: string | undefined;
  if (hasAfter && hasBefore && fs.existsSync(beforePng) && fs.existsSync(afterPng)) {
    try {
      const out = splitDiff(fs.readFileSync(beforePng), fs.readFileSync(afterPng));
      const diffDir = path.join(outputDir, "diff");
      fs.mkdirSync(diffDir, { recursive: true });
      diffBeforePng = path.join(diffDir, `${safe}-before.png`);
      diffAfterPng = path.join(diffDir, `${safe}-after.png`);
      fs.writeFileSync(diffBeforePng, out.before);
      fs.writeFileSync(diffAfterPng, out.after);
    } catch {
      // Dimension mismatch / corrupt PNG — non-fatal, just skip the overlay.
      diffBeforePng = undefined;
      diffAfterPng = undefined;
    }
  }

  // For schematics, pass the project basename so buildManifest can identify
  // the root sheet (always sorted first in the page list).
  const schRootName = fileType === "sch"
    ? path.basename(filePath, ".kicad_sch")
    : undefined;

  // Detect whether the rendering actually changed. Two PNGs that are
  // byte-identical mean the visual diff is empty even if the source files
  // are textually different (e.g. a reformat or a comment edit).
  // hasDiff = true when one side is missing (new or deleted file).
  let hasDiff = !hasBefore || !hasAfter;
  if (hasBefore && hasAfter && fs.existsSync(beforePng) && fs.existsSync(afterPng)) {
    const beforeBuf = fs.readFileSync(beforePng);
    const afterBuf = fs.readFileSync(afterPng);
    hasDiff = !beforeBuf.equals(afterBuf);
  }

  // Manifest records the pinned SHAs (not the user-typed "HEAD" / "main"):
  // the diff is anchored to specific commits, so anyone re-reading the
  // report later — after the branch has moved — can still resolve exactly
  // what was compared. The viewer's refLabel and the markdown refLabelMd
  // both shorten 40-char SHAs to 7 chars for display.
  const manifest = buildManifest({
    relPath, fileType, outputDir, safe, hasBefore, hasAfter, hasDiff,
    diffBeforePng, diffAfterPng, schRootName,
    fromRef, toRef,
  });

  const result: RenderResult = {
    filePath, relPath, fileType, outputDir,
    afterPng: hasAfter ? afterPng : "",
    beforePng: hasBefore ? beforePng : undefined,
    diffPng: diffAfterPng,
    manifest,
  };

  // --images-only: skip HTML generation
  if (opts.imagesOnly) return result;

  // --- HTML generation ---
  const viewerPath = path.resolve(__dirname, "..", "viewer.html");
  const html = buildHtml(viewerPath, manifest);
  const diffHtml = path.join(outputDir, `${safe}_diff.html`);
  fs.writeFileSync(diffHtml, html);
  result.diffHtml = diffHtml;

  // --- Auto-open the diff HTML (non-blocking) ---
  if (opts.open !== undefined) {
    openInEditor(diffHtml, opts.open);
  }

  return result;
}

/** Map well-known short names to their actual command + flags.
 *  Anything not in this map is treated as a literal executable name. */
const OPEN_ALIASES: Record<string, [string, string[]]> = {
  xdg: ["xdg-open", []],
  vscode: ["code", ["-r"]],
  code: ["code", ["-r"]],
};

/** Spawn an external command to open the diff HTML.
 *  Honors KICADIFF_OPEN_CMD env var for testing/customization.
 *  Returns silently if the command isn't available. */
function openInEditor(htmlPath: string, target: string): void {
  // Env var takes precedence — useful for testing and custom configurations
  const overrideCmd = process.env.KICADIFF_OPEN_CMD;
  let cmd: string;
  let args: string[];
  if (overrideCmd !== undefined) {
    if (overrideCmd === "") return; // explicit no-op
    const parts = overrideCmd.split(/\s+/).filter(Boolean);
    if (parts.length === 0) return;
    cmd = parts[0];
    args = [...parts.slice(1), htmlPath];
  } else {
    const alias = OPEN_ALIASES[target];
    if (alias) {
      [cmd, args] = [alias[0], [...alias[1], htmlPath]];
    } else {
      // Unknown target — treat as a literal executable name (firefox, chromium, etc.)
      cmd = target;
      args = [htmlPath];
    }
  }
  if (!hasCommand(cmd)) {
    console.error(`Warning: open command not found: ${cmd}`);
    return;
  }
  const child = spawn(cmd, args, { stdio: "ignore", detached: true });
  child.unref();
}

// =============================================================================
// Project-level rendering (combined PCB + schematic)
// =============================================================================

export interface ProjectRenderOptions {
  /** Input: directory, .kicad_pro, .kicad_pcb, .kicad_sch, or undefined (=cwd).
   *  When a directory or .kicad_pro is given, both .kicad_pcb and .kicad_sch
   *  siblings are picked up. When a single .kicad_{pcb,sch} is given, the
   *  matching sibling of the other type is also included if it exists. */
  input?: string;
  outputDir?: string;
  /** Explicit HTML output path. When set, images live under outputDir but the
   *  combined HTML is written to this path; manifest image paths are
   *  rewritten to be relative to the HTML's parent directory. */
  outputHtml?: string;
  fromRef?: string;
  toRef?: string;
  imagesOnly?: boolean;
  open?: string;
  /** Disable the per-side render cache (default: enabled). Useful when the
   *  cache is suspected stale, or for benchmarking the uncached path. */
  noCache?: boolean;
  /** Force single-file mode (set by `pcb`/`sch` subcommand). When set, only
   *  the file matching the scope is rendered, no sibling auto-detection. */
  scope?: FileType;
}

export interface ProjectRenderResult {
  results: RenderResult[];
  /** Path to the combined HTML (only present when more than one file rendered
   *  AND imagesOnly is false). For single-file mode, the per-file HTML in
   *  the corresponding RenderResult.diffHtml is the entry point. */
  combinedHtml?: string;
}

/** Resolve the user's input into a list of KiCad files to render.
 *  See ProjectRenderOptions.input for accepted formats. */
export function resolveInputs(
  rawInput: string | undefined,
  scope: FileType | undefined,
): string[] {
  const input = rawInput ?? process.cwd();
  const abs = path.isAbsolute(input) ? input : path.resolve(process.cwd(), input);

  if (!fs.existsSync(abs)) {
    // A single KiCad file that doesn't exist on disk may still exist at a
    // git ref — for example, when reviewing a file that was deleted in the
    // working tree. Let it through so render() can extract from the ref.
    // render() will fail later if neither ref has it either.
    if (
      abs.endsWith(".kicad_pcb") ||
      abs.endsWith(".kicad_sch") ||
      abs.endsWith(".kicad_sym") ||
      abs.endsWith(".kicad_mod")
    ) {
      return [abs];
    }
    throw new Error(`input not found: ${abs}`);
  }

  const stat = fs.statSync(abs);
  let pcb: string | undefined;
  let sch: string | undefined;
  const syms: string[] = [];
  const fps: string[] = [];

  /** Auto-pick sibling sym/fp files in a project directory. We restrict to
   *  files whose basename matches the project name to avoid pulling in large
   *  shared libraries. .pretty/ directories follow the same rule.
   *  All sym/fp picks are no-ops when scope is "pcb" or "sch". */
  function scanProjectSiblings(dir: string, base: string): void {
    if (scope !== undefined && scope !== "sym" && scope !== "fp") return;
    const symCandidate = path.join(dir, `${base}.kicad_sym`);
    const prettyCandidate = path.join(dir, `${base}.pretty`);
    if (fs.existsSync(symCandidate)) syms.push(symCandidate);
    if (fs.existsSync(prettyCandidate) && fs.statSync(prettyCandidate).isDirectory()) {
      for (const f of fs.readdirSync(prettyCandidate).sort()) {
        if (f.endsWith(".kicad_mod")) fps.push(path.join(prettyCandidate, f));
      }
    }
  }

  if (stat.isDirectory()) {
    if (abs.endsWith(".pretty")) {
      // .pretty directory: each .kicad_mod inside is a footprint.
      // Defensive filter: skip any leftover `preview_*.kicad_mod` temp files
      // that previous crashed runs may have left behind in the library.
      for (const f of fs.readdirSync(abs).sort()) {
        if (f.endsWith(".kicad_mod") && !f.startsWith("preview_")) {
          fps.push(path.join(abs, f));
        }
      }
    } else {
      // Project directory — pick a pcb/sch *pair* that share a basename, so
      // a folder containing two unrelated boards doesn't get rendered as
      // "board A's PCB + board B's schematic". Preference order:
      //   1. <project>.kicad_pro exists → use its basename (the canonical pair)
      //   2. else: first basename for which both .kicad_pcb and .kicad_sch exist
      //   3. else: first .kicad_pcb (no sch) or first .kicad_sch (no pcb)
      const entries = fs.readdirSync(abs).sort();
      const pcbBases = new Set<string>();
      const schBases = new Set<string>();
      const proBases = new Set<string>();
      for (const f of entries) {
        if (f.endsWith(".kicad_pcb")) pcbBases.add(f.slice(0, -".kicad_pcb".length));
        else if (f.endsWith(".kicad_sch")) schBases.add(f.slice(0, -".kicad_sch".length));
        else if (f.endsWith(".kicad_pro")) proBases.add(f.slice(0, -".kicad_pro".length));
      }
      let projBase: string | undefined;
      // 1) prefer a basename that has a .kicad_pro alongside it
      for (const b of [...proBases].sort()) {
        if (pcbBases.has(b) || schBases.has(b)) { projBase = b; break; }
      }
      // 2) fall back to the first basename that has BOTH pcb and sch
      if (!projBase) {
        for (const b of [...pcbBases].sort()) {
          if (schBases.has(b)) { projBase = b; break; }
        }
      }
      // 3) fall back to the first pcb (or sch) with no matching sibling
      if (!projBase) projBase = [...pcbBases].sort()[0] ?? [...schBases].sort()[0];
      if (projBase) {
        const pcbCandidate = path.join(abs, `${projBase}.kicad_pcb`);
        const schCandidate = path.join(abs, `${projBase}.kicad_sch`);
        if (fs.existsSync(pcbCandidate)) pcb = pcbCandidate;
        if (fs.existsSync(schCandidate)) sch = schCandidate;
        // scanProjectSiblings handles the project-bundled libraries (those
        // that share basename with the project — `<base>.kicad_sym`,
        // `<base>.pretty/`). Don't sweep the whole directory in this case;
        // pulling in every unrelated `.kicad_sym` would clutter the viewer
        // for normal "combined PCB + schematic" diffs.
        scanProjectSiblings(abs, projBase);
      } else {
        // No pcb/sch in this directory → it's a library-only directory.
        // Treat all `.kicad_sym` files and `.pretty/` subdirectories as
        // inputs, scoped by the active subcommand if any.
        if (scope === undefined || scope === "sym") {
          for (const f of entries) {
            if (f.endsWith(".kicad_sym") && !f.startsWith("preview_")) {
              syms.push(path.join(abs, f));
            }
          }
        }
        if (scope === undefined || scope === "fp") {
          for (const f of entries) {
            if (f.endsWith(".pretty")) {
              const pretty = path.join(abs, f);
              if (fs.statSync(pretty).isDirectory()) {
                for (const m of fs.readdirSync(pretty).sort()) {
                  if (m.endsWith(".kicad_mod") && !m.startsWith("preview_")) {
                    fps.push(path.join(pretty, m));
                  }
                }
              }
            }
          }
        }
      }
    }
  } else if (abs.endsWith(".kicad_pro")) {
    const dir = path.dirname(abs);
    const base = path.basename(abs, ".kicad_pro");
    const pcbCandidate = path.join(dir, `${base}.kicad_pcb`);
    const schCandidate = path.join(dir, `${base}.kicad_sch`);
    if (fs.existsSync(pcbCandidate)) pcb = pcbCandidate;
    if (fs.existsSync(schCandidate)) sch = schCandidate;
    scanProjectSiblings(dir, base);
  } else if (abs.endsWith(".kicad_pcb")) {
    pcb = abs;
    const base = path.basename(abs, ".kicad_pcb");
    const schCandidate = abs.slice(0, -".kicad_pcb".length) + ".kicad_sch";
    if (scope === undefined && fs.existsSync(schCandidate)) sch = schCandidate;
    if (scope === undefined) scanProjectSiblings(path.dirname(abs), base);
  } else if (abs.endsWith(".kicad_sch")) {
    sch = abs;
    const base = path.basename(abs, ".kicad_sch");
    const pcbCandidate = abs.slice(0, -".kicad_sch".length) + ".kicad_pcb";
    if (scope === undefined && fs.existsSync(pcbCandidate)) pcb = pcbCandidate;
    if (scope === undefined) scanProjectSiblings(path.dirname(abs), base);
  } else if (abs.endsWith(".kicad_sym")) {
    syms.push(abs);
  } else if (abs.endsWith(".kicad_mod")) {
    fps.push(abs);
  } else {
    throw new Error(`unsupported input: ${abs} (expected dir, .kicad_pro, .kicad_pcb, .kicad_sch, .kicad_sym, .kicad_mod, or .pretty)`);
  }

  // Apply scope filter (subcommand)
  if (scope === "pcb") { sch = undefined; syms.length = 0; fps.length = 0; }
  if (scope === "sch") { pcb = undefined; syms.length = 0; fps.length = 0; }
  if (scope === "sym") { pcb = undefined; sch = undefined; fps.length = 0; }
  if (scope === "fp") { pcb = undefined; sch = undefined; syms.length = 0; }

  const result: string[] = [];
  if (sch) result.push(sch);
  if (pcb) result.push(pcb);
  result.push(...syms);
  result.push(...fps);
  if (result.length === 0) {
    throw new Error(`no KiCad files found under: ${abs}`);
  }
  return result;
}

/** Render one or more KiCad files and produce a single combined HTML viewer.
 *  Used as the main entry point — the CLI and Claude Code hook call this.
 *  Multiple input files are rendered in parallel (PCB and SCH have no
 *  shared state). Within each file, before|after and combined|layers also
 *  run in parallel — see render(). */
export async function renderProject(opts: ProjectRenderOptions): Promise<ProjectRenderResult> {
  const files = resolveInputs(opts.input, opts.scope);

  // Pin mutable refs (branch / tag / HEAD) to their current commit SHAs
  // once for the whole project. Each render() also pins internally as a
  // safety net, but doing it here too means every parallel file render in
  // this batch sees the exact same commit — without this, a fast-moving
  // branch could resolve to one commit for the .kicad_pcb render and a
  // different commit for the .kicad_sch render started microseconds later.
  let pinnedFromRef = opts.fromRef;
  let pinnedToRef = opts.toRef;
  if (files.length > 0) {
    const repoRoot = getRepoRoot(files[0]);
    if (repoRoot) {
      if (pinnedFromRef !== undefined) pinnedFromRef = resolveRefToSha(repoRoot, pinnedFromRef);
      if (pinnedToRef !== undefined) pinnedToRef = resolveRefToSha(repoRoot, pinnedToRef);
    }
  }

  const results: RenderResult[] = await Promise.all(
    files.map(file =>
      render({
        filePath: file,
        outputDir: opts.outputDir,
        fromRef: pinnedFromRef,
        toRef: pinnedToRef,
        imagesOnly: true, // we'll generate one combined HTML below
        noCache: opts.noCache,
      }),
    ),
  );

  if (opts.imagesOnly) {
    return { results };
  }

  // Build a combined manifest. Image paths in each FileManifest are relative
  // to outDir (the shared image directory). When --output points at an HTML
  // outside outDir, paths must be rewritten to be relative to the HTML's
  // parent directory so the browser can resolve them.
  const outDir = results[0].outputDir;
  const safeName = projectSafeName(files);
  const combinedHtml = opts.outputHtml
    ? resolveOutputPath(opts.outputHtml, `${safeName}_diff.html`)
    : path.join(outDir, `${safeName}_diff.html`);

  // Ensure the parent directory of the HTML exists
  fs.mkdirSync(path.dirname(combinedHtml), { recursive: true });

  const htmlDir = path.dirname(combinedHtml);
  const fileManifests = results.map(r => rewriteManifestPaths(r.manifest, outDir, htmlDir));
  const manifest: ProjectManifest = { files: fileManifests };
  fs.writeFileSync(combinedHtml, buildHtmlFromProject(manifest));

  // Auto-open if requested
  if (opts.open !== undefined) {
    openInEditor(combinedHtml, opts.open);
  }

  // Annotate each result with the combined HTML for CLI display
  for (const r of results) r.diffHtml = combinedHtml;

  return { results, combinedHtml };
}

/** Rewrite all image paths in a FileManifest from `<outDir>/<rel>` to a path
 *  relative to `htmlDir`. When htmlDir === outDir, paths are unchanged. */
function rewriteManifestPaths(m: Manifest, outDir: string, htmlDir: string): Manifest {
  if (path.resolve(outDir) === path.resolve(htmlDir)) return m;
  const rewrite = (p: string): string => path.relative(htmlDir, path.join(outDir, p));
  const rewriteSide = (s: SideManifest): SideManifest => {
    const out: SideManifest = { combined: rewrite(s.combined) };
    if (s.layers) {
      out.layers = {};
      for (const [k, v] of Object.entries(s.layers)) out.layers[k] = rewrite(v);
    }
    if (s.pages) {
      out.pages = s.pages.map(p => {
        const np: { name: string; image: string; hasDiff?: boolean } = { name: p.name, image: rewrite(p.image) };
        if (p.hasDiff !== undefined) np.hasDiff = p.hasDiff;
        return np;
      });
    }
    return out;
  };
  const out: Manifest = {
    file: m.file,
    type: m.type,
    hasBefore: m.hasBefore,
  };
  if (m.after) out.after = rewriteSide(m.after);
  if (m.before) out.before = rewriteSide(m.before);
  if (m.hasAfter !== undefined) out.hasAfter = m.hasAfter;
  if (m.hasDiff !== undefined) out.hasDiff = m.hasDiff;
  if (m.fromRef !== undefined) out.fromRef = m.fromRef;
  if (m.toRef !== undefined) out.toRef = m.toRef;
  if (m.diff) out.diff = { before: rewrite(m.diff.before), after: rewrite(m.diff.after) };
  return out;
}

/** Derive a stable filename for the combined HTML based on the input files.
 *  Strategy:
 *    1. If all files share a basename (typical PCB+sch project): use it.
 *    2. Else if all files share a parent directory: use its name (handles
 *       .pretty libraries with many footprints).
 *    3. Else: concatenate basenames, capped at ~80 chars. */
function projectSafeName(files: string[]): string {
  const sanitize = (s: string) => s.replace(/[^a-zA-Z0-9._-]/g, "_");
  const stripExt = (s: string) =>
    s.replace(/\.kicad_(pcb|sch|sym|mod)$/, "");

  const bases = files.map(f => stripExt(path.basename(f)));
  const allSame = bases.every(b => b === bases[0]);
  if (allSame) return sanitize(bases[0]);

  // Files differ — fall back to the common parent directory name. This avoids
  // ENAMETOOLONG when a .pretty/ library yields dozens of file basenames.
  const parents = files.map(f => path.basename(path.dirname(f)));
  const sameParent = parents.every(p => p === parents[0]);
  if (sameParent && parents[0]) return sanitize(parents[0]);

  // Last resort: join bases, but cap so we don't blow past filename limits.
  const joined = bases.map(sanitize).join("__");
  return joined.length > 80 ? joined.slice(0, 80) : joined;
}

function buildHtmlFromProject(manifest: ProjectManifest): string {
  const json = JSON.stringify(manifest).replace(/<\//g, "<\\/");
  return `<script>window.MANIFEST = ${json};</script>\n${readViewerHtml()}`;
}

export type LogLevel = "quiet" | "info" | "debug";

/** Print a project-level summary. At "info" (default) we only show the
 *  per-file rendered line and a single combined HTML path; PNG paths are
 *  emitted only at "debug". `imagesOnly` mode prints just the output dir at
 *  info, full per-file PNG paths at debug.
 *
 *  When `toStderr` is true (caller has reserved stdout for an output file
 *  like the markdown report), the summary is routed to stderr instead. */
export function printProjectSummary(
  project: ProjectRenderResult,
  imagesOnly: boolean,
  logLevel: LogLevel = "info",
  toStderr: boolean = false,
): void {
  if (logLevel === "quiet") return;
  const log = toStderr
    ? (s: string) => process.stderr.write(s + "\n")
    : (s: string) => console.log(s);

  const showPaths = logLevel === "debug";

  if (imagesOnly) {
    // images-only mode: the PNG paths are the headline output, but at info
    // level a single output dir line is enough
    if (showPaths) {
      for (const r of project.results) {
        log(`Images: ${r.relPath}`);
        log(`  After:  ${r.afterPng}`);
        if (r.beforePng) log(`  Before: ${r.beforePng}`);
        if (r.diffPng) log(`  Diff:   ${r.diffPng}`);
      }
    } else if (project.results[0]) {
      log(`Images updated: ${project.results[0].outputDir}`);
    }
    return;
  }

  // Normal mode — per-file rendered line, optional PNG details, single HTML
  for (const r of project.results) {
    const tag = r.beforePng ? "" : " (new file — no before state in git)";
    log(`Rendered: ${r.relPath}${tag}`);
    if (showPaths) {
      log(`  After:  ${r.afterPng}`);
      if (r.beforePng) log(`  Before: ${r.beforePng}`);
      if (r.diffPng) log(`  Diff:   ${r.diffPng}`);
    }
  }

  // Combined HTML (deduplicated — multiple results in project mode share it)
  const html = project.combinedHtml ?? project.results[0]?.diffHtml;
  if (html) log(`Diff HTML: ${html} (open with Live Preview in VSCode)`);
}

/** @deprecated kept for older callers; prefer printProjectSummary. */
export function printSummary(r: RenderResult, imagesOnly: boolean, logLevel: LogLevel = "info"): void {
  printProjectSummary({ results: [r] }, imagesOnly, logLevel);
}
