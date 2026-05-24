/**
 * Text-based structural diff for KiCad files.
 *
 * Parses .kicad_pcb / .kicad_sch S-expressions and reports added, removed,
 * and changed components keyed by their Reference designator (e.g. "C42").
 * The output is a compact, human-readable summary suitable for terminals,
 * commit messages, or CI logs — complementary to the visual HTML diff.
 *
 * For .kicad_pcb we additionally diff electrical connectivity at two
 * levels — see the "Net extraction" section below. Schematic net
 * tracing (wires + labels + bus membership) is harder and remains out
 * of scope; net classes and board outlines also remain out of scope.
 */

import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { FileType } from "./types.ts";

// =============================================================================
// Minimal S-expression parser
// =============================================================================

/** S-expression node: either a list (of nodes) or an atom (string).
 *  Atoms include both bare identifiers (`footprint`) and quoted strings;
 *  quotes are stripped during parse so callers see the raw value. */
export type Sexp = string | Sexp[];

export function parseSexp(src: string): Sexp[] {
  let i = 0;
  const n = src.length;

  function skipWs(): void {
    while (i < n) {
      const c = src[i];
      if (c === " " || c === "\t" || c === "\n" || c === "\r") {
        i++;
      } else {
        break;
      }
    }
  }

  function readString(): string {
    // Opening quote already consumed; read until closing quote, handling \" and \\.
    let out = "";
    while (i < n) {
      const c = src[i++];
      if (c === "\\" && i < n) {
        out += src[i++];
      } else if (c === '"') {
        return out;
      } else {
        out += c;
      }
    }
    throw new Error("unterminated string");
  }

  function readAtom(): string {
    let out = "";
    while (i < n) {
      const c = src[i];
      if (c === "(" || c === ")" || c === " " || c === "\t" || c === "\n" || c === "\r") break;
      out += c;
      i++;
    }
    return out;
  }

  function readList(): Sexp[] {
    const list: Sexp[] = [];
    while (i < n) {
      skipWs();
      if (i >= n) throw new Error("unterminated list");
      const c = src[i];
      if (c === ")") { i++; return list; }
      if (c === "(") { i++; list.push(readList()); }
      else if (c === '"') { i++; list.push(readString()); }
      else { list.push(readAtom()); }
    }
    throw new Error("unterminated list");
  }

  const result: Sexp[] = [];
  skipWs();
  while (i < n) {
    const c = src[i];
    if (c === "(") { i++; result.push(readList()); skipWs(); }
    else if (c === '"') { i++; result.push(readString()); skipWs(); }
    else { result.push(readAtom()); skipWs(); }
  }
  return result;
}

// =============================================================================
// Component extraction
// =============================================================================

export interface Component {
  /** Reference designator (e.g. "U1", "C42"). */
  ref: string;
  /** Sub-unit number for multi-unit schematic symbols (e.g. an opamp's two
   *  channels share Reference "U1" but are units 1 and 2). undefined for
   *  single-unit parts and PCB footprints. */
  unit?: string;
  /** Composite identity used by the differ. For sch multi-unit symbols this
   *  is `${ref}/${unit}`; otherwise just `ref`. Two instances must NOT
   *  collide on `key`, or one would silently overwrite the other. */
  key: string;
  /** Value text (e.g. "100nF", "RP2040"). */
  value: string;
  /** Library ID — footprint name for PCB, symbol lib_id for sch. */
  libId: string;
  /** Position as "x,y" (rounded), or undefined if not present. */
  pos?: string;
  /** Rotation angle in degrees as a string, or undefined. */
  angle?: string;
}

/** Walk a parsed tree and call `visit` on every list whose head is `head`.
 *  Used to find all `(footprint ...)` or `(symbol ...)` blocks regardless
 *  of nesting depth. */
function walk(tree: Sexp[] | Sexp, head: string, visit: (node: Sexp[]) => void): void {
  if (typeof tree === "string") return;
  if (Array.isArray(tree)) {
    if (tree.length > 0 && tree[0] === head) visit(tree);
    for (const child of tree) walk(child, head, visit);
  }
}

/** Find a property by name within a footprint/symbol node. KiCad represents
 *  properties as `(property "Name" "Value" ...)`; we return just the value. */
function findProperty(node: Sexp[], name: string): string | undefined {
  for (const child of node) {
    if (Array.isArray(child) && child[0] === "property" && child[1] === name) {
      return typeof child[2] === "string" ? child[2] : undefined;
    }
  }
  return undefined;
}

