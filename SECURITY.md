# Security

Each installation is one trusted owner’s private workspace. Do not expose it as a shared tenant service or invite mutually untrusted users. Agents on a shared Linux computer are not isolated operating-system tenants.

The gateway requires a strong owner password and HTTPS, protects requests against cross-site submission, encrypts stored connection credentials and authenticates outbound connectors. Profiles, provider credentials, conversations and execution belong to their owning computer. Back up the gateway encryption key with its database; losing either can prevent recovery.

Provider credentials are isolated by selected computer/profile. Imports exclude credentials and machine-specific settings. Cross-computer tasks and artifacts require directional grants and, where configured, approvals. Takeover pauses the assigned screen’s automation. These controls do not make arbitrary imported scripts safe; imports never execute scripts during transfer.

The public site is a separate static build. Its demo uses fixture data and a restrictive Content Security Policy including `connect-src 'none'`. It never mounts the authenticated app.

Never publish secrets, session cookies, screenshots containing credentials, source-state backups or live computer IDs in issues. Report a suspected vulnerability through this repository’s private GitHub security reporting when available. If unavailable, request a private reporting channel without disclosing the vulnerability or credentials publicly.

Before deploying, inspect locked dependency advisories, test relevant permission/credential paths, and review actual browser and runtime results. No independent security audit is claimed by this beta.
