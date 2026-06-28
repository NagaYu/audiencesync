<h1 align="center">🛰️ AudienceSync</h1>

<p align="center">
  <strong>Stop exporting CSVs of your customers' personal data.</strong><br/>
  AudienceSync extracts your high-value customers, hashes their PII <em>in memory</em> with SHA-256,
  and syncs them straight to <strong>Meta Custom Audiences</strong> and
  <strong>Google Customer Match</strong> — on a cron, with zero files on disk.
</p>

<p align="center">
  <a href="https://github.com/NagaYu/audiencesync/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/NagaYu/audiencesync/actions/workflows/ci.yml/badge.svg"></a>
  <a href="#-license"><img alt="License: MIT" src="https://img.shields.io/badge/License-MIT-22c55e.svg"></a>
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-strict-3178c6.svg">
  <img alt="Node" src="https://img.shields.io/badge/Node-%E2%89%A518.17-339933.svg">
  <img alt="PII" src="https://img.shields.io/badge/PII-never%20written%20to%20disk-ef4444.svg">
</p>

---

## 💣 The problem with manual CSV uploads

Most teams still sync audiences by hand. The workflow looks like this:

1. An analyst runs a SQL query and **exports a CSV of raw emails and phone numbers**.
2. The file lands in `~/Downloads`, gets attached to a Slack message, emailed to the agency, or
   parked in a shared drive.
3. Someone uploads it to Meta Ads Manager or Google Ads — often after re-saving it through Excel,
   which silently mangles phone numbers and leading zeros.

Every step above is a **data-protection incident waiting to happen**:

| Manual CSV workflow                | Why it's dangerous                                                                             |
| ---------------------------------- | ---------------------------------------------------------------------------------------------- |
| Raw PII written to a local file    | The file persists in Downloads, Trash, Spotlight indexes, and backups — long after the upload. |
| Shared over Slack / email / drives | PII is now copied across systems you don't control and can't reliably delete.                  |
| Hashing done "later" (or never)    | Many teams upload **un-hashed** emails, handing raw identities to a third party.               |
| Manual normalization               | Inconsistent casing, whitespace, and country codes **tank your match rate**.                   |
| Human-triggered, ad-hoc cadence    | Audiences go stale; yesterday's buyers aren't in today's lookalike seed.                       |

**AudienceSync eliminates the file entirely.** Data is read from the source, normalized, hashed,
and streamed to the ad platforms — all within a single process's memory. There is no CSV to leak,
because there is no CSV.

---

## ✨ Why teams love it

- **🔒 In-memory, file-free by design.** No CSV, no temp file, no staging table. PII exists only as
  transient values in RAM and leaves the process exclusively as **SHA-256 digests**.
- **🧼 Platform-perfect normalization.** Emails and phone numbers are cleaned to the exact spec Meta
  and Google publish (trim → lowercase → E.164 country code) so your match rate is maximized.
- **📦 Smart batching + retries.** Records are chunked to each platform's limit and uploaded
  asynchronously with exponential backoff on 429/5xx.
- **🧩 Pluggable sources.** PostgreSQL, MySQL, or Stripe out of the box — pick one with an env var.
- **⏰ Cron or one-shot.** Run it manually for a backfill, or let the built-in scheduler keep your
  audiences fresh every night.
- **🛡️ Strict TypeScript.** `strict: true`, branded PII types, exhaustive switches — the compiler
  refuses to let raw PII flow where a hash is expected.

---

## 🧠 In-memory ETL data flow

```mermaid
flowchart LR
    subgraph SRC["🗄️ Source (your data)"]
        A1[(PostgreSQL)]
        A2[(MySQL)]
        A3[Stripe API]
    end

    subgraph PROC["⚙️ AudienceSync process — RAM only, no disk"]
        B[Extract rows<br/>for time window]
        C[Normalize<br/>trim · lowercase · E.164]
        D[SHA-256 hash<br/>email · phone · name]
        E[Chunk into batches<br/>~1,000 records]
    end

    subgraph DST["📣 Ad platforms"]
        F[Meta<br/>Custom Audience API]
        G[Google<br/>Customer Match API]
    end

    A1 --> B
    A2 --> B
    A3 --> B
    B --> C --> D --> E
    E -- "async batches" --> F
    E -- "async batches" --> G

    classDef danger fill:#fee2e2,stroke:#ef4444,color:#7f1d1d;
    classDef safe fill:#dcfce7,stroke:#22c55e,color:#14532d;
    class D,E safe;
```

> **Note:** raw PII never crosses the right-hand boundary. Only the green nodes' output — salted-free
> SHA-256 hex digests — is transmitted. No intermediate file is ever produced.

