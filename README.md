# cert-tunnel-check

Monitors TLS certificate expiry, HTTP reachability, and Cloudflare Tunnel
connector health for self-hosted services. Alerts to a Discord webhook **only on
state transitions**, so it stays quiet until something actually changes.

No npm dependencies — Node built-ins only.

## Local testing

```bash
cp config.example.json config.json   # then edit it
node check.js --once
```

`--once` runs a single pass and exits. Without it, the script loops forever on
`INTERVAL_MINUTES` (default 360 = every 6 hours), which is how it runs in Docker.

If the Discord webhook is still a `REPLACE_...` placeholder, the script prints
the alert it *would* have sent instead of failing. Useful for dry runs.

To confirm the debounce works, run `--once` twice — the second run should say
`No state changes — no alert sent.`

### Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `CONFIG_PATH` | `./config.json` | Where to read config from |
| `STATE_PATH` | `./state.json` | Where to persist previous results |
| `INTERVAL_MINUTES` | `360` | Minutes between runs in loop mode |
| `RUN_ONCE` | unset | Set to `true` for a single run (same as `--once`) |

## Deploying to CasaOS

### 1. Publish the image

The repo builds and pushes to GHCR when you push a version tag:

```bash
git tag v1.0
git push origin v1.0
```

That produces `ghcr.io/<your-username>/cert-tunnel-check:v1.0` for amd64 and
arm64. Make the package public once (GitHub → Packages → cert-tunnel-check →
Package settings → Change visibility → Public), or CasaOS won't be able to pull
it without registry credentials.

### 2. Seed config on the CasaOS host

SSH into the CasaOS VM:

```bash
mkdir -p /DATA/AppData/cert-tunnel-check/config
mkdir -p /DATA/AppData/cert-tunnel-check/state
nano /DATA/AppData/cert-tunnel-check/config/config.json
```

Paste your real config — hostnames, Discord webhook, and (when ready)
Cloudflare `accountId` / `tunnelId` / `apiToken` with `enabled: true`.

The container **exits immediately** if this file is missing or invalid. That's
deliberate: a monitoring tool that silently sits idle is worse than one that
visibly stops.

### 3. Install in CasaOS

CasaOS → **+** → **Custom Install** → **Import** (the `⋯` menu) → paste the
contents of `docker-compose.yml`, replacing `YOUR_GITHUB_USERNAME` with yours.

It's a headless app — no web UI. Verify it's working from the container logs;
you should see a `=== cert-tunnel-check run @ ... ===` block.

### 4. Updating

Deliberately manual — no Watchtower. This tool is what tells you when other
things break, so an unattended update silently breaking it defeats the purpose.

1. Commit changes, `git tag v1.1`, `git push origin v1.1`
2. Wait for the Actions run to finish
3. In CasaOS, edit the app's compose, bump the image tag to `v1.1`, save

## Troubleshooting

**Container restarts in a loop** — config.json is missing or malformed. Check
the logs; `Failed to load /config/config.json` means the volume mount or the
JSON is wrong.

**`untrusted chain: ...` next to a cert result** — expected for Cloudflare
Origin CA certs, which don't chain to a public root. The expiry date is still
read correctly and thresholds still apply.

**Everything reports unreachable** — hostnames behind a Cloudflare Tunnel only
resolve where DNS points at Cloudflare. Confirm the CasaOS VM resolves them:
`nslookup vaultwarden.example.com`.

**No Discord alerts, ever** — that's the intended steady state. Alerts fire on
*transitions*. To force one, delete `/DATA/AppData/cert-tunnel-check/state/state.json`
and restart, or temporarily raise `warnDays` above the actual days remaining.
