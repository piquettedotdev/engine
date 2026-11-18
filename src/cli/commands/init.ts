/**
 * `piquette init` — seed a `.piquette/` override directory. Everything else is
 * inherited from the packaged defaults.
 *
 * On a TTY (and without `--template`/`--yes`), this runs an interview
 * instead of writing the all-comments starter file: it asks which coding
 * agent, model/provider, quality checks, and (if wanted) `piquette watch`
 * tracker/host to use, collects the secrets those answers imply, and
 * appends them to `.env` (already auto-loaded by every command — see
 * `src/cli/index.ts`). Piped input, `--yes`, or `--template <name>` all
 * fall through to the original non-interactive behavior unchanged — a
 * scripted `piquette init` must never hang waiting on stdin.
 *
 * Every path here also installs the repo-local Claude Code skill (the same
 * work `piquette install-skill` does by hand) unless `--no-skills` is passed —
 * on every run, not just the first: `install-skill` is idempotent (a no-op
 * once the skill is already up to date), so this never re-does work or
 * clobbers a locally-edited skill file. `--user` (installing to
 * `~/.claude/skills/piquette` instead) stays a `piquette install-skill` invocation of
 * its own; `init` only ever writes the repo-local default.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parse, stringify } from "yaml";
import * as paths from "../../core/paths.ts";
import * as agents from "../../core/agents.ts";
import { ensureGitignore } from "../gitignore.ts";
import { parseCli } from "../../core/utils.ts";
import { paint } from "../../core/console.ts";
import { createAsker, inkAvailable, isInteractive, InterviewAborted } from "../ask.ts";
import { BLOCK_KEYS, gatherContext, INTERVIEW_BLOCKS, runInterview, type InterviewBlock, type InterviewResult } from "../interview.ts";
import { createAnswersAsker, InvalidAnswer, NeedsAnswer, readAnswers, type AnswerValue } from "../answers_asker.ts";
import { readEnvFile, upsertEnvFile, writeEnvExample } from "../env_file.ts";
import { installedSkillState, installSkillCommand, packagedSkills, SKILL_LAYOUTS } from "./install-skill.ts";
import { redundantOverrides } from "../config_drift.ts";

const TEMPLATE_SUFFIX = ".piquette.config.yaml";

/** Every template's short name (e.g. "ts-cc"), derived from disk rather than hand-maintained — never drifts from what's actually packaged. */
function listTemplates(): string[] {
  if (!existsSync(paths.TEMPLATES_DIR)) return [];
  return readdirSync(paths.TEMPLATES_DIR)
    .filter((f) => f.endsWith(TEMPLATE_SUFFIX))
    .map((f) => f.slice(0, -TEMPLATE_SUFFIX.length))
    .sort();
}

function loadTemplate(name: string): string {
  const templatePath = path.join(paths.TEMPLATES_DIR, `${name}${TEMPLATE_SUFFIX}`);
  if (!existsSync(templatePath)) {
    const available = listTemplates();
    throw new Error(
      `unknown template ${JSON.stringify(name)} — available: ${available.length > 0 ? available.join(", ") : "(none packaged)"}`,
    );
  }
  return readFileSync(templatePath, "utf-8");
}

