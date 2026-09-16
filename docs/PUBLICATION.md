# Public website and release maintenance

The static website is in `site/`, separately from the authenticated private application in `cloud/`. Build from the repository root with `npm --prefix site ci --ignore-scripts --workspaces=false`, `npm --prefix site run build`, and `npm --prefix site test`. Publish only `site/dist` to the `revenue-partner-studio` Cloudflare Pages project. Never publish private app state or inject model/Orgo credentials into this build.

Routes are `/`, `/demo`, `/build` and `/prep`. Preparation downloads are generated from `docs/` during the build, so the web and repository guides stay identical. Brand metadata is in `brand/product.json`. The demo imports only static fixtures and presentation styles; its Content Security Policy forbids network connections to agent services. Browser acceptance must still exercise mobile layout, keyboard access, buttons, reset, downloads and request inspection when the approved browser surface is available.

The public domain is `revenuepartnerstudio.com`, with `www` redirected to the root. Before changing nameservers, export and preserve the current authoritative DNS zone, check DNSSEC and add matching records to Cloudflare. Attach both custom domains in Pages, verify the Pages deployment, then update registrar nameservers and confirm HTTPS. An apex Pages domain requires Cloudflare nameservers. Do not replace existing mail or unrelated records based on public DNS queries alone.

## Source and package checks

Run `node distribution/scan-public.mjs` against the staged snapshot using Gitleaks. Retained false positives are reviewed synthetic fixtures, public client IDs, examples and checksums. The allowlist binds each finding to the **entire file hash**; edits cannot inherit an exception from a line number. A new finding blocks publication until reviewed. For an extracted source/runtime package, run the same scanner with its directory argument and `--directory`.

Tag `v0.2.0-beta.4` only after local checks and documented hosted results. Create a source archive, public-site archive and preparation downloads; include SHA256SUMS. Do not attach old Mac ZIPs, private operational evidence, account IDs or histories. This beta’s optional companion is built through the authenticated recipient installation; no notarized public desktop binary is claimed. Publish it as a private-client pilot until an independent installation, live browser acceptance and the clean 24-hour qualification pass.

The repository’s MIT license and upstream notices travel with the source. Review dependency licenses separately when changing dependencies. Keep the old private source and installed clients as rollback options. Update deployment and scheduled maintenance references only after the new source is reachable and verified.

## Custom application domain transition

The public site belongs at `revenuepartnerstudio.com`; `app.revenuepartnerstudio.com` points to the existing private Railway gateway. Attach the custom app domain to that existing service and use Railway's returned DNS target. Keep the original Railway domain and all saved connector URLs. Do not create another gateway, volume or computer.

Once the app certificate is ready, allow exactly the new HTTPS app origin using `STUDIO_ALLOWED_ORIGINS` (comma-separated), alongside the existing `STUDIO_PUBLIC_URL`. Test login, chat, event replay, screen and setup links before changing the canonical `STUDIO_PUBLIC_URL`. Both origins must remain allowed during the transition. Cookies are host-only, so signing in again on the new domain is expected. Never allow the public demo origin, wildcard domains or unrelated subdomains to make authenticated app requests.

If DNS administration is unavailable, keep the working origin and mark domain activation pending. A domain attached in Railway or Pages is not proof that DNS or HTTPS works.
