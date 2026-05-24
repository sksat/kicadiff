#!/usr/bin/env bun
/**
 * kicadiff CLI entry point.
 *
 * Usage (git diff-compatible):
 *   kicadiff                                 cwd as input (combined PCB+sch).
 *                                            Default = index (`:0`) vs working
 *                                            tree, same as bare `git diff`.
 *   kicadiff --cached / --staged             HEAD vs index (same as
 *                                            `git diff --cached`).
 *   kicadiff <input>                         <input> = file/dir/.kicad_pro
 *   kicadiff <ref> <input>                   Compare working tree vs <ref>
 *   kicadiff <r1> <r2> <input>               Compare <r1> vs <r2>
 *   kicadiff <r1>..<r2> <input>              Same as above (range syntax)
 *   kicadiff <ref> -- <input>                Explicit `--` separator
 *   kicadiff pcb|sch <file>                  Subcommand (single-file scoped)
 *   kicadiff hook                            Read PostToolUse JSON from stdin
 *                                            and render if a KiCad file was
 *                                            edited (Claude Code integration).
 *
 * Special refs: `:0` (or `index` / `staged`) reads the git index — same
 * notation as `git show :0:path`. `""` / `"working"` means the working tree.
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { renderProject, printProjectSummary, resolveInputs, resolveOutputPath, resolveRefToSha } from "./render.ts";
import type { LogLevel, ProjectRenderResult } from "./render.ts";
import { textDiff, markdownDiff, computeFileDiff } from "./textdiff.ts";
import { renderTemplate } from "./template.ts";
import { runCheck, checkKindFor, formatCheckDiff } from "./check.ts";
import type { FileType } from "./types.ts";

function usage(): void {
  console.log(`kicadiff — Visual diff for KiCad files

Usage:
  kicadiff [<refs>] [<input>]              Combined PCB + schematic diff
  kicadiff <subcommand> [<refs>] <file>    Single-type scoped diff

Subcommands:
  pcb        Render only the PCB diff (.kicad_pcb file required)
  sch        Render only the schematic diff (.kicad_sch file required)
  schematic  Alias for \`sch\`
  sym        Render only the symbol library diff (.kicad_sym file required)
  symbol     Alias for \`sym\`
  fp         Render footprint diff (.kicad_mod file or .pretty/ directory)
  footprint  Alias for \`fp\`
  hook       Claude Code PostToolUse adapter: read the hook JSON from stdin,
             render only when the edited file is .kicad_pcb / .kicad_sch.
             Defaults to \`--open vscode\`; pass \`--open ...\` to override.
  check      Run DRC (.kicad_pcb) / ERC (.kicad_sch) on both sides and report
             the violation delta as +N new / -M fixed / =K unchanged. Exits 1
             when NEW violations are introduced on the target side, so the
             gate fails only on regressions — pre-existing violations that
             persist do not fail the check. Operational failures (missing
             kicad-cli, git errors, JSON parse errors) also produce a
             non-zero exit. Same positional shape as bare \`kicadiff\` (refs
             first, input last). Skips .kicad_sym / .kicad_mod.

Inputs (positional):
  <input>    One of:
               - <file.kicad_pcb> / <file.kicad_sch>  (single file; sibling of
                 the other type is auto-included unless a subcommand scopes it)
               - <file.kicad_sym> / <file.kicad_mod>  (single library / footprint)
               - <dir.pretty>                          (footprint library directory)
               - <file.kicad_pro>                      (KiCad project file)
               - <directory>                           (find all files in dir)
               - (omitted)                             (current working dir)

Refs (positional, git diff-compatible):
  <ref>             Compare working tree vs <ref>            (1 ref)
  <r1> <r2>         Compare <r1> vs <r2>                     (2 refs)
  <r1>..<r2>        Same as above (range syntax)             (1 ref token)
  --                Separator: refs before, input after

  Special ref names: \`:0\` (or \`index\` / \`staged\`) reads the git index —
  same notation as \`git show :0:path\`. \`working\` (or the empty toRef)
  means the working tree. Bare \`kicadiff\` defaults to \`:0\` vs working,
  matching \`git diff\`.

Options:
  --from <ref>           Base ref (alternative to positional)
  --to <ref>             Target ref (alternative to positional; default: working tree)
  --cached, --staged     Compare HEAD vs the index (same as \`git diff --cached\`).
                         Equivalent to \`--from HEAD --to :0\`. A positional
                         \`<ref>\` combined with --cached overrides the default
                         from (so \`kicadiff --cached main\` is main vs index).
  --output-dir <dir>     Image output directory (default: <repo>/.claude/preview)
  -o, --output <path>    Output file path. Default: <output-dir>/<name>_diff.html
                         (or .md with --markdown). Image paths in the file are
                         emitted relative to <path>'s directory so the file is
                         portable. Use \`--output -\` or \`--output stdout\` to
                         write the markdown report to stdout instead of a file.
  --images-only          Skip HTML generation and auto-open
  --text                 Also print a structural text diff to stdout
  --text-only            Print only the text diff (no SVG/PNG/HTML rendering — fast)
  --markdown, --md       Render images and emit a markdown report (side-by-side
                         image table + structural diff). Skips HTML viewer.
  --md-template <path>   Use a custom project-level markdown template. The
                         template sees: from_ref, to_ref, from_label, to_label,
                         file_count, has_changes, files (array), and the
                         pre-rendered file_sections string. Mustache subset:
                         {{var}}, {{#section}}…{{/section}}, {{^inverted}}…{{/}}.
  --md-file-template <p> Use a custom per-file markdown template. Rendered for
                         each file with: path, type, before_image, after_image,
                         has_before, has_after, has_both, after_only, before_only,
                         added_count, removed_count, changed_count, unchanged_count,
                         nets_added, nets_removed, nets_changed (pcb only),
                         has_structural_diff (real component OR net changes exist),
                         has_visual_diff (rendered PNGs differ), has_changes (any
                         of the above), and structural_diff (the formatted body).
                         The result fills {{file_sections}} in the project template.
  -v, --verbose, --debug Show every PNG path in the summary (default: only HTML path)
  -q, --quiet            Suppress the summary entirely
  --log <level>          Set summary log level: quiet | info | debug (default: info)
  --no-cache             Skip the render cache (default: cached at \$XDG_CACHE_HOME/kicadiff)
  --exit-code            Exit with status 1 if any change is detected, 0 otherwise.
                         Errors still exit non-zero. Mirrors \`git diff --exit-code\`.
  --watch                Long-running mode: re-render whenever an input KiCad
                         file changes. Hot reload comes from your viewer —
                         open the diff HTML in VSCode Live Preview, live-server,
                         or any auto-reloading viewer for an end-to-end loop.
  --open                 Open diff HTML with xdg-open after rendering
  --open vscode|code     Open in VSCode tab (\`code -r\`)
  --open firefox|...     Open in named browser (firefox, chromium, chrome, etc.)
  --open=<cmd>           Use arbitrary command (\`<cmd> <html-path>\`)
  -h, --help             Show this help

Env:
  KICADIFF_OPEN_CMD      Override --open command (full command, html path
                         appended; empty string = no-op). Useful for testing.

Examples:
  kicadiff                              # cwd, combined PCB+sch — index vs working
  kicadiff --cached                     # HEAD vs index (staged-only delta)
  kicadiff HEAD project/                # working tree vs HEAD (staged + unstaged)
  kicadiff project/                     # both files in project/
  kicadiff foo.kicad_pcb                # foo.kicad_pcb + sibling foo.kicad_sch
  kicadiff main project/                # working tree vs main
  kicadiff main..feat foo.kicad_pcb     # main vs feat
  kicadiff pcb foo.kicad_pcb            # PCB only (no auto-include)
  kicadiff schematic foo.kicad_sch      # schematic only
  kicadiff v1.0 v2.0 -- board.kicad_pcb # explicit -- separator
`);
}

interface ParsedArgs {
  /** Resolved input — file path, directory, .kicad_pro, or undefined (=cwd) */
  input?: string;
  fromRef?: string;
  toRef?: string;
  outputDir?: string;
  /** Explicit path for the combined diff HTML file. When set, manifest image
   *  paths are emitted relative to the HTML's directory. */
  outputHtml?: string;
  imagesOnly?: boolean;
  /** Print structural text diff to stdout. Cheap (no SVG/PNG rendering).
   *  When also producing HTML/images, the text appears alongside. */
  text?: boolean;
  /** Skip HTML/image rendering — only print the text diff. */
  textOnly?: boolean;
  /** Markdown mode: emit a markdown report referencing rendered images
   *  (side-by-side, structural diff for pcb/sch). Images are rendered;
   *  HTML viewer generation is skipped (markdown is the deliverable). */
  markdown?: boolean;
  /** Path to a custom project-level markdown template. Sees the project
   *  context: from_ref, to_ref, files (array), file_count, has_changes,
   *  and the pre-rendered file_sections string. */
  mdTemplate?: string;
  /** Path to a custom per-file markdown template. Rendered once per file
   *  with the file context (path, type, before_image, after_image, the
   *  *_only / has_* booleans, and structural_diff). The result populates
   *  file_sections in the project template. */
  mdFileTemplate?: string;
  /** Log level for stdout summary. Default "info". "debug" surfaces every PNG
   *  path; "quiet" suppresses the summary entirely. */
  logLevel?: LogLevel;
  /** Disable the per-side render cache (default: cache enabled). */
  noCache?: boolean;
  scope?: FileType;
  open?: string;
  /** Long-running watch mode: re-render on file change. Hot-reload of the
   *  viewer is delegated to whatever already serves the HTML (VSCode Live
   *  Preview, live-server, browsersync, etc.). */
  watch?: boolean;
  /** `git diff --exit-code` semantics: when set, exit 1 if any change is
   *  detected, 0 otherwise. Errors still exit non-zero as today. Lets CI
   *  wrappers detect "kicad files changed" via process exit instead of
   *  parsing stdout. */
  exitCode?: boolean;
}