---

## ⚡ 10-second quick start

```bash
# 1) Install
npm install

# 2) Configure (copy and edit)
cp .env.example .env   # or just export the vars below

# 3) Build + dry-run (extracts & hashes, but uploads nothing)
npm run build
node dist/index.js sync --dry-run

# 4) Go live
node dist/index.js sync
```

Minimal `.env` for **Postgres → Meta**:

```dotenv
SOURCE_KIND=postgres
PG_CONNECTION_STRING=postgres://user:pass@host:5432/db
PG_SSL=true

META_ENABLED=true
META_ACCESS_TOKEN=EAAB...
META_AUDIENCE_ID=23847...

LOOKBACK_HOURS=24
```

That's it. `audiencesync sync` will pull every customer whose `last_purchase_at` falls in the last
24 hours, hash them, and push them to your Custom Audience.

---

## 🛠️ Installation

```bash
git clone https://github.com/NagaYu/audiencesync.git
cd audiencesync
npm install
npm run build      # compiles src/ → dist/ with tsup
```

Run directly with Node, or link the CLI globally:

```bash
npm link
audiencesync --help
```

---

## 🚀 Usage

```text
audiencesync sync       Run a one-shot extract → hash → upload for a time window
audiencesync schedule   Run sync repeatedly on CRON_SCHEDULE (long-lived process)
audiencesync config     Print the resolved, secret-redacted configuration
```

### One-shot sync

```bash
# Default window = now - LOOKBACK_HOURS → now
audiencesync sync

# Explicit window (ISO 8601)
audiencesync sync --since 2026-06-27T00:00:00Z --until 2026-06-28T00:00:00Z

# Validate everything without sending a single byte upstream
audiencesync sync --dry-run
```

### Scheduled sync

```bash
# Runs on CRON_SCHEDULE (default: every day at 02:00) in CRON_TIMEZONE
audiencesync schedule
```

Deploy it under PM2, systemd, a Docker `CMD`, or a Kubernetes `Deployment`. The scheduler skips a
tick if the previous run is still in flight, and shuts down cleanly on `SIGINT`/`SIGTERM`.

---

## ⚙️ Configuration reference

All configuration is via environment variables (12-factor). `dotenv` auto-loads a local `.env`.

### Source

| Variable                  | Default    | Description                                                                                                                                                                 |
| ------------------------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SOURCE_KIND`             | `postgres` | One of `postgres`, `mysql`, `stripe`.                                                                                                                                       |
| `SOURCE_QUERY`            | built-in   | SQL with **two** placeholders bound to `[since, until)`. Postgres uses `$1/$2`; MySQL uses `?/?`. Must return columns: `email, phone, first_name, last_name, country, zip`. |
| `PG_CONNECTION_STRING`    | —          | Required when `SOURCE_KIND=postgres`.                                                                                                                                       |
| `PG_SSL`                  | `true`     | Enforce TLS with certificate verification.                                                                                                                                  |
| `MYSQL_CONNECTION_STRING` | —          | Required when `SOURCE_KIND=mysql`.                                                                                                                                          |
| `MYSQL_SSL`               | `true`     | Enforce TLS.                                                                                                                                                                |
| `STRIPE_API_KEY`          | —          | Required when `SOURCE_KIND=stripe`.                                                                                                                                         |
| `STRIPE_MODE`             | `charges`  | `charges` = customers charged in the window; `customers` = customers created in the window.                                                                                 |

### Window & resilience

| Variable              | Default | Description                                                       |
| --------------------- | ------- | ----------------------------------------------------------------- |
| `LOOKBACK_HOURS`      | `24`    | Window size when `--since/--until` are omitted.                   |
| `DEFAULT_COUNTRY`     | `US`    | ISO alpha-2 used to add a calling code to national phone numbers. |
| `MAX_RETRIES`         | `4`     | Extra attempts per batch on transient errors.                     |
| `RETRY_BASE_DELAY_MS` | `500`   | Base for exponential backoff.                                     |
| `DRY_RUN`             | `false` | Global dry-run toggle (also `--dry-run`).                         |

### Scheduler

| Variable        | Default     | Description                             |
| --------------- | ----------- | --------------------------------------- |
| `CRON_SCHEDULE` | `0 2 * * *` | Standard 5-field cron expression.       |
| `CRON_TIMEZONE` | `UTC`       | IANA timezone, e.g. `America/New_York`. |

### Meta destination

| Variable            | Default | Description                              |
| ------------------- | ------- | ---------------------------------------- |
| `META_ENABLED`      | `false` | Enable the Meta uploader.                |
| `META_ACCESS_TOKEN` | —       | System-user token with `ads_management`. |
| `META_AUDIENCE_ID`  | —       | The Custom Audience id.                  |
| `META_API_VERSION`  | `v21.0` | Graph API version.                       |
| `META_BATCH_SIZE`   | `1000`  | Users per request (Meta caps at 10,000). |

### Google destination

| Variable                         | Default | Description                           |
| -------------------------------- | ------- | ------------------------------------- |
| `GOOGLE_ENABLED`                 | `false` | Enable the Google uploader.           |
| `GOOGLE_DEVELOPER_TOKEN`         | —       | Google Ads developer token.           |
| `GOOGLE_CUSTOMER_ID`             | —       | Ads customer id (digits only).        |
| `GOOGLE_USER_LIST_RESOURCE_NAME` | —       | `customers/{cid}/userLists/{id}`.     |
| `GOOGLE_LOGIN_CUSTOMER_ID`       | —       | MCC login customer id (optional).     |
| `GOOGLE_API_VERSION`             | `v17`   | Google Ads API version.               |
| `GOOGLE_BATCH_SIZE`              | `1000`  | Identifiers per `addOperations` call. |

**Google auth — provide EITHER a static token OR refresh credentials:**

| Variable                                                             | Description                                                                                                                                             |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GOOGLE_ACCESS_TOKEN`                                                | A pre-fetched OAuth2 Bearer token. **Expires in ~1 hour** — fine for a manual one-shot run, unsuitable for cron.                                        |
| `GOOGLE_REFRESH_TOKEN` + `GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET` | **Recommended for unattended cron.** AudienceSync exchanges these for a fresh access token on every run, so the scheduler never breaks on token expiry. |

