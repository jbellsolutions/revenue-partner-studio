# v0.2.0-beta.1 — support and verification

This document separates implemented behavior, automated coverage and live acceptance. The public demo is simulated; no demo action proves a model or computer connection.

## Supported scope

Private browser workspace; existing Orgo Linux computers, starting with 8 GB; native Hermes profiles/skills/providers; explicit computer scoping; persistent tasks and specialists; managed cloud screens; reviewed imports; directional trusted connections; optional Mac Hermes chat and files. Mac desktop control is hidden. There is no shared SaaS tenant layer, funded public demo or notarized public desktop download.

## Evidence status

| Check | Current status |
| --- | --- |
| Existing connected private workflow | Prior backend acceptance includes real tool tasks, profile-scoped model changes, handoff/grant checks and four separate managed screens. Private records are excluded from this repository. |
| Public release source, branding and installer | Local checks and [hosted verification](https://github.com/jbellsolutions/revenue-partner-studio/actions/runs/34809435709) passed. Exact results are recorded below. |
| Independent recipient installation | **Not yet verified.** Requires its own authorized accounts/resources, provider authentication, real chat/tools and screen/reopen checks. A preflight or mocked adapter does not satisfy this gate. |
| Browser visual acceptance | **Unverified while administrator-policy verification is unavailable.** This affects live appearance, mobile interaction, keyboard navigation and visible takeover acceptance. No bypass is permitted. |
| 24-hour backend reliability trial | An existing trial is in progress. At the September 14 review, 1.64 hours had elapsed: all 591 samples each of status, agent listing and task listing succeeded, and 3 real tool tasks were verified. This is not a completed 24-hour result. |
| Public anonymous access, DNS and HTTPS | Cloudflare Pages reports a successful production deployment of the sample site. Domain activation is pending DNS administration access. Anonymous HTTP verification received Cloudflare error 1010; anonymous access and downloads remain unverified. |

## Performance and reliability targets

Healthy, already-running computers: Studio ready ≤2 s, cached switch ≤250 ms, task acknowledgment ≤1 s, warm screen ≤3 s, reconnect ≤5 s, measured at p95. Model response/tool completion are separate. Unmeasured targets are not guarantees. A complete release acceptance includes 24 hours of repeated switching, simultaneous work, reconnects and browser closure, plus restoration verification.

## Release validation log

Local checks on September 14, 2026:

- Gateway: 28 tests passed; cloud TypeScript check and production build passed.
- Runtime/provider/coordination/import/file/backup suites: 249 tests passed across 21 files.
- Distribution, upstream, Mac workspace and subscription-worker suites: 43 tests passed across 4 files.
- Resumable setup and credential configuration: 8 tests passed, including uncertain creation, resume, destination isolation, missing credentials and accepted-task reconciliation.
- Public demo: 5 automated fixture/static checks passed; production build passed. These are not browser interaction or visual tests.
- Desktop branding, policy and connections: 137 tests passed across 18 files; typecheck and local Bot package build passed. Signature verification passed and the original application identifier is retained. No app was installed or replaced as part of this check.
- Preparation Word guide: rendered and visually checked across both pages. No clipping or overlap found.
- Fresh source scan: 819 findings match previously reviewed exact baseline lines (synthetic fixtures/examples, public OAuth client IDs, C macros and checksums); no new unreviewed finding. Exceptions are bound to full file hashes. Extracted source and runtime packages also passed with no new findings. Final published downloads carry SHA-256 checksums.

Hosted verification passed on Linux, including clean cloud/site installs, TypeScript checks, builds, desktop policy/connection tests and runtime/provider/installer checks. The initial cloud lockfile failure was repaired and verified from a fresh install.

Remaining gates: independent recipient installation, anonymous website/download verification, custom-domain DNS/HTTPS activation, permitted browser acceptance, completed reliability review and restoration acceptance. Detailed private records, account identifiers and personal paths are excluded.
