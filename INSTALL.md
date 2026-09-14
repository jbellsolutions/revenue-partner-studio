# Install Revenue Partner Studio by Your AI Guy

This is the **browser-first** installation path for v0.2.0-beta.1. The coding assistant performs the commands and configuration. The owner completes account sign-in and approves concrete costs. Read [Before You Start](docs/BEFORE-YOU-START.md) first and use the [complete setup prompt](docs/SETUP-PROMPT.txt).

## 1. Prepare an independent release copy

Use a new folder, not another product’s checkout or a linked worktree. Clone the public repository, check out `v0.2.0-beta.1`, and read AGENTS.md. Verify the release SHA-256 checksums if using packaged downloads. Install Git, Node 22.22+ (24 recommended) and npm with the owner’s existing package manager. Install the Railway CLI if absent. Use an existing authenticated Railway account or initiate its supported login flow.

```sh
node distribution/setup.mjs preflight
```

This checks tools and Railway authentication without purchasing anything. State lives in ignored `.revenue-partner-studio/`, directory mode 700 and files mode 600. Keep this folder private and backed up. It contains the generated password and resumable resource receipts. A second install from the same folder resumes the first. Use `status` to inspect non-secret progress.

## 2. Resolve the owner’s destination and costs

Ask which running Orgo Linux computer to connect, and confirm access through the owner’s Orgo account. Begin with the tested 8 GB configuration. Do not create or resize a computer by default. Existing Hermes state is preserved and backed up by the connector installer.

Resolve the owner’s Railway workspace and either an explicitly selected project or a new private project. Explain one gateway service, one persistent volume and the separate Orgo/model charges. Obtain approval before creating paid resources. Use the unique project name returned by preflight when creating a project; inspect the account for that exact project before retrying any uncertain create. Resolve its production environment ID. Never use the locally linked project without confirming ownership and destination.

The assistant can use Railway’s authenticated CLI or connector. For a new approved project, `railway init --name <preflight-project-name> --workspace <owner-workspace-id> --json` creates and links it. Read `railway status --json` in this independent directory and verify the resulting project/environment. If a request times out, inspect before retrying.

Write a **private** configuration file with only these selected IDs, not credentials:

```json
{
  "projectId": "OWNER_RAILWAY_PROJECT_UUID",
  "environmentId": "OWNER_RAILWAY_ENVIRONMENT_UUID",
  "computerId": "OWNER_ORGO_COMPUTER_UUID"
}
```

Use placeholders only in documentation; the assistant resolves actual IDs. Put the file inside `.revenue-partner-studio/` with mode 600.

## 3. Install the gateway

```sh
node distribution/setup.mjs install --config .revenue-partner-studio/destination.json --approve-resources
```

The approval flag records the already obtained owner approval. The driver creates a uniquely named service in the explicit project, attaches `/data`, generates an HTTPS domain, creates an owner password privately, applies the existing `cloud/Dockerfile` configuration, and deploys the release source. It uses one replica and disables sleeping. It neither creates Orgo computers nor calls a model.

The full repository is the Docker build context. The gateway needs bundled runtime installers, the shared shell stylesheet and branding. Do not deploy just `cloud/` as an isolated folder. The volume stores SQLite metadata and its encryption key; ephemeral storage is not sufficient.

The driver checks existing resources before creating any. It journals create intentions before network requests. If the result is uncertain and the resource is not visible, it stops instead of duplicating it. Inspect the account, reconcile the receipt and resume. Do not delete `.revenue-partner-studio/` to clear an error. A conflicting computer/project/environment binding fails closed.

Wait for Railway deployment SUCCESS and verify `GET /health` reports `ok: true`. A returned deployment ID is not proof of health. On a failed build, inspect logs, repair the identified issue and redeploy the same service; never allocate a replacement to bypass a failure. See [troubleshooting](docs/TROUBLESHOOTING.md).

