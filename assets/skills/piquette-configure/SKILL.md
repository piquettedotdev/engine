---
name: piquette-configure
description: Change an existing PIQUETTE config — switch the coding agent/backend or model, add or change quality checks and suites, turn on receipts, set up or retune `piquette watch`, notifications, or advanced settings. Use when `.piquette/piquette.config.yaml` already exists and the user wants part of it changed.
---

# PIQUETTE configure

The config is split into blocks, and each block is re-asked on its own. The
CLI keeps every other block exactly as it was.

| block | owns |
|---|---|
| `coding_agent` | `defaults.coding_agent`, `defaults.model`, `agents:` model pins, `env:` launch commands, auth |
| `quality` | `quality.checks`, `quality.suites` |
| `receipts` | `receipts:` (store, viewer URL) |
| `watch` | `watch:` (tracker, code host, repo, labels, chain, refine lane) |
| `notifications` | `notifications:` (Slack / Teams / webhook) |
| `advanced` | thinking level, data_dir, protected_files, poll/timeouts, `observability:` |

## Secrets rule (non-negotiable)

Never take an API key, token, or webhook URL through the chat, and never
write one. `--answers` rejects them. For `env_needed` entries with
`"set": false`, tell the user the key names to add to `.env` themselves,
then verify with `piquette doctor --json`.

## Flow

1. `piquette init --detect`. Its `blocks[].configured` shows what exists,
   and `config_exists` must be `true` (otherwise use **piquette-setup**).
2. Map the request to block(s). "Use opus" → `coding_agent`. "Add a lint
   check" → `quality`. "Run issues from Jira" → `watch`.
3. Run the interview loop for just those blocks:

   ```bash
   piquette init --only quality --answers '<json>'
   ```

   It works the same way as setup. Exit 3 / `needs_answer`: ask
   `question.label`, add `question.key`, and re-run. Exit 1 /
   `invalid_answer`: re-ask. Exit 0 / `written`: done. `--dry-run` previews
   the merged config, and `--accept-defaults` keeps every default.
   Re-asking a block **replaces** that block. Where a question's `default`
   is the current value, keeping it means keeping what's there.
4. Report `validation_warning` if present, handle `env_needed`, then run
   `piquette doctor --json`.

## When to hand-edit instead

The interview doesn't cover everything: per-agent `tools:`/`writes:`,
`tiering:`, `sandbox:`, `decisions:`, `cloud:`/`sync:`, custom chains. For
those, edit `.piquette/piquette.config.yaml` directly, using
`../piquette/references/config.md` (field reference) and
`../piquette-author/cookbooks/roster.md` (agents). Only write what changes. The
file is merged over packaged defaults. After every hand edit, run
`piquette doctor --json` and fix what it reports before you say you're done.

`sync:` and `cloud:` credentials belong in the machine config
(`$PIQUETTE_CONFIG_HOME/piquette.config.yaml`), never the repo. Doctor's
`sync` check flags it if they land in the wrong place.