> At least one of `META_ENABLED` / `GOOGLE_ENABLED` must be `true`. When Google is enabled you must
> supply either `GOOGLE_ACCESS_TOKEN` or the full refresh-token trio, or startup fails fast.

---

## 🧼 How normalization works

To maximize match rates, AudienceSync applies the rules both platforms publish — **before** hashing:

- **Email** → trim, strip internal whitespace, lowercase. (Gmail dots / `+tags` are preserved, as
  the platforms expect the address as entered.)
- **Phone** → strip every non-digit, drop national trunk `0`, prepend the calling code derived from
  the record's country (or `DEFAULT_COUNTRY`), validate E.164 length, hash the digits.
- **Name** → trim, lowercase, strip surrounding punctuation (keeping internal `'` and `-`).
- **Country** → ISO alpha-2, uppercased.
- **Zip** → trimmed/lowercased; US zips reduced to 5 digits. Sent **plain** to Google, **hashed** to
  Meta, per each platform's spec.

Records with neither a usable email nor phone are dropped — they can't be matched anyway.

---

## 🔐 Security model

- **No disk writes.** PII lives only in process memory and is emitted solely as SHA-256 hex.
- **No PII in logs.** Logs report counts and batch status, never identifiers.
- **TLS-by-default** to your database; certificate verification on.
- **Secret redaction.** `audiencesync config` masks every token and connection string.
- **Least privilege.** Use a read-only DB role and a restricted-scope Stripe key / Meta system user.

> **You are the data controller.** Ensure you have a lawful basis and the appropriate consent to
> share customer identifiers with Meta and Google, and honor deletion/opt-out requests at the source.

---

## 🧪 Development

```bash
npm run dev          # tsup watch mode
npm run typecheck    # tsc --noEmit, strict
npm run lint         # ESLint (type-aware) — npm run lint:fix to autofix
npm run format       # Prettier write — npm run format:check in CI
npm test             # vitest
npm run build        # production bundle → dist/
```

Project layout:

```text
src/
├── types.ts        # strict shared types + branded PII primitives
├── normalizer.ts   # pure in-memory cleansing + SHA-256 hashing
├── extractor.ts    # Postgres / MySQL / Stripe extraction
├── sync.ts         # Meta + Google batched uploaders
└── index.ts        # commander CLI + node-cron scheduler
```

---

## 🤝 Contributing

Issues and PRs are welcome. Please keep `npm run typecheck`, `npm run lint`, and `npm test` green,
run `npm run format` before committing, and never log raw PII. See
[CONTRIBUTING.md](CONTRIBUTING.md) for the full guide and [CHANGELOG.md](CHANGELOG.md) for the
release history.

---

## 📄 License

Released under the **MIT License**.

```text
MIT License

Copyright (c) 2026 AudienceSync Contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

<p align="center"><em>Built for MarTech engineers who refuse to email a spreadsheet of customer emails. ⭐ it if that's you.</em></p>
