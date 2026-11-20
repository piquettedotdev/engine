/**
 * `watch.resume_at_failed_phase` (#14): the leading-phase skip in `steps.runStepList`.
 *
 * A real sqlite tracer holds the "previous run's" rows; the Run is a fake whose
 * phases only record that they ran. The contract under test: only the leading
 * agent steps (and a proveBase with a usable receipt) whose previous result is
 * on record are skipped; request always re-runs; every gating/verifying/
 * committing step always runs; and any mismatch ends the prefix so the rest
 * runs normally.
 */
import "./hermetic_git.js"; // MUST stay first: one test runs git in a temp repo
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as steps from "../chains/steps.js";
import { makeEventRecord, makePhaseParams, type Phase } from "../core/data_types.js";
import { loadJourneysFile } from "../core/journeys.js";
import { proofStore, prove } from "../core/prove.js";
import type { Run } from "../core/runner.js";
import { Tracer } from "../core/tracer.js";

const ADW = "issue-9";

interface Seed {
  name: string;
  status?: "success" | "fail";
  owner?: string;
  /** Payload of the phase's envelope; omitted = no envelope row. */
  envelope?: Record<string, unknown>;
  valid?: boolean;
  type?: string;
  logs?: Array<Record<string, unknown>>;
}

async function fixture(prior: Seed[], startAt = 0) {
  const dir = mkdtempSync(join(tmpdir(), "piquette-steps-resume-"));
  const tracer = await Tracer.open(join(dir, "piquette.db"), join(dir, "events.jsonl"));
  let seq = startAt;
  for (const p of prior) {
    seq += 1;
    const phase: Phase = {
      phase_id: `${ADW}_${String(seq).padStart(2, "0")}_${p.name}`,
      adw_id: ADW,
      seq,
      params: makePhaseParams({ name: p.name, kind: "agent", owner: p.owner ?? "builder", description: `Prior ${p.name} phase for the resume test` }),
      status: p.status ?? "success",
      attempt: 0,
      error: null,
      started_at: null,
      ended_at: null,
    };
    await tracer.phaseUpsert(phase);
    if (p.envelope) await tracer.envelopeRow(phase, p.owner ?? "builder", p.type ?? (p.name === "plan" ? "PlanOutput" : "BuildOutput"), JSON.stringify(p.envelope), p.valid ?? true, 0);
    for (const payload of p.logs ?? []) await tracer.event(makeEventRecord({ adw_id: ADW, phase_id: phase.phase_id, type: "log", name: p.name, payload }));
  }
  const ran: string[] = [];
  const notes: string[] = [];
  const run = {
    cfg: {},
    repo_root: dir,
    adw_id: ADW,
    engineer: "eng",
    tracer,
    console: { note: async (m: string) => void notes.push(m) },
    phase: async (params: { name: string }, fn: (ph: unknown) => Promise<unknown>) => {
      ran.push(params.name);
      return fn({
        phase_id: `fresh-${params.name}`,
        log: async () => {},
        call: async () => ({ status: "success", summary: `fresh ${params.name}`, artifacts: [], notes_for_next_agent: "", changed_files: [], commit_message: "" }),
      });
    },
  } as unknown as Run;
  const state = steps.makeState("the ask", {}, "9");
  const gateRan: string[] = [];
  const gateStep = (async () => void gateRan.push("gate")) as unknown as steps.Step; // declares no resume: always runs
  return { run, state, ran, notes, gateRan, gateStep, tracer, dir, to: seq, cleanup: async () => (await tracer.close?.(), rmSync(dir, { recursive: true, force: true })) };
}

const ok = (summary: string, extra: Record<string, unknown> = {}) => ({ status: "success", summary, artifacts: [], notes_for_next_agent: "", ...extra });

test("resume: plan and build are skipped with state.previous rehydrated; request and every gate step re-run", async () => {
  const f = await fixture([{ name: "request" }, { name: "plan", owner: "planner", envelope: ok("prior plan") }, { name: "build", envelope: ok("prior build", { changed_files: ["a.ts"] }) }, { name: "test", status: "fail" }]);
  try {
    await steps.runStepList(f.run, f.state, [steps.request(), steps.plan(), steps.build(), f.gateStep], { from: 0, to: f.to });
    assert.deepEqual(f.ran, ["request"]);
    assert.deepEqual(f.gateRan, ["gate"]);
    assert.equal(f.state.previous?.summary, "prior build");
    assert.ok(f.notes.some((n) => /skipping plan/.test(n)) && f.notes.some((n) => /skipping build/.test(n)));
  } finally {
    await f.cleanup();
  }
});

