# START.md — set up piquette in this repo (written for an AI agent)

You are an AI coding agent. The human pasted this file to have you install
**piquette** (Piquette, `@piquette/engine`), configure it for their repo,
and do the first real runs. piquette is a global CLI that runs repeatable
agents-plus-code chains (plan, build, test, commit...) against a repo: TypeScript
owns the sequencing and gates, coding agents are bounded steps inside it.

Rules for you:

- **piquette carries its own instructions.** After installing it (section 1),
  read them from the CLI, with nothing installed in this repo yet:
  `piquette skill show piquette-setup` (and `piquette skill list` for the
  rest). The skills are authoritative. Where this file and a skill differ,
  follow the skill.
- Do the sections in order. Each ends with a **Gate**. Run the gate command and
  read the output; do not continue on a failure and do not assume success.
- Never invent a flag. If unsure, run `piquette --help` or `piquette list`.
- **Secrets never pass through you.** API keys and tokens go in `.env` at the
  repo root (gitignored, auto-loaded by every piquette command), and the human
  types them there. Never ask for a value in chat, never write one yourself.
  `piquette init --answers` rejects secrets outright, and `piquette doctor`
  confirms a key is present without reading it.
- Ask the human before anything that costs money (real chain runs) or touches
  a remote (`piquette watch init`, `piquette watch`, a commit or push).

Canonical docs, for reference: the README and `assets/` in the installed
package (`$(npm root -g)/@piquette/engine/`), or
https://github.com/piquette-ai/engine. Every skill file is also readable with
`piquette skill show <skill> --file <path>`, for example
`piquette skill show piquette --file references/config.md`.

---

## 1. Install and verify

Requires Node >= 22.19.0 and a git repository (run everything from the repo root).

```bash
node --version                 # must be >= 22.19.0
npm i -g @piquette/engine
piquette version                    # prints the installed version
piquette doctor                     # checks everything that otherwise fails silently
```

`piquette doctor` prints one line per check: `✓` ok, `ℹ` informational, `⚠`
warning, `✗` hard failure, and exits non-zero if any line is `✗`. It works
with zero config. Fix every `✗`; read each `⚠`. What the common lines mean:

| Line | Meaning and fix |
|---|---|
| `node version` fails | Upgrade Node to >= 22.19.0. |
| `git repository: no` | `git init`, or `cd` to the repo root. |
| `.piquette/ not gitignored: WARNING` | `.gitignore` ignores `.piquette/` itself, which defeats `protected_files`. Ignore `.piquette/data/` instead. (`good` is the expected value.) |
| `agent "<name>" provider key: none of ... is set` | The agent's model provider needs a key in `.env`. **Expected on a fresh repo:** the packaged roster runs on flue with Fireworks, Gemini, and OpenAI models, so you will see these until section 2 picks the human's own models. For `claude_code` agents this line is always `✓`; `ANTHROPIC_API_KEY` is optional if the human ran `claude login`. |
| `claude CLI` / `opencode CLI` not found on PATH | Only shown when an agent uses that backend. Install the CLI, or pick another backend in section 2. |
| `opencode auth` | Informational. Have the human run `opencode auth login` if it reports nothing configured. |
| `quality check "<x>"`: NOT found on PATH | A configured lint/test command's binary is missing. Install it or fix the check's `argv`. |
| `quality suite "<x>"`: names unknown check(s) | A suite lists a check name that `quality.checks` does not define. |
| `protected_files pattern ... matches nothing` | Informational on a clean tree. |
| `GITHUB_TOKEN`, `JIRA_EMAIL / JIRA_API_TOKEN`, `BITBUCKET_EMAIL / BITBUCKET_API_TOKEN` | Only shown once a `watch:` block is configured, and then required. Put them in `.env`. |
| `config parses` / `roster + suites validate` fails | The config is invalid; the line names the field. Fix it in `.piquette/piquette.config.yaml`. |

Use `piquette doctor --json` if you want to parse results.

**Gate:** `node version`, `git repository`, `config parses`, and
`roster + suites validate` are all `✓`. Provider-key `✗` lines are expected
at this point (see the table); section 2 clears them.

---

## 2. Set up the repo (the piquette-setup skill)

```bash
piquette skill show piquette-setup
```

Follow it. In short:

1. `piquette init --detect` shows the repo and what's already configured.
2. Run the interview as a loop: `piquette init --answers '<json>'` returns
   the next question (exit 3) until every answer is in, then writes
   `.piquette/piquette.config.yaml` and installs the skills into
   `.claude/skills/` and `.agents/skills/`.
3. Work through the result's `next_steps`:
   - the human adds the `.env` keys it names
   - you run `piquette doctor --json`
   - `piquette watch init` if watch is on (confirm first)
   - commit `files_to_commit` (confirm first, never `.env`)

Don't hand-write the config, and don't run a bare `piquette init` to "get
started". Without a terminal it writes an empty, comments-only starter.
`--answers` replaces that starter without `--force`, if one is already
there.

