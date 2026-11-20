# Postman Spec Sync (`.postman/`)

Keeps HubSpot's public Postman workspace in step with this monorepo, automatically. No more manual re-publishing when an engineering team ships a spec change or a new date-based version lands.

Everything Postman-related lives in this one folder. `migration-state.json` (produced by the Phase 1 migration) is the source-of-truth mapping between each monorepo spec file and its Postman spec + curated collection. The older `.postman/api_*` files from the v11 Git integration can sit alongside it; the sync doesn't read them.

---

## Setup (one time)

### 0. Install into the monorepo

From any folder, with Node 20+:

```bash
git clone https://github.com/postman-cs/hubspot-v12-migration.git
node hubspot-v12-migration/phase2/install.mjs <path-to-monorepo> --state <your migration-state.json>
```

`--state` is the `migration-state.json` from your Phase 1 run (the GitHub Actions artifact). Leave it off if it's already in `.postman/`. The installer copies the workflow and sync engine in, fills in any missing collection links for the 4 non-conventional APIs, and prints a preview of the first sync. It doesn't write anything to Postman. Then commit `.github/workflows/postman-sync.yml` and `.postman/`, open a PR, and merge it.

### 1. Create a service account key

Use a service account so the sync isn't tied to any one person.

1. A Postman Team Admin opens **Team settings > Service Accounts > Create Service Account** (for example `hubspot-spec-sync`).
2. Under **Assigned workspaces**, add the public workspace with the **Editor** role (or Admin). Make sure the account can edit the curated collections too.
3. Click **Generate API Key**, name it (for example `github-actions`), and copy it. It's only shown once.

The key goes straight into the `X-Api-Key` header like any Postman API key, so nothing else changes. To rotate later: generate a second key, swap the secret, then revoke the old key.

### 2. Add the secret (and optionally the workspace)

**Settings > Secrets and variables > Actions > New repository secret**

| Secret | Value |
| --- | --- |
| `POSTMAN_API_KEY` | The service account API key |
| `POSTMAN_WORKSPACE_ID` | Optional. Defaults to `targetWorkspaceId` in `migration-state.json` (`d7645f33-…`) |

### 3. Let Actions open pull requests

**Settings > Actions > General > Workflow permissions**: tick **Allow GitHub Actions to create and approve pull requests**. The sync records its progress in `migration-state.json` through a PR.

### 4. Turn on scheduled apply (after a first look)

Scheduled runs are **plan-only** until you opt in. Run one manual `plan`, read the report, then add the repo variable:

**Settings > Secrets and variables > Actions > Variables**: `POSTMAN_SYNC_SCHEDULED_MODE` = `apply`

Set it back to `plan` (or delete it) any time to pause writes.

Node 20 is the only runtime and there are no dependencies to install.

## How it runs

- **Automatically**: weekday mornings. Spec sync and new-service onboarding only. Collections are never touched on a schedule.
- **Manually**: **Actions > Postman Spec Sync > Run workflow**
  - `mode`: `plan` (preview, writes nothing) or `apply`
  - `collections`: also update collections (new version folders, new endpoints, new services)
  - `create-new`: onboard brand-new services

Every run uploads a `sync-report.json` artifact listing exactly what changed, what was skipped, and anything that needs a human decision.

## What it does on each run

**Which version is latest.** The newest *released* date version wins (a `2026-09` folder counts from September 2026 on), then the highest `vN`. Betas like `2027-03-beta` and future dates are never published. Pin a specific version per API in `.postman/version-overrides.json`:

```json
{ "CRM/Contacts": "2026-09" }
```

For every API in `migration-state.json`:

1. **A newer version is released** (e.g. `v3` to `2026-09`). The spec is updated in place: same name, same ID, so links never break. With `collections` on:
   - APIs with version subfolders (e.g. Account Info) get a `2026-09 [latest]` subfolder, filled from the spec. If a `2026-09` folder already exists, it's reused and only missing requests are added. The `[latest]` label moves off the previous version, and older versions are left untouched.
   - APIs whose curated folder is organized by function (most of CRM) are reported as `needs-layout-decision`. Their curated folder documents the old version, so nothing is mixed in. Set `"rollApiLevelFolders": true` in `sync-config.json` to give them a `{version} [latest]` subfolder too.
2. **Same version, new rollout folder.** The path is updated, and the spec is updated if the content changed. No new folders are created.
3. **Spec edited in place.** The spec is updated. With `collections` on, only brand-new endpoints are added to the bound folder, and only when that folder documents the same version. Existing curated requests, descriptions and examples are never modified or removed.
4. **Removed from the monorepo.** Reported, never deleted. Removing something from the public workspace is a human decision.

For APIs not in state yet:

- **Brand-new service with a released version.** A spec `{Group} - {API} API Definition` is created. With `collections` on, it lands at `{Group} API Collections > {API} API > {version} [latest]`. A grouping collection is created only for a brand-new group.
- **Needs review.** APIs left out in Phase 1 that now have a released version, and APIs that only have betas so far. These are listed in the report, nothing is created.

**Safe to re-run.** Before creating anything, the sync looks for an existing spec, collection or folder with the expected name and reuses it. If the state PR isn't merged yet, the next run converges on the same result instead of duplicating, and the open PR is refreshed.

## Configuration (`sync-config.json`)

```json
{
  "ignoreGroups": ["Test"],
  "ignoreApis": [],
  "rollApiLevelFolders": false
}
```

- `ignoreGroups` / `ignoreApis`: never onboard these (keys look like `CRM/Contacts`).
- `rollApiLevelFolders`: see case 1 above.

## The state file

`migration-state.json` is keyed by `{group}/{api}`. Each entry carries the monorepo side (`specPath`, `blobSha`) and the Postman side (`specId`, `groupingCollectionUid`, `apiFolderId`, `versionFolderId`, `bindingLevel`, `boundVersion`). `boundVersion` is the version the bound curated folder documents. The sync reads the file to know what maps to what, and writes it back through a PR so hashes and new IDs stay current. Progress is saved even if some APIs hit errors, and the job is marked failed afterward so the errors are visible.

## Run it locally (optional)

```bash
# preview, no writes
POSTMAN_API_KEY=… node .postman/sync.mjs --plan

# apply spec sync only
POSTMAN_API_KEY=… node .postman/sync.mjs --apply --no-collections

# apply everything, including collections
POSTMAN_API_KEY=… node .postman/sync.mjs --apply
```

Flags: `--plan|--apply`, `--no-collections`, `--no-create`, `--repo <path>`, `--state <path>`, `--workspace <id>`, `--config <path>`, `--version-map <path>`.
