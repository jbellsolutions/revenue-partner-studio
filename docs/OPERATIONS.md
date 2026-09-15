# Updates, backups, restoration and uninstall

## Keep installation records private

Record release tag/commit, selected account/project/service/computer IDs, provider/profile and verification status in the owner’s private notes. Preserve `.revenue-partner-studio/`, including the password and resource receipts, in private encrypted storage. None belongs in a public fork or issue.

## Back up before updates

Back up the Railway `/data` volume, including SQLite databases and `connection-key`, using Railway’s supported volume backup/snapshot feature. Prefer a consistent snapshot; do not copy an active SQLite file alone while ignoring its WAL. For file-level backup, quiesce only the selected gateway after checking active work, use SQLite’s backup API, and include the matching encryption key. Encrypt off-service copies and verify their checksums.

On each computer, retain consistent Hermes database snapshots and the matching profile/configuration/memory/skill files, credentials and Studio connector state. Credential backups are private recovery artifacts, never import bundles. The connector installers create and verify backups of existing homes before modifications. Check their saved backup locations before updating. Do not stop unrelated business services.

## Update deliberately

Review the new release notes and checks. Fetch the public release into a clean independent source folder, verify checksums, and run relevant compatibility tests. Back up state, deploy the new gateway build to the same Railway service/volume, and confirm the URL/login/computer bindings remain unchanged. Use the existing connector update/repair path one computer at a time; it checks and preserves existing installations. Recheck real chat/tools, handoff and screen ownership before proceeding to the next computer.

Do not blindly merge Hermes upstream. Pin the reviewed runtime and preserve provider isolation and custom coordination. Internal IDs and paths intentionally keep historical names; changing them can create a second installation. Older applications remain rollback clients until acceptance passes.

## Optional public website on the existing service

The cloud container includes the fixture-only public website. To serve it from the same Railway service, set `STUDIO_WEBSITE_URL` to its canonical HTTPS origin and attach that domain plus its `www` alias to the existing service on port 8788. Keep the private app on a separate hostname. The gateway refuses a public website origin that matches its private app hostname. `STUDIO_WEBSITE_DIR` is an optional directory override; the packaged files are selected by default.

Keep DNS with the current provider when it supports an apex ALIAS, ANAME or flattened CNAME. Use the exact targets Railway reports for each domain, preserve existing records, and export a backup before editing. Do not guess an IP address from the target. Deploy and test the host routing before changing the public domain's DNS. Validate each hostname's DNS and HTTPS certificate independently. An attached domain or propagated record alone does not establish working HTTPS.

