# Revenue Partner Studio — installation and development instructions

When given this repository to install, read **INSTALL.md**, then carry out the technical work. Claude Code and Codex use the same procedure. Ask the owner only for missing account choices, interactive authentication, or approval of concrete costs/credential destinations. A repository URL cannot provide account consent.

## Installation boundaries

- Use an independent directory and the recipient’s explicitly selected accounts, computer and model provider. Never discover or import publisher credentials, computer IDs, operational state or personal files.
- The browser-first path is `distribution/setup.mjs`. Existing `distribution/install.py` is the legacy Electron/SSH client, not a browser prerequisite. Inherited `scripts/install.sh`, `setup-hermes.sh` and `installer/` are upstream/runtime tools, not product setup entrypoints.
- Preserve existing Hermes profiles, credentials, history and computer bindings. Existing app IDs, local data directories, launch-service labels and remote paths are compatibility identifiers; do not rename them just to match the visible product name.
- Model credentials belong to their selected computer/profile. Orgo account credentials are saved encrypted in the recipient’s gateway only after approval for that destination. Never put secrets in command arguments, source, issue bodies, logs or ordinary profile bundles.
- Do not buy or resize computers, silently enable API billing, overwrite homes, change unrelated services or retire rollback clients without authorization. Resolve uncertain resource creation before retrying. A same-name resource alone is not proof of ownership.
- Pairing does not grant cross-computer access. Respect saved directional grants, owner approvals and revocations. Agents on one OS are not mutually hostile security tenants.
- Never call real services from the public demo or mount the authenticated application there. Only fixture data is allowed in `site/`.

## Development and checks

`brand/product.json` is the product/link authority. Public docs live in `docs/`; exclude personal operational evidence from commits. Never add live IDs, credentials, histories or backups to fixtures.

Use `npm --prefix cloud test`, `npm --prefix cloud run typecheck`, and `npm --prefix cloud run build` for app/gateway work. Use `npm --prefix site test` and `npm --prefix site run build` for the public site. Installation changes require `node --test distribution/setup.test.mjs distribution/configure.test.mjs` and relevant Python distribution tests. Desktop changes also require desktop typechecking, product/connection tests and a Bot build.

Python tests must use `scripts/run_tests.sh <files> -j 2 -q`. Install locked dependencies with `uv sync --frozen --python 3.11 --extra dev --extra mcp --extra anthropic`. Do not run tests against real model credentials or production homes.

Record actual evidence in `docs/RELEASE-CHECKS.md`. Builds and simulated tests cannot prove fresh-account installation, browser appearance, real provider entitlement, or a 24-hour reliability trial. Respect browser-policy restrictions; do not use another tool to bypass a denied destination.

Updates follow `docs/OPERATIONS.md`. Review upstream Hermes changes and compatibility tests before promotion. The public repository is the development destination; historical private repositories and clients remain rollback references.
