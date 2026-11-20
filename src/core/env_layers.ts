/**
 * Startup env layering. Precedence, highest first: the real process env, the repo `.env`, the machine env file
 * (`<machine dir>/env`, see `paths.machineEnvPath`), then `cfg.env` (`agents.applyConfigEnv`).
 *
 * The machine file is how a credential that applies to every repo on this machine (the sync Access token, receipt-store keys,
 * D1) is set once instead of per repo. It is resolved AFTER the repo `.env` has been loaded and its protected keys restored, so a
 * repo can never choose which machine file is read. It is read with the same discipline as the machine config layer: protected
 * keys are ignored, and a file this user does not own or that others can write is REFUSED (a writable env file is a code-execution
 * vector via `PIQUETTE_CLAUDE_CMD` or `NODE_OPTIONS`).
 *
 * Secret VALUES never leave this module: the registry holds key names and file paths only.
 */
import { lstatSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseEnvText } from "../cli/env_file.ts";
import { PROTECTED_CONFIG_ENV } from "./agents.ts";
import { machineEnvPath } from "./paths.ts";

export type EnvSource = "shell" | "repo .env" | "machine env" | "config env";

export interface MachineEnvStatus {
  path: string;
  exists: boolean;
  /** Key names this file actually set (not shadowed by the shell or the repo `.env`). */
  loaded: string[];
  /** Key names in the file that are protected (they locate the machine layer) and were ignored. */
  ignoredProtected: string[];
  /** Non-comment lines that were not `KEY=value` (e.g. `set -a`). */
  ignoredLines: number;
  modeWarning?: string;
  /** Why the file was not loaded at all (unsafe ownership or permissions, unreadable). */
  refused?: string;
}

const sources = new Map<string, EnvSource>();
let status: MachineEnvStatus | undefined;

/** Where `key`'s value in `process.env` came from, or undefined if the startup loader never saw it (e.g. `doctorCommand` called directly). */
export function envSource(key: string): EnvSource | undefined {
  return sources.get(key);
}

/** What the loader found at the machine env path; undefined until `loadStartupEnv` has run. */
export function machineEnvStatus(): MachineEnvStatus | undefined {
  return status;
}

/** Records that `applyConfigEnv` set `key` (called by `agents.applyConfigEnv`). */
export function recordConfigEnv(key: string): void {
  if (!sources.has(key)) sources.set(key, "config env");
}

export function resetEnvLayersForTest(): void {
  sources.clear();
  status = undefined;
}

export interface StartupEnvOptions {
  env?: NodeJS.ProcessEnv;
  home?: string;
}

/**
 * Loads the repo `.env` (Node's own parser, protected keys restored afterwards — a repo must not relocate the machine layer, #221)
 * and then the machine env file. A key already set is never overridden.
 */
export function loadStartupEnv(repoRoot: string, opts: StartupEnvOptions = {}): void {
  const env = opts.env ?? process.env;
  const home = opts.home ?? os.homedir();
  sources.clear();
  status = undefined;

  for (const key of Object.keys(env)) if (env[key] !== undefined) sources.set(key, "shell");

  const protectedBefore = [...PROTECTED_CONFIG_ENV].map((key) => [key, env[key]] as const);
  const keysBefore = new Set(Object.keys(env));
  try {
    // process.loadEnvFile writes to process.env; tests that inject `env` use process.env too.
    process.loadEnvFile(path.join(repoRoot, ".env"));
  } catch {
    // no .env there — fine, nothing to load
  }
  for (const [key, value] of protectedBefore) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  for (const key of Object.keys(env)) {
    if (!keysBefore.has(key) && env[key] !== undefined) sources.set(key, "repo .env");
  }

  loadMachineEnv(env, home);
}

function loadMachineEnv(env: NodeJS.ProcessEnv, home: string): void {
  const file = machineEnvPath(env, home);
  const result: MachineEnvStatus = { path: file, exists: false, loaded: [], ignoredProtected: [], ignoredLines: 0 };
  status = result;

  let st;
  try {
    st = lstatSync(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      result.exists = true;
      result.refused = `cannot stat: ${(err as NodeJS.ErrnoException).code ?? "error"}`;
      console.error(`piquette: machine env file ${file} not loaded (${result.refused})`);
    }
    return;
  }
  result.exists = true;

  if (process.platform !== "win32") {
    const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
    if (!st.isFile()) {
      result.refused = "not a regular file";
    } else if (uid !== undefined && st.uid !== uid) {
      result.refused = "not owned by the current user";
    } else if (st.mode & 0o022) {
      result.refused = "writable by group or others — chmod 600";
    }
    if (result.refused) {
      console.error(`piquette: machine env file ${file} NOT loaded: ${result.refused}`);
      return;
    }
    if (st.mode & 0o044) {
      result.modeWarning = "readable by group or others — chmod 600";
      console.error(`piquette: machine env file ${file} is ${result.modeWarning}`);
    }
  }

  let text: string;
  try {
    text = readFileSync(file, "utf-8");
  } catch (err) {
    result.refused = `cannot read: ${(err as NodeJS.ErrnoException).code ?? "error"}`;
    console.error(`piquette: machine env file ${file} not loaded (${result.refused})`);
    return;
  }

  const parsed = parseEnvText(text);
  result.ignoredLines = parsed.ignoredLines;
  for (const [key, value] of parsed.values) {
    if (PROTECTED_CONFIG_ENV.has(key)) {
      result.ignoredProtected.push(key);
      continue;
    }
    if (env[key] !== undefined) continue;
    env[key] = value;
    sources.set(key, "machine env");
    result.loaded.push(key);
  }
}