**Gate:** `piquette doctor --json` reports `"ok": true`, or every remaining
failing check is something only the human can resolve (a key in `.env`, a
tool to install). If so, list those for the human plainly.

---

## 3. First runs

Always from the repo root. Each run prints an `adw_id` (the run/session id).

```bash
# 3a. Zero risk: read-only recon, changes nothing.
piquette scout "describe this repo: layout, entry points, how tests are run"

# 3b. See the chains and pick by the shape of the work.
piquette list
```

Pick a chain by work-shape (`piquette list` is authoritative):

| Work | Chain |
|---|---|
| Recon, no changes | `scout` |
| Want the spec before any code | `plan` |
| Small, well-understood change | `plan-build` |
| There is a test suite to satisfy | `build-test` |
| The standard choice | `plan-build-test` |
| Also gate on lint/typecheck/build | `plan-build-test-quality` |
| "Is this what was asked for" matters | `build-review` |
| Real work, unclear shape | `simple-sdlc` |

`simple-sdlc` has a human sign-off before its build commit. Your shell is
usually not a TTY, so nobody gets asked: by default it commits on the AI
reviewer's verdict alone (with a warning), and with
`review.require_human_signoff: true` it fails closed instead. Tell the human
which one applies before you run it.

```bash
# 3c. Optional: projected model routing and cost from past runs (read-only;
#     exits 3 when there is no history yet, which is normal on a fresh repo).
piquette estimate plan-build-test "add a /health endpoint"

# 3d. A real run. Ask the human for a small, low-stakes task first.
#     Chains commit on the CURRENT branch, so branch off first.
git switch -c piquette/first-run
piquette plan-build-test "add a /health endpoint that returns 200 and {status: 'ok'}"
```

Chain options: `--cwd <dir>`, `--agent <name>`, `--base <ref>`, `--issue <id>`,
`--priority p0|p1|p2|p3`, `--suite <name>` (only on chains `piquette list` marks
"--suite overrides"), `--adw-id <id>` (join an existing session; agents
resume their context). Cost guards: `defaults.max_run_cost` /
`defaults.max_run_tokens` in the config.

### Read the run back

```bash
piquette sessions                  # recent runs
piquette phases <adw_id>           # the run's phases and each outcome
piquette events <adw_id>           # trace events (add --follow to tail a live run)
piquette ui                        # browser trace visualizer (loopback only)
piquette abort <adw_id>            # stop a run that is going wrong
```

`sessions`, `phases`, and `events` accept `--json`. piquette never merges anything:
review the result (`git log`, `git diff`) and tell the human what changed.

**Gate:** `piquette phases <adw_id>` shows every phase finished successfully and the
quality suite passed. If a phase failed, read `piquette events <adw_id>`, fix the
cause (usually config, a missing key, or an unclear prompt), and rerun; do not
paper over it.

---

## 4. Build things

Pointers only. Read the canonical doc before changing anything non-trivial.

- **Repo-local chains.** Drop a YAML file in `.piquette/chains/*.yaml` to compose your
  own chain from the same step factories (agents, quality-suite steps, git
  commit, external CLIs). It then appears in `piquette list` and runs as
  `piquette <name> "<prompt>"`. `piquette init` scaffolds two fully commented-out
  examples, `.piquette/chains/example.yaml` and `.piquette/chains/review-fix.yaml`.
  See `assets/skills/piquette-author/cookbooks/authoring_chains.md`.
- **Roster and prompt overrides.** Each agent in the roster has a model, tools,
  and write permissions (patch them under `agents:` by `name`), and a
  system/user prompt pair that a repo overrides by placing files under
  `.piquette/prompt_engineering/<agent>/` (start from the packaged ones in
  `assets/prompts/<agent>/`). `piquette eject` copies the compiled engine out for
  reading; it has no config surface and is not how you customize. See
  `assets/skills/piquette-author/cookbooks/roster.md` and `assets/skills/piquette/references/config.md`.
- **Templates.** `piquette init --template <name>` seeds a filled-in config for common
  setups (Claude Code, opencode, flue with Ollama/OpenRouter/Cloudflare). Browse
  `assets/templates/` for the exact files.
- **Watch.** `piquette watch` polls the tracker for `piquette:ready` issues, runs
  `watch.chain` on each in its own worktree, opens a PR, and tracks it to
  done/blocked. Start with `piquette watch --dry-run --once`. Set
  `watch.allowed_authors` before pointing it at a repo that takes outside
  issues. See the README's "piquette watch" section and `config.md`.
- **Also worth knowing.** `piquette fanout <chain> "<prompt>" --n 3` (best-of-N; you
  merge the winner), `piquette loop <chain> "<goal>" --until-suite <name> --max N`
  (repeat until a suite passes), `piquette migrate` (old `adws/` tree to `.piquette/`).

Run `piquette --help` for the full command list.
