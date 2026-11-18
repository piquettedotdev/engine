---
name: piquette-author
description: Extend PIQUETTE in a repo — write or change a repo-local chain (.piquette/chains/*.yaml), add or retune an agent in the roster (model, tools, writes, backend), or write a proof script for work receipts and journeys can't verify on their own (e.g. a UI change). Use when the user wants a new chain or step order, a new or different agent, or a way to prove a change for real.
---

# PIQUETTE authoring

This skill changes what piquette *is* in this repo. The **piquette** skill
*runs* it. Keep the two separate. While authoring, don't launch chains to
"try them out" against real work until the chain validates.

## Route the request

| Request | Cookbook | Writes to |
|---|---|---|
| a new chain, a different step order, a fix loop, `route_when` for watch | `cookbooks/authoring_chains.md` (start at "Repo-local chains") | `.piquette/chains/<name>.yaml` |
| change an agent's model, thinking, tools, `writes`, backend; add an agent | `cookbooks/roster.md` | `agents:` in `.piquette/piquette.config.yaml` |
| prove a change receipts/journeys can't (UI, rendered behavior) | `cookbooks/authoring_proof_scripts.md` | a script the user owns, usually under `protected_files` |
| a new gate, output type, or step factory | `cookbooks/authoring_chains.md` § "Adding an engine primitive" | the piquette package's `src/`. That's a fork, so say so before starting. |

Changing only the *default* model or backend for every agent is a config
change, not authoring. Hand it to **piquette-configure**
(`piquette init --only coding_agent --answers …`).

## Rules

- **Compose, don't fork.** A repo chain names existing step factories with
  params and never imports repo code. If the shape truly can't be expressed
  that way, report it and stop. Don't hand-roll a workaround.
- **One agent, one prompt, one purpose.** A roster entry is who an agent
  is. Output types and per-call prompts live at the call site.
- **Overrides are partial.** In `agents:`, list only `name` plus the fields
  that change. Everything else merges from the packaged roster.
- **`writes` is the real boundary.** Narrow it when adding an agent. Don't
  widen `protected_files` exemptions to make an agent's job easier.
- **Proof scripts are a human task.** They usually live under
  `protected_files`, so agents can't edit them during a run. Draft one with
  the user and have them review it. Never weaken protection to land it.
- **Secrets** go in `.env`, written by the user. An agent's `env_allowlist`
  names keys and never holds values.

## Validate before you call it done

Run these after every change, and fix what they report before moving on:

```bash
piquette list --json      # the chain is in `chains`; nothing for its file in `problems`
piquette doctor --json    # owners/suites resolve; agent models, tools, keys check out
```

- A chain file that fails to load shows up in `list --json`'s `problems`
  and as doctor's `repo_chain_load`. It is silently absent from `chains`,
  so check `problems` every time.
- `chain_owners` / `chain_suites` failing means the chain names an agent or
  quality suite that isn't configured. Add it (roster here, suites via
  **piquette-configure**'s `quality` block) or change the chain.
- `agent_model` / `agent_tool` / `provider_key` point at the roster entry
  you just touched.

Then do one cheap, real run if the user agrees, for example `piquette
<chain> "…"` on a trivial prompt. Read the result with `piquette phases
<adw_id> --json`, not by guessing at the trace db.

Each cookbook ends with its own "Before you finish" checklist. Run that
too.
