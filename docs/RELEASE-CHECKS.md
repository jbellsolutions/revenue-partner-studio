# v0.2.0-beta.2 — support and verification

This document separates implemented behavior, automated coverage and live acceptance. The public demo is simulated; no demo action proves a model or computer connection.

## Supported scope

Private browser workspace; existing Orgo Linux computers, starting with 8 GB; native Hermes profiles/skills/providers; explicit computer scoping; persistent tasks and specialists; managed cloud screens; reviewed imports; directional trusted connections; optional Mac Hermes chat and files. Mac desktop control is hidden. There is no shared SaaS tenant layer, funded public demo or notarized public desktop download.

## Evidence status

| Check | Current status |
| --- | --- |
| Existing connected private workflow | Prior backend acceptance includes real tool tasks, profile-scoped model changes, handoff/grant checks and four separate managed screens. Private records are excluded from this repository. |
| Public release source, branding and installer | Previous beta.1 [hosted verification](https://github.com/jbellsolutions/revenue-partner-studio/actions/runs/34809435709) passed. Round two local checks are recorded below; match the prerelease commit to its [hosted verification run](https://github.com/jbellsolutions/revenue-partner-studio/actions/workflows/studio-ci.yml). |
| Independent recipient installation | **Not yet verified.** Requires its own authorized accounts/resources, provider authentication, real chat/tools and screen/reopen checks. A preflight or mocked adapter does not satisfy this gate. |
| Browser visual acceptance | **Unverified while administrator-policy verification is unavailable.** This affects live appearance, mobile interaction, keyboard navigation and visible takeover acceptance. No bypass is permitted. |
| 24-hour backend reliability trial | The original trial runs from September 14, 03:45:36 UTC to September 15, 03:45:36 UTC on its original runtime revision. At 9.47 elapsed hours on September 14, all five computers were online. The checkpoint had 12 verified tool jobs, 3,397 successful status samples and 11 failed status samples. Agent/task listings succeeded 3,397 times each. Failures recovered; their cause remains unresolved. The trial has not been reset or declared passed. Interface deployment does not qualify the new computer extension. |
| Public anonymous access, DNS and HTTPS | Cloudflare Pages reports a successful production deployment of the sample site. Domain activation is pending DNS administration access. Anonymous HTTP verification received Cloudflare error 1010; anonymous access and downloads remain unverified. |

## Performance and reliability targets

Healthy, already-running computers: Studio ready ≤2 s, cached switch ≤250 ms, task acknowledgment ≤1 s, warm screen ≤3 s, reconnect ≤5 s, measured at p95. Model response/tool completion are separate. Unmeasured targets are not guarantees. A complete release acceptance includes 24 hours of repeated switching, simultaneous work, reconnects and browser closure, plus restoration verification.

## Previous beta.1 validation log

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

## Round two validation log

Local automated checks on September 14, 2026:

- Cloud: 35 tests passed, including four simulated DOM/component tests of connected-model search, manual selection, activation errors, stale responses and catalog isolation. TypeScript check and production build passed.
- Runtime: 76 tests passed across nine affected model, import, profile, connector, coordination and screen files. Skill-only coverage includes an archive round trip, approved destination identity, scope mismatch, source/destination links, excluded secrets, busy agents, hash verification, updates and conflicts.
- Public site: five fixture checks and the production build passed after preparation downloads were regenerated. Setup/configuration: eight tests passed. The demo imports only shared presentation components and fixture data.
- Clean independent source copy: cloud and site dependency installs, typechecks, builds and demo fixture tests passed. This is build reproducibility, not a fresh customer account installation.
- Desktop compatibility: 18 focused product/connection/model tests and TypeScript checks passed; a local Bot package built and retained its original application ID. No app was installed, replaced or published as a notarized download.
- Preparation guide: both regenerated Word pages were rendered and visually checked.
- Source scan: all 819 existing baseline findings in the extracted snapshot matched reviewed file hashes; no new finding.
- Account/domain state: Railway's custom app domain is attached to the existing service, pending DNS and certificate validation. Cloudflare dashboard access was blocked by the browser policy check; the existing publishing token cannot create zones or edit DNS. No nameserver or existing DNS record was changed.

Hosted verification and final package scans are recorded with the prerelease. Pending before full acceptance: compatible extension promotion and live selected-skill transfer, permitted browser acceptance (including keyboard, scroll, pointer, takeover and switching), measured end-to-end performance, DNS/HTTPS activation, and the unchanged reliability trial. The existing private workspace and rollback clients remain in place.
