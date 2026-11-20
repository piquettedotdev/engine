import "./hermetic_git.js";

/**
 * The startup env layers (#13): shell > repo `.env` > machine env file (`<PIQUETTE_CONFIG_HOME>/env`) > `cfg.env`. Mutates
 * process.env, so every key here is a unique PIQUETTE_TEST_MENV_* name and everything is restored afterwards.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentEnv, applyConfigEnv, loadConfig } from "../core/agents.js";
import { envSource, loadStartupEnv, machineEnvStatus, resetEnvLayersForTest } from "../core/env_layers.js";
import { operatorEnv } from "../core/utils.js";

const KEYS = [
  "PIQUETTE_TEST_MENV_A",
  "PIQUETTE_TEST_MENV_B",
  "PIQUETTE_TEST_MENV_C",
  "PIQUETTE_TEST_MENV_D",
  "PIQUETTE_TEST_MENV_CFG",
  "PIQUETTE_TEST_MENV_REF",
  "PIQUETTE_SYNC_CLIENT_ID",
  "PIQUETTE_SYNC_CLIENT_SECRET",
  "PIQUETTE_CONFIG_HOME",
  "HOME",
  "USERPROFILE",
];
const saved = new Map<string, string | undefined>();
let root: string;
let repo: string;
let machine: string;

beforeEach(() => {
  for (const k of KEYS) saved.set(k, process.env[k]);
  for (const k of KEYS) if (k.startsWith("PIQUETTE_TEST_") || k.startsWith("PIQUETTE_SYNC_") || k === "PIQUETTE_CONFIG_HOME") delete process.env[k];
  root = realpathSync(mkdtempSync(join(tmpdir(), "piquette-env-layers-")));
  repo = join(root, "repo");
  machine = join(root, "machine");
  mkdirSync(repo, { recursive: true });
  mkdirSync(machine, { recursive: true });
  process.env.PIQUETTE_CONFIG_HOME = machine;
  resetEnvLayersForTest();
});
afterEach(() => {
  for (const [k, v] of saved) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  resetEnvLayersForTest();
  rmSync(root, { recursive: true, force: true });
});

function machineEnv(text: string, mode = 0o600): string {
  const file = join(machine, "env");
  writeFileSync(file, text);
  chmodSync(file, mode);
  return file;
}

/** Captures stderr lines written through console.error while `fn` runs. */
function captureStderr(fn: () => void): string[] {
  const lines: string[] = [];
  const orig = console.error;
  console.error = (...args: unknown[]) => void lines.push(args.join(" "));
  try {
    fn();
  } finally {
    console.error = orig;
  }
  return lines;
}

test("precedence: shell > repo .env > machine env > cfg.env, with sources recorded", () => {
  process.env.PIQUETTE_TEST_MENV_A = "shell-a";
  writeFileSync(join(repo, ".env"), "PIQUETTE_TEST_MENV_A=repo-a\nPIQUETTE_TEST_MENV_B=repo-b\n");
  machineEnv("PIQUETTE_TEST_MENV_A=m-a\nPIQUETTE_TEST_MENV_B=m-b\nexport PIQUETTE_TEST_MENV_C=m-c\n");
  loadStartupEnv(repo);
  applyConfigEnv({ PIQUETTE_TEST_MENV_A: "cfg-a", PIQUETTE_TEST_MENV_B: "cfg-b", PIQUETTE_TEST_MENV_C: "cfg-c", PIQUETTE_TEST_MENV_D: "cfg-d" });
  assert.equal(process.env.PIQUETTE_TEST_MENV_A, "shell-a");
  assert.equal(process.env.PIQUETTE_TEST_MENV_B, "repo-b");
  assert.equal(process.env.PIQUETTE_TEST_MENV_C, "m-c");
  assert.equal(process.env.PIQUETTE_TEST_MENV_D, "cfg-d");
  assert.equal(envSource("PIQUETTE_TEST_MENV_A"), "shell");
  assert.equal(envSource("PIQUETTE_TEST_MENV_B"), "repo .env");
  assert.equal(envSource("PIQUETTE_TEST_MENV_C"), "machine env");
  assert.equal(envSource("PIQUETTE_TEST_MENV_D"), "config env");
  assert.equal(envSource("PIQUETTE_TEST_MENV_NOPE"), undefined);
  assert.deepEqual(machineEnvStatus()!.loaded, ["PIQUETTE_TEST_MENV_C"]);
});

test("PIQUETTE_CONFIG_HOME is honored, and an empty value means ~/.piquette", () => {
  const home = join(root, "home");
  mkdirSync(join(home, ".piquette"), { recursive: true });
  writeFileSync(join(home, ".piquette", "env"), "PIQUETTE_TEST_MENV_A=from-home\n", { mode: 0o600 });
  machineEnv("PIQUETTE_TEST_MENV_A=from-config-home\n");
  loadStartupEnv(repo, { home });
  assert.equal(process.env.PIQUETTE_TEST_MENV_A, "from-config-home");

  delete process.env.PIQUETTE_TEST_MENV_A;
  process.env.PIQUETTE_CONFIG_HOME = "";
  loadStartupEnv(repo, { home });
  assert.equal(process.env.PIQUETTE_TEST_MENV_A, "from-home");
  assert.equal(machineEnvStatus()!.path, join(home, ".piquette", "env"));
});