const STARTER_CONFIG = `# .piquette/piquette.config.yaml — merged ON TOP of piquette's packaged built-in defaults.
# List only what you want to CHANGE; everything else (the roster, prompts,
# models) is inherited. Run \`piquette doctor\` any time to see what's actually in
# effect for this repo, and where each value came from.

# Uncomment to enable a quality-gated chain (build-test, plan-build-test,
# plan-build-test-quality, quality, simple-sdlc) — an unconfigured suite
# fails loudly before anything runs, on purpose, rather than reporting a
# placeholder green.
# quality:
#   checks:
#     - {name: test, operation: build, argv: ["npm", "test"], timeout_seconds: 600}
#   suites:
#     test: [test]
#     all: [test]

# Uncomment to capture verification receipts (before/after proof, evidence,
# the PR's Verification section) — off until this block exists. See
# README.md's "Verification receipts (store)" section for what it turns on
# in chains, and docs/cloud.md for serving them through \`piquette cloud deploy\`.
# receipts:
#   store:
#     kind: local                    # default: files under .piquette/data/receipts (gitignored)
#     path: .piquette/data/receipts
#
#   # or any S3-compatible store: AWS S3, Cloudflare R2, MinIO, ...
#   # store:
#   #   kind: s3
#   #   bucket: piquette-receipts
#   #   endpoint: https://<account_id>.r2.cloudflarestorage.com   # omit for AWS
#   #   region: auto                                              # e.g. us-east-1 on AWS
#   #   prefix: ""                                                # optional key prefix
#   #   access_key_id_env: R2_ACCESS_KEY_ID                       # env var NAMES, never values
#   #   secret_access_key_env: R2_SECRET_ACCESS_KEY
#   # viewer_url: https://receipts.example.com                    # optional

# agents:
#   - name: builder
#     model: anthropic/claude-sonnet-4-6
#     coding_agent: claude_code   # run this agent on Claude Code instead of Flue
#     model: sonnet               # claude_code's own alias, NOT provider/model-id
#
# Switching coding_agent globally, in defaults: above, instead of per-agent?
# The packaged default roster pins planner/reviewer/documenter to their own
# explicit Flue-style provider/model-id strings, and an agent's own model
# always wins over defaults.model — so those three keep running on whatever
# backend you just switched to, with a model id it can't resolve, unless
# you override their model here too (builder/scout/refiner have no model of
# their own in the packaged roster, so they need no override). See
# assets/templates/ts.piquette.config.yaml (or --template ts) for the full
# working pattern.

# Uncomment to enable \`piquette watch\` — polls an issue tracker labeled
# <label_prefix>:ready and runs \`chain\` against each in its own worktree.
# issue_provider and code_host default to "github" and are independent —
# a Jira tracker against a Bitbucket repo is just issue_provider: jira +
# code_host: bitbucket + a watch.jira: {base_url, project_key} block. See
# README.md's "piquette watch" section for every combination's env vars and
# required scopes. \`piquette doctor\` checks whatever this resolves to.
# watch:
#   issue_provider: github   # github | github-projects | jira
#   code_host: github        # github | bitbucket
#   repo: owner/name          # the CODE HOST's repo — "owner/name" (github) or "workspace/repo_slug" (bitbucket)
#   # issue_repo: owner/name  # ONLY for issue_provider: github/github-projects + code_host: bitbucket,
#   #                         # when the tracker and code host are genuinely different repos
#   # issue_provider: github-projects drives intake off a board's Status field
#   # instead of labels — see README.md's "GitHub Projects v2" section.
#   # github_projects:
#   #   project_number: 3     # REQUIRED — the owner's Projects v2 board number
#   #   status_map: {ready: Todo, working: In Progress, review: In Review, done: Done, blocked: Blocked}
#   label_prefix: piquette
#   chain: plan-build-test
#   base_branch: main
#   # Optional second lane: decompose a piquette:spec-ready product spec into a
#   # feature/story-or-bug tree of real issues. Off by default; needs
#   # issue_provider: github, github-projects, OR jira — all three support
#   # issue authoring. On Jira,
#   # each kind maps to a real issue type via watch.jira.issue_types
#   # (defaults: epic/feature -> Epic, story -> Story, bug -> Bug,
#   # task -> Task) — \`piquette watch init\` validates this against the project.
#   refine:
#     enabled: true
#     chain: refine
#     concurrency: 1

# Uncomment to push notifications for unattended work — piquette watch's daemon
# lifecycle, and every chain run (piquette <chain> / piquette run, including watch's
# own per-issue runs). Interactive commands (doctor, list, sessions, ...)
# never notify — you're already looking at the terminal for those. events:
# "errors" sends only true failures; "attention" adds blocked issues and
# feedback requests; "all" adds every milestone too (run started, issue
# claimed, PR opened, ...). The URL is a secret and lives only in .env —
# never in this file. See README.md's "Notifications" section for how to
# get each webhook URL.
# notifications:
#   events: attention          # off (default) | errors | attention | all
#   channels:
#     - kind: slack            # slack | teams | webhook
#       webhook_url_env: SLACK_WEBHOOK_URL   # default for slack; TEAMS_WEBHOOK_URL / PIQUETTE_WEBHOOK_URL for the others

# Uncomment to change the human sign-off gate in front of simple-sdlc's
# commit_build phase — the one place an AI reviewer's approved flag alone
# can gate a commit. See assets/skills/piquette/references/config.md's "review"
# section for the full behavior.
# review:
#   require_human_signoff: false   # true = an unattended simple-sdlc run fails closed instead of committing on the reviewer's verdict alone
#   signoff_timeout_seconds: 300

# Uncomment to route roles to cheaper/stronger models by a run-global risk
# signal (chain kind + prompt length) — OFF by default, and absence/false is
# a TOTAL no-op: every agent dispatches at exactly the model its roster
# entry names. \`piquette init --template ts-flue-ollama\` ships this ON with two
# MEASURED local tags; this starter leaves it off and commented because no
# tag below has been measured against YOUR roster. See
# assets/skills/piquette/references/config.md's "tiering" section for the full
# mechanism (the ladder walk, rule T, the availability probe) before turning
# this on — \`piquette doctor\` checks these rungs the same way it checks
# cfg.agents[].model, but ONLY once enabled: true.
# tiering:
#   enabled: true
#   tiers:
#     - { name: cheap,  coding_agent: flue, model: google/gemini-3.6-flash }
#     - { name: strong, coding_agent: flue, model: openai/gpt-5.6-terra }
#   roles:
#     builder: cheap
#     reviewer: strong
`;

