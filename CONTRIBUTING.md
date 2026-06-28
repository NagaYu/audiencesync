# Contributing to AudienceSync

Thanks for your interest in improving AudienceSync! This project handles customer PII, so we hold
contributions to a high bar for correctness and security. Please read this before opening a PR.

## Ground rules

1. **Never log raw PII.** Emails, phone numbers, and names must only ever exist in memory as
   transient values and leave the process exclusively as SHA-256 digests. Logs may contain counts
   and batch status — never identifiers.
2. **No disk writes for customer data.** No CSV, temp file, or staging table. The in-memory,
   file-free guarantee is the whole point of the tool.
3. **Keep it strict.** `tsc --strict` must pass with zero errors. Prefer the branded PII types in
   [`src/types.ts`](src/types.ts) so raw values can't flow where a hash is expected.

## Development setup

Requires Node.js >= 18.17.

```bash
git clone https://github.com/NagaYu/audiencesync.git
cd audiencesync
npm install
```

### Everyday commands

```bash
npm run dev          # tsup watch mode
npm run typecheck    # tsc --noEmit, strict
npm run lint         # ESLint (type-aware); npm run lint:fix to autofix
npm run format       # Prettier write; npm run format:check to verify
npm test             # vitest
npm run build        # production bundle → dist/
```

Before pushing, make sure all of these are green:

```bash
npm run typecheck && npm run lint && npm run format:check && npm test && npm run build
```

CI runs the same checks across Node 18, 20, and 22.

## Project layout

```text
src/
├── types.ts        # strict shared types + branded PII primitives
├── normalizer.ts   # pure in-memory cleansing + SHA-256 hashing
├── extractor.ts    # Postgres / MySQL / Stripe extraction
├── sync.ts         # Meta + Google batched uploaders
└── index.ts        # commander CLI + node-cron scheduler
test/
├── normalizer.test.ts
└── sync.test.ts
```

## Pull request expectations

- **One logical change per PR.** Keep diffs reviewable.
- **Add or update tests** for any behavior change. Pure logic (normalization, batching, parsing)
  should have unit tests in `test/`.
- **Update docs** (README / this file / `.env.example`) when you change configuration or behavior.
- **Conventional-ish commit subjects** are appreciated (`feat:`, `fix:`, `chore:`, `docs:`), and
  reference the issue you're closing (`Closes #N`).
- **Update [`CHANGELOG.md`](CHANGELOG.md)** under an `Unreleased` heading for user-facing changes.

## Reporting security issues

If you find a vulnerability — especially anything that could expose PII — please do **not** open a
public issue. Email the maintainers privately so it can be addressed before disclosure.

## License

By contributing, you agree that your contributions will be licensed under the
[MIT License](LICENSE).
