# Pinned Orgo runtime overlays

These assets adapt this fork's team-task reliability changes to the exact
Hermes revision already installed on the primary Orgo computer. They are not
an instruction to replace a running gateway or downgrade Hermes.

## Autonomous release candidate

The approved CI repairs are in `c12e0e3`: explicit UTF-8 Git output and a read-only
inbox probe before loading notification recovery settings. Three idle-inbox
regressions failed before the fix and pass afterward. All 603 focused local
tests pass, including the original gateway cleanup-order and Windows scan failures.

The default manifest is now `63279301-autonomous-release.json`, SHA-256
`1db09c638e7834eba5a471b1d3fff7e20ec560530b4ea0bafb8c26a011902ce8`.
It preserves all unchanged retry-bounds candidate hashes and includes the
notification fix plus its tests. This supersedes `7533a44a` without modifying it.
Preparation, acceptance, and activation are separate gates; deployment evidence
must identify the installed runtime and app, not infer activation from a manifest.

## Current retry-bounds candidate (unactivated)

The default preparation manifest is `63279301-retry-bounds.json`, with patch
SHA-256 `7533a44a99eea2f5740b9a22633d8db8acc3e9f1c7bf79638e29dd4b9a14b082`
and 29 verified output files. The primary Orgo candidate is
`/root/.hermes/desktop-runtime/orgo-team-63279301-7533a44a`.
It includes the cancellation/history overlay plus `2ad2825`'s readiness guard
against automatic reopening of an exhausted protocol-failure retry budget.
Older checkpoints below describe historical candidates, not the current target.

| Check | macOS | Primary Orgo Linux |
| --- | --- | --- |
| 84-file Kanban/gateway/notification regression | 678 passed, 9 skipped; 32.7 s | 682 passed, 5 skipped; 133.4 s |
| Real scheduler retry exhaustion and restart | 1 passed; 80.0 s | 1 passed; 98.3 s |
| Operator/specialist automatic return, both dispatch modes | 2 passed; 21.2 s | 2 passed; 67.0 s |
| Authenticated cancellation and retained history | 1 passed; 9.9 s | 1 passed; 17.1 s |
| Authenticated transport and crash recovery | Not rerun for this candidate | 1 passed; 42.4 s |

The retry fixture also passed against local source (80.6 s). Its initial runs
against upstream 0.21 exhausted the three-turn model budget rather than producing
the intended clean-exit protocol failure. Setting the disposable fixture's budget
to five leaves room for the CLI's corrective nudges. The exact protocol-marker,
two-run exhaustion, and restart assertions remain unchanged; initial failures are
retained in the evidence. Production budgets and retry policy were not relaxed.

Preparation-helper tests: 10 passed. Desktop release checks on current source:
4,024 UI tests passed (1 skipped), all three typecheck projects passed, and
1,175 desktop-platform tests passed (2 skipped). These are not native installed
app acceptance or green GitHub CI.

Evidence: `/tmp/orgo-runtime-retry.hRTfYv/` locally and
`/tmp/orgo-retry-verification.gfgVzz/` on Orgo. Final remote verification confirmed
all 29 output hashes, a clean original runtime, unchanged production process
identities, and no remaining test-owned processes. The candidate is still
unactivated. Checks use loopback scripted models, not paid live-model planning.
The inherited Linux FTS failure and release/CI gates remain open. Cross-computer
A2A expansion and its documented origin-boundary repair are deferred; they are
not enabled by this same-computer milestone.

## Authenticated cancellation acceptance

`tests/test_cancellation_acceptance.py` boots a disposable real backend and
dispatches a real Hermes worker through `_default_spawn`. One loopback scripted
model request starts a harmless `sleep 25` terminal command within the normal
foreground limit. Missing and incorrect session tokens cannot cancel it. The
authenticated cancellation endpoint must stop both the worker and its terminal
before test cleanup, without stopping the backend. The test restarts only its
own backend and verifies durable cancelled state, retained discussions and worker
history, rejection of late completion, no dispatcher retry, and no changes to
an unrelated parked task or private transcript.