// .piquette/piquette.config.yaml and .piquette/prompt_engineering/ stay tracked — they're
// shared project config, same as package.json. Only runtime/generated
// content is ignored: session traces (data/), a hand-editable engine copy
// (engine/, from `piquette eject`), and secrets (.env).
//
// `.piquette/chains/` is deliberately NOT in this list. A chain file is DATA
// that decides what the disposer runs (see repo_chains.ts's module comment)
// — the same trust boundary `defaults.protected_files` exists to guard.
// Gitignoring it would let anyone (or any agent) rewrite what "piquette plan-
// build-test" or a watch.chain even means, invisibly to `git diff`/PR
// review, in a repo that otherwise protects every other file that judges
// agent output. Chain files stay tracked so `protected_files` covers the
// chain that judges the agents, not just the code it judges.
const GITIGNORE_ENTRIES = [".piquette/data/", ".piquette/engine/", ".env"];

/**
 * Scaffolded once by `piquette init` — fully commented out, so every line is a
 * `#` comment and `parseYaml` reads the whole file as an empty document;
 * `loadOne` (repo_chains.ts) treats that as "declares no chain" and skips it
 * silently — no chain registered, but also no problem reported against
 * piquette's own scaffold. It exists to show the shape (naming existing
 * `chains/steps.ts` factories as data, never importing repo code — params
 * are flat siblings of `step:`, never nested under a `params:` key) and to
 * carry the one divergence an author needs to know before writing a real
 * one.
 */
export const EXAMPLE_CHAIN_YAML = `# .piquette/chains/example.yaml — a repo-local chain, loaded as DATA.
#
# This file NAMES existing step factories from piquette's own chains/steps.ts
# (request, plan, build, fixLoop, commit, ...) — it never imports or runs
# code from this repo. "Agent proposes, code disposes," and the code that
# disposes is always PIQUETTE's own, packaged code; a chain file only ever picks
# which of ITS steps run, in which order, with which params. See
# .claude/skills/piquette-author/cookbooks/authoring_chains.md (installed by \`piquette init\`
# into THIS repo) for the full step vocabulary — its "Repo-local chains"
# section is written for exactly this file.
#
# WATCH DIVERGENCE: \`piquette watch\` registers chains from the MAIN repo anchor
# once, at daemon start — not per-issue, not per-worktree. A chain file
# edited on an issue branch (inside the worktree \`piquette watch\` checks that
# branch out into) is NOT what runs for that issue; the daemon keeps using
# whatever \`.piquette/chains/\` looked like in the main repo when it started. The
# disposer stays the OPERATOR's, never the branch's — exactly the property
# that keeps an agent from being able to rewrite its own quality gate mid-run
# by editing a chain file as part of the change it's making.
#
# Uncomment and edit to register this chain (piquette list / piquette doctor will
# then show it). Every field below is required unless noted. \`route_when\`
# is optional: one or two sentences for \`piquette watch\`'s decision-layer chain
# router saying WHEN to pick this chain (it reads that instead of \`describe\`;
# see docs/decisions.md, "chain_router"). Leave it out and describe is used.
#
# name: example                  # piquette example "<prompt>" / piquette run example "<prompt>"
# describe: small build+fix example chain — build, then a bounded test-fix loop
# route_when: Use for a small fix with an existing test suite and no need for a written plan. Not for docs-only edits.
# steps:
#   - step: request               # every chain opens with this
#   - step: build
#     fromPlan: false              # no preceding plan() step in this chain
#   - step: fixLoop
#     suite: test                  # must name a key under quality.suites in piquette.config.yaml
#     owner: builder               # must name an agent in the roster (cfg.agents)
#     max: 3                       # optional — defaults to 3 if omitted
#   - step: commit
#     onlyIfAccepted: true
`;

/**
 * Second scaffold, same contract as EXAMPLE_CHAIN_YAML: every line a `#`
 * comment, so it registers nothing and reports no problem. It shows the other
 * thing a repo-local chain is for — putting an EXTERNAL CLI (a third-party
 * reviewer, a linter) into the sequence. A chain can't run an arbitrary
 * command inline; the command is declared as a `quality.checks[]` entry,
 * grouped into a `quality.suites` suite, and the chain names that suite via
 * `fixLoop`. The checks half lives in piquette.config.yaml, so it is shown here as
 * a comment rather than written for you.
 */