/** Extract `(at x y [angle])` position. Returns "x,y" rounded to 2dp and
 *  the angle separately (so position can be diffed without angle noise). */
function findAt(node: Sexp[]): { pos?: string; angle?: string } {
  for (const child of node) {
    if (Array.isArray(child) && child[0] === "at") {
      const x = child[1], y = child[2], a = child[3];
      if (typeof x === "string" && typeof y === "string") {
        const px = Number(x), py = Number(y);
        const pos = `${px.toFixed(2)},${py.toFixed(2)}`;
        const angle = typeof a === "string" ? a : undefined;
        return { pos, angle };
      }
    }
  }
  return {};
}

export function extractComponents(src: string, fileType: FileType): Component[] {
  const tree = parseSexp(src);
  const out: Component[] = [];

  if (fileType === "pcb") {
    // PCB: (footprint "lib:name" ... (property "Reference" "U1" ...) ...).
    // Footprints are always one instance per reference (no unit concept).
    walk(tree, "footprint", node => {
      const libId = typeof node[1] === "string" ? node[1] : "";
      const ref = findProperty(node, "Reference") ?? "";
      const value = findProperty(node, "Value") ?? "";
      if (!ref) return;
      const { pos, angle } = findAt(node);
      out.push({ ref, key: ref, value, libId, pos, angle });
    });
  } else if (fileType === "sch") {
    // Schematic: (symbol (lib_id "...") ... (property "Reference" "U1" ...)).
    // Multi-unit parts (opamps, relays, etc.) emit one (symbol ...) block per
    // unit, all sharing the same Reference but with different `(unit N)`.
    // Distinguish them via the `key` field so the diff doesn't collapse them.
    // Skip lib_symbols entries (template symbols, not instances).
    walk(tree, "symbol", node => {
      // Instances have (uuid ...) and (at x y) at the top level; templates
      // inside (lib_symbols ...) do not.
      const hasUuid = node.some(c => Array.isArray(c) && c[0] === "uuid");
      const hasAt = node.some(c => Array.isArray(c) && c[0] === "at");
      if (!hasUuid || !hasAt) return;
      const libIdNode = node.find(c => Array.isArray(c) && c[0] === "lib_id");
      const libId = Array.isArray(libIdNode) && typeof libIdNode[1] === "string" ? libIdNode[1] : "";
      const ref = findProperty(node, "Reference") ?? "";
      const value = findProperty(node, "Value") ?? "";
      if (!ref) return;
      const unitNode = node.find(c => Array.isArray(c) && c[0] === "unit");
      const unit = Array.isArray(unitNode) && typeof unitNode[1] === "string"
        ? unitNode[1] : undefined;
      const key = unit !== undefined ? `${ref}/${unit}` : ref;
      const { pos, angle } = findAt(node);
      out.push({ ref, unit, key, value, libId, pos, angle });
    });
  }

  // Sort for deterministic output (stable across runs)
  out.sort((a, b) => a.key.localeCompare(b.key, undefined, { numeric: true }));
  return out;
}

// =============================================================================
// Net extraction (PCB only)
// =============================================================================

/**
 * Connectivity snapshot of a PCB. Two pieces, both keyed by *name* (not id,
 * because KiCad freely renumbers net ids between saves — the name is the
 * stable identity for a net).
 *
 *   - `names`     : the set of named nets that exist in the file. The
 *                   unconnected net (`""`) is deliberately excluded; it
 *                   churns constantly as the router shuffles unrouted pads
 *                   and would drown the real diff in noise.
 *   - `padNets`   : map of `"<ref>.<padNum>"` → net name, again excluding
 *                   pads whose net is `""`. Identity is the pad identifier
 *                   so we can detect "this physical pad was rewired".
 *   - `componentRefs` : set of footprint refs present, used so the diff
 *                   layer can suppress pad-moved lines for pads whose
 *                   parent footprint was itself added or removed (avoids
 *                   emitting `R5.1 ""→GND` for every pad of a freshly
 *                   added R5; the footprint-level `+ R5` line covers it).
 */
export interface NetInfo {
  names: Set<string>;
  padNets: Map<string, string>;
  componentRefs: Set<string>;
}

