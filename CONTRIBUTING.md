# Contributing

## Development Setup

```bash
npm ci
npm run typecheck
npm run build
npm run test
```

Run the app locally:

```bash
npm run dev
```

Run the installer locally:

```bash
citio
```

## Contribution Guidelines

- Keep diffs small and reviewable.
- Prefer runtime-safe behavior over clever abstractions.
- Do not introduce unrelated refactors.
- Do not commit generated local machine state such as `citio.yaml`, `.env`, local auth files, or screenshots containing secrets.
- Preserve the AWS-first deployment path unless the change explicitly widens platform support.

## Before Opening a PR

Please run:

```bash
npm run typecheck
npm run build
npm run test
```

If the change affects:

- installer behavior: mention local/OS assumptions and migration impact
- runtime session behavior: mention restart/redeploy behavior
- auth handling: explain where credentials are stored and how they flow into ECS
- AWS deployment: describe IAM, EFS, and ECS task-definition effects

## PR Expectations

A good PR for Citio should include:

- what changed
- why it changed
- how it was tested
- any remaining risk or limitation

## Release Notes

For release process details, see [docs/RELEASING.md](/Users/work/Dev/ai-dev/Citio/docs/RELEASING.md).