The latest test also requires the cancelled run's stored worker session to match
the actual conversation in the run's profile after restart, including the exact
profile/session reference exposed by the authenticated task-detail REST response.
The earlier database-link check passed locally
in 11.3 seconds with startup-linked worker history, one loopback model request,
and no remaining test-owned processes. Evidence:
`/tmp/orgo-worker-link-cancellation.fVAZo1/evidence/test_authenticated_cancellatio0/cancellation-acceptance-report.json`.
An older runtime that only stamps successful handoffs will fail this stronger
check; retaining the SQLite conversation alone is not enough.

Copy this test and `tests/test_runtime_acceptance.py` together when testing a
prepared runtime; the latter supplies the required signal-free startup-cleanup
preflight. Use the candidate's canonical `scripts/run_tests.sh -j 1` with the
explicit test path and a fresh disposable `--basetemp`. Never reuse user-data
directories for that flag. Cleanup acts only on captured test process identities.
This is manual acceptance, not an enabled hosted CI lane.

The final local check passed in 10.6 seconds on source `bc3cae1`, with one local
mock-model request. Report and logs:
`/tmp/orgo-live-cancellation.zKENta/evidence/test_authenticated_cancellatio0/`;
runner output: `/tmp/orgo-live-cancellation.zKENta/run.log`.
Worker session `20260908_195303_dca53f` remained in its own profile database.
Earlier harness errors (wrong fixture keyword/path type, a foreground timeout
above the existing limit, and incorrectly assuming initial blocked status) were
corrected without changing production policy or weakening acceptance assertions.

The previous `b2542a35` prepared Linux runtime does **not** include cancellation.
The new `4a306c07` candidate described below includes cancellation and persistent
worker-history links. Neither candidate is activated. Native desktop interaction
and installed-release verification remain separate gates.

## Runtime preparation and previous evidence

`63279301-cancellation.json` identifies the upstream revision, hashes each original file,
and verifies the accompanying patch's integrity by checksum. The patch preserves
0.21's turn-ownership admission and terminal callbacks, including releasing a
notification lease when admission returns `False`. It includes the notification
inbox, atomic task/return-route creation, retry validation and behavioral tests.
It also includes same-home Desktop and messaging-gateway cleanup guards from
`afe5041` and `4983444`, compression-safe return routing from `8096049`, and
passive versus active task delivery from `86c458a`. The 0.21-specific port
preserves admission refusal and terminal callbacks; a refused compressed-chat
turn releases its original receipt, not the continuation's unrelated inbox.
The overlay also ports `89756df` worker-thread attribution:
the event's own run must belong to the task before its profile and validated
stored session ID can become a navigation reference. It does not grant access.
The cancellation overlay adds `894f6d4` durable cancellation/CLI, `bc3cae1`'s
authenticated backend endpoint, and `2828550` startup-linked worker history.
Desktop assets are built separately; this backend overlay does not install the
Mac task drawer or its conversation-link controls.

Do not activate the older overlays (`63279301.json`,
`63279301-attribution.json`, or `63279301-isolation.json`). They retain at least
one upstream startup-cleanup path that can terminate another home's remote
Desktop backend or messaging gateway. The assets are retained for provenance,
not approved for rollout.

The preparation command is:

```sh
python scripts/prepare_orgo_runtime.py \
  --source /usr/local/lib/hermes-agent \
  --destination /root/.hermes/desktop-runtime/<new-version-directory> \
  --sync --extra dev --extra slack --extra acp
```