/** Known names that can be used after a bare `--open` (with a space).
 *  Anything else needs `--open=<value>` to disambiguate from positional args. */
const KNOWN_OPEN_TARGETS = new Set([
  "xdg",
  "vscode", "code",
  "firefox", "chromium", "chrome", "brave", "edge", "safari",
]);

/** True if `s` looks like a kicadiff input (kicad file, .kicad_pro, or
 *  an existing directory). Used to disambiguate input from refs.
 *
 *  The slash-containing case is tricky: branch names commonly contain
 *  slashes (`feature/foo`, `release/v1`), so we can't treat any slash as
 *  "this is a path". Heuristic:
 *    - explicit relative/absolute paths (`./x`, `../x`, `/x`, ends with `/`)
 *    - paths that exist on disk
 *  Anything else → falls through to ref handling, where `git rev-parse`
 *  validates the name and reports a useful error if it isn't a ref either. */
function isLikelyInput(s: string): boolean {
  if (
    s.endsWith(".kicad_pcb") ||
    s.endsWith(".kicad_sch") ||
    s.endsWith(".kicad_pro") ||
    s.endsWith(".kicad_sym") ||
    s.endsWith(".kicad_mod") ||
    s.endsWith(".pretty") ||
    s.endsWith(".pretty/")
  ) {
    return true;
  }
  if (s === "." || s.startsWith("./") || s.startsWith("../") || s.startsWith("/") || s.endsWith("/")) {
    return true;
  }
  // A bare slash-containing token might be a path or a branch name; only
  // treat as input if it actually exists on disk. Existence wins over the
  // ref name if both happen to coincide — explicit `--` separator can
  // disambiguate that edge case.
  if (s.includes("/")) {
    try { return fs.existsSync(s); } catch { /* fall through */ }
  }
  return false;
}

/** Canonical form of the git index marker. `git show :0:path` reads stage 0
 *  of the index for `path` — same notation we use throughout. */
const INDEX_REF = ":0";

/** True if `s` is one of the accepted spellings for the git index. We
 *  normalise to `INDEX_REF` everywhere downstream so manifest output and
 *  comparison are consistent regardless of which spelling the user typed. */
function isIndexAlias(s: string): boolean {
  return s === INDEX_REF || s === "index" || s === "staged";
}