test("a repo .env cannot choose which machine file is read", () => {
  const evil = join(root, "evil");
  mkdirSync(evil, { recursive: true });
  writeFileSync(join(evil, "env"), "PIQUETTE_TEST_MENV_A=evil\n", { mode: 0o600 });
  writeFileSync(join(repo, ".env"), `PIQUETTE_CONFIG_HOME=${evil}\nHOME=${evil}\n`);
  machineEnv("PIQUETTE_TEST_MENV_B=real\n");
  loadStartupEnv(repo);
  assert.equal(process.env.PIQUETTE_CONFIG_HOME, machine);
  assert.equal(process.env.PIQUETTE_TEST_MENV_A, undefined);
  assert.equal(process.env.PIQUETTE_TEST_MENV_B, "real");
});

test("the machine file cannot set PIQUETTE_CONFIG_HOME / HOME / USERPROFILE; they are ignored and recorded", () => {
  const homeBefore = process.env.HOME;
  machineEnv(`PIQUETTE_CONFIG_HOME=/elsewhere\nHOME=/elsewhere\nUSERPROFILE=/elsewhere\nPIQUETTE_TEST_MENV_A=ok\n`);
  loadStartupEnv(repo);
  assert.equal(process.env.PIQUETTE_CONFIG_HOME, machine);
  assert.equal(process.env.HOME, homeBefore);
  assert.equal(process.env.PIQUETTE_TEST_MENV_A, "ok");
  assert.deepEqual(machineEnvStatus()!.ignoredProtected.sort(), ["HOME", "PIQUETTE_CONFIG_HOME", "USERPROFILE"]);
});

test("permissions: 0600 is silent, 0644 loads with a warning, group/other-writable files are refused", { skip: process.platform === "win32" }, () => {
  machineEnv("PIQUETTE_TEST_MENV_A=1\n", 0o600);
  assert.deepEqual(captureStderr(() => loadStartupEnv(repo)), []);
  assert.equal(machineEnvStatus()!.modeWarning, undefined);
  assert.equal(process.env.PIQUETTE_TEST_MENV_A, "1");

  delete process.env.PIQUETTE_TEST_MENV_A;
  machineEnv("PIQUETTE_TEST_MENV_A=2\n", 0o644);
  const warned = captureStderr(() => loadStartupEnv(repo));
  assert.equal(warned.length, 1);
  assert.match(warned[0], /chmod 600/);
  assert.match(machineEnvStatus()!.modeWarning!, /chmod 600/);
  assert.equal(process.env.PIQUETTE_TEST_MENV_A, "2");

  for (const mode of [0o664, 0o646]) {
    delete process.env.PIQUETTE_TEST_MENV_A;
    machineEnv("PIQUETTE_TEST_MENV_A=3\n", mode);
    const refused = captureStderr(() => loadStartupEnv(repo));
    assert.equal(refused.length, 1);
    assert.match(refused[0], /NOT loaded/);
    assert.ok(machineEnvStatus()!.refused, `mode ${mode.toString(8)} refused`);
    assert.equal(process.env.PIQUETTE_TEST_MENV_A, undefined);
  }
});

test("a missing machine env file is a silent no-op", () => {
  assert.deepEqual(captureStderr(() => loadStartupEnv(repo)), []);
  const status = machineEnvStatus()!;
  assert.equal(status.exists, false);
  assert.deepEqual(status.loaded, []);
});

test("machine-loaded sync credentials never reach operatorEnv() or an allowlisted agent env", () => {
  machineEnv("PIQUETTE_SYNC_CLIENT_ID=id-secret\nPIQUETTE_SYNC_CLIENT_SECRET=sk-secret\nPIQUETTE_TEST_MENV_A=visible\n");
  loadStartupEnv(repo);
  assert.equal(process.env.PIQUETTE_SYNC_CLIENT_ID, "id-secret");
  const op = operatorEnv();
  assert.equal(op.PIQUETTE_SYNC_CLIENT_ID, undefined);
  assert.equal(op.PIQUETTE_SYNC_CLIENT_SECRET, undefined);
  assert.equal(op.PIQUETTE_TEST_MENV_A, "visible");
  const cfg = loadConfig([]);
  const agentCfg = { ...cfg.agents[0], env_allowlist: ["PIQUETTE_SYNC_CLIENT_ID", "PIQUETTE_SYNC_CLIENT_SECRET", "PIQUETTE_TEST_MENV_A"] };
  const env = agentEnv(agentCfg)!;
  assert.equal(env.PIQUETTE_SYNC_CLIENT_ID, undefined);
  assert.equal(env.PIQUETTE_SYNC_CLIENT_SECRET, undefined);
  assert.equal(env.PIQUETTE_TEST_MENV_A, "visible");
});

test("a cfg.env ${VAR} reference sees a machine-loaded value", () => {
  machineEnv("PIQUETTE_TEST_MENV_REF=from-machine\n");
  loadStartupEnv(repo);
  applyConfigEnv({ PIQUETTE_TEST_MENV_CFG: "tag-${PIQUETTE_TEST_MENV_REF}" });
  assert.equal(process.env.PIQUETTE_TEST_MENV_CFG, "tag-from-machine");
});
