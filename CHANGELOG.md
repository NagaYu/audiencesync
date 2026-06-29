# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Streaming extraction with bounded memory: PostgreSQL/MySQL use server-side cursors
  (`pg-query-stream` / mysql2 row streams) and Stripe uses lazy pagination. The pipeline now runs
  extract → hash → upload one batch at a time via a `SyncSession`, so the full audience is never
  materialized in memory.
- Google Customer Match now sends a plain-text `countryCode` in `addressInfo`, so country
  participates in address matching (while Meta continues to receive the hashed country column).
- Accurate Google partial-failure accounting: `recordsAccepted` / `recordsRejected` are now derived
  from the parsed `partialFailureError.details`, instead of counting the whole batch as accepted.
- ESLint (type-aware) + Prettier, wired into CI alongside typecheck, tests, and build.
- `CONTRIBUTING.md` and this `CHANGELOG.md`.

## [1.0.0] - 2026-06-28

### Added

- Initial release of **AudienceSync** — secure, in-memory Reverse ETL.
- Source extraction from PostgreSQL, MySQL, and Stripe for a configurable time window.
- Platform-correct PII normalization (email, phone → E.164, name, country, zip) and SHA-256 hashing,
  performed entirely in memory with no disk writes.
- Meta Custom Audience and Google Customer Match uploaders with configurable batch sizes and
  exponential-backoff retries on transient (429 / 5xx) failures.
- Google OAuth2 refresh-token exchange for unattended cron runs.
- `commander` CLI with `sync`, `schedule`, and `config` subcommands, plus a `node-cron` scheduler.
- Strict TypeScript with branded PII types and a vitest test suite for the normalizer.
- GitHub Actions CI across Node 18, 20, and 22.

[Unreleased]: https://github.com/NagaYu/audiencesync/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/NagaYu/audiencesync/releases/tag/v1.0.0