/** Validate a string is a usable git ref. */
function isLikelyValidRef(ref: string): boolean {
  if (ref === "" || ref === "working") return true;
  if (isIndexAlias(ref)) return true;
  const r = spawnSync("git", ["rev-parse", "--verify", "--quiet", ref + "^{}"], {
    stdio: ["ignore", "ignore", "ignore"],
  });
  return r.status === 0;
}

function parseArgs(argv: string[]): ParsedArgs {
  let i = 0;
  let scope: FileType | undefined;

  // Detect leading subcommand. Aliases:
  //   sch ↔ schematic
  //   sym ↔ symbol
  //   fp  ↔ footprint
  if (argv[0] === "pcb") {
    scope = "pcb";
    i = 1;
  } else if (argv[0] === "sch" || argv[0] === "schematic") {
    scope = "sch";
    i = 1;
  } else if (argv[0] === "sym" || argv[0] === "symbol") {
    scope = "sym";
    i = 1;
  } else if (argv[0] === "fp" || argv[0] === "footprint") {
    scope = "fp";
    i = 1;
  }

  const positional: string[] = [];
  const inputsAfterDash: string[] = [];
  let sawDoubleDash = false;
  let fromRef: string | undefined;
  let toRef: string | undefined;
  let outputDir: string | undefined;
  let outputHtml: string | undefined;
  let imagesOnly = false;
  let text = false;
  let textOnly = false;
  let markdown = false;
  let mdTemplate: string | undefined;
  let mdFileTemplate: string | undefined;
  let logLevel: LogLevel | undefined;
  let noCache = false;
  let open: string | undefined;
  let watch = false;
  let cached = false;
  let exitCode = false;

  for (; i < argv.length; i++) {
    const arg = argv[i];
    if (sawDoubleDash) {
      inputsAfterDash.push(arg);
      continue;
    }
    if (arg === "--") {
      sawDoubleDash = true;
    } else if (arg === "--from") {
      if (i + 1 >= argv.length) throw new Error("--from requires a value");
      fromRef = argv[++i];
    } else if (arg === "--to") {
      if (i + 1 >= argv.length) throw new Error("--to requires a value");
      toRef = argv[++i];
    } else if (arg === "--output-dir") {
      if (i + 1 >= argv.length) throw new Error("--output-dir requires a value");
      outputDir = argv[++i];
    } else if (arg === "--output" || arg === "-o") {
      if (i + 1 >= argv.length) throw new Error(`${arg} requires a value`);
      outputHtml = argv[++i];
    } else if (arg.startsWith("--output=")) {
      outputHtml = arg.slice("--output=".length);
    } else if (arg === "--images-only") {
      imagesOnly = true;
    } else if (arg === "--text") {
      text = true;
    } else if (arg === "--text-only") {
      textOnly = true;
      text = true;
    } else if (arg === "--markdown" || arg === "--md") {
      markdown = true;
    } else if (arg === "--md-template") {
      if (i + 1 >= argv.length) throw new Error("--md-template requires a path");
      mdTemplate = argv[++i];
    } else if (arg === "--md-file-template") {
      if (i + 1 >= argv.length) throw new Error("--md-file-template requires a path");
      mdFileTemplate = argv[++i];
    } else if (arg === "--no-cache") {
      noCache = true;
    } else if (arg === "--watch") {
      watch = true;
    } else if (arg === "--exit-code") {
      exitCode = true;
    } else if (arg === "--cached" || arg === "--staged") {
      // `git diff --cached` semantics: compare HEAD against the index.
      // Explicit --from / --to / positional refs still win.
      cached = true;
    } else if (arg === "--verbose" || arg === "-v" || arg === "--debug") {
      logLevel = "debug";
    } else if (arg === "--quiet" || arg === "-q") {
      logLevel = "quiet";
    } else if (arg === "--log") {
      if (i + 1 >= argv.length) throw new Error("--log requires a value");
      const v = argv[++i];
      if (v !== "quiet" && v !== "info" && v !== "debug") {
        throw new Error(`invalid --log level: ${v} (expected quiet, info, or debug)`);
      }
      logLevel = v;
    } else if (arg === "--open" || arg.startsWith("--open=")) {
      let target: string | undefined;
      if (arg.startsWith("--open=")) {
        target = arg.slice("--open=".length);
      } else if (i + 1 < argv.length && KNOWN_OPEN_TARGETS.has(argv[i + 1])) {
        target = argv[++i];
      }
      open = target ?? "xdg";
    } else if (arg.startsWith("--")) {
      throw new Error(`unknown option: ${arg}`);
    } else {
      positional.push(arg);
    }
  }

  // Determine which positional is the input, which are refs.
  // - With `--`: everything after `--` is input(s); pre-`--` is refs.
  // - Otherwise: the LAST positional that looks like an input (file/dir/pro)
  //   is treated as input; earlier positionals are refs.
  // - If no positional looks like an input, all are refs and input = undefined (cwd).
  let input: string | undefined;
  let refTokens: string[];
  if (sawDoubleDash) {
    if (inputsAfterDash.length > 1) {
      throw new Error(`expected at most 1 input after \`--\`, got ${inputsAfterDash.length}`);
    }
    input = inputsAfterDash[0];
    refTokens = positional;
  } else {
    let inputIdx = -1;
    for (let j = positional.length - 1; j >= 0; j--) {
      if (isLikelyInput(positional[j])) { inputIdx = j; break; }
    }
    if (inputIdx === -1) {
      // No path-like positional — all are refs, input = cwd
      input = undefined;
      refTokens = positional;
    } else {
      if (positional.slice(inputIdx + 1).length > 0) {
        throw new Error(`extra arguments after input: ${positional.slice(inputIdx + 1).join(" ")}`);
      }
      input = positional[inputIdx];
      refTokens = positional.slice(0, inputIdx);
    }
  }

  // Expand `<r1>..<r2>` range, then normalise index aliases (`index` /
  // `staged` → `:0`) so the rest of the pipeline only ever sees the
  // canonical form.
  const expandedRefs: string[] = [];
  for (const tok of refTokens) {
    const dotIdx = tok.indexOf("..");
    if (dotIdx > 0 && dotIdx < tok.length - 2) {
      expandedRefs.push(tok.slice(0, dotIdx), tok.slice(dotIdx + 2));
    } else {
      expandedRefs.push(tok);
    }
  }
  for (let j = 0; j < expandedRefs.length; j++) {
    if (isIndexAlias(expandedRefs[j])) expandedRefs[j] = INDEX_REF;
  }

  // Map positional refs to from/to
  if (expandedRefs.length === 0) {
    // Defaults applied below (depending on --cached, otherwise index vs working)
  } else if (expandedRefs.length === 1) {
    if (fromRef === undefined) fromRef = expandedRefs[0];
  } else if (expandedRefs.length === 2) {
    if (fromRef === undefined) fromRef = expandedRefs[0];
    if (toRef === undefined) toRef = expandedRefs[1];
  } else {
    throw new Error(
      `too many ref arguments (max 2, got ${expandedRefs.length}): ${expandedRefs.join(" ")}`,
    );
  }

  // --cached / --staged switches the "to" side to the index. Mirrors
  // `git diff --cached`: bare flag = HEAD vs index, `--cached <ref>` =
  // <ref> vs index. Explicit --from / --to / a 2-ref positional pair win.
  if (cached) {
    if (fromRef === undefined) fromRef = "HEAD";
    if (toRef === undefined) toRef = INDEX_REF;
  }

  // Normalise --from / --to aliases too (so `--from index` works).
  if (fromRef !== undefined && isIndexAlias(fromRef)) fromRef = INDEX_REF;
  if (toRef !== undefined && isIndexAlias(toRef)) toRef = INDEX_REF;

  if (fromRef !== undefined && !isLikelyValidRef(fromRef)) {
    throw new Error(`bad ref: ${fromRef}`);
  }
  if (toRef !== undefined && !isLikelyValidRef(toRef)) {
    throw new Error(`bad ref: ${toRef}`);
  }

  // --exit-code only has meaning for one-shot invocations: it signals
  // "did anything change?" via the process exit status. --watch is a
  // long-running mode that never exits on its own, so the combination
  // is incoherent. Reject up front rather than silently dropping the
  // flag — users mirroring `git diff --exit-code` muscle memory would
  // otherwise be surprised when their CI wrapper hangs forever.
  if (watch && exitCode) {
    throw new Error(
      "--exit-code is not compatible with --watch (watch is long-running; --exit-code only has meaning for one-shot invocations)",
    );
  }

  // Validate subcommand vs input extension when input is a single file.
  // Directory and .kicad_pro inputs skip this check (resolveInputs handles
  // scope-filtering). For sym/fp the file may also be a .pretty directory,
  // so we don't enforce strictly here either.
  if (input !== undefined) {
    if (scope === "pcb" && !input.endsWith(".kicad_pcb")) {
      throw new Error(`pcb subcommand requires a .kicad_pcb file, got: ${input}`);
    }
    if (scope === "sch" && !input.endsWith(".kicad_sch")) {
      throw new Error(`sch subcommand requires a .kicad_sch file, got: ${input}`);
    }
    if (scope === "sym" && !input.endsWith(".kicad_sym")) {
      throw new Error(`sym subcommand requires a .kicad_sym file, got: ${input}`);
    }
    if (scope === "fp" && !input.endsWith(".kicad_mod") && !input.endsWith(".pretty") && !input.endsWith(".pretty/")) {
      throw new Error(`fp subcommand requires a .kicad_mod file or .pretty directory, got: ${input}`);
    }
  }

  return {
    input, fromRef, toRef, outputDir, outputHtml, imagesOnly, text, textOnly,
    markdown, mdTemplate, mdFileTemplate, logLevel, noCache, scope, open, watch,
    exitCode,
  };
}

