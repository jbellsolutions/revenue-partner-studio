# Round two — interface and experience

Revenue Partner Studio v0.2.0-beta.2 keeps the existing computers, Hermes harness, provider routing and stored profiles. This release changes the browser experience and adds a bounded selected-skill transfer to the existing import system. Model generation speed is outside this release.

## Chat and screens

Choose the model beside the attachment button in the composer. Search the connected profile's catalog or open **Enter a model ID**. Provider credentials are still managed in Settings. Model changes retain the conversation; a running turn finishes before a pending choice is applied. An activation failure remains visible and blocks the next turn until a valid model is selected. There is no billing fallback.

Bot faces are consistent in the agent rail, conversation and team activity. Activity indicators reflect recorded work. Completed messages retain their rendered Markdown during streaming; text deltas paint in small batches while completions and approvals arrive immediately. Reading history stops automatic scrolling until the reader returns to the bottom.

Watching a screen keeps the local pointer visible. **Take control** and **Resume agent** remain explicit. Expanded screens include those controls, the owning agent and the connection status. A disconnected screen is covered by a reconnect notice. The existing four-screen assignment and queue are unchanged.

## Bring skills from local Hermes

1. Open **Import from Hermes** on the destination computer. A connected Mac is selected by default. If needed, **Connect local Hermes** prepares the existing Mac companion.
2. Choose **Selected skills**, select a source profile and an existing destination agent, then search and select skills.
3. Review the proposed changes and approve the copy to the named computer and agent.
4. To update later, repeat the same selection. This is an explicit one-way copy, not automatic synchronization.

Selected-skill transfers require this release's compatible Studio extension on both computers. Older companions show an update message and continue supporting complete-profile imports. A selected-skill request cannot fall back to a full profile export.

The copy changes only selected skill files. It leaves the destination's identity, model configuration, credentials, permissions, memory and history intact. Scripts are copied as data and never executed during transfer. A running destination agent must finish before its skills are changed; the cached prompt is refreshed for its next turn. Existing disabled-skill settings remain in effect.

Conflicting edits preserve the installed skill and a complete incoming version in the destination's import records. Hashes identify later changes, backups preserve replaced files, and retries reconcile previously copied files. Source deletions do not remove destination files. Source connection credentials and machine-specific configuration are excluded. Review Mac-only tools before using an imported skill on Linux.

**Complete profiles** retains the existing reviewed profile/history import. **Click / drop a Hermes export** retains destination-bound bundle uploads. Both preserve prior imported identities and conflict records.

## Compatibility and rollout

App IDs, launch services, data directories, connector URLs and the Hermes runtime pin stay unchanged. New installations receive the extension in their runtime package. Existing computers need a compatible extension update during an idle window, after backing up their current installation. Do not interrupt an accepted task to promote this release, or reinstall a Hermes home to update the interface.

Gateway/interface deployment does not by itself update an already-installed computer extension. Until extension promotion is verified, selected-skill transfers remain unavailable there. Keep the prior clients and deployment for rollback.

The public demo remains fixture-only and consumes no model credits. `revenuepartnerstudio.com` is the public site; `app.revenuepartnerstudio.com` is the custom address for the private gateway. Domain activation requires DNS ownership verification; the existing gateway address continues working during the transition.

See [release evidence](RELEASE-CHECKS.md) for completed automated checks and pending live acceptance. Simulated component tests do not establish browser appearance, real provider entitlement, takeover behavior or measured end-to-end speed.