Railway also requires a DNS TXT record for ownership verification for each hostname. Its API returns `status.verificationDnsHost` and `status.verificationToken` separately from `status.dnsRecords`; a routing-only summary can omit this requirement. Publish the exact returned name and value, then verify both DNS routing and ownership before checking certificate issuance. See [Railway's domain API documentation](https://docs.railway.com/integrations/api/manage-domains).

Only the public host serves `/`, `/demo`, `/build`, `/prep`, public assets and preparation downloads. Its `www` alias redirects those paths to the canonical origin. Public hosts reject private APIs, setup endpoints and WebSockets, even when a client supplies an owner cookie. Their content security policy forbids agent-service connections. The private app retains its login and computer connections on its own host; add only that app origin to `STUDIO_ALLOWED_ORIGINS`. Existing connector URLs can remain in service during a domain transition.

This option requires no second Railway service. Cloudflare Pages remains an independent supported destination for the same public site. Unset `STUDIO_WEBSITE_URL` to disable the optional host routing; restore the previous DNS targets when rolling back public hosting. Keep public DNS changes separate from runtime upgrades and note deployment transitions in reliability records.

## Repair an existing Studio extension

Use `distribution/update-extension.py --config <existing-private-connector-config> --source <reviewed-release-directory> --check` with that installation’s Hermes Python. Then use the same arguments with `--apply` after the check reports no accepted work. This updater verifies the saved computer identity and exact supervised service ownership, stops only the Studio connector, rechecks work before stopping its runtime, and backs up source and consistent Studio databases. Legacy Orgo paths are resolved from the matching running Studio processes; the owned screen wrapper and connector configuration are backed up before migration. It does not replace native Hermes, homes, profiles or provider credentials.

The updater checks the authenticated runtime’s capabilities before reopening cloud work. A failed startup restores the prior extension and service configuration. Backups are retained beside the private connector configuration under `extension-backups/`; keep them private. Mac services use the interactive process class because they serve immediate browser requests. Native source, application identifiers, ports and service labels remain the same.

Check `status` for separate connector/runtime readiness and extension versions. `screen.status` is read-only: it neither allocates a screen nor renews a lease. An unverified live process is preserved for ownership reconciliation. The Advanced screen count starts with the existing four-specialist baseline. Higher counts require a host-specific qualification record and measured resource headroom; a setting alone does not prove capacity. Lowering a limit preserves occupied assignments.

“Repair screen ownership” verifies the selected specialist’s process groups, display, listening ports and Chrome data directory before restoring ownership records. It does not stop services, change assignments, clear human control, or remove browser data. Ambiguous or mismatched owners remain blocked. A private ownership backup is retained. This operation repairs missing records; it does not establish browser visual acceptance or authorize a different agent’s desktop.

An existing Mac repair download uses this same guarded updater and runs compatibility checks in a temporary home, so it never contends with the live Studio queue. It retains a healthy pairing and can renew a failed pairing only for the saved workspace using the owner-scoped repair credential. A repair download is marked connected only when its specific installation job reports a ready runtime. An already-connected older companion cannot complete that repair flow. Low local disk space still blocks imports and durable writes; diagnostic-file failures alone do not close a working transport.

## Restore and prove it

Restore a backup into an isolated recovery environment first. Use the matching gateway database plus encryption key and the exact saved runtime version. Avoid two active gateways/connector owners for the same computer: keep recovery connectors offline until the original is quiesced and the owner approves cutover. Validate SQLite integrity, verify known profile/history records and credential decryptability without printing secrets, then test one harmless task and its assigned screen. Record what was restored and verified.

For rollback, redeploy the prior known-good gateway artifact against its compatible data snapshot and restore the prior connector source/configuration when required. Keep backup files until the restored system passes real verification. Restoration is a live acceptance check; a documented procedure alone is not evidence it passed.

## Uninstall without losing work

First choose whether the owner wants to retain histories/files. Back up the chosen state and stop only this installation’s connector/runtime and optional companion services. Revoke its private pairing tokens/grants. Remove the matching Railway service and volume only after explicit deletion approval; removing the volume destroys its connection records and encryption key. Existing Orgo computers are not deleted by uninstall. Do not remove a shared Hermes home or unrelated runtime. Keep the owner’s original local Hermes installation.

The assistant can inspect exact saved launch-service labels and Supervisor configuration to identify this installation. Do not use broad process-name kills or delete all similarly named directories. Close and remove only the matching product app if the optional Electron client was installed.

## Automatic connector recovery

Previously connected Orgo computers receive separate, lightweight connection checks. After 30 seconds of observed disconnection, Studio diagnoses through the existing Orgo API. It starts only a verified `EXITED` or `FATAL` Studio connector whose runtime is still healthy and whose ownership lock is free. `RUNNING`, `STARTING`, `BACKOFF`, intentional `STOPPED`, paused access, unknown ownership, and unavailable Hermes are preserved. The repair path does not invoke the installer, rotate pairing credentials, restart Hermes, or modify screens.

Each computer has one persisted incident ID. API and SSH attempts share that receipt; uncertain starts are reconciled rather than repeated. The computer-side helper records intent before starting the connector and enforces two starts per ten minutes. The gateway also limits attempts. A repair that cannot be resolved within ten minutes requires review. Reconnection remains independent of browser or Mac availability.

`GET /api/computers` includes optional `recovery` information: state, detail, reachability, connector, Hermes readiness, saved-conversation readiness, last successful check and whether restricted SSH is configured. `POST /api/connections/repair` with `computerId` requests the same bounded checks. `connection.reconcile` reattaches surviving sessions and verifies expired histories in their original profiles; it never submits a prompt. Individual conversations and screens retain their own readiness and errors.

An opened but unused chat may have no persisted Hermes history. For older queued turns, reconciliation follows their existing accepted request and completed delivery to the same profile's stored history. Neither case creates a replacement task or moves messages between profiles. Missing or mismatched evidence still requires review.

### Optional restricted SSH

SSH is disabled until an installation assistant has verified a real provider endpoint, the computer binding, host fingerprint, and a dedicated restricted key. An SSH daemon or a VNC address does not prove native Orgo SSH reachability. Do not infer endpoints or replace images to obtain support.

Install the reviewed `distribution/recover.py` as `/root/.hermes/studio-cloud/recover.py`, root-owned and not writable by other users. For a dedicated Ed25519 key, the server's authorized-key entry must use `restrict,command="/usr/bin/python3 /root/.hermes/studio-cloud/recover.py"` and the key's public portion. Verify the restriction in the actual SSH server configuration: no shell, PTY, agent forwarding, port forwarding, or user startup scripts. Keep this key separate from interactive Codex access. Confirm the server fingerprint through authenticated Orgo administration, not an unauthenticated scan.

The owner-only `POST /api/connections/ssh` accepts `{computerId, configuration:{host,port,user,privateKey,hostKey}}`. `hostKey` is the verified `ssh-ed25519 BASE64` public host key. The gateway rejects unrestricted shell access and mismatched computer identity before saving configuration with its existing authenticated encryption. Supply configuration through a private authenticated request, never command arguments or a committed file. Native SSH endpoint discovery and remote key provisioning must be completed by the installer before this API is called. Public demos and agent RPCs cannot call it.

Send `{computerId,configuration:null}` or use **Disable SSH recovery** to remove the gateway's saved key immediately. Also remove only that dedicated public key on the computer through authorized administration; if the computer is unreachable, track that remote revocation as pending. Provider authorization denials do not trigger SSH fallback. API timeouts may fall back only to a separately verified SSH configuration using the same request receipt.

Backups require the gateway database plus its connection encryption key and the computer-side recovery receipts. Restore them together so accepted starts retain their identities. To suspend automatic computer-side starts, create the Studio-owned `studio-cloud/recovery-disabled` marker; remove only that marker to re-enable. Older clients and existing connections remain rollback options.

### Client pilot gate

Begin client distribution with one private Studio per recipient, using their own Railway and Orgo accounts and computer/provider credentials. Complete the repaired-version qualification, permitted browser acceptance, backup/restoration check and an independent installation before calling it client-ready. SSH recovery is optional, and unsupported native SSH must not block the normal outbound connector. Shared SaaS tenancy is not part of this release.