/** Read all of stdin synchronously. Used by the `hook` subcommand to consume
 *  the PostToolUse JSON Claude Code pipes in. We deliberately use the
 *  fd-based `readFileSync(0, ...)` form: it's available on every runtime
 *  (Node, Bun) and avoids the async/streaming dance that `process.stdin`
 *  would otherwise require for what is essentially a one-shot read. */
function readStdinSync(): string {
  try {
    return fs.readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

/** Translate a Claude Code PostToolUse hook invocation into normal kicadiff
 *  arguments. Returns the synthesized argv to feed into parseArgs, or `null`
 *  if the hook should be a no-op (the edited file isn't a KiCad file, or
 *  doesn't exist). The shape of the input is documented at:
 *  https://docs.anthropic.com/en/docs/claude-code/hooks#hook-input
 *
 *  Default behavior mirrors the previous shell wrapper: render with
 *  `--open vscode` so the diff opens automatically in a Live Preview tab.
 *  Anything the caller already passed (e.g. `--open firefox`) wins. */
function expandHookArgs(restArgs: string[]): string[] | null {
  const stdin = readStdinSync();
  let data: { tool_input?: { file_path?: string } };
  try {
    data = JSON.parse(stdin);
  } catch (e) {
    console.error(`kicadiff hook: invalid JSON on stdin: ${(e as Error).message}`);
    process.exit(1);
  }
  const filePath = data?.tool_input?.file_path ?? "";
  // Quietly skip non-KiCad edits — the hook fires on every Edit/Write, so
  // it must be cheap and silent for the common case.
  if (!filePath) return null;
  if (!filePath.endsWith(".kicad_pcb") && !filePath.endsWith(".kicad_sch")) {
    return null;
  }
  const abs = path.isAbsolute(filePath)
    ? filePath
    : path.resolve(process.cwd(), filePath);
  // The path may be reported for a delete or for a write that hasn't flushed
  // yet — either way, no file = nothing to diff.
  if (!fs.existsSync(abs)) return null;

  const hasOpen = restArgs.some(a => a === "--open" || a.startsWith("--open="));
  const out = [...restArgs];
  if (!hasOpen) out.push("--open", "vscode");
  out.push(abs);
  return out;
}

async function main(): Promise<void> {
  let argv = process.argv.slice(2);
  if (argv[0] === "-h" || argv[0] === "--help") {
    usage();
    process.exit(0);
  }

  if (argv[0] === "hook") {
    if (argv[1] === "-h" || argv[1] === "--help") {
      usage();
      process.exit(0);
    }
    const expanded = expandHookArgs(argv.slice(1));
    if (expanded === null) process.exit(0);
    argv = expanded;
  }

  // `check` is a verb subcommand: it reuses the rest of kicadiff's positional
  // parser (refs + input), but the dispatch target is the DRC/ERC differ
  // rather than the render pipeline. Strip the leading `check` token here so
  // the remaining argv shape matches everywhere else, then hand off to
  // runCheckCli below.
  let checkMode = false;
  if (argv[0] === "check") {
    if (argv[1] === "-h" || argv[1] === "--help") {
      usage();
      process.exit(0);
    }
    checkMode = true;
    argv = argv.slice(1);
  }

  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(argv);
  } catch (e) {
    console.error(`Error: ${(e as Error).message}`);
    usage();
    process.exit(1);
  }

  if (checkMode) {
    try {
      pinParsedRefs(parsed);
      const exit = runCheckCli(parsed);
      process.exit(exit);
    } catch (e) {
      console.error(`Error: ${(e as Error).message}`);
      process.exit(1);
    }
  }

  try {
    // --watch hands off to the long-running watcher: it does the same
    // initial render, then keeps re-rendering on every input file change.
    // Deliberately runs *before* the main pinning step below — each
    // rerender re-pins on its own (inside renderProject), so watch tracks
    // a moving branch over the lifetime of the watcher instead of being
    // frozen to whatever the ref pointed at when the watcher started.
    if (parsed.watch) {
      const { startWatch } = await import("./watch.ts");
      await startWatch({
        input: parsed.input,
        outputDir: parsed.outputDir,
        outputHtml: parsed.outputHtml,
        imagesOnly: parsed.imagesOnly,
        fromRef: parsed.fromRef,
        toRef: parsed.toRef,
        open: parsed.open,
        scope: parsed.scope,
        noCache: parsed.noCache,
      });
      return;
    }

    // Pin mutable refs once at the top of the run so every downstream
    // consumer — renderProject, printTextDiff, buildMarkdownReport — sees
    // the same commit. Without this, the branch could move between the
    // render and the report and the markdown headings + structural diff
    // would describe a different commit pair than the already-rendered
    // images. Each callee still pins again internally; that resolution is
    // idempotent once the ref is already a 40-char SHA.
    pinParsedRefs(parsed);

    // --text-only short-circuits rendering entirely — useful when piping the
    // structural diff into another tool without paying for SVG/PNG.
    if (parsed.textOnly) {
      const anyChanges = printTextDiff(parsed);
      if (parsed.exitCode && anyChanges) process.exit(1);
      return;
    }

    // --markdown skips HTML viewer generation: the markdown is the deliverable
    // and the viewer would be redundant. Images still render so the markdown
    // can reference them.
    const skipHtml = parsed.imagesOnly || parsed.markdown;

    const project = await renderProject({
      input: parsed.input,
      outputDir: parsed.outputDir,
      outputHtml: parsed.outputHtml,
      imagesOnly: skipHtml,
      fromRef: parsed.fromRef,
      toRef: parsed.toRef,
      open: parsed.open,
      scope: parsed.scope,
      noCache: parsed.noCache,
    });
    // When stdout is reserved for the markdown report (--md --output stdout/-),
    // route the summary line to stderr so the user can pipe `> report.md`
    // without polluting the file with progress chatter.
    const stdoutIsReport = parsed.markdown
      && (parsed.outputHtml === "-" || parsed.outputHtml === "stdout");
    printProjectSummary(project, !!skipHtml, parsed.logLevel ?? "info", stdoutIsReport);
    const quiet = (parsed.logLevel ?? "info") === "quiet";
    const newline = (s: string) => stdoutIsReport ? process.stderr.write(s + "\n") : console.log(s);
    if (parsed.text) {
      if (!quiet) newline("");
      // When stdout is reserved for the markdown report, route the text
      // diff to stderr too so it doesn't get prepended to the .md file.
      printTextDiff(parsed, stdoutIsReport ? "stderr" : "stdout");
    }
    // Track whether the markdown path already computed the per-file change
    // verdict. When it has, `projectHasChanges` can reuse the result instead
    // of re-running `computeFileDiff` for every pcb/sch file — that work
    // already happened inside `buildMarkdownReport`, and on large projects
    // it's the dominant cost.
    let mdHasChanges: boolean | undefined;
    if (parsed.markdown) {
      if (!quiet && !stdoutIsReport) newline("");
      mdHasChanges = emitMarkdownReport(parsed, project);
    }
    if (parsed.exitCode) {
      const changed = mdHasChanges ?? projectHasChanges(parsed, project);
      if (changed) process.exit(1);
    }
  } catch (e) {
    console.error(`Error: ${(e as Error).message}`);
    process.exit(1);
  }
}

/** True if any file in the rendered project shows a meaningful change.
 *  Mirrors the per-file `has_changes` definition exposed to markdown
 *  templates in buildMarkdownReport: structural diff, visual diff (PNG
 *  bytes differ), or one side missing entirely. Kept in sync with that
 *  definition so `--exit-code` and the markdown `{{has_changes}}` flag
 *  always agree about what counts as a change.
 *
 *  Only called when the markdown path didn't already compute the verdict —
 *  `emitMarkdownReport` returns the same answer as a by-product of building
 *  the report, so the caller in main() prefers that to avoid re-parsing
 *  every pcb/sch file twice. */
function projectHasChanges(parsed: ParsedArgs, project: ProjectRenderResult): boolean {
  const repoRoot = project.results[0] ? repoRootOf(project.results[0].filePath) : null;
  // parsed.{from,to}Ref are already pinned at the top of main(); fall back
  // to the same defaults the rest of the pipeline uses if pinning was a no-op.
  const fromRef = parsed.fromRef ?? INDEX_REF;
  const toRef = parsed.toRef ?? "";
  for (const r of project.results) {
    const m = r.manifest;
    const hasBoth = !!(m.hasBefore && r.beforePng && r.afterPng);
    const afterOnly = !hasBoth && !!r.afterPng;
    const beforeOnly = !hasBoth && !r.afterPng && !!r.beforePng;
    if (afterOnly || beforeOnly) return true;
    if (m.hasDiff) return true;
    if (m.type === "pcb" || m.type === "sch") {
      const fd = computeFileDiff(r.filePath, fromRef, toRef, repoRoot);
      if (fd.diff.added.length + fd.diff.removed.length + fd.diff.changed.length > 0) {
        return true;
      }
    }
  }
  return false;
}

/** Resolve inputs, run DRC/ERC on each supported file at both refs, and
 *  print the violation delta. Returns the process exit code: 1 if any file
 *  introduced NEW violations on the `to` side (i.e. a regression), 0
 *  otherwise. Files that don't support DRC/ERC (.kicad_sym, .kicad_mod) are
 *  skipped with a stderr note rather than failing the run — a `check` over
 *  a project directory may legitimately include sibling libraries. */
function runCheckCli(parsed: ParsedArgs): number {
  const files = resolveInputs(parsed.input, parsed.scope);
  const supported = files.filter((f) => checkKindFor(f) !== null);
  const skipped = files.filter((f) => checkKindFor(f) === null);
  // Aggregate skips into one summary line. resolveInputs auto-includes every
  // .kicad_mod inside a sibling .pretty/ library, so a footprint library can
  // produce dozens of "unsupported" entries — printing one stderr line each
  // would flood CI logs without telling the user anything useful.
  if (skipped.length > 0) {
    const sample = skipped.slice(0, 3).map((f) => path.basename(f)).join(", ");
    const more = skipped.length > 3 ? `, …` : "";
    console.error(
      `kicadiff check: skipped ${skipped.length} unsupported file${skipped.length === 1 ? "" : "s"} (.kicad_sym / .kicad_mod not supported by check): ${sample}${more}`,
    );
  }
  if (supported.length === 0) {
    // Only print the "no inputs to check" hint when the user genuinely passed
    // nothing checkable AND nothing was skipped — i.e. resolveInputs found no
    // files at all. In the all-unsupported case the aggregated skip line above
    // already explains why nothing ran; adding "no inputs to check" on top of
    // it reads like the user passed nothing, which is misleading.
    if (skipped.length === 0) {
      console.error("kicadiff check: no .kicad_pcb / .kicad_sch inputs to check");
    }
    return 0;
  }
  const repoRoot = repoRootOf(supported[0]);
  const fromRef = parsed.fromRef ?? INDEX_REF;
  const toRef = parsed.toRef ?? "";
  const results = runCheck({ files: supported, fromRef, toRef, repoRoot });
  let anyNew = false;
  for (const r of results) {
    console.log(formatCheckDiff(r.displayPath, r.kind, r.diff));
    if (r.diff.added.length > 0) anyNew = true;
  }
  return anyNew ? 1 : 0;
}

/** Resolve inputs and emit a structural text diff for each file. By default
 *  goes to stdout; pass "stderr" to redirect (used when stdout is reserved
 *  for a markdown report being piped into a file). Skips file types that
 *  the text differ doesn't support (sym/fp). Returns true if any file has
 *  a non-zero structural delta — used by --exit-code. */
function printTextDiff(parsed: ParsedArgs, dest: "stdout" | "stderr" = "stdout"): boolean {
  const files = resolveInputs(parsed.input, parsed.scope)
    .filter(f => f.endsWith(".kicad_pcb") || f.endsWith(".kicad_sch"));
  if (files.length === 0) {
    console.error("Warning: text diff supports only .kicad_pcb / .kicad_sch — nothing to diff");
    return false;
  }
  const repoRoot = repoRootOf(files[0]);
  // Pin mutable refs to a commit SHA before any `git show`. textDiff reads
  // each file twice (before + after), and across multiple files in a batch
  // we'd issue many more reads — same race as the render path, same fix.
  const fromRef = repoRoot
    ? resolveRefToSha(repoRoot, parsed.fromRef ?? INDEX_REF)
    : (parsed.fromRef ?? INDEX_REF);
  const toRef = repoRoot
    ? resolveRefToSha(repoRoot, parsed.toRef ?? "")
    : (parsed.toRef ?? "");
  const out = dest === "stderr"
    ? (s: string) => process.stderr.write(s + "\n")
    : (s: string) => console.log(s);
  let anyChanges = false;
  // textDiff already parses both sides internally to produce its formatted
  // output. The follow-up computeFileDiff parses them again to read the
  // counts — cheap per file but doubles the parse work on large
  // .kicad_pcb/.kicad_sch projects. Only pay that cost when --exit-code
  // actually needs the verdict; the common --text-only path skips it.
  const needCounts = !!parsed.exitCode;
  for (const f of files) {
    out(textDiff(f, fromRef, toRef, repoRoot));
    if (!needCounts) continue;
    const fd = computeFileDiff(f, fromRef, toRef, repoRoot);
    if (fd.diff.added.length + fd.diff.removed.length + fd.diff.changed.length > 0) {
      anyChanges = true;
    }
  }
  return anyChanges;
}

/** Format a friendly ref label for markdown headings. Mirrors the viewer's
 *  refLabel: empty/missing toRef → "working tree", `:0` → "index",
 *  full SHAs → 7-char short. */
function refLabelMd(ref: string): string {
  if (!ref) return "working tree";
  if (ref === INDEX_REF) return "index";
  if (/^[0-9a-f]{40}$/i.test(ref)) return ref.slice(0, 7);
  return ref;
}

/** Default per-file markdown template. Reproduces the pre-templating output
 *  shape: a heading, then the appropriate image block (side-by-side table /
 *  preview / deletion notice), then the structural diff body. Authors can
 *  override via --md-file-template.
 *
 *  The structural section is gated on `{{#structural_diff}}` (Mustache
 *  truthy-on-non-empty-string) rather than `has_structural_diff`, so that
 *  the bundled default still shows the `+0 -0 ~0 =N` summary line for
 *  unchanged pcb/sch files (matching the pre-templating behaviour). The
 *  stricter `has_structural_diff` boolean is reserved for custom templates
 *  that want to filter out unchanged files entirely. */
const DEFAULT_FILE_TEMPLATE =
  "## `{{path}}` ({{type}})" +
  "{{#has_both}}\n\n| Before ({{from_label}}) | After ({{to_label}}) |\n| --- | --- |\n| ![Before]({{before_image}}) | ![After]({{after_image}}) |{{/has_both}}" +
  "{{#after_only}}\n\n![Preview]({{after_image}}){{/after_only}}" +
  "{{#before_only}}\n\n![Before — deleted in {{to_label}}]({{before_image}}){{/before_only}}" +
  "{{#structural_diff}}\n\n{{structural_diff}}{{/structural_diff}}";

/** Default project-level template. Just emits the rendered file sections
 *  joined with blank lines and a trailing newline. Override via --md-template
 *  to wrap the whole thing in a custom heading / summary / front-matter. */
const DEFAULT_PROJECT_TEMPLATE = "{{file_sections}}\n";

interface FileTemplateContext extends Record<string, unknown> {
  path: string;
  type: string;
  from_ref: string;
  to_ref: string;
  from_label: string;
  to_label: string;
  before_image: string;
  after_image: string;
  has_before: boolean;
  has_after: boolean;
  has_both: boolean;
  after_only: boolean;
  before_only: boolean;
  /** Component-level diff counts (pcb/sch only; 0 for sym/fp). */
  added_count: number;
  removed_count: number;
  changed_count: number;
  unchanged_count: number;
  /** Net-level diff counts (pcb only; 0 for sch/sym/fp). `nets_changed`
   *  counts pad-rewires after suppression of pads on added/removed
   *  footprints — i.e. the same number the renderer prints in the Nets
   *  subsection. */
  nets_added: number;
  nets_removed: number;
  nets_changed: number;
  /** True iff the structural diff has at least one added / removed / changed
   *  component OR (for pcb) at least one net-level change (added net,
   *  removed net, or pad rewired). Use this to filter out unchanged files
   *  in custom templates. Distinct from `structural_diff` being non-empty:
   *  unchanged pcb/sch files still emit a `+0 -0 ~0 =N` summary line, so
   *  `structural_diff` is non-empty even when `has_structural_diff` is
   *  false. Net changes count because a pad rewire is a real electrical
   *  edit even when no component-level field moved. */
  has_structural_diff: boolean;
  /** True when the rendered before/after PNG bytes differ. */
  has_visual_diff: boolean;
  /** True when the file has any visible change at all (structural or visual,
   *  or one side missing entirely). The convenient catch-all for templates
   *  that want to filter to "changed files only". */
  has_changes: boolean;
  structural_diff: string;
}

/** Result of building the markdown report. `hasChanges` mirrors the per-file
 *  `has_changes` definition (structural diff, visual diff, or one side
 *  missing) aggregated across the project — same answer `projectHasChanges`
 *  would arrive at, but obtained as a by-product of the work the markdown
 *  path already did. Surfaced so `--exit-code` in the markdown path can
 *  skip the redundant `computeFileDiff` sweep. */
interface MarkdownReportResult {
  text: string;
  hasChanges: boolean;
}

/** Build the markdown report text. Image paths are emitted relative to
 *  `mdDir` so the file is portable: ship the .md alongside its image
 *  directory and links resolve from any location.
 *
 *  Templating: each file is rendered through the per-file template, results
 *  are joined with `\n\n`, and that string fills `{{file_sections}}` in the
 *  project template. Custom templates from --md-template / --md-file-template
 *  override the bundled defaults. */
function buildMarkdownReport(
  parsed: ParsedArgs,
  project: ProjectRenderResult,
  mdDir: string,
): MarkdownReportResult {
  const repoRoot = project.results[0]
    ? repoRootOf(project.results[0].filePath)
    : null;
  // Pin refs to commit SHAs so the structural diff (computed here via
  // computeFileDiff → readAtRef) sees the same commit as the visual diff
  // already rendered by renderProject. Without this the image and the
  // component list could be computed against different commits if the
  // branch moved between the render and the report.
  const fromRef = repoRoot
    ? resolveRefToSha(repoRoot, parsed.fromRef ?? INDEX_REF)
    : (parsed.fromRef ?? INDEX_REF);
  const toRef = repoRoot
    ? resolveRefToSha(repoRoot, parsed.toRef ?? "")
    : (parsed.toRef ?? "");
  const fromLabel = refLabelMd(fromRef);
  const toLabel = refLabelMd(toRef);

  const fileTemplate = parsed.mdFileTemplate
    ? fs.readFileSync(parsed.mdFileTemplate, "utf8")
    : DEFAULT_FILE_TEMPLATE;
  const projectTemplate = parsed.mdTemplate
    ? fs.readFileSync(parsed.mdTemplate, "utf8")
    : DEFAULT_PROJECT_TEMPLATE;

  const fileContexts: FileTemplateContext[] = project.results.map((r) => {
    const m = r.manifest;
    const rel = (abs: string) => path.relative(mdDir, abs);
    const hasBoth = !!(m.hasBefore && r.beforePng && r.afterPng);
    const afterOnly = !hasBoth && !!r.afterPng;
    const beforeOnly = !hasBoth && !r.afterPng && !!r.beforePng;

    // Pull component counts directly from computeFileDiff so templates can
    // distinguish "section is included" (default rendering) from "section
    // has actual changes" (filter out unchanged files).
    let addedCount = 0;
    let removedCount = 0;
    let changedCount = 0;
    let unchangedCount = 0;
    let netsAdded = 0;
    let netsRemoved = 0;
    let netsChanged = 0;
    let structuralDiff = "";
    if (m.type === "pcb" || m.type === "sch") {
      const fd = computeFileDiff(r.filePath, fromRef, toRef, repoRoot);
      addedCount = fd.diff.added.length;
      removedCount = fd.diff.removed.length;
      changedCount = fd.diff.changed.length;
      unchangedCount = fd.diff.unchanged;
      if (fd.nets) {
        netsAdded = fd.nets.added.length;
        netsRemoved = fd.nets.removed.length;
        netsChanged = fd.nets.padChanges.length;
      }

      const struct = markdownDiff(r.filePath, fromRef, toRef, repoRoot)
        .split("\n");
      // markdownDiff prefixes a `## …` heading; drop it so our template
      // controls heading placement (and avoids duplicates).
      if (struct[0]?.startsWith("##")) {
        struct.shift();
        while (struct.length > 0 && struct[0] === "") struct.shift();
      }
      structuralDiff = struct.join("\n");
    }

    // Net-level changes are real structural edits — a pad rewired from GND
    // to VCC is an electrical change worth surfacing even if no
    // component-level field moved. Custom templates that filter on
    // has_structural_diff / has_changes used to drop these PCBs silently.
    const hasStructuralDiff =
      (addedCount + removedCount + changedCount + netsAdded + netsRemoved + netsChanged) > 0;
    const hasVisualDiff = !!m.hasDiff;
    // "Has changes" = any meaningful difference. A file with both sides but
    // identical content has none of these; a renamed/added/deleted file has
    // afterOnly/beforeOnly; an edited file has either structural or visual
    // diff (often both).
    const hasChanges =
      hasStructuralDiff || hasVisualDiff || afterOnly || beforeOnly;

    return {
      path: r.relPath,
      type: m.type,
      from_ref: fromRef,
      to_ref: toRef,
      from_label: fromLabel,
      to_label: toLabel,
      before_image: r.beforePng ? rel(r.beforePng) : "",
      after_image: r.afterPng ? rel(r.afterPng) : "",
      has_before: !!r.beforePng,
      has_after: !!r.afterPng,
      has_both: hasBoth,
      after_only: afterOnly,
      before_only: beforeOnly,
      added_count: addedCount,
      removed_count: removedCount,
      changed_count: changedCount,
      unchanged_count: unchangedCount,
      nets_added: netsAdded,
      nets_removed: netsRemoved,
      nets_changed: netsChanged,
      has_structural_diff: hasStructuralDiff,
      has_visual_diff: hasVisualDiff,
      has_changes: hasChanges,
      structural_diff: structuralDiff,
    };
  });

  const sections = fileContexts.map((ctx) => renderTemplate(fileTemplate, ctx));
  const fileSections = sections.join("\n\n");
  const hasChanges = fileContexts.some((c) => c.has_changes);

  const text = renderTemplate(projectTemplate, {
    from_ref: fromRef,
    to_ref: toRef,
    from_label: fromLabel,
    to_label: toLabel,
    file_count: fileContexts.length,
    has_changes: hasChanges,
    files: fileContexts,
    file_sections: fileSections,
  });
  return { text, hasChanges };
}

/** Project-level filename for the combined markdown — kept in sync with the
 *  HTML's projectSafeName so users get matching `<name>_diff.html` and
 *  `<name>_diff.md` siblings. */
function projectSafeNameFromResults(project: ProjectRenderResult): string {
  if (project.combinedHtml) {
    return path.basename(project.combinedHtml).replace(/_diff\.html$/, "");
  }
  // Fallback when imagesOnly skipped HTML: derive from the first file
  const first = project.results[0];
  if (!first) return "diff";
  return path.basename(first.filePath).replace(/\.kicad_(pcb|sch|sym|mod)$/, "");
}

/** Emit the markdown report. Default destination is a file alongside the
 *  rendered images (parallel to the HTML viewer); `--output - / stdout`
 *  redirects to standard output, with image paths relative to CWD so the
 *  user can pipe / redirect somewhere predictable.
 *
 *  Returns whether any per-file change was detected, so the caller can
 *  reuse the verdict for `--exit-code` instead of re-running the
 *  structural diff. */
function emitMarkdownReport(parsed: ParsedArgs, project: ProjectRenderResult): boolean {
  const outArg = parsed.outputHtml; // unified --output / -o flag
  const isStdout = outArg === "-" || outArg === "stdout";

  if (isStdout) {
    const report = buildMarkdownReport(parsed, project, process.cwd());
    process.stdout.write(report.text);
    return report.hasChanges;
  }

  const outDir = project.results[0]?.outputDir ?? process.cwd();
  const safeName = projectSafeNameFromResults(project);
  const mdPath = outArg
    ? resolveOutputPath(outArg, `${safeName}_diff.md`)
    : path.join(outDir, `${safeName}_diff.md`);
  fs.mkdirSync(path.dirname(mdPath), { recursive: true });
  const report = buildMarkdownReport(parsed, project, path.dirname(mdPath));
  fs.writeFileSync(mdPath, report.text);
  if ((parsed.logLevel ?? "info") !== "quiet") {
    console.log(`Diff markdown: ${mdPath}`);
  }
  return report.hasChanges;
}

function repoRootOf(filePath: string): string | null {
  // Walk up from the file's parent until we find an existing directory.
  // `resolveInputs` allows files that no longer exist on disk (deleted on
  // one side of the diff but still present at a ref) — in that case the
  // immediate parent dir may not exist anymore even though the repo does,
  // and a `git -C <missing>` would fail. Mirrors getRepoRoot() in
  // src/render.ts so the deleted-file flow doesn't silently skip ref
  // pinning.
  let dir = path.dirname(filePath);
  while (!fs.existsSync(dir)) {
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  const r = spawnSync("git", ["-C", dir, "rev-parse", "--show-toplevel"], {
    encoding: "utf8",
  });
  return r.status === 0 ? r.stdout.trim() : null;
}

/** Pin `parsed.fromRef` / `parsed.toRef` to concrete commit SHAs once for
 *  the whole CLI invocation. Mutating the parsed object propagates the
 *  pinned values to every downstream consumer (renderProject,
 *  printTextDiff, buildMarkdownReport) without each having to thread an
 *  extra parameter. No-op when there are no resolvable inputs, or when
 *  the input doesn't sit inside a git repo. */
function pinParsedRefs(parsed: ParsedArgs): void {
  let files: string[];
  try {
    files = resolveInputs(parsed.input, parsed.scope);
  } catch {
    return; // resolveInputs throws on bad input; let the dispatcher report it
  }
  if (files.length === 0) return;
  const repoRoot = repoRootOf(files[0]);
  if (!repoRoot) return;
  // Default: from=index (":0"), to=working — matches `git diff` rather than
  // `git diff HEAD`. Index and working-tree markers pass through
  // resolveRefToSha unchanged; only branch/tag/SHA-ish refs get pinned.
  parsed.fromRef = resolveRefToSha(repoRoot, parsed.fromRef ?? INDEX_REF);
  parsed.toRef = resolveRefToSha(repoRoot, parsed.toRef ?? "");
}

main();