export const EXAMPLE_REVIEW_FIX_CHAIN_YAML = `# .piquette/chains/review-fix.yaml — an external CLI reviewer + lint as a gate.
#
# A chain step can't run an arbitrary shell command inline. The command is
# declared once under quality.checks in .piquette/piquette.config.yaml, grouped into a
# suite, and the chain names the suite. fixLoop runs the suite, hands any
# failing output VERBATIM to the fix agent, and re-runs it — bounded by max,
# and never leaving an unverified fix on the last iteration.
#
# 1. Add to .piquette/piquette.config.yaml (this half is config, not chain):
#
#   quality:
#     checks:
#       - { name: ocr,  area: backend, operation: lint, argv: ["./scripts/ocr-gate.sh"], timeout_seconds: 600 }
#       - { name: lint, area: backend, operation: lint, argv: ["npm", "run", "lint"], timeout_seconds: 120 }
#     suites:
#       review-lint: [ocr, lint]     # ONE suite for both — see the note below
#
# 2. Write ./scripts/ocr-gate.sh. A check passes or fails on its exit code
#    ALONE, and open-code-review (https://github.com/alibaba/open-code-review)
#    does not document one for "found issues" — so wrap it: run
#    \`ocr review --format json --output <tmp>\` (a path OUTSIDE the repo, so
#    nothing dirties the tree that \`commit\` will stage), print the findings
#    to stdout (that is what the fix agent reads), and exit nonzero if there
#    are any. Without that wrapper this gate can never fail.
#    ocr calls its own LLM with your credentials; that spend never appears in
#    \`piquette sessions\`. See cookbooks/ocr_reviewer.md for the reviewer-agent
#    alternative.
#
# 3. Uncomment the chain below — piquette build-review-fix "<prompt>"
#
# Use ONE suite, not two fixLoop steps. Acceptance is kept per suite, so a
# failing review loop followed by a passing lint loop is still (correctly)
# reported unaccepted — but the second loop spends its fix attempts on a run
# that can no longer be accepted, and both loops name their repair phases
# fix_1, fix_2, ... One suite lets one loop repair every finding together.
#
# Decision-layer finding triage (decisions.kinds.finding_triage, off by default) does NOT
# apply here: fixLoop hands the suite's output to the fix agent verbatim.
# Triage classifies structured review findings (real|noise|style) in
# reviseLoop's review -> revise handoff, so to get it, have a reviewer agent
# consult the tool and use reviseLoop instead (cookbooks/ocr_reviewer.md).
# Triage only reshapes what the fixer is asked to fix, never the verdict.
#
# name: build-review-fix
# describe: plan, build, then an ocr + lint gate with a bounded auto-fix loop
# steps:
#   - step: request
#   - step: plan
#   - step: build
#   - step: fixLoop
#     suite: review-lint            # must name a key under quality.suites
#     owner: builder                # optional — the agent that repairs failures
#     max: 3
#   - step: commit
#     onlyIfAccepted: true
`;

const GENERATED_HEADER = `# .piquette/piquette.config.yaml — written by \`piquette init\`'s interview, merged ON TOP of
# piquette's packaged built-in defaults. Only what you changed is here; run
# \`piquette doctor\` any time to see what's actually in effect for this repo, and
# where each value came from. Secrets this config implies live in .env
# (gitignored) — .env.example lists the key names only.
`;

const BLOCK_LABELS: Record<InterviewBlock, string> = {
  coding_agent: "Coding agent (backend, model, auth)",
  quality: "Quality checks",
  receipts: "Verification receipts",
  watch: "Watch ticket loop (piquette watch)",
  notifications: "Notifications",
  advanced: "Advanced settings",
};

/** Whether `block` already has something written in `existing` — drives both the picker's "currently configured" hint and that confirm's default (reconfigure what's there; leave what isn't alone). */
function blockConfigured(block: InterviewBlock, existing: Record<string, unknown>): boolean {
  const existingDefaults = (existing.defaults as Record<string, unknown> | undefined) ?? {};
  switch (block) {
    case "coding_agent":
      return Boolean(existingDefaults.coding_agent);
    case "advanced":
      return Boolean(existing.observability) || ["thinking", "data_dir", "protected_files"].some((k) => k in existingDefaults);
    default:
      return Boolean(existing[block]);
  }
}

/** Reads `.env.example`'s key names (ignoring values — this is the committable, value-free file) so a `--partial` run's `writeEnvExample` call adds to it instead of truncating it down to just this run's keys. */
function readEnvExampleKeys(repoRoot: string): string[] {
  const p = path.join(repoRoot, ".env.example");
  if (!existsSync(p)) return [];
  const keys: string[] = [];
  for (const line of readFileSync(p, "utf-8").split("\n")) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(line.trim());
    if (match) keys.push(match[1]);
  }
  return keys;
}

/**
 * True when the config file has no settings at all — every line a comment, as
 * the non-interactive `piquette init` starter writes it. Such a file configures
 * nothing, so setup treats it as absent: `--detect` reports `config_empty`,
 * and `--answers` / the interview replace it without needing --force.
 */
export function configIsEmpty(configPath: string): boolean {
  if (!existsSync(configPath)) return true;
  try {
    const doc = parse(readFileSync(configPath, "utf-8")) as unknown;
    return doc === null || doc === undefined || (typeof doc === "object" && !Array.isArray(doc) && Object.keys(doc as object).length === 0);
  } catch {
    return false; // unparseable is not "empty" — never silently replace a file someone was editing
  }
}

/**
 * The shared setup a teammate needs, as repo-relative paths with uncommitted
 * changes: the config, repo chains, `.env.example`, `.gitignore` and the
 * installed skill folders. Asks git, so an already-committed, unchanged file
 * isn't listed; outside a git repo it falls back to whichever exist. `.env`
 * (secrets) is never included.
 */