The assistant gives the owner the private app URL and stores `.revenue-partner-studio/owner-password` in the owner’s chosen private password manager. Never paste it into shared installation notes. Keep the state directory for safe resume.

## 4. Connect the computer

Sign in to the newly deployed private app. In Settings → Computers, save the owner’s Orgo API key, select the computer or enter its computer ID, and choose **Connect / Repair**. This is also exposed through the same setup driver:

```sh
node distribution/setup.mjs connect --approve-key-transfer
```

The assistant supplies `ORGO_API_KEY` privately to the process, after explicit approval to store that key in this exact private gateway. Do not put its value on the command line. The flag does not authorize copying some other application’s saved credential. If the key was already saved in Settings, run `connect` without a new key.

The gateway’s existing installation job validates the running Linux computer, backs up existing Hermes state, installs the pinned Studio extension and supervises an outbound connector. Repeating `connect` resumes the same active job. Keep checking the job until the actual computer is online. Failed jobs display their real error; no manual one-time credential needs to be pasted onto the computer.

## 5. Authenticate Hermes on the selected computer

Choose the intended Hermes profile in Studio. In Settings → Providers / subscriptions, use its supported sign-in flow or save a private API key with **Save and check**. OpenRouter supports searchable models and manual model IDs. Check authentication, requested-model access and a real tool turn separately. Finish OAuth/device consent in the owner’s account when required. Do not assume the installation assistant’s subscription is already available to remote Hermes.

Do not transfer existing saved provider credentials without approval for this computer/profile, or silently change billing to a different provider. Expiration, quota and missing entitlement are actionable setup results. Keep any working remote credentials intact.

## 6. Verify the real installation

After the owner authorizes a small real model/tool check:

```sh
node distribution/setup.mjs verify --approve-test
```

This reads the selected computer’s actual roster, opens one persistent conversation and asks its agent to calculate 19 × 23 using a terminal tool. It records the session and idempotent request ID before sending, then reconciles remote delivery/evidence on subsequent `verify` runs. A lost acknowledgment does not create a new task. Run verification again after completion; require answer 437 and recorded tool starts/results. Provider failures stay visible.

Then use the permitted browser automation surface to verify:

1. Real conversation and tool result appear in this computer’s history.
2. Open the selected agent’s live screen, perform a harmless browser action, take control, then resume. Confirm the displayed screen belongs to the same agent.
3. Start a harmless task, close the browser, reopen and inspect the same task’s progress/result. Do not submit a replacement task.
4. If connecting another computer, switch repeatedly, including identical profile names. Confirm no history, credential, draft or screen crossover.
5. Record the release revision, actual installation result and any remaining browser or provider blocker in private owner notes.

A health response or generated screen ticket does not count as visual acceptance. If browser security policy prevents a check, respect it and report the check as unverified. Independent recipient installation is not yet an unconditional supported claim; consult [release checks](docs/RELEASE-CHECKS.md).

## Optional local Hermes and imports

After the cloud workspace passes, use **Connect local Hermes** to download that workspace’s short-lived Mac pairing package. The assistant runs the included connection command on the selected Mac after approval. It discovers compatible native Hermes, verifies snapshots and installs the companion under the existing compatibility paths. It does not replace the owner’s original Hermes installation. Mac chat and approved files are supported; desktop control is hidden in this beta.

Use the reviewed import controls to select a source profile, destination computer and items. Folder pickers work through the companion or remote browser; bundles support click/drop. Transfers preserve conflicting versions and exclude provider credentials. See [workspace guide](docs/WORKSPACE.md).

## Finish and maintain

Deliver the owner’s private app URL, securely stored password, chosen computer/profile/provider, verification results and backup location. Explain only remaining account decisions or limitations; do not hand back technical chores. Use [operations](docs/OPERATIONS.md) for updates, backups, restoration and uninstall. Keep rollback clients until actual acceptance passes.
