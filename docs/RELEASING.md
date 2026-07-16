# Releasing Citio

Releases publish to npm automatically: push a `v*` tag and the `Release`
workflow does the rest (requires the `NPM_TOKEN` repo secret, already set).

## Local release flow

1. Update the version in `package.json`.
2. Run the verification steps locally:
   - `npm ci`
   - `npm run typecheck`
   - `npm run build`
   - `npm run test`
3. Commit the release changes.
4. Create a version tag:
   - `git tag vX.Y.Z`
5. Push the branch and tag:
   - `git push origin <branch>`
   - `git push origin vX.Y.Z`

## GitHub Actions

Two workflows are included:

- `CI`
  - Runs on every pull request and on pushes to `main`/`master`
  - Executes `npm ci`, `npm run typecheck`, `npm run build`, and `npm run test`

- `Release`
  - Runs on pushed tags matching `v*`
  - Re-runs typecheck/build/tests
  - Publishes to npm if `NPM_TOKEN` is configured
  - Creates a GitHub release with generated notes

## AWS release note

The npm/GitHub release flow is separate from the AWS deployment flow. Publishing a new npm package version does not redeploy ECS. Use the installer or the documented AWS deployment commands when you want to update the running service.