export function filesToCommit(repoRoot: string): string[] {
  const candidates = [".piquette/piquette.config.yaml", ".piquette/chains", ".env.example", ".gitignore", ...Object.values(SKILL_LAYOUTS)].filter((p) =>
    existsSync(path.join(repoRoot, p)),
  );
  if (candidates.length === 0) return [];
  const status = spawnSync("git", ["status", "--porcelain", "--untracked-files=all", "--", ...candidates], { cwd: repoRoot, encoding: "utf-8" });
  if (status.status !== 0) return candidates;
  const changed = status.stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => line.slice(3).replace(/^"|"$/g, ""))
    .map((p) => (p.includes(" -> ") ? p.split(" -> ")[1] : p));
  // Collapse per-file noise to the candidate it belongs to, so a skill folder reads as one entry, not forty.
  const out = new Set<string>();
  for (const p of changed) {
    const owner = candidates.find((c) => p === c || p.startsWith(c + "/"));
    if (owner) out.add(statSync(path.join(repoRoot, owner)).isDirectory() ? owner + "/" : owner);
  }
  return [...out].sort();
}

function packageVersion(): string {
  return (JSON.parse(readFileSync(path.join(paths.PACKAGE_ROOT, "package.json"), "utf-8")) as { version: string }).version;
}

/** Run `fn` with console.log routed to stderr — keeps a `--json` command's stdout a single parseable document while reused code paths still print. */
async function quietStdout<T>(fn: () => T | Promise<T>): Promise<T> {
  const original = console.log;
  console.log = (...args: unknown[]) => console.error(...args);
  try {
    return await fn();
  } finally {
    console.log = original;
  }
}

/** Scaffolded unconditionally on every writing path — never overwrites a file already there (an author may have started editing the example). */
function scaffoldChains(sfDir: string): void {
  const chainsDir = path.join(sfDir, "chains");
  mkdirSync(chainsDir, { recursive: true });
  const exampleChainPath = path.join(chainsDir, "example.yaml");
  if (!existsSync(exampleChainPath)) writeFileSync(exampleChainPath, EXAMPLE_CHAIN_YAML);
  const reviewFixChainPath = path.join(chainsDir, "review-fix.yaml");
  if (!existsSync(reviewFixChainPath)) writeFileSync(reviewFixChainPath, EXAMPLE_REVIEW_FIX_CHAIN_YAML);
}

/**
 * The config a finished interview should leave on disk. A full run replaces the
 * file; a partial run (`only` set) merges into `existing`: `defaults` is shared
 * by two blocks (coding_agent, advanced) and runInterview already reconciled it
 * (seeded from `existing`, each selected block setting or deleting only its own
 * keys), so it's always the complete, correct replacement. Every other touched
 * key is owned by exactly one block: set it when this run produced it, delete it
 * when the block ran but decided against it (see runInterview's doc comment on
 * `asks`/BLOCK_KEYS for why "ran but absent" must delete rather than leave the
 * untouched merge default in place).
 */
function finalConfig(result: InterviewResult, partial?: { only: Set<InterviewBlock>; existing: Record<string, unknown> }): Record<string, unknown> {
  if (!partial) return result.config;
  const merged: Record<string, unknown> = { ...partial.existing, defaults: result.config.defaults };
  if (!merged.defaults || Object.keys(merged.defaults as object).length === 0) delete merged.defaults;
  for (const block of partial.only) {
    for (const key of BLOCK_KEYS[block]) {
      if (key in result.config) merged[key] = result.config[key];
      else delete merged[key];
    }
  }
  return merged;
}

/**
 * Write a finished interview's config, `.env` entries and `.env.example` keys,
 * then run the same merge-then-validate pipeline `piquette doctor` runs — which
 * catches a bad answer (e.g. a suite naming an unconfigured check) right after
 * writing, not at the first real chain run. Non-fatal: returns the validation
 * problem (if any) rather than throwing; the config is already written either way.
 * Shared by the terminal interview and `--answers`, so both write identically.
 */
function writeInterviewResult(
  anchor: paths.RepoAnchor,
  configPath: string,
  result: InterviewResult,
  partial?: { only: Set<InterviewBlock>; existing: Record<string, unknown> },
): { config: Record<string, unknown>; envWritten: string[]; warning?: string } {
  const config = finalConfig(result, partial);
  writeFileSync(configPath, GENERATED_HEADER + stringify(config));
  console.log(`wrote ${configPath}${partial ? ` (reconfigured: ${[...partial.only].join(", ")})` : ""}`);
  const envWritten = Object.keys(result.env);
  if (envWritten.length > 0) upsertEnvFile(anchor.repo_root, result.env);
  if (partial) {
    if (result.envExampleKeys.length > 0) {
      writeEnvExample(anchor.repo_root, [...new Set([...readEnvExampleKeys(anchor.repo_root), ...result.envExampleKeys])]);
    }
  } else {
    writeEnvExample(anchor.repo_root, result.envExampleKeys);
  }
  try {
    const cfg = agents.loadConfig([paths.BUILTIN_CONFIG_PATH, configPath]);
    agents.validate(cfg, cfg.agents.map((a) => a.name), Object.keys(cfg.quality.suites), anchor.cwd);
    return { config, envWritten };
  } catch (error) {
    return { config, envWritten, warning: (error as Error).message };
  }
}

