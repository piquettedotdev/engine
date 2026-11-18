---
name: piquette-cloud
description: Set up and operate PIQUETTE's hosted side on the user's own Cloudflare account — `piquette cloud init`, Access application planning, `cloud deploy`, `cloud status`, adding tenants, and provisioning factory service tokens for `piquette sync`. Use when the user wants hosted receipts, a hosted dashboard, multi-factory sync, or asks about `piquette cloud` or Cloudflare deployment of piquette.
---

# PIQUETTE cloud

Almost every step here changes the user's Cloudflare account or its
security perimeter. **Confirm before each outward-facing step** (deploy,
add tenant, provision), naming what will change. One "yes" covers one
step, not the whole sequence. Read-only steps (`--dry-run`,
`access-plan`, `status`) can run freely.

## Where config lives

`cloud:` and `sync:` belong in the **machine layer**
(`$PIQUETTE_CONFIG_HOME/piquette.config.yaml`, default
`~/.piquette/piquette.config.yaml`), shared by every repo on the box.
`cloud init` writes there. Never put them in a repo's `.piquette/`: a cloned
repo could redirect deploys or credentials. If `access-plan` or `status`
warns about a "repo layer" cloud block, move it to the machine layer before
acting on it.

## Secrets

All credentials are environment variables. Config names them and never
holds them:
- `CLOUDFLARE_ACCOUNT_ID`
- `CLOUDFLARE_API_TOKEN` (Workers Scripts Edit plus Workers R2 Storage
  Edit; also Access: Service Tokens Edit if you'll provision factories)
- `CF_ACCESS_CLIENT_ID` / `CF_ACCESS_CLIENT_SECRET` (only for `status`'s
  module probe)
- `PIQUETTE_SYNC_CLIENT_ID` / `PIQUETTE_SYNC_CLIENT_SECRET` (per factory)

The user sets these in their own shell or env manager. Never ask for a
value in chat, and never write one to a file.

## 1. Configure: `cloud init --answers`

```bash
piquette cloud init --answers '<json>'          # exit 3 = needs_answer, 0 = written
piquette cloud init --dry-run --answers '<json>'  # preview the cloud:/sync: block
```

It works like **piquette-setup**'s loop. On `needs_answer`, ask the user
`question.label`, add `question.key`, and re-run. On `invalid_answer`,
re-ask. The questions cover:
- worker name
- hostname, or a route plus zone
- an optional base path
- the Access team domain
- modules (receipts, ingest, dashboard)
- bucket and D1 names
- tenant and readers
- whether every repo on this machine syncs

An existing `cloud:` block isn't replaced without `--force`. To add a
tenant instead, use step 5.

`written` returns `access_plan` and a `next` hint.

## 2. Access applications: the user creates them

Deploy never creates Access applications. That needs an account-wide
credential, and the security team often owns that perimeter. Show the user
`access_plan.apps` (or `piquette cloud access-plan --json`): each app's
domain, path, policy type and suggested rule. Surface every entry in
`warnings` too. The user creates the apps in Zero Trust → Access →
Applications. Then put each app's **AUD** into `cloud.access.aud` in the
machine config, replacing the placeholder. The Worker refuses every request
until the placeholder is gone.

## 3. Deploy

```bash
piquette cloud deploy --dry-run     # generated wrangler config + command; no API call
```

Show the user the dry run. On their go-ahead:

```bash
piquette cloud deploy
```

This creates the R2 bucket if needed, applies D1 migrations, and deploys
the Worker through a pinned `npx wrangler`.

## 4. Verify

```bash
piquette cloud status --json        # exit 1 = a failed check, 2 = no cloud: block
piquette doctor --json              # the `cloud` / `sync` checks
```

`status` confirms the deployed vars match config, the bucket exists, and an
unauthenticated request is refused *by Access*. A 2xx with no credentials
is a failure: the perimeter isn't in front. Treat it as urgent.

## 5. Tenants and readers

```bash
piquette cloud init --add-tenant --tenant <id> --reader-domain <csv> --reader-email <csv>
```

This adds a tenant. With `--force` it **widens** an existing tenant's
readers: it adds to them and never removes any. It only touches
`cloud.tenants`. Then redeploy, so the reader grants take effect. The
Access app's own policy may need widening by hand too, and the printed
plan says so.

## 6. Factories (sync): the user runs this one

`provision-factory` mints a service token and prints its secret **once**, on
stdout. It's never stored. If you run it, the secret lands in your context,
so give the user the command to run in their own terminal:

```bash
piquette cloud provision-factory --name <machine-name> --tenant <tenant-id>
```

Tell them to put `PIQUETTE_SYNC_CLIENT_ID` and `PIQUETTE_SYNC_CLIENT_SECRET`
into that factory's environment, and to make sure `sync: {}` is in that
machine's config. Then verify on that machine:

```bash
piquette sync --dry-run             # counts only, sends nothing
```

`--client-id <id>` adopts an existing token instead of minting one. That
prints no secret, so you can run it yourself.

Full reference: `docs/cloud.md` and `docs/sync.md` in the piquette package.