The assistant/operator runs this on the intended computer. It refuses a wrong
revision, tracked source edits, altered patch, or existing destination. It
archives committed files into a new directory without copying untracked
credentials, applies the checked patch and optionally installs locked
dependencies into that directory's own virtual environment. If `uv` is absent,
the pinned bootstrap tool is installed only into `.runtime-bootstrap` inside
the new directory, not into system Python or the live Hermes environment.
A failed directory is retained for diagnosis; it is never erased or silently
reused. `--resume-dependencies --extra dev` resumes only after the receipt and
prepared code/dependency-lock checksums match; edited snapshots are refused.
If a bootstrap directory already exists, retries create a fresh private
directory instead of mixing Python interpreters in a partial virtual
environment. The previous attempt is retained. The selected Python still
needs working `venv`/`ensurepip` support when no `uv` is available.

`orgo-runtime-receipt.json` reports preparation/dependency status, not activation
or successful tests. No services are restarted, application paths switched,
profiles copied or Orgo computers provisioned. A runtime snapshot has no Git
checkout metadata; the receipt, not a fabricated Git HEAD, identifies it.

Before activation, use its own `scripts/run_tests.sh` for the included delivery
tests and relevant upstream gateway tests. Then verify the intended profile,
model/provider dependencies, a synthetic operator/specialist exchange and a
controlled restart. Keep the original runtime available for rollback. Do not
run an in-place `hermes update` inside this snapshot; prepare a newly verified
version and switch only after acceptance.

Initial overlay evidence (2026-09-08): all 52 targeted delivery, admission and return-route
tests passed in the isolated runtime on the primary Linux Orgo computer, with
its own locked dependencies. The live checkout remains clean at `63279301` and
the snapshot receipt still reports `activated: false`. The preparation helper's
9 local tests also pass. The broader local snapshot suite has an existing
`test_model_options_preserves_canonical_custom_row_after_agent_init` failure,
also reproduced on the unmodified upstream snapshot. This is not a clean
release sign-off. Runtime activation remains a separate unfinished gate.

The previous attribution overlay contains source changes through `5216da4`,
including structured task attribution and live timeline delivery. Its 56 focused
tests pass against the matching 0.21 snapshot locally and on the primary Linux
computer in `orgo-team-63279301-a19534cc`. That snapshot has locked dependencies
ready but remains unactivated. Its bootstrap required the pinned `uv` from the
previous isolated snapshot after system Python lacked `ensurepip`. The helper's
subsequent fresh-bootstrap retry fix passed 10 local tests and successfully
resumed dependencies on that actual Linux snapshot using a working Python.
The original
`63279301.json`/`.patch` pair is retained for the previous prepared runtime and
contains only changes through `3f10fb5`. Do not assume the current fork HEAD is
what any pinned snapshot runs; inspect its exact overlay receipt.

The previous scoped-cleanup overlay is prepared at
`/root/.hermes/desktop-runtime/orgo-team-63279301-fde45f05` and remains
unactivated. Its 158 focused Linux tests pass (6 platform skips).
`tests/test_runtime_acceptance.py` is a manual real-server check, not part of
the ordinary unit suite. Copy it to a disposable path on the intended computer,
then invoke the candidate's own `scripts/run_tests.sh` with that absolute test
path. Use `--basetemp=/new/disposable/evidence-path` to retain logs and the JSON
report; pytest clears that path, so never reuse a directory containing user
data. Signal-free safety preflights for both cleanup paths must pass before
any backend starts.
The test uses a private synthetic Hermes home, local mock model, loopback-only
authenticated WebSockets, bounded recovery, and only test-owned process cleanup.
Lazy dependency installs are disabled for this synthetic test. It does not
activate the candidate or prove Mac reconnect/Keychain behavior.

That scoped-cleanup candidate passed the earlier guarded real-server test in 23 seconds on
the primary Linux computer. Both production Desktop backend identities and
the messaging gateway identity (PID plus creation time) were unchanged across
the final run. Earlier candidates failed this isolation requirement despite
passing chat/recovery assertions; do not reuse their acceptance as a rollout
sign-off. The current receipt still says `activated: false`.