/**
 * `piquette init --detect --json` — everything the interview would detect, plus
 * what's already configured, as one JSON document. Writes nothing. `.env` is
 * reported by key NAME only — a value never reaches stdout.
 */
function detectCommand(anchor: paths.RepoAnchor): number {
  const configPath = path.join(anchor.repo_root, ".piquette", "piquette.config.yaml");
  const envPath = path.join(anchor.repo_root, ".env");
  const ctx = gatherContext(anchor.repo_root, readEnvFile(envPath));
  let existing: Record<string, unknown> | null = null;
  let configError: string | undefined;
  if (existsSync(configPath)) {
    try {
      existing = (parse(readFileSync(configPath, "utf-8")) ?? {}) as Record<string, unknown>;
    } catch (error) {
      configError = (error as Error).message;
    }
  }
  const skills = packagedSkills();
  const out = {
    repo_root: anchor.repo_root,
    piquette_dir: anchor.piquette_dir,
    config_path: configPath,
    config_exists: existsSync(configPath),
    // A comments-only file (the non-interactive starter) configures nothing — setup may replace it without --force.
    config_empty: existsSync(configPath) && configIsEmpty(configPath),
    ...(configError ? { config_error: configError } : {}),
    blocks: INTERVIEW_BLOCKS.map((block) => ({
      block,
      label: BLOCK_LABELS[block],
      configured: existing ? blockConfigured(block, existing) : false,
    })),
    context: {
      repo_slug: ctx.repoSlug ?? null,
      current_branch: ctx.currentBranch,
      git_name: ctx.gitName ?? null,
      git_email: ctx.gitEmail ?? null,
      scripts: ctx.scripts,
      claude_on_path: ctx.claudeOnPath,
      opencode_on_path: ctx.opencodeOnPath,
      roster: ctx.rosterNames,
      env_keys_present: [...ctx.existingEnv.keys()].sort(),
      env_example_keys: readEnvExampleKeys(anchor.repo_root),
    },
    templates: listTemplates(),
    ...(existing ? { redundant_overrides: redundantOverrides(existing) } : {}),
    piquette_version: packageVersion(),
    skills: {
      packaged: skills,
      // Per layout: every skill folder found there (packaged or not — a removed skill shows up here and not in `packaged`),
      // with the piquette version that last installed it and any `.new` files from a conflicting upgrade still to merge.
      installed: Object.fromEntries(
        Object.entries(SKILL_LAYOUTS).map(([layout, rel]) => {
          const root = path.join(anchor.repo_root, rel);
          const names = existsSync(root) ? readdirSync(root).filter((n) => n.startsWith("piquette")) : [];
          const state = names.flatMap((name) => {
            const st = installedSkillState(path.join(root, name));
            return st ? [{ name, ...st }] : [];
          });
          return [layout, state];
        }),
      ),
    },
  };
  console.log(JSON.stringify(out, null, 2));
  return 0;
}

/** `--only coding_agent,quality` -> a validated block set, or an error message. */
function parseOnly(raw: string | undefined): Set<InterviewBlock> | string | undefined {
  if (raw === undefined) return undefined;
  const wanted = raw.split(",").map((s) => s.trim()).filter(Boolean);
  const unknown = wanted.filter((w) => !(INTERVIEW_BLOCKS as string[]).includes(w));
  if (unknown.length > 0 || wanted.length === 0) return `--only takes a comma-separated list of: ${INTERVIEW_BLOCKS.join(", ")} (got ${JSON.stringify(raw)})`;
  return new Set(wanted as InterviewBlock[]);
}

/**
 * `piquette init --answers <file|-|{json}> [--only <blocks>] [--accept-defaults] [--dry-run] [--force]`
 *
 * The agent-driven interview: runs the exact same `runInterview` flow through
 * an answers-backed Asker (`../answers_asker.ts`). Always prints one JSON
 * document. Exit codes: 0 written (or dry run complete), 3 a question still
 * needs an answer (nothing written — add `question.key` and re-run), 1 an
 * answer was invalid, the config already exists without --force, or a usage error.
 */
