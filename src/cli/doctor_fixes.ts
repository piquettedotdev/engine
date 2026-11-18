/**
 * Stable ids and remediation hints for `piquette doctor`'s checks.
 *
 * Doctor's check NAMES are human labels, and many are interpolated (`agent
 * "builder" model`, `quality suite "test"`), so an agent can't key a fix on
 * them. This maps each name to a stable `id` (the same for every instance of
 * that kind of check), a one-line `fix`, and — where re-asking part of the
 * interview is the fix — the `piquette init --answers --only <block>` block
 * that owns it. Ordered: the first matching rule wins, so specific patterns
 * sit above general ones. An unmatched name still gets an id (its slug) and
 * no fix — never a guessed one.
 */
import type { InterviewBlock } from "./interview.ts";

export interface CheckFix {
  id: string;
  fix?: string;
  block?: InterviewBlock;
}

interface Rule {
  id: string;
  match: RegExp;
  fix: string;
  block?: InterviewBlock;
}

const RULES: Rule[] = [
  // ── repo + config ─────────────────────────────────────────────────────────
  { id: "git_repository", match: /^git repository$/, fix: "run piquette inside a git repository (`git init`, or pass --cwd <repo>) — commit phases and change capture need one" },
  { id: "piquette_dir_gitignored", match: /^\.piquette\/ not gitignored$/, fix: "ignore only .piquette/data/ and .piquette/engine/, never .piquette/ itself — `piquette init` writes the right .gitignore entries" },
  { id: "machine_config", match: /^machine config$/, fix: "PIQUETTE_CONFIG_HOME points at a directory with no piquette.config.yaml — create one there or unset the variable" },
  { id: "config_parses", match: /^config parses$/, fix: "fix the YAML/schema error named in detail in .piquette/piquette.config.yaml (references/config.md has every field), then re-run doctor" },
  { id: "decisions_config", match: /^decisions config$|^decisions\./, fix: "rename the jev: block to decisions: — see docs/decisions.md, \"Migrating from jev:\"" },
  { id: "roster_validate", match: /^roster \+ suites validate$/, fix: "the roster or a quality suite is inconsistent — fix the agent/suite named in detail; for suites, `piquette init --answers … --only quality`", block: "quality" },
  { id: "branch_guard", match: /^branch guard$/, fix: "pass a chain name from `piquette list --json`, or switch off a protected branch before running a committing chain" },
  { id: "protected_files_pattern", match: /^protected_files pattern /, fix: "informational — a protected_files glob that matches nothing may be a typo (defaults.protected_files)", block: "advanced" },
  { id: "env_file", match: /^\.env(\.example)?$/, fix: "the user creates .env with the keys .env.example lists — never paste secret values into an agent chat" },

  // ── coding agents + providers ──────────────────────────────────────────────
  { id: "claude_cli", match: /^claude CLI$/, fix: "install Claude Code (`claude` on PATH) or set PIQUETTE_CLAUDE_CMD to its launch command", block: "coding_agent" },
  { id: "claude_cmd_ollama", match: /^PIQUETTE_CLAUDE_CMD ollama launch wrapper$/, fix: "the ollama launcher must be exactly `ollama launch claude --model {model}` — re-pick it in the coding agent block", block: "coding_agent" },
  { id: "anthropic_base_url", match: /^ANTHROPIC_BASE_URL (shape|reachability)$/, fix: "ANTHROPIC_BASE_URL should be the server root (no trailing /v1) and reachable from this machine", block: "coding_agent" },
  { id: "opencode_cli", match: /^opencode CLI$/, fix: "install opencode (`npm install -g opencode-ai`) or set PIQUETTE_OPENCODE_CMD", block: "coding_agent" },
  { id: "opencode_auth", match: /^opencode auth$/, fix: "the user runs `opencode auth login` (or sets the provider's own API key env var in .env)" },
  { id: "ollama_reachability", match: /^OLLAMA_BASE_URL reachability$/, fix: "start Ollama (`ollama serve`) or fix OLLAMA_BASE_URL in .env" },
  { id: "cloudflare_workers_ai", match: /^Cloudflare Workers AI (endpoint|reachability)$/, fix: "set CLOUDFLARE_ACCOUNT_ID (or CLOUDFLARE_AI_BASE_URL) and the Workers AI token in .env", block: "coding_agent" },
  { id: "provider_key", match: / provider key$/, fix: "the user adds one of the env vars named in detail to .env (doctor only checks it is set, never its value)" },
  { id: "agent_model", match: / model$/, fix: "use a model id this agent's backend understands (claude_code: sonnet/opus/haiku or a full id; flue/opencode: provider/model-id)", block: "coding_agent" },
  { id: "agent_tool", match: / tool "/, fix: "remove or rename the unknown tool in that agent's tools: list (roster.md lists the valid names)" },
  { id: "vllm_cache_details", match: /^vLLM cache-details support$/, fix: "informational — cache-read token accounting is unavailable from this server" },
  { id: "tiering", match: /^tiering /, fix: "check the tiering: ladder in config — every tier's model must be served and every role must name a tier (references/config.md, tiering)" },

  // ── quality + chains ───────────────────────────────────────────────────────
  { id: "quality_check_binary", match: /^quality check "/, fix: "the check's argv[0] isn't on PATH — install it or change the check's command", block: "quality" },
  { id: "quality_suite", match: /^quality suite "/, fix: "make every name in the suite match a quality.checks entry", block: "quality" },
  { id: "repo_chain_load", match: /^repo chain \.piquette|^repo chain [^"]/, fix: "fix the .piquette/chains/*.yaml file named here (authoring_chains.md) — or delete it if it's an abandoned draft" },
  { id: "chain_owners", match: / owners$/, fix: "the chain names an agent that isn't in the roster — add it (roster.md) or change the chain's owner" },
  { id: "chain_suites", match: / suites$/, fix: "add the missing suite under quality.suites, naming configured checks", block: "quality" },

  // ── receipts, data, observability ──────────────────────────────────────────
  { id: "receipt_store", match: /^receipt store/, fix: "check receipts.store; for s3/r2 the user puts the access key env vars in .env", block: "receipts" },
  { id: "receipt_recorder_tools", match: /^receipt recorder tools$/, fix: "install the recorder tools named in detail, or turn off receipt recording", block: "receipts" },
  { id: "d1_trace_db", match: /^D1 trace db /, fix: "set the D1 database id and the Cloudflare credentials it names, or switch observability.db back to local sqlite", block: "advanced" },
  { id: "otel", match: /^observability\.otel/, fix: "fix observability.otel's endpoint/headers, or remove the block", block: "advanced" },

  // ── sync + cloud ───────────────────────────────────────────────────────────
  { id: "sync", match: /^sync( |$)/, fix: "sync endpoint, credentials and factory name belong in the machine config (PIQUETTE_CONFIG_HOME), not the repo — see docs/sync.md" },
  { id: "cloud", match: /^cloud( |$)/, fix: "run `piquette cloud status --json` for the deployed app's own checks (docs/cloud.md)" },

  // ── sandbox ───────────────────────────────────────────────────────────────
  { id: "opensandbox", match: /^opensandbox /, fix: "install/start the OpenSandbox control plane or switch sandbox.backend (references/config.md, sandbox)" },
  { id: "sandbox", match: /^sandbox|^\[docker\]|^cloudflare (config|bridge)| sandbox | credential grant$| coding_agent x sandbox$/, fix: "see references/config.md's sandbox section for this field; detail names the exact key" },

  // ── watch ─────────────────────────────────────────────────────────────────
  { id: "watch_credentials", match: /^(GITHUB_TOKEN|JIRA_EMAIL \/ JIRA_API_TOKEN|BITBUCKET_EMAIL \/ BITBUCKET_API_TOKEN)$/, fix: "the user adds the token(s) named here to .env — never through chat" },
  { id: "watch_fanout", match: /^watch\.fanout/, fix: "adjust watch.fanout (n, budget, sandbox) per detail — references/config.md, piquette fanout", block: "watch" },
  { id: "watch_refine", match: /^watch\.refine/, fix: "fix watch.refine per detail, or disable the refine lane", block: "watch" },
  { id: "watch_chain", match: /^watch\.chain|^watch\.route_when|^chain router /, fix: "point watch.chain(s) at a chain from `piquette list --json` whose suites/agents are configured", block: "watch" },
  { id: "watch", match: /^watch\./, fix: "fix the watch field named here; labels missing on the tracker are seeded by `piquette watch init`", block: "watch" },

  // ── notifications ─────────────────────────────────────────────────────────
  { id: "notifications_channel", match: /^notifications: /, fix: "the user puts the channel's webhook URL env var (named in detail) in .env", block: "notifications" },
  { id: "notifications", match: /^notifications\./, fix: "configure at least one channel for the events selected, or set events to none", block: "notifications" },
];

function slug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

export function classifyCheck(name: string): CheckFix {
  const rule = RULES.find((r) => r.match.test(name));
  if (!rule) return { id: slug(name) };
  return { id: rule.id, fix: rule.fix, ...(rule.block ? { block: rule.block } : {}) };
}
