/**
 * `piquette skill list [--json]` / `piquette skill show <name> [--file <path>]`
 *
 * Reads the packaged agent skills straight out of the installed CLI, with
 * nothing installed in any repo first. This is the bootstrap for an agent
 * that only knows `piquette` exists: `piquette --help` points it at
 * `piquette skill show piquette-setup`, and that skill's own instructions end
 * with installing the skills into the repo. A skill's other files (cookbooks,
 * references, and cross-skill paths like `../piquette/references/config.md`)
 * are reachable the same way via `--file`.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import { parseCli } from "../../core/utils.ts";
import { packagedSkills, SKILLS_SRC_DIR } from "./install-skill.ts";
import { unknownNameMessage } from "../unknown_name.ts";

const USAGE = "usage: piquette skill list [--json]\n       piquette skill show <name> [--file <path-inside-the-skill>]";

/** A skill's `description:` frontmatter, or "" when it has none. */
function describe(skill: string): string {
  const md = readFileSync(path.join(SKILLS_SRC_DIR, skill, "SKILL.md"), "utf-8");
  const fm = /^---\n([\s\S]*?)\n---\n/.exec(md);
  if (!fm) return "";
  return String((parse(fm[1]) as { description?: unknown } | null)?.description ?? "");
}

function skillFiles(skill: string): string[] {
  const root = path.join(SKILLS_SRC_DIR, skill);
  return readdirSync(root, { recursive: true, encoding: "utf-8" })
    .filter((f) => statSync(path.join(root, f)).isFile())
    .sort();
}

export function skillCommand(argv: string[]): number {
  const [sub, ...rest] = argv;
  const { positionals, options, flags } = parseCli(rest, ["file"], ["json"]);
  const skills = packagedSkills();

  if (sub === "list") {
    if (flags["json"]) {
      console.log(JSON.stringify({ skills: skills.map((name) => ({ name, description: describe(name), files: skillFiles(name) })) }, null, 2));
      return 0;
    }
    for (const name of skills) console.log(`${name}\n  ${describe(name)}\n`);
    console.log("read one with: piquette skill show <name>");
    return 0;
  }

  if (sub === "show") {
    const name = positionals[0];
    if (!name) {
      console.error(USAGE);
      return 1;
    }
    if (!skills.includes(name)) {
      console.error(unknownNameMessage("skill", name, skills));
      return 1;
    }
    const root = path.join(SKILLS_SRC_DIR, name);
    const rel = options["file"] ?? "SKILL.md";
    const target = path.resolve(root, rel);
    // Stay inside the packaged skills tree: `../<other-skill>/...` (how skills cross-reference each other) is fine, anything above it is not.
    if (!target.startsWith(SKILLS_SRC_DIR + path.sep) || !existsSync(target) || !statSync(target).isFile()) {
      console.error(`piquette skill show: no file ${JSON.stringify(rel)} in skill ${name} — files: ${skillFiles(name).join(", ")}`);
      return 1;
    }
    console.log(readFileSync(target, "utf-8").replace(/\n$/, ""));
    if (rel === "SKILL.md") {
      const others = skillFiles(name).filter((f) => f !== "SKILL.md");
      console.log(`\n---\n(read by \`piquette skill show ${name}\`. This skill's paths are relative to its own folder: read \`cookbooks/x.md\` with \`--file cookbooks/x.md\`, and \`../other-skill/x.md\` with \`piquette skill show other-skill --file x.md\`.${others.length ? ` Other files here: ${others.join(", ")}.` : ""})`);
    }
    return 0;
  }

  console.error(USAGE);
  return 1;
}