test("resume: a build that failed last time runs again (its predecessor is still skipped)", async () => {
  const f = await fixture([{ name: "request" }, { name: "plan", owner: "planner", envelope: ok("prior plan") }, { name: "build", status: "fail", envelope: ok("half built") }]);
  try {
    await steps.runStepList(f.run, f.state, [steps.request(), steps.plan(), steps.build()], { from: 0, to: f.to });
    assert.deepEqual(f.ran, ["request", "build"]);
    assert.equal(f.state.previous?.summary, "fresh build");
  } finally {
    await f.cleanup();
  }
});

test("resume: any mismatch means a full run — wrong phase order, invalid envelope, wrong output type, wrong agent, no request first", async () => {
  const cases: Array<{ name: string; prior: Seed[] }> = [
    { name: "missing plan row", prior: [{ name: "request" }, { name: "build", envelope: ok("b") }] },
    { name: "invalid envelope", prior: [{ name: "request" }, { name: "plan", owner: "planner", envelope: ok("p"), valid: false }, { name: "build", envelope: ok("b") }] },
    { name: "unparseable envelope", prior: [{ name: "request" }, { name: "plan", owner: "planner", envelope: { nope: true } }, { name: "build", envelope: ok("b") }] },
    { name: "wrong output type", prior: [{ name: "request" }, { name: "plan", owner: "planner", type: "BuildOutput", envelope: ok("p") }, { name: "build", envelope: ok("b") }] },
    { name: "different agent", prior: [{ name: "request" }, { name: "plan", owner: "someone-else", envelope: ok("p") }, { name: "build", envelope: ok("b") }] },
    { name: "no request first", prior: [{ name: "plan", owner: "planner", envelope: ok("p") }] },
    { name: "failed request", prior: [{ name: "request", status: "fail" }, { name: "plan", owner: "planner", envelope: ok("p") }] },
  ];
  for (const c of cases) {
    const f = await fixture(c.prior);
    try {
      await steps.runStepList(f.run, f.state, [steps.request(), steps.plan(), steps.build()], { from: 0, to: f.to });
      assert.deepEqual(f.ran, ["request", "plan", "build"], c.name);
    } finally {
      await f.cleanup();
    }
  }
});

test("resume: a trace that moved on since (max seq != range.to), a range that misses the rows, or no resume at all runs everything", async () => {
  const prior: Seed[] = [{ name: "request" }, { name: "plan", owner: "planner", envelope: ok("p") }, { name: "build", envelope: ok("b") }];
  for (const [label, range] of [
    ["max seq moved", (to: number) => ({ from: 0, to: to - 1 })],
    ["range above the rows", (to: number) => ({ from: to, to })],
    ["no resume", () => undefined],
  ] as const) {
    const f = await fixture(prior);
    try {
      await steps.runStepList(f.run, f.state, [steps.request(), steps.plan(), steps.build()], range(f.to));
      assert.deepEqual(f.ran, ["request", "plan", "build"], label);
    } finally {
      await f.cleanup();
    }
  }
});

test("resume: only rows inside (from, to] count — an earlier claim's phases for the same adw_id are ignored", async () => {
  const f = await fixture([{ name: "request" }, { name: "plan", owner: "planner", envelope: ok("old plan") }, { name: "request" }, { name: "plan", owner: "planner", envelope: ok("new plan") }]);
  try {
    await steps.runStepList(f.run, f.state, [steps.request(), steps.plan()], { from: 2, to: f.to });
    assert.deepEqual(f.ran, ["request"]);
    assert.equal(f.state.previous?.summary, "new plan");
  } finally {
    await f.cleanup();
  }
});

test("resume: proveBase with no receipts configured would write no phase, so it is skipped without consuming a row", async () => {
  const f = await fixture([{ name: "request" }, { name: "plan", owner: "planner", envelope: ok("p") }, { name: "build", envelope: ok("b") }]);
  try {
    await steps.runStepList(f.run, f.state, [steps.request(), steps.plan(), steps.proveBase(), steps.build()], { from: 0, to: f.to });
    assert.deepEqual(f.ran, ["request"], "plan, prove_base (nothing to run) and build all skipped");
  } finally {
    await f.cleanup();
  }
});

