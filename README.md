# Revenue Partner Studio
### by Your AI Guy

Your agents. Your computers. One workspace.

A private browser interface for persistent **Hermes agents on Orgo computers**, with an optional companion for local Hermes on a Mac. Keep your agents and conversations on the left, work in the center, and the selected computer’s screen on the right.

**[Try the free demo](https://revenuepartnerstudio.com/demo)** · **[Build your own](https://revenuepartnerstudio.com/build)** · **[Before you start](docs/BEFORE-YOU-START.md)** · **[Copy setup prompt](https://revenuepartnerstudio.com/build#setup-prompt)**

The demo uses invented sample data and simulated screens. It has no connection to the publisher’s computers, no model calls, no uploads and no account requirement. Your own installation uses your own hosting, computers and model access.

## Install with Claude Code or Codex

Give your coding assistant this repository URL and the request below. It performs the technical setup; you finish account authentication and approve costs. Full instructions: **[INSTALL.md](INSTALL.md)**.

```text
Install Revenue Partner Studio by Your AI Guy from
https://github.com/jbellsolutions/revenue-partner-studio at v0.2.0-beta.4.
Read AGENTS.md and INSTALL.md. Use an independent folder, check prerequisites
and accounts, explain costs, deploy my private Railway workspace, connect my
selected Orgo Linux computer, configure my selected model provider, and verify
real chat, tool use, screen takeover and reopening. Use the resumable setup
driver. Preserve existing data. Do not use publisher credentials, purchase
capacity without approval, or enable an unapproved paid fallback. Do the
technical work and report any verification that remains incomplete.
```

[Open the copy button](https://revenuepartnerstudio.com/build#setup-prompt) · [Download the complete prompt](docs/SETUP-PROMPT.txt) · [Word preparation guide](docs/Revenue%20Partner%20Studio%20-%20Before%20You%20Start.docx)

GitHub renders this fenced prompt with its own copy control; the website also provides a one-click button.

## What you get

- Computer switching with separate conversations, drafts, profiles, credentials and screens.
- Hermes profiles, instructions, skills, memory and history on their owning computers.
- Searchable conversation recall across every profile on the selected computer, including preserved imports and compatible histories from earlier Studio clients.
- Provider settings, supported subscription flows, OpenRouter models and manual model IDs.
- Persistent specialist agents and permission-controlled handoffs across connected computers.
- Four prewarmed screen slots with private per-agent browser data, human takeover/resume and durable capacity queuing.
- Local headless research overflow for public web work; authenticated, upload, desktop and takeover work always waits for a visible screen.
- Files, attachments and reviewed Hermes imports, including optional native Mac pairing.
- Outbound cloud connectors: the browser needs no Mac SSH tunnel or Tailscale route.

Select a computer, and you are talking to that computer’s Hermes agents. Studio routes requests; Hermes makes model calls and executes tools. See [architecture](docs/ARCHITECTURE.md).

## Before you start

Use [Claude Code](https://code.claude.com/docs/en/quickstart) or [Codex](https://openai.com/codex/), a [Railway account](https://railway.com/pricing), and an [Orgo account](https://orgo.ai?r=aiguy) with a running Linux computer. Begin with 8 GB RAM. Bring your own supported model subscription or API key. Your installation assistant and agent runtime authenticate separately.

The Orgo link is an affiliate link; no particular discount is promised. As checked September 14, 2026, Railway Hobby starts at $5/month and Orgo Hacker lists an 8 GB computer at $29/month. Allow roughly $34/month before model costs and overages, and confirm current prices before approving resources. Existing capacity can be reused. Full details are in [Before You Start](docs/BEFORE-YOU-START.md).

## Release status

**v0.2.0-beta.4** is a private-client pilot, not a shared multi-tenant SaaS. The GTM canary opened four real specialist browser workspaces on distinct screens, queued a fifth, released every viewer lease and reacquired a fresh screen identity. All four existing Orgo computers then passed guarded update, Hermes readiness and specialist-screen checks. An independent recipient installation, administrator-permitted visual/takeover acceptance and the clean 24-hour qualification remain release gates, so this beta is not yet an unconditional client-ready claim. Mac chat and approved files are supported; Mac desktop control is hidden. There is no notarized public Mac binary in this release. Runtime entitlement depends on the selected provider.

The public site is live at [revenuepartnerstudio.com](https://revenuepartnerstudio.com), and the private workspace uses its separate application host. The installation instructions and preparation files are also available directly in this repository.

Read [supported features and release checks](docs/RELEASE-CHECKS.md) before client rollout. Model-speed work is outside this release.

## Documentation

[Installation](INSTALL.md) · [Operations, updates and restoration](docs/OPERATIONS.md) · [Troubleshooting](docs/TROUBLESHOOTING.md) · [Profiles, imports and providers](docs/WORKSPACE.md) · [Security](SECURITY.md) · [Privacy](PRIVACY.md) · [Contributing](CONTRIBUTING.md)

## Development

The public site and private application are separate builds.

```sh
npm --prefix cloud ci --ignore-scripts --workspaces=false
npm --prefix cloud test
npm --prefix cloud run typecheck
npm --prefix cloud run build
npm --prefix site ci --ignore-scripts --workspaces=false
npm --prefix site test
npm --prefix site run build
node --test distribution/setup.test.mjs distribution/configure.test.mjs
```

Use Node 22.22 or newer (Node 24 recommended). For runtime changes use `scripts/run_tests.sh` with the relevant suites, after `uv sync --frozen --python 3.11 --extra dev --extra mcp --extra anthropic`. See [AGENTS.md](AGENTS.md).

## License and attribution

MIT, including the original Nous Research copyright. Built on [Hermes Agent](https://github.com/NousResearch/hermes-agent), descended from AI Guy’s Orgo integration, with a Studio interface inspired by agent desktop workflows. See [NOTICE.md](NOTICE.md) and [PROVENANCE.md](PROVENANCE.md). This project is independent of the referenced vendors and does not include proprietary Grok code.

Read [what changed in round two](docs/ROUND-TWO.md) for the chat model menu and selected-skill imports. Existing computer extensions need the guarded beta.4 update before screen sessions and selected-skill transfers become available.