The delivery-modes candidate is prepared separately at
`/root/.hermes/desktop-runtime/orgo-team-63279301-af31e4da`, with its own locked
environment and `activated: false`. Before porting, the newer tests reproduced
12 failures against the older candidate. The port passed 212 local focused
delivery/cleanup tests (6 platform skips), plus 294 state/ownership tests
(2 skips). The preparation helper's 10 tests and focused lint passed.

The manual acceptance test now pins this new overlay and adds passive
transcript persistence without model work, plus pending passive/active receipt
delivery after cold resume into a seeded compression continuation. The seeded
scenario tests routing and recovery, not actual model-driven summarization.
Do not run the updated acceptance script against the older snapshot or treat
its earlier pass as evidence for these newer scenarios.

Linux regression validation returned 507 passed, 1 failed and 6 skipped across
16 files. The failure is
`TestFTS5Search.test_search_projection_skips_context_enrichment_queries`: the
trace assertion expects one context-enrichment query and observes zero. It
also fails unchanged in a fresh archive of upstream `63279301` with its own
locked environment (`/tmp/orgo-upstream-baseline.omgFzR`). The test was not
disabled or weakened. This is an inherited Linux failure, not a green full
regression or release sign-off. Production activation remains unfinished.

The expanded real-server acceptance passed on Linux in 40.8 seconds, using
four local mock-model requests. Passive notices used zero model attempts;
the interrupted active receipt settled after one recovery retry. Cold resume
into the seeded continuation delivered a passive and an active result under
their original receipt identities. Authenticated reconnect and wrong-token
rejection also passed. All test-owned processes were stopped, and both
production Desktop backends plus the messaging gateway retained identical
PID/create-time identities. Evidence is retained at
`/tmp/orgo-delivery-verification.olmZLJ/evidence-delivery-v1/test_actual_backend_auth_chat_0/`.
The production source remains clean at `63279301`; the candidate remains
unactivated. This is cloud backend evidence, not installed Mac release proof.

The previous worker-links candidate is prepared at
`/root/.hermes/desktop-runtime/orgo-team-63279301-b2542a35`.
Its manifest checks 21 output files; only the
server collector and its regression test differ from the delivery-modes
candidate. The locked environment, turn admission, passive/wake semantics,
compression routing, and both same-home cleanup guards are unchanged.

The previous candidate failed two new worker-link regressions before the port.
The port passed 175 tests across 11 files on both macOS and the actual Linux
computer (3 platform skips each), plus 10 local preparation-helper tests and
focused lint. The extended real-server acceptance passed on Linux in 58.7
seconds. A task completed by `analyst` and then assigned to `reviewer` delivered
the original `analyst` worker-session reference through the actual board poller,
live WebSocket notice, and saved transcript. That passive delivery ran no model.
Existing authenticated chat, wrong-token rejection, crash-at-model-boundary,
one recovery retry, and seeded compression-resume checks also passed using
four local mock-model requests in total. All test-owned processes stopped;
production Desktop backends and the messaging gateway retained identical
PID/create-time identities. The live source remained clean at `63279301`.
Evidence: `/tmp/orgo-worker-link-verification.b834fy/` on the primary computer.

The candidate remains unactivated. These focused tests do not replace the
previously documented inherited Linux FTS trace failure or the broader release
gates, and they do not prove Mac sleep/remote reconnect or a deployed client.
Old overlay files remain intact for provenance. The current manual recovery
acceptance test requires the cancellation checksum and rejects older candidates.

The additional manual `tests/test_team_acceptance.py` exercises an authenticated
operator conversation creating a profile, assigning a task through the real
Kanban tool, and receiving its actual worker's result without another user
prompt. Copy **both** this file and `tests/test_runtime_acceptance.py` into the
same disposable test directory; the team test reuses the signal-free startup
cleanup preflight and WebSocket helper from the latter. Invoke the runtime's
canonical `scripts/run_tests.sh -j 1 --file-timeout 240` with the absolute team
test path and a fresh disposable `--basetemp` path. It does not require an
overlay receipt, so it can also verify the local source checkout. It remains
a manual acceptance check, not an enabled CI lane.

