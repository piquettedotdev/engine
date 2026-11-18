---
name: piquette-maintain
description: Keep a repo's PIQUETTE setup current — after upgrading the piquette CLI, re-sync the installed skills and merge any `.new` files, migrate an old stamped `adws/` tree, prune config overrides that now just repeat the defaults, and clear deprecations. Use when the user upgraded piquette, asks to "update/upgrade/tidy/maintain piquette" in a repo, or detect output shows stale skills or pending `.new` files.
---

# PIQUETTE maintain

A maintenance pass is read first, change second. Gather the facts, show the
user what you'd change, then change it.

## 1. Gather

```bash
piquette version --json          # the CLI that's installed now
piquette init --detect           # what this repo has
piquette migrate --json          # dry run, writes nothing
```

From `--detect`, look at:

- `piquette_version` vs. each `skills.installed.<layout>[].version`. Older
  means the skills are behind the CLI.
- `skills.installed.<layout>[].pending_new`: `.new` files left by an
  earlier conflicting upgrade. They're still unmerged.
- A skill under `installed` that isn't in `skills.packaged` is no longer
  shipped. `install-skill` deletes unedited stale files on its own. An
  edited one stays, and the user decides.
- `redundant_overrides`: config paths whose value already equals the
  packaged default. They do nothing today, and they silently pin the old
  value when a future release changes the default.
- `config_exists: false` → nothing to maintain. Hand off to
  **piquette-setup**.

From `migrate --json`: `needed: true` means an old `adws/` tree is present.

## 2. Re-sync skills

```bash
piquette install-skill --json
```

It's safe to run any time:
- Unedited files upgrade in place.
- Edited files are never overwritten. The new version lands beside them as
  `<file>.new` and is listed in `conflicts`.

For each conflict, and each older `pending_new`:

1. Diff `<file>` against `<file>.new`.
2. If the local edit is still wanted, carry it onto the new version. If
   it's obsolete, take `.new` as-is. If it's unclear, ask the user.
3. Write the merged result to `<file>` and delete `<file>.new`.

Re-run `install-skill --json`. A merged file is now treated as locally
edited, so it reports no new conflicts until the next release changes it.
That's expected.

Use `--force` only if the user explicitly wants every local skill edit
thrown away.

## 3. Migrate (only if `needed: true`)

Show the user the `actions` list from the dry run. On their go-ahead:

```bash
piquette migrate --apply --json
```

It copies and never deletes `adws/`. Custom `adw_*.ts` chains and edited
`adw_modules/` code don't migrate automatically. Re-express them as repo
chains with the **piquette-author** skill, or point the user at `piquette
eject`. Removing the old `adws/` tree is the user's call, made after they've
verified the migration. Don't delete it for them.

## 4. Tidy the config

- **Redundant overrides.** List them for the user and remove the ones they
  agree to from `.piquette/piquette.config.yaml`. Remove the key, and its
  parent if that leaves it empty. Change nothing else in the file.
- **Deprecations.** Run `piquette doctor --json`. Warnings with `fix` text
  name renames (e.g. `decisions_config`: `jev:` → `decisions:`). Apply them
  as the fix describes.
- **New options.** Skim `CHANGELOG.md` in the installed package, between
  the old skill version and `piquette_version`, for new config the user
  might want. Mention them and offer, but don't switch anything on
  unasked. Turning one on is a **piquette-configure** job.

## 5. Verify

```bash
piquette doctor --json
piquette list --json
```

Done when doctor is clean, or only user-owned items remain (keys in `.env`,
tools to install), and `list --json` shows no `problems`. Report what
changed in a few lines: skills synced (and merged), migration applied or
not needed, overrides removed.

Secrets rule, as everywhere: if a key turns out to be missing, the user
adds it to `.env`. Never through chat.
