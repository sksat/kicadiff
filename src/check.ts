/**
 * `kicadiff check` — DRC / ERC violation diff.
 *
 * Runs `kicad-cli pcb drc` (for .kicad_pcb) or `kicad-cli sch erc` (for
 * .kicad_sch) on both sides of a comparison, then reports the *delta*:
 *   foo.kicad_pcb (drc): +N -M =K
 *     + clearance        ...
 *     - lengths_match    (resolved)
 *
 * The unit of comparison is a single violation, identified by a stable
 * signature. The signature choice is deliberately conservative — see
 * `signatureOf` for the why.
 *
 * Exit semantics: `kicadiff check` exits 1 iff there are NEW violations on
 * the target side (i.e. `added.length > 0` for any input). Pre-existing
 * violations that persist do not fail the gate — the point of `check` is
 * "did this change introduce something?" rather than "is the design clean?".
 */

import { spawnSync, execFileSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resolveRefToSha } from "./render.ts";

// =============================================================================
// Types — model kicad-cli's JSON shape (drc.v1 / erc.v1).
// =============================================================================

export interface ViolationItem {
  description: string;
  uuid?: string;
  pos?: { x: number; y: number };
}

export interface Violation {
  /** kicad-cli violation type key, e.g. "clearance", "courtyards_overlap",
   *  "unconnected_items", "pin_not_connected". This is the most stable part
   *  of a violation: human descriptions occasionally include coordinates or
   *  units, but the `type` key is a fixed enum. */
  type: string;
  severity: "error" | "warning" | "exclusion";
  description: string;
  items: ViolationItem[];
}

export type CheckKind = "drc" | "erc";

export interface ViolationDiff {
  added: Violation[];
  removed: Violation[];
  unchanged: Violation[];
}

// =============================================================================
// Violation signature
//
// Identity question: "is this the same violation as before?". We use
//   (type, sorted item descriptions)
// hashed. Rationale:
//   - `type` is a stable enum key (e.g. "clearance"), so it survives KiCad
//     phrasing changes to the human-readable `description`.
//   - Item `description` strings ("Pad 1 [GND] of U2 on F.Cu") identify the
//     specific board/sheet entities involved, which is what makes one
//     "clearance violation" different from another.
//   - We deliberately EXCLUDE `uuid` (regenerated on some edits), `pos`
//     (a 0.01mm nudge isn't a new violation), and `severity` (a config
//     change that re-classifies a warning as an error shouldn't appear as
//     "1 new + 1 removed"). These choices are intentionally conservative:
//     we'd rather under-report changes than spam new findings on every
//     incidental edit.
//   - Items are sorted before hashing so kicad-cli's traversal order
//     doesn't affect identity.
// =============================================================================

export function signatureOf(v: Violation): string {
  const itemKeys = v.items.map((i) => i.description).sort();
  const h = crypto.createHash("sha256");
  h.update(v.type);
  h.update("\0");
  for (const k of itemKeys) {
    h.update(k);
    h.update("\0");
  }
  return h.digest("hex");
}

export function diffViolations(
  before: Violation[],
  after: Violation[],
): ViolationDiff {
  // Multiset semantics: identical violations on both sides should pair up
  // 1:1, with excess on either side classified as added / removed. KiCad
  // sometimes emits the same (type, items) entry multiple times, and
  // collapsing them would understate the delta.
  const beforeBuckets = new Map<string, Violation[]>();
  for (const v of before) {
    const k = signatureOf(v);
    const arr = beforeBuckets.get(k) ?? [];
    arr.push(v);
    beforeBuckets.set(k, arr);
  }
  const added: Violation[] = [];
  const unchanged: Violation[] = [];
  for (const v of after) {
    const k = signatureOf(v);
    const arr = beforeBuckets.get(k);
    if (arr && arr.length > 0) {
      arr.shift();
      unchanged.push(v);
    } else {
      added.push(v);
    }
  }
  const removed: Violation[] = [];
  for (const arr of beforeBuckets.values()) {
    for (const v of arr) removed.push(v);
  }
  return { added, removed, unchanged };
}

// =============================================================================
// kicad-cli invocation + JSON parsing
// =============================================================================

/** Run `kicad-cli pcb drc --format json` on `inputPcb` and return the parsed
 *  violations. We pass `--severity-all` so the diff sees every level
 *  (errors, warnings, exclusions) — under-reporting at the source would be
 *  unrecoverable downstream. */