The team check passed locally (7.6 seconds) and on the worker-links Linux
candidate (25.5 seconds), with seven loopback mock-model requests per run. A
single controlled dispatcher pass launched one real specialist; its terminal
calculation succeeded, the worker exited normally, and the returned notice
kept its actual profile/session attribution. Histories stayed in their own
databases and unrelated private content was absent from model requests.
Cloud evidence is under `/tmp/orgo-team-acceptance.hhfKAR/`. Production process
identities were unchanged. Scripted-model and single-dispatch evidence does
not establish real-model planning, unattended scheduling, cross-computer
permission grants, or an installed Mac release.

The existing pinned `test_runtime_acceptance.py` also passed after extracting
the shared preflight (39.7 seconds on Linux). Final checks found no remaining
test-owned processes on either computer, unchanged production process
identities, a clean live `63279301` checkout, and all 21 candidate output hashes
matching the manifest. The candidate receipt still reports `activated: false`.

## Cancellation/history Linux candidate (2026-09-08, unactivated)

The previous preparation target was
`/root/.hermes/desktop-runtime/orgo-team-63279301-4a306c07`.
Manifest `63279301-cancellation.json` verifies 28 output files and patch SHA-256
`4a306c07ec4aaf7cc6283bd8d34a4061bc44d5aaafc169e70290b9c9d6488e72`.
It preserves the prior overlay's unchanged output hashes and the live 0.21
runtime's admission, notification, and same-home cleanup behavior.

Verification with the candidate's own locked environment:

| Check | macOS | Actual Orgo Linux |
| --- | --- | --- |
| 84-file targeted Kanban/gateway/notification regression | 674 passed, 9 skipped; 22.6 s | 678 passed, 5 skipped; 125.0 s |
| Real authenticated cancellation, restart, and exact worker link in REST | 1 passed; 10.0 s | 1 passed; 15.7 s |
| Operator → specialist → automatic operator return | 1 passed; 7.6 s | 1 passed; 20.8 s |
| Authenticated transport, crash recovery, reconnect, and delivery attribution | Not rerun on Mac for this candidate | 1 passed; 33.7 s |

The preparation-helper suite also passed all 10 tests; focused Ruff and diff
whitespace checks passed. The first broad Mac attempt lacked optional Slack/ACP
test dependencies, reproduced in the previous candidate; installing the locked
`dev`, `slack`, and `acp` extras resolved that collection/failure pair without
source or lockfile changes. These extras enable imports, not running services.
The first Linux manual command collected no tests because the runner split the
space-separated `--basetemp` value; the corrected `--basetemp=<fresh-path>` command
passed. Its failed invocation log is retained, not counted as an application pass.

Final read-only verification confirmed all 28 candidate hashes, the clean live
`63279301` source, unchanged PID/create-time identities for both production
Desktop backends and the messaging gateway, and no remaining test-owned
processes. The receipt is `dependencies_ready`, `activated: false`.

Local evidence: `/tmp/orgo-runtime-cancellation.1YawtU/`.
Linux evidence: `/tmp/orgo-cancellation-verification.VEUipw/`, including
`linux-regression.log`, `linux-cancellation-v2.log`, `linux-team.log`,
`linux-recovery.log`, and the corresponding disposable evidence directories.
Only the completed archive's `base-complete`/`candidate-complete` directories
were tested; earlier truncated archive extractions were retained unused.

These are real backend/worker tests with loopback scripted models and controlled
dispatch, not proof of real-model planning or unattended scheduling. The inherited
Linux FTS failure, pending CI/A2A repairs, native Mac acceptance, and installed
release gates remain open. No production runtime was activated or replaced.

## Normal gateway scheduler acceptance (2026-09-08)