async function answersCommand(
  anchor: paths.RepoAnchor,
  options: Record<string, string>,
  flags: Record<string, boolean>,
  installSkill: () => void,
): Promise<number> {
  const emit = (doc: Record<string, unknown>, code: number): number => {
    console.log(JSON.stringify(doc, null, 2));
    return code;
  };
  const sfDir = path.join(anchor.repo_root, ".piquette");
  const configPath = path.join(sfDir, "piquette.config.yaml");

  const only = parseOnly(options["only"]);
  if (typeof only === "string") return emit({ status: "error", error: only }, 1);
  if (options["template"] || flags["yes"] || flags["partial"]) {
    return emit({ status: "error", error: "--answers can't be combined with --template/--yes/--partial (use --only <blocks> to reconfigure part of an existing config)" }, 1);
  }
  let partial: { only: Set<InterviewBlock>; existing: Record<string, unknown> } | undefined;
  if (only) {
    if (!existsSync(configPath)) return emit({ status: "error", error: `${configPath} does not exist — run a full \`piquette init --answers\` first` }, 1);
    partial = { only, existing: (parse(readFileSync(configPath, "utf-8")) ?? {}) as Record<string, unknown> };
  } else if (existsSync(configPath) && !configIsEmpty(configPath) && !flags["force"] && !flags["dry-run"]) {
    return emit({ status: "error", error: `${configPath} already exists — pass --force to replace it, or --only <blocks> to reconfigure part of it` }, 1);
  }

  let answers: Record<string, AnswerValue>;
  try {
    answers = readAnswers(options["answers"]);
  } catch (error) {
    return emit({ status: "error", error: `could not read --answers: ${(error as Error).message}` }, 1);
  }

  const asker = createAnswersAsker(answers, { acceptDefaults: flags["accept-defaults"] });
  const ctx = gatherContext(anchor.repo_root, readEnvFile(path.join(anchor.repo_root, ".env")));
  let result: InterviewResult | null;
  try {
    result = await quietStdout(() => runInterview(asker, ctx, partial));
  } catch (error) {
    if (error instanceof NeedsAnswer) {
      return emit(
        {
          status: "needs_answer",
          question: error.question,
          answered: asker.answered,
          hint: `ask the user, add "${error.question.key}" to the answers object, and re-run (or pass --accept-defaults to take every default)`,
        },
        3,
      );
    }
    if (error instanceof InvalidAnswer) return emit({ status: "invalid_answer", question: error.question, problem: error.problem }, 1);
    throw error;
  }
  if (!result) return emit({ status: "cancelled", answered: asker.answered }, 1);

  const envNeeded = [...new Map([...result.envExampleKeys.map((key) => [key, { key, set: ctx.existingEnv.has(key) || key in result.env }] as const)]).values()];
  const common = { answered: asker.answered, unused_answers: asker.unused(), env_needed: envNeeded, notes: asker.notes };

  if (flags["dry-run"]) {
    return emit({ status: "dry_run", config_path: configPath, config: finalConfig(result, partial), env_keys: Object.keys(result.env), ...common }, 0);
  }

  const written = await quietStdout(() => {
    mkdirSync(sfDir, { recursive: true });
    scaffoldChains(sfDir);
    const w = writeInterviewResult(anchor, configPath, result, partial);
    installSkill();
    ensureGitignore(anchor.repo_root, GITIGNORE_ENTRIES);
    return w;
  });
  const missingKeys = envNeeded.filter((e) => !e.set).map((e) => e.key);
  const commitFiles = filesToCommit(anchor.repo_root);
  // Ordered: secrets first (doctor can't pass without them), then verify, then the two steps that need the user's go-ahead.
  const nextSteps: Record<string, unknown>[] = [];
  if (missingKeys.length > 0) {
    nextSteps.push({ who: "user", step: `add ${missingKeys.join(", ")} to .env (gitignored) — the user types the values; never through the agent chat`, keys: missingKeys });
  }
  nextSteps.push({ who: "agent", step: "verify the setup; fix what it reports (piquette-doctor skill)", command: "piquette doctor --json" });
  if (written.config["watch"]) {
    nextSteps.push({ who: "agent", step: "seed the tracker labels piquette watch uses — writes to the issue tracker", command: "piquette watch init", confirm_first: true });
  }
  if (commitFiles.length > 0) {
    nextSteps.push({ who: "agent", step: "commit the shared setup so teammates get it (never .env)", files: commitFiles, confirm_first: true });
  }
  return emit(
    {
      status: "written",
      config_path: configPath,
      config: written.config,
      env_keys_written: written.envWritten,
      ...(written.warning ? { validation_warning: written.warning } : {}),
      ...common,
      files_to_commit: commitFiles,
      next_steps: nextSteps,
    },
    0,
  );
}

