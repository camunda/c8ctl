# Release Automation

This repository uses **semantic-release** + GitHub Actions to build, test, tag, create GitHub releases, and publish to npm.

## What happens on a release run

The release workflow is [.github/workflows/release.yml](.github/workflows/release.yml).

1. **Tests run first** (unit + integration against Camunda 8 via Docker Compose). This job is copied from the test workflow so release runs are gated on the same checks.
2. If tests pass, the workflow runs `npx semantic-release`.
3. `semantic-release`:
   - determines the next version from commit messages (Conventional Commits)
   - generates release notes
   - **builds** the package (`npm run build`)
   - publishes to npm
   - creates a GitHub release + comments on included issues/PRs

Release configuration lives in [.releaserc.json](.releaserc.json).

## Branch and channel strategy

We publish two “streams”:

- **Alpha (prerelease)**: from branch `main`
  - published to npm under the `alpha` dist-tag (so users install via `npm i @camunda8/cli@alpha`)
  - versions look like `2.0.0-alpha.2`

- **Stable (latest)**: from branch `release`
  - published to npm under the default `latest` dist-tag
  - versions look like `2.0.0`

This is controlled by the `branches` setting in [.releaserc.json](.releaserc.json).

## npm publishing and OIDC

The release workflow is intended to publish using GitHub Actions **OIDC** (no long-lived npm token stored in GitHub).

- The workflow requests `id-token: write` permissions.
- npm must be configured to trust this GitHub repository for OIDC publishing.
- The publish step uses provenance (`--provenance` / `NPM_CONFIG_PROVENANCE=true`).

## What files get published

npm decides what goes into the published tarball.

In this repo, the `files` field in [package.json](package.json) limits the published contents to:

- `dist/`
- `README.md`
- `LICENSE`

(Plus `package.json` itself and npm’s standard always-included metadata files.)

## Commit message requirements (semantic-release)

semantic-release only creates a new release when there are commits that imply a version bump.

Examples:

- `fix: ...` → patch
- `feat: ...` → minor
- `feat!: ...` or `BREAKING CHANGE: ...` → major

If you merge commits that don’t follow Conventional Commits, semantic-release may do **no release**.

---

# Maintainer Procedures

## Procedure: Release an alpha version (from `main`)

This is the normal day-to-day prerelease flow.

1. Ensure your changes are merged to `main` with Conventional Commit messages.
2. Push to `main` (merging a PR to `main` is enough).
3. Verify GitHub Actions:
   - Go to Actions → **Release** workflow
   - Confirm the run triggered on `main` completed successfully
4. Verify artifacts:
   - npm: check that a new version exists under the **alpha** dist-tag
     - Example install: `npm i -g @camunda8/cli@alpha`
   - GitHub: confirm a new release + tag were created (tag format is `vX.Y.Z[-prerelease]`)

If the workflow says “no release”:

- Confirm at least one commit since the last tag uses `fix:`, `feat:`, or contains a breaking change marker.

### One-time bootstrap (only if the package does not exist on npm yet)

If npm OIDC requires the package to already exist, you can do a one-time manual alpha publish to create it.

1. Update version + tag:
   - `git checkout main && git pull --ff-only`
   - `npm version 2.0.0-alpha.1 -m "chore(release): %s"`
2. Build and publish:
   - `npm ci`
   - `npm run build`
   - `npm publish --tag alpha --access public`
3. Push the commit + tag so semantic-release has the correct baseline:
   - `git push origin main --follow-tags`

After this bootstrap, prefer the automated workflow for subsequent alpha releases.

## Procedure: Release a stable version (from `release`)

Stable releases are cut by updating the `release` branch.

1. Decide what goes into the stable release.
   - Typical approach: fast-forward `release` to the desired commit from `main`.
2. Update `release` locally:
   - `git fetch origin`
   - `git checkout release`
   - `git pull --ff-only`
   - Merge the desired commits from `main`:
     - Option A (recommended when releasing everything currently in `main`):
       - `git merge --ff-only origin/main`
     - Option B (selective):
       - `git cherry-pick <sha> ...`
3. Push `release`:
   - `git push origin release`
4. Verify GitHub Actions:
   - Go to Actions → **Release** workflow
   - Confirm the run triggered on `release` completed successfully
5. Verify artifacts:
   - npm: the new version should be on the **latest** dist-tag (default)
     - Example install: `npm i -g @camunda8/cli`
   - GitHub: confirm a release + tag were created

If you need to re-run without changing commits, you can use **Actions → Release → Run workflow** (workflow_dispatch), but note that semantic-release will still only publish if there are release-worthy commits since the last tag.