The team test now runs two separate disposable-home cases: the prior single-pass
dispatch and the normal gateway's background loop. The second launches
`python -m gateway.run` with messaging platforms unconfigured, a one-second
configured interval, and one-worker concurrency. It does not replace the tick,
spawn, notification, or completion paths. After the operator creates a specialist
and its task, the scheduler launches the real worker without a manual dispatch.
An event holds the scripted model's first worker response until the test verifies
the worker's parent is the scheduler and its home is the specialist's profile.
The worker then runs the terminal calculation, completes its task, and returns
an attributed result that wakes the operator without a second user prompt.

Both cases passed on macOS (2 tests, 26.9 seconds) and the inactive `4a306c07`
Orgo candidate (2 tests, 50.3 seconds). Each case used seven local scripted-model
requests. The scheduled worker exited before cleanup and the gateway remained
live after completion; its exit code is not asserted from a non-parent process.
Separate histories, absence of unrelated private content, exactly one successful
task run, and exactly one operator acknowledgement were verified in both cases.

Evidence: `/tmp/orgo-scheduler-acceptance.kt6UxB/` locally and
`/tmp/orgo-scheduler-acceptance.kMHcHt/` on Orgo. This establishes automatic
pickup/return for one task through the real gateway, not arbitrary real-model
planning, failure/retry bounds, cross-computer grants, or long-running unattended
reliability. The existing production gateway and installed Mac app are unchanged.

## Bounded protocol-retry checkpoint (2026-09-08, local source)

`tests/test_scheduler_retry_acceptance.py` runs the actual messaging-gateway
scheduler in a disposable home, without messaging platforms, manual dispatch
ticks, or mocked spawn/exit hooks. A scripted worker exits without completing
its task, including after the CLI's normal corrective prompts. One task succeeds
on its next worker attempt; a second keeps failing and must stop at its configured
two-failure bound. After a real gateway restart, a fresh lower-priority task must
complete while the exhausted task remains blocked with no additional run. This
positive dispatch barrier avoids a sleep-only claim that no retry occurred.
Each run's recorded conversation must still exist in its own profile database.

The initial valid real-worker scenario reproduced a third worker launch despite
the two-attempt bound (73.37 seconds). The cause was `recompute_ready` checking
only the ordinary failure counter after the protocol-violation handler had
blocked the task using a separate streak. Three focused cases also reproduced
automatic reopening; the one-attempt control passed. Readiness now honors both
budgets without disabling explicit operator unblock/retry.

After the fix, the real gateway scenario passed in 80.5 seconds with 13 loopback
scripted-model requests. It covers second-attempt recovery, exhaustion, restart,
fresh-task dispatch, and retained isolated worker histories. The full targeted
task suite passed 482 tests with 2 platform skips across 66 files (22.4 seconds).
Focused Ruff and `git diff --check` passed. Evidence is retained under
`/tmp/orgo-retry-acceptance.ULgBgH/`, including `regression-before.log`,
`acceptance-before.log`, `acceptance-after.log`, `broad-regression.log`, and
`evidence-after/test_gateway_bounds_worker_ret0/retry-acceptance-report.json`.
The operator-to-specialist handoff regression also passed both dispatch modes
(2 tests, 20.5 seconds). A final resolved-home process inventory found no
remaining test-owned processes.

Two earlier harness attempts are retained: one used an unsupported initial-status
fixture value, and the other counted model requests instead of worker attempts,
overlooking the CLI's corrective prompts. The final harness identifies the real
run in the task database; production retry policy and the 30-second crash grace
were not weakened for the test.

At this historical checkpoint the fix was local only. The immutable `4a306c07`
candidate still contains the reproduced readiness bug; the new `7533a44a`
candidate above supplies the forward-port and Linux verification.
This acceptance covers clean-exit protocol failures, not every
timeout, quota, mixed-failure, or long-running scheduling case. The CI/A2A approval
requirements and installed Mac release gates remain open.
