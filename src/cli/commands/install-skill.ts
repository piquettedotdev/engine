/**
 * `piquette install-skill` — copy every packaged agent skill (`assets/skills/<name>/`)
 * into a target repo, for every agent that reads skills from disk:
 *
 *   - `.claude/skills/<name>`  — Claude Code
 *   - `.agents/skills/<name>`  — the open Agent Skills layout (Codex, opencode, ...)
 *
 * `--user` installs to `~/.claude/skills` / `~/.agents/skills` instead.
 * `--agents claude|agents|claude,agents` (default both) picks which layouts.
 * `--target <dir>` overrides the location entirely: `<dir>` is a skills ROOT,
 * each skill lands at `<dir>/<name>` (and `--agents` is ignored).
 *
 * Each skill folder is a real copy, not a symlink — symlinked skill folders are
 * unreliable on Windows and ignored by some agents' discovery. `piquette init`
 * calls this itself, every run, unless `--no-skills` is passed.
 *
 * Idempotent via a manifest (`.piquette-skill-version`: {package, version,
 * files: {relpath: sha256}}) written at each skill's root:
 *   - unchanged file, unchanged source -> no-op
 *   - unchanged file, source changed (version bump) -> upgraded in place
 *   - user-edited file (its on-disk hash no longer matches what we last
 *     installed) -> NEVER silently overwritten; the incoming version is
 *     written to a `.new` sibling instead, unless --force
 *   - a file present in the OLD manifest but absent from the current
 *     package (renamed/removed cookbook) -> deleted, but only if it was
 *     never edited; an edited stale file is left in place and reported
 *
 * `--json` prints a machine-readable report (one entry per installed skill
 * folder, with every file action) so an agent can follow up on `.new` files.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import * as paths from "../../core/paths.ts";
import { parseCli } from "../../core/utils.ts";

export const MANIFEST_NAME = ".piquette-skill-version";
export const SKILLS_SRC_DIR = path.join(paths.ASSETS_DIR, "skills");

/** Every agent skill layout piquette knows how to install into, keyed by the name `--agents` takes. */
export const SKILL_LAYOUTS = {
  claude: path.join(".claude", "skills"),
  agents: path.join(".agents", "skills"),
} as const;
export type SkillLayout = keyof typeof SKILL_LAYOUTS;

interface Manifest {
  package: string;
  version: string;
  files: Record<string, string>;
}

export type FileAction = "added" | "upgraded" | "forced" | "conflict" | "removed" | "stale-kept";

export interface SkillInstallResult {
  skill: string;
  dest: string;
  version: string;
  actions: { file: string; action: FileAction }[];
}

function sha256(content: Buffer | string): string {
  return createHash("sha256").update(content).digest("hex");
}

function listFiles(root: string): string[] {
  return readdirSync(root, { recursive: true, encoding: "utf-8" })
    .filter((entry) => statSync(path.join(root, entry)).isFile())
    .sort();
}

function readManifest(manifestPath: string): Manifest | null {
  if (!existsSync(manifestPath)) return null;
  try {
    return JSON.parse(readFileSync(manifestPath, "utf-8")) as Manifest;
  } catch {
    return null; // corrupt/foreign file at this path — treat as "no manifest", never crash the install
  }
}

function packageVersion(): string {
  const pkg = JSON.parse(readFileSync(path.join(paths.PACKAGE_ROOT, "package.json"), "utf-8")) as { version: string };
  return pkg.version;
}

/** The packaged skill names — one per folder under `assets/skills/` that has a `SKILL.md`, derived from disk so a new skill needs no code change here. */
export function packagedSkills(): string[] {
  if (!existsSync(SKILLS_SRC_DIR)) return [];
  return readdirSync(SKILLS_SRC_DIR)
    .filter((name) => existsSync(path.join(SKILLS_SRC_DIR, name, "SKILL.md")))
    .sort();
}

/** What's on disk for one installed skill folder: the version its manifest records (null if never installed by piquette) and any `.new` files still waiting to be merged. */
export function installedSkillState(skillDir: string): { version: string | null; pending_new: string[] } | null {
  if (!existsSync(path.join(skillDir, "SKILL.md"))) return null;
  const manifest = readManifest(path.join(skillDir, MANIFEST_NAME));
  return { version: manifest?.version ?? null, pending_new: listFiles(skillDir).filter((f) => f.endsWith(".new")) };
}

