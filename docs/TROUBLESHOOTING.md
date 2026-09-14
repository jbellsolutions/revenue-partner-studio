# Troubleshooting

| Symptom | Assistant action |
| --- | --- |
| Preflight says Railway is unauthenticated | Start the supported Railway login flow; owner completes account consent, then rerun preflight. |
| Setup stops with an uncertain resource request | Inspect the exact project/service and saved intent. Resume to discover the existing resource. Clear an intent only after proving the create did not happen; do not allocate replacements blindly. |
| The destination differs from saved setup | Use the original explicit binding or a separate folder for a genuinely separate install. Never rewrite a binding to bypass the check. |
| Railway deployment failed | Read the current build/runtime error. Use the full repository build context, `cloud/Dockerfile`, Node 22.22+, one replica, `/data` and the required variables. Repair and redeploy the same service. |
| Login fails | Read the owner password from the private setup store or approved password manager. Reset only the selected service’s password after owner authorization. Never publish it. |
| Computer is offline | Choose Connect / Repair. Verify its ID, running Linux status, authorized Orgo key and displayed installation job error. Keep the existing Hermes home intact. |
| Provider saved but a turn fails | Distinguish credential acceptance, model entitlement and tool access. Inspect expiration/quota errors. Do not switch billing automatically. |
| Screen fails while chat works | Repair the viewer/assignment separately. Check current owner, takeover and capacity. Do not restart all runtimes to fix a single viewer. |
| Local Hermes not discovered | Check the supported native install paths and extension compatibility shown by the companion. Preserve the original installation; use the supported Hermes installer only with approval. |
| Mac folder picker unavailable | Confirm the companion is online and approved folder access is allowed. Mac desktop control is intentionally hidden. |
| Browser QA denied by administrator policy | Respect the restriction. Record affected checks as unverified until the policy issue is resolved; do not use an alternate browser or proxy to bypass it. |

Private diagnostics can contain tokens and paths. Summarize and redact errors before opening public issues. See SUPPORT.md.