export function runDrc(inputPcb: string, outputJson: string): Violation[] {
  const r = spawnSync("kicad-cli", [
    "pcb", "drc",
    "--severity-all",
    "--format", "json",
    "--output", outputJson,
    inputPcb,
  ], { stdio: ["ignore", "pipe", "pipe"] });
  // kicad-cli pcb drc exits 5 when violations are found with default flags;
  // with `--exit-code-violations` omitted it should be 0. Be lenient on exit
  // code but require the report file to exist.
  if (!fs.existsSync(outputJson)) {
    const stderr = (r.stderr ?? "").toString().trim();
    throw new Error(`kicad-cli pcb drc failed for ${inputPcb}${stderr ? `: ${stderr}` : ""}`);
  }
  return parseDrcViolations(outputJson);
}

export function runErc(inputSch: string, outputJson: string): Violation[] {
  const r = spawnSync("kicad-cli", [
    "sch", "erc",
    "--severity-all",
    "--format", "json",
    "--output", outputJson,
    inputSch,
  ], { stdio: ["ignore", "pipe", "pipe"] });
  if (!fs.existsSync(outputJson)) {
    const stderr = (r.stderr ?? "").toString().trim();
    throw new Error(`kicad-cli sch erc failed for ${inputSch}${stderr ? `: ${stderr}` : ""}`);
  }
  return parseErcViolations(outputJson);
}

interface RawViolation {
  type?: string;
  severity?: string;
  description?: string;
  items?: { description?: string; uuid?: string; pos?: { x: number; y: number } }[];
}

function normalizeRaw(raw: RawViolation): Violation {
  const severity: Violation["severity"] =
    raw.severity === "warning" || raw.severity === "exclusion"
      ? raw.severity
      : "error";
  return {
    type: raw.type ?? "unknown",
    severity,
    description: raw.description ?? "",
    items: (raw.items ?? []).map((it) => ({
      description: it.description ?? "",
      uuid: it.uuid,
      pos: it.pos,
    })),
  };
}

/** DRC JSON shape (schemas.kicad.org/drc.v1): top-level `violations`,
 *  `unconnected_items`, `schematic_parity` arrays. All three are findings
 *  the user has to deal with, so we fold them all into the same Violation
 *  stream. */
export function parseDrcViolations(jsonPath: string): Violation[] {
  const j = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
  const out: Violation[] = [];
  for (const key of ["violations", "unconnected_items", "schematic_parity"]) {
    const arr = j?.[key];
    if (Array.isArray(arr)) {
      for (const v of arr) out.push(normalizeRaw(v));
    }
  }
  return out;
}

/** ERC JSON shape (schemas.kicad.org/erc.v1): violations are grouped by
 *  sheet under top-level `sheets[]`. Flatten across all sheets — the
 *  per-sheet grouping is more useful for the human-readable report than
 *  for diffing, and individual item descriptions encode the sheet path. */
export function parseErcViolations(jsonPath: string): Violation[] {
  const j = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
  const out: Violation[] = [];
  const sheets = j?.sheets;
  if (Array.isArray(sheets)) {
    for (const s of sheets) {
      const vs = s?.violations;
      if (Array.isArray(vs)) {
        for (const v of vs) out.push(normalizeRaw(v));
      }
    }
  }
  return out;
}

// =============================================================================
// Formatting
// =============================================================================

function summarizeItem(it: ViolationItem): string {
  const desc = it.description || "";
  if (it.pos) {
    return `${desc} at (${it.pos.x.toFixed(2)}, ${it.pos.y.toFixed(2)})`;
  }
  return desc;
}

function summarizeViolation(v: Violation): string {
  // Join up to 2 item descriptions for compactness; KiCad violations with
  // many items (e.g. a long net of unconnected pads) would otherwise blow
  // out the line width with marginal information value.
  const head = v.items.slice(0, 2).map(summarizeItem).join(" / ");
  const more = v.items.length > 2 ? ` (+${v.items.length - 2} more)` : "";
  return head + more;
}

export function formatCheckDiff(
  filePath: string,
  kind: CheckKind,
  diff: ViolationDiff,
): string {
  const lines: string[] = [];
  lines.push(
    `${filePath} (${kind}): +${diff.added.length} -${diff.removed.length} =${diff.unchanged.length}`,
  );
  for (const v of diff.added) {
    lines.push(`  + ${v.type.padEnd(22)} ${summarizeViolation(v)}`);
  }
  for (const v of diff.removed) {
    lines.push(`  - ${v.type.padEnd(22)} (resolved)`);
  }
  return lines.join("\n");
}

// =============================================================================
// Per-side rendering + check driver
// =============================================================================

const SUPPORTED_EXT: Record<string, CheckKind> = {
  ".kicad_pcb": "drc",
  ".kicad_sch": "erc",
};

/** Return the CheckKind for a given file, or null if unsupported. */
export function checkKindFor(filePath: string): CheckKind | null {
  for (const [ext, kind] of Object.entries(SUPPORTED_EXT)) {
    if (filePath.endsWith(ext)) return kind;
  }
  return null;
}