export function extractNets(src: string): NetInfo {
  const tree = parseSexp(src);
  const names = new Set<string>();
  const padNets = new Map<string, string>();
  const componentRefs = new Set<string>();

  // The (net ...) atom comes in two shapes:
  //   - Legacy (KiCad <= 9): `(net <id> "<name>")` — name is at index 2.
  //   - KiCad 10:            `(net "<name>")`      — name is at index 1.
  // Read whichever is present so we cover both formats.
  const netName = (atom: Sexp[]): string | undefined => {
    if (typeof atom[2] === "string") return atom[2];
    if (typeof atom[1] === "string") return atom[1];
    return undefined;
  };

  // Top-level (net ...) entries enumerate the project's net table — but
  // ONLY KiCad <= 9 emits them. KiCad 10 dropped the table entirely and
  // we have to derive the name set from pad / track entries below.
  // Nested (net ...) inside pads is membership, not declaration, and is
  // picked up later.
  if (tree.length > 0 && Array.isArray(tree[0])) {
    for (const child of tree[0]) {
      if (Array.isArray(child) && child[0] === "net") {
        const name = netName(child);
        if (name !== undefined && name !== "") names.add(name);
      }
    }
  }

  walk(tree, "footprint", node => {
    const ref = findProperty(node, "Reference") ?? "";
    if (!ref) return;
    componentRefs.add(ref);
    for (const child of node) {
      if (!Array.isArray(child) || child[0] !== "pad") continue;
      const padNum = typeof child[1] === "string" ? child[1] : "";
      if (!padNum) continue;
      // Pad's (net ...) sub-form. Absent for NC pads. Same dual-shape
      // handling as the top-level table — KiCad 10 pads have no id.
      const netSub = child.find(c => Array.isArray(c) && c[0] === "net");
      if (Array.isArray(netSub)) {
        const name = netName(netSub);
        if (name !== undefined && name !== "") {
          padNets.set(`${ref}.${padNum}`, name);
          // KiCad 10 has no top-level net table; backfill the name set
          // from pad memberships so added/removed-net detection works.
          // Harmless on legacy files — `Set.add` is idempotent.
          names.add(name);
        }
      }
    }
  });

  return { names, padNets, componentRefs };
}

export interface NetDiff {
  added: string[];
  removed: string[];
  /** Pads whose net assignment changed. `before` / `after` are net names;
   *  if a pad gained or lost a net entirely, the missing side is `""`. */
  padChanges: { pad: string; before: string; after: string }[];
}

export function diffNets(before: NetInfo, after: NetInfo): NetDiff {
  const added: string[] = [];
  const removed: string[] = [];
  for (const n of after.names) if (!before.names.has(n)) added.push(n);
  for (const n of before.names) if (!after.names.has(n)) removed.push(n);
  added.sort();
  removed.sort();

  const padChanges: NetDiff["padChanges"] = [];
  const padKeys = new Set<string>([...before.padNets.keys(), ...after.padNets.keys()]);
  for (const key of padKeys) {
    const b = before.padNets.get(key) ?? "";
    const a = after.padNets.get(key) ?? "";
    if (b === a) continue;
    // We DO report named-net ↔ unconnected transitions: pulling a pad off
    // GND or wiring an NC pad to +3V3 is a real electrical change worth
    // surfacing. (We only suppress "" from the *name set* itself — see
    // extractNets — because the unconnected net churns on every save.)
    padChanges.push({ pad: key, before: b, after: a });
  }
  padChanges.sort((x, y) => x.pad.localeCompare(y.pad, undefined, { numeric: true }));

  return { added, removed, padChanges };
}

// =============================================================================
// Diff
// =============================================================================

export interface ComponentDiff {
  added: Component[];
  removed: Component[];
  /** `key` matches the corresponding before/after Component.key — for
   *  multi-unit schematic symbols this includes the unit suffix. */
  changed: { key: string; before: Component; after: Component; fields: string[] }[];
  unchanged: number;
}

export function diffComponents(before: Component[], after: Component[]): ComponentDiff {
  // Key by `c.key` so multi-unit schematic symbols (same Reference, different
  // unit) don't overwrite each other when stuffed into a Map.
  const beforeMap = new Map(before.map(c => [c.key, c]));
  const afterMap = new Map(after.map(c => [c.key, c]));

  const added: Component[] = [];
  const removed: Component[] = [];
  const changed: ComponentDiff["changed"] = [];
  let unchanged = 0;

  for (const [key, b] of beforeMap) {
    const a = afterMap.get(key);
    if (!a) {
      removed.push(b);
      continue;
    }
    const fields: string[] = [];
    if (a.value !== b.value) fields.push("value");
    if (a.libId !== b.libId) fields.push("libId");
    if (a.pos !== b.pos) fields.push("pos");
    if (a.angle !== b.angle) fields.push("angle");
    if (fields.length > 0) changed.push({ key, before: b, after: a, fields });
    else unchanged++;
  }
  for (const [key, a] of afterMap) {
    if (!beforeMap.has(key)) added.push(a);
  }
  return { added, removed, changed, unchanged };
}