export async function initCommand(argv: string[]): Promise<number> {
  const { options, flags } = parseCli(
    argv,
    ["cwd", "template", "answers", "only", "skill-agents"],
    ["force", "yes", "no-skills", "partial", "detect", "json", "accept-defaults", "dry-run"],
  );
  const anchor = paths.resolveAnchor(options["cwd"]);

  if (flags["detect"]) return detectCommand(anchor);

  // Idempotent (a no-op once the skills are already up to date, a `.new`
  // sibling rather than an overwrite for a locally-edited file) — safe to
  // call on every `piquette init`, not just the first.
  const installSkill = () => {
    if (flags["no-skills"]) return;
    installSkillCommand([
      ...(options["cwd"] ? ["--cwd", options["cwd"]] : []),
      ...(options["skill-agents"] ? ["--agents", options["skill-agents"]] : []),
    ]);
  };

  if (options["answers"] !== undefined) return answersCommand(anchor, options, flags, installSkill);

  const sfDir = path.join(anchor.repo_root, ".piquette");
  mkdirSync(sfDir, { recursive: true });
  scaffoldChains(sfDir);

  const configPath = path.join(sfDir, "piquette.config.yaml");
  const templateName = options["template"];
  const interactive = !templateName && !flags["yes"] && isInteractive();

  if (flags["partial"]) {
    if (templateName || flags["yes"]) {
      console.error("piquette init --partial is interactive-only — drop --template/--yes (agents: use --answers with --only <blocks>)");
      return 1;
    }
    if (!isInteractive()) {
      console.error("piquette init --partial needs a terminal (it asks which block(s) to reconfigure) — for scripted/agent use, pass --answers <file> --only <blocks>");
      return 1;
    }
    if (!existsSync(configPath)) {
      console.error(`${configPath} does not exist — run \`piquette init\` first`);
      return 1;
    }
  }

  const reportWarning = (warning: string | undefined) => {
    if (warning) console.log(paint("yellow", `warning: ${warning}\nrun \`piquette doctor\` for the full picture.`));
  };

  if (!interactive) {
    if (existsSync(configPath) && !flags["force"]) {
      console.log(`${configPath} already exists — leaving it alone (--force to overwrite)`);
    } else {
      const content = templateName ? loadTemplate(templateName) : STARTER_CONFIG;
      writeFileSync(configPath, content);
      console.log(`wrote ${configPath}${templateName ? ` (from template "${templateName}")` : ""}`);
    }
    installSkill();
  } else {
    // Ink needs raw-mode stdin to drive arrow-key selects and inline
    // validation; `inkAvailable()` is `isInteractive()` plus one extra
    // guard for the (practically never, but cheap to check) case where a
    // TTY-reporting stdin still doesn't expose `setRawMode`. Either way
    // falls back to the original readline asker, never to a hang.
    const asker = inkAvailable() ? (await import("../ui/ink_asker.tsx")).createInkAsker() : createAsker();
    try {
      if (flags["partial"]) {
        // Guarded above: configPath exists, templateName/--yes are unset, and we're on a TTY.
        const existing = (parse(readFileSync(configPath, "utf-8")) ?? {}) as Record<string, unknown>;

        asker.heading("Reconfigure which block(s)?");
        const only = new Set<InterviewBlock>();
        for (const block of INTERVIEW_BLOCKS) {
          const configured = blockConfigured(block, existing);
          const want = await asker.confirm(`${BLOCK_LABELS[block]} — ${configured ? "currently configured" : "not set"}. Reconfigure?`, configured);
          if (want) only.add(block);
        }
        if (only.size === 0) {
          console.log("nothing selected — config unchanged");
          asker.close();
          installSkill();
          ensureGitignore(anchor.repo_root, GITIGNORE_ENTRIES);
          return 0;
        }

        const envPath = path.join(anchor.repo_root, ".env");
        const ctx = gatherContext(anchor.repo_root, readEnvFile(envPath));
        const result = await runInterview(asker, ctx, { only, existing });
        asker.close();
        if (!result) {
          console.log("init --partial cancelled — nothing written");
          return 1;
        }
        reportWarning(writeInterviewResult(anchor, configPath, result, { only, existing }).warning);
        installSkill();
        // Falls through to the shared trailer below (gitignore, template list, next-steps) —
        // same as the full-interview success path just below, so --partial prints it too.
      } else {
        if (existsSync(configPath) && !configIsEmpty(configPath) && !flags["force"]) {
          const overwrite = await asker.confirm(`${configPath} already exists — overwrite it?`, false);
          if (!overwrite) {
            console.log("leaving the existing config alone (--force to skip this prompt)");
            asker.close();
            installSkill();
            ensureGitignore(anchor.repo_root, GITIGNORE_ENTRIES);
            return 0;
          }
        }

        const envPath = path.join(anchor.repo_root, ".env");
        const ctx = gatherContext(anchor.repo_root, readEnvFile(envPath));
        const result = await runInterview(asker, ctx);
        asker.close();
        if (!result) {
          console.log("init cancelled — nothing written");
          return 1;
        }
        reportWarning(writeInterviewResult(anchor, configPath, result).warning);
        installSkill();
      }
    } catch (error) {
      asker.close();
      if (error instanceof InterviewAborted) {
        console.log("\ninit interrupted — nothing written");
        return 130;
      }
      throw error;
    }
  }

  ensureGitignore(anchor.repo_root, GITIGNORE_ENTRIES);
  const templates = listTemplates();
  if (templates.length > 0) {
    console.log(`templates available via --template: ${templates.join(", ")}`);
  }
  const commitFiles = filesToCommit(anchor.repo_root);
  if (commitFiles.length > 0) console.log(`\ncommit for your team (never .env): ${commitFiles.join(" ")}`);
  console.log(`\nnext: piquette doctor   (confirm everything resolves), then piquette scout "describe this repo"`);
  // No terminal means no interview ran: an agent that reached for a bare `piquette init` got only the starter/template.
  // Point it at the setup skill, which detects what's there and either finishes setup or hands off to piquette-configure.
  if (!interactive) console.log(`agents: to finish setup, run \`piquette skill show piquette-setup\` (no setup interview ran here)`);
  console.log(
    paint(
      "yellow",
      `warning: piquette ui reads .piquette/data/piquette.db, which doesn't exist until a run creates it — run piquette scout (or any chain) at least once before piquette ui.`,
    ),
  );
  return 0;
}
