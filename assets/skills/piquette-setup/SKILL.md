---
name: piquette-setup
description: Set up PIQUETTE in a repo for the first time — detect the repo, interview the user through `piquette init --answers`, have them fill secrets in .env, and finish with a clean `piquette doctor`. Use when the user wants to install, initialize, onboard or bootstrap piquette in a repository, or when `.piquette/piquette.config.yaml` doesn't exist yet.
---

# PIQUETTE setup

You may be reading this through `piquette skill show piquette-setup`, before
any skill is installed in the repo. That's expected: setup installs them.
Read other skills the same way (`piquette skill show piquette-doctor`).

You run piquette's own setup interview on the user's behalf. The CLI holds
every rule (which models pair with which backend, which launch commands
work, which follow-up questions apply), so **never hand-write
`.piquette/piquette.config.yaml` during setup** — drive `piquette init
--answers` and let it write the file.

## Secrets rule (non-negotiable)

Never ask the user to paste an API key, token, or webhook URL into the chat,
and never write one yourself. `--answers` rejects secrets outright. When a
run reports `env_needed` entries with `"set": false`, tell the user the
exact key names and ask them to add them to `.env` (gitignored) themselves,
then confirm with `piquette doctor --json`. Doctor checks that a key is
present, never what it is.

## 1. Detect

```bash
piquette init --detect
```

Read-only JSON: repo slug, branch, package scripts, whether `claude`/
`opencode` are on PATH, which `.env` keys exist (names only), which config
blocks are already configured, templates, installed skills.

- `config_exists: false`, or `config_empty: true` (a comments-only starter
  file, e.g. from a plain `piquette init`) → first-time setup. Carry on, and
  `--answers` replaces the empty file without `--force`.
- `config_exists: true` and `config_empty: false` → this is not a first-time
  setup. Switch to the **piquette-configure** skill instead.
- Don't run a bare `piquette init` to "get started". Without a terminal it
  writes that empty starter file and nothing else.
- Use `context.scripts` to suggest quality check commands, and
  `context.repo_slug` for the watch repo.
- The watch questions include two opt-in, default-no ones:
  `watch.resume_from_wip` (a blocked issue relabelled ready resumes from
  its preserved `-wip-<sha>` branch instead of starting over) and, only if
  that is yes, `watch.resume_at_failed_phase` (also skip phases that already
  finished). Don't turn them on unless the user wants resume behavior; they
  change what a reclaimed issue starts from.

## 2. Interview loop

Keep an answers object, starting with `{}`. Repeat:

```bash
piquette init --answers '<json>'
```

| exit | `status` | what to do |
|---|---|---|
| 3 | `needs_answer` | Ask the user `question.label` (show `choices` for a select, mention `default`, include `question.context` — the notes a human would have read). Add `question.key: <answer>` and re-run. |
| 1 | `invalid_answer` | Tell the user `problem`, ask again, replace that key. |
| 0 | `written` | Done — go to step 3. |

Batch where it's obvious: if you already know an answer (e.g. the detected
repo slug), propose it and let the user confirm in one message rather than
one question per turn. If the user says "just use the defaults", add
`--accept-defaults` — every question with a default takes it, and you only
get asked for the ones without. `--dry-run` shows the config that would be
written without writing anything; use it to show the user before the real
run if they want to review.

Answer types: `select` → one of the `choices[].value` strings; `confirm` →
`true`/`false`; `text` → a string. A `secret` question never appears — it
is recorded in `env_needed` instead.

`unused_answers` in the result lists keys no question matched — usually an
answer for a branch the user didn't take. Harmless, but check for typos.

## 3. Follow `next_steps`

A `written` result carries `next_steps`, already in order. Work through them:

| `who` | what you do |
|---|---|
| `user` | Tell the user exactly which `keys` to add to `.env` (gitignored), and where to get each one if a `notes` line said so. They type the values themselves, never into the chat. Wait until they say it's done. |
| `agent` | Run `command`. If the step has `confirm_first: true`, ask the user before running it. |

The steps, in the order they appear:

1. **Secrets** (only if any are missing).
2. **`piquette doctor --json`.** Hand anything failing to the
   **piquette-doctor** skill. Done when `ok` is `true`, or only user-owned
   items remain.
3. **`piquette watch init`** (only if watch was enabled). It writes labels
   to the issue tracker, so confirm first.
4. **Commit the shared setup.** `files` lists exactly what to stage. Never
   stage `.env`. Confirm first, then commit on a branch if the repo's
   conventions want one. This step is what turns the next engineer's setup
   into "install the CLI, fill `.env`, run doctor".

## 4. Hand-off

Tell the user briefly:
- what was configured: backend and model, quality suites, watch on or off
- that `piquette list` shows the chains they can run now
- that a cheap first run is `piquette scout "describe this repo"`

The skills are now installed in `.claude/skills/` and `.agents/skills/`.
Teammates' agents pick them up from the commit.
