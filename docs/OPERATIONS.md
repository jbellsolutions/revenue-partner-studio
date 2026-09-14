# Updates, backups, restoration and uninstall

## Keep installation records private

Record release tag/commit, selected account/project/service/computer IDs, provider/profile and verification status in the owner’s private notes. Preserve `.revenue-partner-studio/`, including the password and resource receipts, in private encrypted storage. None belongs in a public fork or issue.

## Back up before updates

Back up the Railway `/data` volume, including SQLite databases and `connection-key`, using Railway’s supported volume backup/snapshot feature. Prefer a consistent snapshot; do not copy an active SQLite file alone while ignoring its WAL. For file-level backup, quiesce only the selected gateway after checking active work, use SQLite’s backup API, and include the matching encryption key. Encrypt off-service copies and verify their checksums.

On each computer, retain consistent Hermes database snapshots and the matching profile/configuration/memory/skill files, credentials and Studio connector state. Credential backups are private recovery artifacts, never import bundles. The connector installers create and verify backups of existing homes before modifications. Check their saved backup locations before updating. Do not stop unrelated business services.

## Update deliberately

Review the new release notes and checks. Fetch the public release into a clean independent source folder, verify checksums, and run relevant compatibility tests. Back up state, deploy the new gateway build to the same Railway service/volume, and confirm the URL/login/computer bindings remain unchanged. Use the existing connector update/repair path one computer at a time; it checks and preserves existing installations. Recheck real chat/tools, handoff and screen ownership before proceeding to the next computer.

Do not blindly merge Hermes upstream. Pin the reviewed runtime and preserve provider isolation and custom coordination. Internal IDs and paths intentionally keep historical names; changing them can create a second installation. Older applications remain rollback clients until acceptance passes.

## Restore and prove it

Restore a backup into an isolated recovery environment first. Use the matching gateway database plus encryption key and the exact saved runtime version. Avoid two active gateways/connector owners for the same computer: keep recovery connectors offline until the original is quiesced and the owner approves cutover. Validate SQLite integrity, verify known profile/history records and credential decryptability without printing secrets, then test one harmless task and its assigned screen. Record what was restored and verified.

For rollback, redeploy the prior known-good gateway artifact against its compatible data snapshot and restore the prior connector source/configuration when required. Keep backup files until the restored system passes real verification. Restoration is a live acceptance check; a documented procedure alone is not evidence it passed.

## Uninstall without losing work

First choose whether the owner wants to retain histories/files. Back up the chosen state and stop only this installation’s connector/runtime and optional companion services. Revoke its private pairing tokens/grants. Remove the matching Railway service and volume only after explicit deletion approval; removing the volume destroys its connection records and encryption key. Existing Orgo computers are not deleted by uninstall. Do not remove a shared Hermes home or unrelated runtime. Keep the owner’s original local Hermes installation.

The assistant can inspect exact saved launch-service labels and Supervisor configuration to identify this installation. Do not use broad process-name kills or delete all similarly named directories. Close and remove only the matching product app if the optional Electron client was installed.
