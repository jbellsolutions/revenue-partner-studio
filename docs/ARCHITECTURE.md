# How Studio fits together

| Location | Responsibility |
| --- | --- |
| Public Cloudflare site (`site/`) | Introduction, fixture-only demo, preparation and setup prompts. |
| Private Railway gateway (`cloud/`) | Login, computer directory, durable coordination metadata, grants and event routing. One service with a persistent `/data` volume. |
| Each Orgo Linux computer (`studio/`, Hermes runtime) | Profiles, models, provider credentials, tools, memory, sessions, files, execution and screens. Outbound authenticated connector. |
| Optional Mac companion (`distribution/connect-local.py`) | Pair existing local Hermes for chat, approved folders and reviewed transfers. |

Browser, chat/status events and screens use separate channels. Every routed operation includes computer identity and relevant agent/session/task/screen identity. Requests use stable IDs; reconnects reconcile accepted work. Screen ownership remains assigned while automation, a viewer or takeover holds it; capacity is four managed screens before queuing.

The gateway never runs another lead model agent. Specialists use persistent Hermes profiles. Cross-computer work executes on the destination computer and carries only approved context/artifacts. The extension preserves Hermes’ authoritative provider/model operations and current custom handoffs.

This is a trusted private workspace, not hard isolation among hostile tenants. See SECURITY.md. Internal historical names in IDs and state paths are intentional compatibility details, not duplicate installations.