/** Materialise a file at a git ref into a temp directory along with its
 *  sibling .kicad_pro / .kicad_prl. DRC depends on the project (board
 *  setup rules live in .kicad_pro), so we have to extract the project
 *  alongside the .kicad_pcb / .kicad_sch — without it kicad-cli falls back
 *  to defaults and reports a different set of violations than the user
 *  would see in the GUI.
 *
 *  We use a dedicated temp directory instead of the writeContentToTempBeside
 *  pattern from render.ts because `check` doesn't need cache parity with the
 *  user's working tree, and isolating the inputs in their own dir prevents
 *  kicad-cli's sibling .kicad_prl writes from leaking back into the user's
 *  source tree.
 *
 *  Returns the absolute path of the materialised file inside `tmpDir`, or
 *  null if the file does not exist at the given ref. */
function materializeAtRef(
  filePath: string,
  ref: string,
  repoRoot: string | null,
  tmpDir: string,
): string | null {
  const base = path.basename(filePath);
  const stem = base.replace(/\.[^.]+$/, "");
  const ext = path.extname(base);
  const target = path.join(tmpDir, base);

  if (ref === "" || ref === "working") {
    if (!fs.existsSync(filePath)) return null;
    fs.copyFileSync(filePath, target);
    // Copy siblings from disk
    const origDir = path.dirname(filePath);
    const origStem = path.basename(filePath, ext);
    for (const sibExt of [".kicad_pro", ".kicad_prl"]) {
      const sib = path.join(origDir, origStem + sibExt);
      if (fs.existsSync(sib)) {
        fs.copyFileSync(sib, path.join(tmpDir, stem + sibExt));
      }
    }
    return target;
  }

  if (!repoRoot) return null;
  const rel = path.relative(repoRoot, filePath);
  const exists = spawnSync("git", ["-C", repoRoot, "cat-file", "-e", `${ref}:${rel}`]).status === 0;
  if (!exists) return null;
  const content = execFileSync("git", ["-C", repoRoot, "show", `${ref}:${rel}`], {
    maxBuffer: 32 * 1024 * 1024,
  });
  fs.writeFileSync(target, content);

  // Pull sibling .kicad_pro / .kicad_prl from the same ref so DRC sees the
  // same project rules the engineer saw at that commit.
  const origExt = path.extname(filePath);
  const origStem = filePath.slice(0, -origExt.length);
  for (const sibExt of [".kicad_pro", ".kicad_prl"]) {
    const sibRel = path.relative(repoRoot, origStem + sibExt);
    const sibExists = spawnSync("git", ["-C", repoRoot, "cat-file", "-e", `${ref}:${sibRel}`]).status === 0;
    if (sibExists) {
      const sibContent = execFileSync("git", ["-C", repoRoot, "show", `${ref}:${sibRel}`], {
        maxBuffer: 32 * 1024 * 1024,
      });
      fs.writeFileSync(path.join(tmpDir, stem + sibExt), sibContent);
    }
  }
  return target;
}

function violationsAtRef(
  filePath: string,
  kind: CheckKind,
  ref: string,
  repoRoot: string | null,
): Violation[] {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kicadiff-check-"));
  try {
    const target = materializeAtRef(filePath, ref, repoRoot, tmpDir);
    if (target === null) return [];
    const report = path.join(tmpDir, "report.json");
    return kind === "drc" ? runDrc(target, report) : runErc(target, report);
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

export interface CheckResult {
  filePath: string;
  /** Repo-relative path when running inside a git repo; absolute otherwise. */
  displayPath: string;
  kind: CheckKind;
  diff: ViolationDiff;
}

export interface RunCheckOptions {
  files: string[];
  fromRef: string;
  toRef: string;
  repoRoot: string | null;
}

export function runCheck(opts: RunCheckOptions): CheckResult[] {
  const { files, fromRef, toRef, repoRoot } = opts;
  // Pin once so all per-file invocations see the same commits even if the
  // branch moves mid-run. resolveRefToSha is idempotent for SHAs / index /
  // working-tree markers, so this is safe to call even if the caller already
  // pinned upstream.
  const pinnedFrom = repoRoot ? resolveRefToSha(repoRoot, fromRef) : fromRef;
  const pinnedTo = repoRoot ? resolveRefToSha(repoRoot, toRef) : toRef;

  const out: CheckResult[] = [];
  for (const f of files) {
    const kind = checkKindFor(f);
    if (!kind) continue;
    const before = violationsAtRef(f, kind, pinnedFrom, repoRoot);
    const after = violationsAtRef(f, kind, pinnedTo, repoRoot);
    const diff = diffViolations(before, after);
    const displayPath = repoRoot ? path.relative(repoRoot, f) : f;
    out.push({ filePath: f, displayPath, kind, diff });
  }
  return out;
}
