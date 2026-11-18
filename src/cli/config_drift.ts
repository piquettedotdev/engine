/**
 * Config drift between a repo's `.piquette/piquette.config.yaml` and piquette's
 * packaged defaults — read-only facts for `piquette init --detect`.
 *
 * A repo config is merged ON TOP of the packaged defaults, so an override that
 * equals the default today does nothing, and it silently pins that value when a
 * later release changes the default. `redundantOverrides` lists those, by
 * dotted path, so an agent maintaining the repo can offer to remove them.
 *
 * Merge shape mirrors `agents.loadConfig`: plain objects merge key by key,
 * `agents:` merges by `name`, and every other value (scalars, arrays) replaces
 * wholesale — so an array is redundant only when it is deep-equal to the default.
 */
import { readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { parse } from "yaml";
import { BUILTIN_CONFIG_PATH } from "../core/paths.ts";

type Obj = Record<string, unknown>;

function isPlainObject(value: unknown): value is Obj {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function walk(repo: Obj, builtin: Obj, prefix: string, out: string[]): void {
  for (const [key, value] of Object.entries(repo)) {
    if (!(key in builtin)) continue;
    const path = prefix ? `${prefix}.${key}` : key;
    const dflt = builtin[key];
    if (isPlainObject(value) && isPlainObject(dflt)) walk(value, dflt, path, out);
    else if (isDeepStrictEqual(value, dflt)) out.push(path);
  }
}

/** Dotted paths in `repoConfig` whose value already equals the packaged default (`agents[<name>].<field>` for roster overrides). */
export function redundantOverrides(repoConfig: Obj, builtinConfig: Obj = parse(readFileSync(BUILTIN_CONFIG_PATH, "utf-8")) as Obj): string[] {
  const out: string[] = [];
  const { agents: repoAgents, ...rest } = repoConfig;
  const { agents: builtinAgents, ...builtinRest } = builtinConfig;
  walk(rest, builtinRest, "", out);

  if (Array.isArray(repoAgents) && Array.isArray(builtinAgents)) {
    for (const agent of repoAgents) {
      if (!isPlainObject(agent) || typeof agent.name !== "string") continue;
      const base = builtinAgents.find((a) => isPlainObject(a) && a.name === agent.name);
      if (!isPlainObject(base)) continue;
      const { name, ...fields } = agent;
      const found: string[] = [];
      walk(fields, base, `agents[${name}]`, found);
      out.push(...found);
    }
  }
  return out;
}
