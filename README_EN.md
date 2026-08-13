# Literature Downloader Suite

Lawful academic full-text download toolkit for researchers with institutional
access (CARSI / WebVPN / library SSO). It connects your already-authorized
browser session to batch tools that fetch full-text HTML and PDFs, one paper at
a time, with built-in pacing and circuit breakers to avoid triggering publisher
anti-abuse systems.

> **This toolkit creates no access rights.** You must have a legitimate
> subscription through your institution. It never bypasses paywalls, CAPTCHAs,
> DRM, or two-factor authentication.

## Components

| Component | Source | Role |
|---|---|---|
| `skills/nature-downloader` | [Yuan1z0825/nature-skills](https://github.com/Yuan1z0825/nature-skills) (MIT) | DOI routing: OA → publisher API → institutional browser |
| `skills/web-access` | [eze-is/web-access](https://github.com/eze-is/web-access) (MIT) | Chrome CDP bridge with login-state reuse |
| `scripts/cdp-harvest.mjs` | this repo | Batch full-text HTML capture through the bridge |
| `scripts/cdp-pdf-fetch.mjs` | this repo | Single-paper PDF capture (article → click View PDF → fetch bytes) |
| `setup-bridge.ps1` | this repo | One-command Chrome debugging + CDP proxy setup |

See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for license details.

## Requirements

- Node.js 22+ (Codex Desktop bundles one)
- Python 3 + `pip install -r skills/nature-downloader/requirements.txt`
- Chrome (or Edge) with your institution logged in
- A normal network egress IP (campus / home broadband). Datacenter IPs are
  flagged by publishers and Cloudflare, which blocks PDF endpoints.

## Quick Start

1. Install the two skills into your agent's skill directory
   (`~/.codex/skills/` for Codex, `~/.claude/skills/` for Claude Code), or call
   the scripts directly from this repo.
2. Configure your school:

   ```powershell
   python skills/nature-downloader/scripts/configure_school.py url "https://your-library-portal"
   ```

3. Log in once in Chrome (e.g. ScienceDirect → Sign in → Access through your
   institution → pick your school).
4. Start the bridge:

   ```powershell
   .\setup-bridge.ps1
   ```

5. Harvest full-text HTML (fastest; works even on flagged IPs):

   ```powershell
   node scripts/cdp-harvest.mjs --list list.csv --out .\downloads
   ```

   `list.csv` format: `record_id,authoritative_url`

6. Or fetch a single PDF:

   ```powershell
   node scripts/cdp-pdf-fetch.mjs --article "https://www.sciencedirect.com/science/article/pii/<PII>" --out .\downloads\MC-001.pdf
   ```

Full usage, troubleshooting, and safety limits: [USER_GUIDE.md](USER_GUIDE.md)

## Safety controls (built-in defaults)

- Strictly sequential processing (no concurrency)
- Randomized 8–15 s delays between items
- Skip already-downloaded items on reruns
- Circuit breaker: stop after 3 consecutive blocked pages
- PDF retries capped at 2; abort immediately on bot-block pages
- 15 s cooldown after each successful PDF

Respect your library's rules: stay within normal reading volumes (≤30–50 PDFs
per publisher per day), and never share institutional accounts.

## Chrome 151 note

Newer Chrome versions ignore `--remote-debugging-port` for the default profile
and no longer write `DevToolsActivePort`. This repo's web-access copy includes a
patch (`WEB_ACCESS_CHROME_DATA_DIR` env var) and `setup-bridge.ps1` handles the
port file automatically.

## License

This repository's own scripts and documentation: MIT.
Third-party components retain their upstream licenses — see
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