/** Install ONE skill folder (`srcRoot`) at `destRoot`, with the manifest-guarded upgrade rules in this module's doc comment. */
export function installOneSkill(srcRoot: string, destRoot: string, opts: { force?: boolean; version?: string } = {}): SkillInstallResult {
  const version = opts.version ?? packageVersion();
  const sourceFiles = listFiles(srcRoot);
  const manifestPath = path.join(destRoot, MANIFEST_NAME);
  const oldManifest = readManifest(manifestPath);

  const finalFiles: Record<string, string> = {};
  const actions: SkillInstallResult["actions"] = [];

  for (const relpath of sourceFiles) {
    const srcPath = path.join(srcRoot, relpath);
    const destPath = path.join(destRoot, relpath);
    const sourceContent = readFileSync(srcPath);
    const sourceHash = sha256(sourceContent);
    const previousHash = oldManifest?.files[relpath];

    if (!existsSync(destPath)) {
      mkdirSync(path.dirname(destPath), { recursive: true });
      writeFileSync(destPath, sourceContent);
      finalFiles[relpath] = sourceHash;
      actions.push({ file: relpath, action: "added" });
      continue;
    }

    const destHash = sha256(readFileSync(destPath));
    if (destHash === sourceHash) {
      finalFiles[relpath] = sourceHash;
      continue; // already exactly right — true no-op
    }
    if (previousHash !== undefined && destHash === previousHash) {
      writeFileSync(destPath, sourceContent); // untouched since our last install — safe to upgrade
      finalFiles[relpath] = sourceHash;
      actions.push({ file: relpath, action: "upgraded" });
      continue;
    }
    if (opts.force) {
      writeFileSync(destPath, sourceContent);
      finalFiles[relpath] = sourceHash;
      actions.push({ file: relpath, action: "forced" });
      continue;
    }
    writeFileSync(`${destPath}.new`, sourceContent);
    finalFiles[relpath] = previousHash ?? destHash; // keep tracking what's actually on disk
    actions.push({ file: relpath, action: "conflict" });
  }

  const sourceSet = new Set(sourceFiles);
  for (const relpath of Object.keys(oldManifest?.files ?? {})) {
    if (sourceSet.has(relpath)) continue;
    const destPath = path.join(destRoot, relpath);
    if (!existsSync(destPath)) continue;
    const destHash = sha256(readFileSync(destPath));
    if (destHash === oldManifest!.files[relpath]) {
      rmSync(destPath);
      actions.push({ file: relpath, action: "removed" });
    } else {
      actions.push({ file: relpath, action: "stale-kept" });
    }
  }

  mkdirSync(destRoot, { recursive: true });
  const manifest: Manifest = { package: "@piquette/engine", version, files: finalFiles };
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  return { skill: path.basename(srcRoot), dest: destRoot, version, actions };
}

function parseLayouts(raw: string | undefined): SkillLayout[] | string {
  if (raw === undefined) return Object.keys(SKILL_LAYOUTS) as SkillLayout[];
  const wanted = raw.split(",").map((s) => s.trim()).filter(Boolean);
  const unknown = wanted.filter((w) => !(w in SKILL_LAYOUTS));
  if (unknown.length > 0 || wanted.length === 0) {
    return `--agents takes a comma-separated list of: ${Object.keys(SKILL_LAYOUTS).join(", ")} (got ${JSON.stringify(raw)})`;
  }
  return [...new Set(wanted)] as SkillLayout[];
}

/** Every skills ROOT this invocation installs into (each skill then lands at `<root>/<name>`). */
function resolveSkillRoots(options: Record<string, string | undefined>, flags: Record<string, boolean>, layouts: SkillLayout[]): string[] {
  if (options["target"]) return [path.resolve(options["target"])];
  const base = flags["user"] ? homedir() : paths.resolveAnchor(options["cwd"]).repo_root;
  return layouts.map((layout) => path.join(base, SKILL_LAYOUTS[layout]));
}

const ACTION_MARK: Record<FileAction, (file: string) => string> = {
  added: (f) => `+ ${f}`,
  upgraded: (f) => `^ ${f} (upgraded)`,
  forced: (f) => `! ${f} (forced over local edits)`,
  conflict: (f) => `? ${f} (locally modified — wrote ${f}.new instead; --force to overwrite)`,
  removed: (f) => `- ${f} (removed — no longer shipped)`,
  "stale-kept": (f) => `  ${f} (no longer shipped, but locally modified — left in place)`,
};

export function installSkillCommand(argv: string[]): number {
  const { options, flags } = parseCli(argv, ["cwd", "target", "agents"], ["user", "force", "json"]);
  const layouts = parseLayouts(options["agents"]);
  if (typeof layouts === "string") {
    console.error(`piquette install-skill: ${layouts}`);
    return 1;
  }

  const skills = packagedSkills();
  if (skills.length === 0) {
    console.error(`piquette install-skill: no packaged skills found under ${SKILLS_SRC_DIR}`);
    return 1;
  }
  const version = packageVersion();
  const results: SkillInstallResult[] = [];
  for (const root of resolveSkillRoots(options, flags, layouts)) {
    for (const skill of skills) {
      results.push(installOneSkill(path.join(SKILLS_SRC_DIR, skill), path.join(root, skill), { force: flags["force"], version }));
    }
  }

  if (flags["json"]) {
    const conflicts = results.flatMap((r) => r.actions.filter((a) => a.action === "conflict").map((a) => path.join(r.dest, `${a.file}.new`)));
    console.log(JSON.stringify({ version, skills, results, conflicts }, null, 2));
    return 0;
  }

  for (const r of results) {
    console.log(`piquette install-skill: ${r.dest} (v${version})`);
    if (r.actions.length === 0) console.log("  already up to date");
    for (const a of r.actions) console.log(`  ${ACTION_MARK[a.action](a.file)}`);
  }
  return 0;
}