test("resume: prove_base is rehydrated from the stored receipt; no log, a missing receipt, or the wrong stage cannot be", async () => {
  const f = await fixture([{ name: "request" }, { name: "plan", owner: "planner", envelope: ok("p") }]);
  const repo = mkdtempSync(join(tmpdir(), "piquette-steps-resume-repo-"));
  try {
    const git = (...a: string[]) => assert.equal(spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t.invalid", "-c", "commit.gpgsign=false", ...a], { cwd: repo, encoding: "utf-8" }).status, 0);
    git("init", "-q", "-b", "main");
    writeFileSync(join(repo, "a.txt"), "a");
    git("add", "-A");
    git("commit", "-q", "-m", "init");
    const journeysPath = join(repo, "journeys.yaml");
    writeFileSync(journeysPath, 'journeys:\n  - id: P01\n    criterion: "it runs"\n    run: "true"\n    expect: { exit: 0 }\n');
    const cfg = { receipts: { record: false, store: { kind: "local", path: join(repo, "store") } } };
    const store = proofStore(cfg as never, repo);
    const made = await prove({ repoRoot: repo, store, repo: "r", runId: ADW, issue: "9", stage: "base", journeys: loadJourneysFile(journeysPath) });
    const withBase = async (logs: Array<Record<string, unknown>>, stageOk = true) => {
      const seeded = await fixture([{ name: "prove_base", owner: "prover", logs }]);
      const run = { ...(seeded.run as object), cfg, repo_root: repo } as unknown as Run;
      const state = steps.makeState("x", {}, "9");
      state.previous = ok("plan", { artifacts: [journeysPath] }) as never;
      const prior = (await seeded.tracer.phasesInRange(ADW, 0, 1))[0]!;
      const step = steps.proveBase();
      const result = await step.resume!.rehydrate(run, state, stageOk ? prior : prior);
      await seeded.cleanup();
      return { result, state };
    };
    const good = await withBase([{ receipt: made.key, verdict: made.receipt.verdict }]);
    assert.equal(good.result, true);
    assert.equal(good.state.verification?.base?.key, made.key);
    assert.equal((await withBase([{ note: "no receipt key" }])).result, false);
    assert.equal((await withBase([{ receipt: "r/attempts/issue-9/7/receipt.json" }])).result, false);
    const head = await prove({ repoRoot: repo, store, repo: "r", runId: ADW, issue: "9", stage: "head", journeys: loadJourneysFile(journeysPath) });
    assert.equal((await withBase([{ receipt: head.key }])).result, false, "a head receipt is not a base proof");
  } finally {
    rmSync(repo, { recursive: true, force: true });
    await f.cleanup();
  }
});

test("resume: proveBase re-run on resumed work records a problem (so verification reports UNVERIFIED); a normal run records none", async () => {
  const f = await fixture([]);
  const repo = mkdtempSync(join(tmpdir(), "piquette-steps-resume-repo-"));
  try {
    const git = (...a: string[]) => assert.equal(spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t.invalid", "-c", "commit.gpgsign=false", ...a], { cwd: repo, encoding: "utf-8" }).status, 0);
    git("init", "-q", "-b", "main");
    writeFileSync(join(repo, "a.txt"), "a");
    git("add", "-A");
    git("commit", "-q", "-m", "init");
    const journeysPath = join(repo, "journeys.yaml");
    writeFileSync(journeysPath, 'journeys:\n  - id: P01\n    criterion: "it runs"\n    run: "true"\n    expect: { exit: 0 }\n');
    const cfg = { receipts: { record: false, store: { kind: "local", path: join(repo, "store") } } };
    for (const resumed of [true, false]) {
      const run = { ...(f.run as object), cfg, repo_root: repo, context_handoff_dir: repo } as unknown as Run;
      const state = steps.makeState("x", {}, "9");
      state.previous = ok("plan", { artifacts: [journeysPath] }) as never;
      if (resumed) state.resumedFromWip = true;
      await steps.proveBase()(run, state);
      const problems = state.verification!.problems.filter((p) => /ran on resumed work/.test(p));
      assert.equal(problems.length, resumed ? 1 : 0, `resumed=${resumed}`);
    }
  } finally {
    rmSync(repo, { recursive: true, force: true });
    await f.cleanup();
  }
});

test("resume: only agent steps and proveBase declare resume — gating, verifying and committing steps never do", () => {
  for (const s of [steps.request(), steps.plan(), steps.build(), steps.scout(), steps.promptOnly(), steps.proveBase()]) assert.ok(s.resume || s.resumeNeutral, s.label);
  for (const s of [steps.qualityCheck({ suite: "all" }), steps.fixLoop({ suite: "all" }), steps.proveHead({ suite: "all" }), steps.reviseLoop(), steps.commit(), steps.changes(), steps.document()]) {
    assert.equal(s.resume, undefined, s.label);
    assert.equal(s.resumeNeutral, undefined, s.label);
  }
});