// =============================================================================
// CLI integration
// =============================================================================

/** Read the file content at a git ref (or working tree). Returns undefined
 *  if the file does not exist at that ref. */
function readAtRef(filePath: string, ref: string, repoRoot: string | null): string | undefined {
  if (ref === "" || ref === "working") {
    return fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : undefined;
  }
  if (!repoRoot) return undefined;
  const rel = path.relative(repoRoot, filePath);
  // Verify the file exists at this ref before trying to read it
  const exists = spawnSync("git", ["-C", repoRoot, "cat-file", "-e", `${ref}:${rel}`]).status === 0;
  if (!exists) return undefined;
  return execFileSync("git", ["-C", repoRoot, "show", `${ref}:${rel}`], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
}

export interface FileDiff {
  fileType: FileType;
  rel: string;
  diff: ComponentDiff;
  /** Net-level diff. Populated for `pcb` only; undefined for `sch` (schematic
   *  net tracing is out of scope — TODO when wire-tracing lands). */
  nets?: NetDiff;
}

/** Compute a structural component diff for a single KiCad file. The result is
 *  format-agnostic — both textDiff and markdownDiff render it. */
export function computeFileDiff(
  filePath: string,
  fromRef: string,
  toRef: string,
  repoRoot: string | null,
): FileDiff {
  let fileType: FileType;
  if (filePath.endsWith(".kicad_pcb")) fileType = "pcb";
  else if (filePath.endsWith(".kicad_sch")) fileType = "sch";
  else throw new Error(`text diff only supports .kicad_pcb / .kicad_sch (got: ${filePath})`);

  const beforeSrc = readAtRef(filePath, fromRef, repoRoot);
  const afterSrc = readAtRef(filePath, toRef, repoRoot);

  const before = beforeSrc ? extractComponents(beforeSrc, fileType) : [];
  const after = afterSrc ? extractComponents(afterSrc, fileType) : [];

  const rel = repoRoot ? path.relative(repoRoot, filePath) : filePath;
  const result: FileDiff = { fileType, rel, diff: diffComponents(before, after) };

  if (fileType === "pcb") {
    const empty = { names: new Set<string>(), padNets: new Map<string, string>(), componentRefs: new Set<string>() };
    const beforeNets = beforeSrc ? extractNets(beforeSrc) : empty;
    const afterNets = afterSrc ? extractNets(afterSrc) : empty;
    const netDiff = diffNets(beforeNets, afterNets);
    // Drop pad-change lines whose footprint was itself added or removed —
    // the footprint-level `+ R5` / `- R5` line already conveys the change,
    // and listing every pad of a freshly added part is noise.
    const addedRefs = new Set(result.diff.added.map(c => c.ref));
    const removedRefs = new Set(result.diff.removed.map(c => c.ref));
    netDiff.padChanges = netDiff.padChanges.filter(p => {
      const ref = p.pad.split(".")[0];
      return !addedRefs.has(ref) && !removedRefs.has(ref);
    });
    result.nets = netDiff;
  }

  return result;
}

/** Render a textual diff for a single KiCad file. Returns a multi-line string. */
export function textDiff(
  filePath: string,
  fromRef: string,
  toRef: string,
  repoRoot: string | null,
): string {
  const fd = computeFileDiff(filePath, fromRef, toRef, repoRoot);
  const { fileType, rel, diff: d, nets } = fd;
  const lines: string[] = [];
  lines.push(`${rel} (${fileType}): +${d.added.length} -${d.removed.length} ~${d.changed.length} =${d.unchanged}`);

  // Use displayRef so multi-unit symbols show as "U1/2" rather than "U1"
  const displayRef = (c: Component) => c.unit !== undefined ? `${c.ref}/${c.unit}` : c.ref;
  for (const c of d.added) {
    lines.push(`  + ${displayRef(c)} ${c.value} [${c.libId}]${c.pos ? ` at (${c.pos})` : ""}`);
  }
  for (const c of d.removed) {
    lines.push(`  - ${displayRef(c)} ${c.value} [${c.libId}]${c.pos ? ` at (${c.pos})` : ""}`);
  }
  for (const ch of d.changed) {
    const parts: string[] = [];
    for (const f of ch.fields) {
      const bv = (ch.before as unknown as Record<string, string | undefined>)[f] ?? "";
      const av = (ch.after as unknown as Record<string, string | undefined>)[f] ?? "";
      parts.push(`${f}: ${bv} → ${av}`);
    }
    lines.push(`  ~ ${displayRef(ch.after)}  ${parts.join(", ")}`);
  }

  // Net subsection. Format:
  //   Nets: +A -R ~P
  //     + new_net_name
  //     - old_net_name
  //     ~ R1.2: old_net → new_net
  // The header summary stays component-only so existing callers / templates
  // that parse `+A -R ~C =U` keep working unchanged.
  if (nets && (nets.added.length || nets.removed.length || nets.padChanges.length)) {
    lines.push(`  Nets: +${nets.added.length} -${nets.removed.length} ~${nets.padChanges.length}`);
    for (const n of nets.added) lines.push(`    + ${n}`);
    for (const n of nets.removed) lines.push(`    - ${n}`);
    // The unconnected net is named `""` in the file; render it as a word so
    // a pad-disconnect line reads "GND → (unconnected)" instead of "GND → ".
    const netLabel = (n: string) => n === "" ? "(unconnected)" : n;
    for (const p of nets.padChanges) {
      lines.push(`    ~ ${p.pad}: ${netLabel(p.before)} → ${netLabel(p.after)}`);
    }
  }
  return lines.join("\n");
}

/** Render a markdown diff for a single KiCad file. Suitable for pasting into
 *  PR descriptions, issue comments, or commit messages — refs, values, and
 *  field names are wrapped in backticks for monospace rendering. */
export function markdownDiff(
  filePath: string,
  fromRef: string,
  toRef: string,
  repoRoot: string | null,
): string {
  const fd = computeFileDiff(filePath, fromRef, toRef, repoRoot);
  const { fileType, rel, diff: d, nets } = fd;
  const lines: string[] = [];

  // File header. Backtick the path so it renders monospace and won't be
  // interpreted as markdown formatting if it contains `_` or other chars.
  lines.push(`## \`${rel}\` (${fileType})`);
  lines.push("");
  lines.push(`\`+${d.added.length}\` \`-${d.removed.length}\` \`~${d.changed.length}\` \`=${d.unchanged}\``);

  // Display ref includes the unit number for multi-unit schematic symbols:
  // "U1/2" disambiguates the second unit of an opamp etc.
  const displayRef = (c: Component) => c.unit !== undefined ? `${c.ref}/${c.unit}` : c.ref;
  if (d.added.length > 0) {
    lines.push("");
    lines.push(`### Added (${d.added.length})`);
    for (const c of d.added) {
      const at = c.pos ? ` at \`(${c.pos})\`` : "";
      lines.push(`- \`${displayRef(c)}\` \`${c.value}\` \`${c.libId}\`${at}`);
    }
  }
  if (d.removed.length > 0) {
    lines.push("");
    lines.push(`### Removed (${d.removed.length})`);
    for (const c of d.removed) {
      const at = c.pos ? ` at \`(${c.pos})\`` : "";
      lines.push(`- \`${displayRef(c)}\` \`${c.value}\` \`${c.libId}\`${at}`);
    }
  }
  if (d.changed.length > 0) {
    lines.push("");
    lines.push(`### Changed (${d.changed.length})`);
    for (const ch of d.changed) {
      const parts: string[] = [];
      for (const f of ch.fields) {
        const bv = (ch.before as unknown as Record<string, string | undefined>)[f] ?? "";
        const av = (ch.after as unknown as Record<string, string | undefined>)[f] ?? "";
        parts.push(`${f}: \`${bv}\` → \`${av}\``);
      }
      lines.push(`- \`${displayRef(ch.after)}\` — ${parts.join(", ")}`);
    }
  }

  if (nets && (nets.added.length || nets.removed.length || nets.padChanges.length)) {
    lines.push("");
    lines.push(`### Nets (+${nets.added.length} -${nets.removed.length} ~${nets.padChanges.length})`);
    for (const n of nets.added) lines.push(`- \`+\` \`${n}\``);
    for (const n of nets.removed) lines.push(`- \`-\` \`${n}\``);
    const netLabel = (n: string) => n === "" ? "(unconnected)" : n;
    for (const p of nets.padChanges) {
      lines.push(`- \`~\` \`${p.pad}\` — \`${netLabel(p.before)}\` → \`${netLabel(p.after)}\``);
    }
  }
  return lines.join("\n");
}
