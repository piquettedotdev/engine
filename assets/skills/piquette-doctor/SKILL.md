---
name: piquette-doctor
description: Diagnose and fix a broken or misbehaving PIQUETTE setup using `piquette doctor --json` — missing keys, bad models, unconfigured quality suites, broken repo chains, watch/tracker problems. Use when a piquette command failed or did nothing, before running a chain on an unfamiliar repo, after any config change, or when the user asks "why isn't piquette working".
---

# PIQUETTE doctor

```bash
piquette doctor --json            # add --no-probe to skip network probes
```

Exit 0 means clean, and exit 1 means at least one check failed. Each check
looks like this:

```json
{ "name": "agent \"builder\" model", "id": "agent_model", "ok": false,
  "detail": "…", "fix": "…", "block": "coding_agent" }
```

- `id` is stable for that *kind* of check, so key on `id`, not on `name`.
- `fix` and `block` appear only on failing checks or checks with
  `severity: "warn"`. `info` checks are context, not problems.

## Fixing

Work through failing checks first, then warnings. Use this order, because
earlier fixes often clear later checks:

1. `config_parses`: nothing else is meaningful until this passes. Fix the
   YAML or schema error named in `detail`.
2. `roster_validate`, `quality_suite`, `chain_owners`, `chain_suites`.
3. Everything else.

For each check:

- **Has `block`.** Re-ask that block with the **piquette-configure** skill
  (`piquette init --only <block> --answers …`). Prefer this over
  hand-editing, because the interview applies the coupled changes (for
  example, model pins on planner/reviewer/documenter).
- **Missing env var** (`provider_key`, `watch_credentials`,
  `notifications_channel`, `receipt_store`, `env_file`). The user adds the
  key to `.env` (or the machine-wide `~/.piquette/env`) themselves. Name the exact variable from `detail`. Never ask
  for its value in chat, and never write it.
- **Otherwise.** Follow `fix`. For config fields, look the key up in
  `../piquette/references/config.md` and edit only that key in
  `.piquette/piquette.config.yaml`.
- **No `fix`.** Read `detail` and report it to the user. Don't guess a
  remedy.

After each round of fixes, re-run `piquette doctor --json`. You're done when
`ok` is `true`, or when the only failing checks are ones the user has to
resolve (a key in `.env`, a tool to install, a protected branch). List
those for the user plainly.

## Don'ts

- Don't guess at `piquette.db`'s schema to debug a run. Use
  `piquette sessions` / `phases` / `events --json`.
- Don't run `piquette watch init`, `cloud deploy`, or `cloud
  provision-factory` as a "fix" without the user's go-ahead. They change
  outside systems.
- `branch_guard` failing on `main` is expected when a chain commits. Switch
  to a branch rather than loosening the guard.
