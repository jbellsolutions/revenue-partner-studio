# Revenue Partner Studio

## Before You Start

By Your AI Guy · Preparation guide · Updated September 16, 2026

Revenue Partner Studio gives your Hermes agents a browser workspace and their own Orgo computers. You can chat, switch computers, explore skills and files, and take over an agent's screen. This guide helps you prepare your accounts before Claude Code or Codex installs your private copy.

**Try it first:** [Open the free guided demo](https://revenuepartnerstudio.com/demo). It uses sample data and simulated responses. It needs no account and consumes no model credits.

## 1. Choose your installation assistant

Use either [Claude Code](https://code.claude.com/docs/en/quickstart) or [Codex](https://openai.com/codex/). Install it and sign in. Choose a local coding session with permission to work in a new project folder. Your assistant will install the technical prerequisites, configure hosting and check the result.

A regular chat without computer or terminal access cannot perform the installation. You do not need both assistants. The browser application does not require an Electron desktop app.

## 2. Prepare your accounts

| What you need | Where to get it | What it is for |
| --- | --- | --- |
| GitHub account | [github.com/signup](https://github.com/signup) | Your source copy and optional updates. The public release can be downloaded without signing in. |
| Railway account | [railway.com](https://railway.com) | Your private web application, secure connections and persistent connection records. |
| Orgo account | [Orgo through Your AI Guy](https://orgo.ai?r=aiguy) | The Linux computer where Hermes, agents and their work run. |
| Model access | Your supported subscription or provider account | The intelligence used by agents on your computers. |

Your AI Guy's Orgo link is an affiliate link. We may receive a referral benefit. No specific discount is promised here.

Start with one running **Orgo Linux computer with 8 GB RAM**. Save its computer ID and obtain an Orgo API key from your account. One computer supports multiple agents; you do not need four computers to try Studio. The installer will show which computer it is about to connect and preserve any existing Hermes data.

Supply keys through the installer's private input or the authenticated settings screen. Do not paste secrets into a GitHub issue, commit, public demo or shared document. The key used for discovery is stored encrypted in your own private Studio service; provider credentials stay on their selected computer/profile.

## 3. Choose the agents' model provider

Your installation assistant's subscription and your agents' model access are separate connections. Being signed in to Claude Code or Codex does not automatically authenticate Hermes on an Orgo computer.

Choose an available Hermes subscription flow, such as ChatGPT/Codex, or your own API credentials, such as OpenRouter or Anthropic. Authenticate on the selected computer. Studio reports authentication, model availability and tool results separately. A supported login does not guarantee every model or subscription entitlement, and Studio must not silently switch to a paid API.

## 4. Understand the costs

The guided demo is free. Your own installation has separate hosting, computer and model costs.

As checked on September 14, 2026, [Railway Hobby](https://railway.com/pricing) starts at a $5 monthly minimum including $5 of usage, and [Orgo Hacker](https://www.orgo.ai/) lists one 8 GB computer at $29 per month. That is a planning baseline of **about $34 per month before model costs and hosting overages**, not a fixed-price bundle. Existing eligible accounts or capacity may reduce what you need to add. Review the linked prices at installation because plans can change.

Your assistant will describe the resources and ask for approval before purchasing or expanding capacity. Connecting an existing computer does not require replacing it. Model subscriptions, API usage, taxes and optional services are additional where applicable.

## 5. Optional local Hermes

You can add an existing Hermes installation on a Mac after the cloud workspace works. The optional companion requires compatible Apple developer tools; the assistant checks those for you. It is a source-built beta companion, not a notarized public Mac installer.

Local chat and approved folders are supported. Mac desktop control is hidden in this release. Imports are reviewed one-way transfers into a selected computer, with conflicts preserved. Credentials are excluded. Connecting two computers does not automatically permit their agents to send each other work.

## 6. Start the installation

Open [the repository](https://github.com/jbellsolutions/revenue-partner-studio) and copy its setup prompt into Claude Code or Codex. The same prompt is available on [Build your own](https://revenuepartnerstudio.com/build).

Ask the assistant to install Revenue Partner Studio from the repository, read AGENTS.md and INSTALL.md, prepare an independent folder, check your accounts and costs, deploy your private Railway workspace, connect your selected Orgo computer, and verify a real conversation, tool task and screen. It should preserve existing data and report any remaining checks honestly.

You handle account sign-in and consent. Your assistant does the technical setup. It should finish by giving you your private app link, a securely stored owner password, verification results and recovery instructions. Keep the password and the gateway encryption-key backup private.

**Release status:** v0.2.0-beta.4 private-client pilot. Each installation is one private workspace. The public demo is simulated, and this release is not shared multitenant SaaS. Four live GTM specialist screens and fifth-agent queuing passed on the existing canary. Independent recipient installation, administrator-permitted visual/takeover acceptance and the clean 24-hour qualification remain required before an unconditional client-ready claim. See the repository's release checks for current evidence.
