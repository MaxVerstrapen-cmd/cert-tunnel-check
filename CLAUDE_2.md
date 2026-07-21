# cert-tunnel-check

Homelab monitoring tool for Matthew's self-hosted services. Checks TLS cert
expiry, HTTP reachability, and Cloudflare Tunnel connector health, and alerts
to Discord only on state transitions (not every run) to avoid alert spam.

## Context / environment

- Runs as a Docker container inside **CasaOS**, which itself runs as a **VM
  on a 3-node Proxmox cluster** (migrating to Ceph for HA — CasaOS VM will
  get HA automatically once that migration is done).
- Services being monitored sit behind **Cloudflare Tunnels** — Cloudflare
  terminates TLS at the edge for tunneled hostnames, so cert checks mostly
  matter for any Origin CA certs (e.g. NPM backend in Full Strict mode).
- Deployment target: **CasaOS Custom Install** using a `docker-compose.yml`
  with `x-casaos` labels so it shows up properly in the CasaOS dashboard
  (icon, name, category, description).
- Update strategy: **manual, pinned tags** — build image, push to GHCR
  (`ghcr.io/<user>/cert-tunnel-check:vX.Y`), bump tag, hit "Update" in
  CasaOS. Deliberately **not** using Watchtower auto-update, since this tool
  is the thing that alerts when other things break — an unattended update
  silently breaking it defeats the purpose.
- Matthew's other homelab conventions worth following: small clearly-scoped
  commits, git tag once stable (same pattern he's using for a separate
  UPS-monitoring dashboard project), state-transition-only alerting with
  debounce (same instinct he applied to a NUT/UPS notify script).

## Current state (prototype, tested working)

Files in this directory:
- `check.js` — main script, fully functional
- `config.json` — hostnames, thresholds, Discord webhook, Cloudflare creds
- `package.json` — minimal, no dependencies (uses Node built-ins only:
  `fs`, `path`, `child_process`, `https`)

### What `check.js` does

1. **Cert expiry check** — shells out to `openssl s_client` + `openssl x509
   -noout -enddate` per hostname, parses `notAfter`, computes days
   remaining.
2. **HTTP reachability check** — plain `https.get` per hostname, records
   status code + response time, handles timeout/error.
3. **Cloudflare Tunnel status check** — **currently stubbed**
   (`cloudflare.enabled: false` in config). When enabled, hits
   `GET https://api.cloudflare.com/client/v4/accounts/{accountId}/cfd_tunnel/{tunnelId}`
   with a Bearer token and checks `result.status === "healthy"`. Code is
   already written, just gated behind the `enabled` flag until Matthew
   supplies real `accountId` / `tunnelId` / `apiToken`.
4. **State diffing** — reads/writes `state.json` (hosts + tunnel), only
   emits an alert on a *transition* (e.g. ok→warn, reachable→unreachable),
   not on every run. This is deliberate — same debounce pattern used
   elsewhere in his homelab.
5. **Alert thresholds** — cert alerts escalate at `warnDays` (30),
   `criticalDays` (14), `urgentDays` (7), configurable in `config.json`.
6. **Discord webhook** — POSTs a formatted alert message. If the webhook
   URL in config is still a placeholder (`REPLACE_...`), it logs what
   *would* have been sent instead of failing, which is useful for local
   testing.

Tested locally against `github.com` as a stand-in public hostname — cert
parsing, reachability, threshold logic, and debounce (no duplicate alert on
unchanged state) all confirmed working.

## Not yet done / next steps

1. **Real Cloudflare credentials** — Matthew needs to fill in `accountId`,
   `tunnelId`, `apiToken` and flip `cloudflare.enabled: true` to activate
   the tunnel check.
2. **Real hostnames + Discord webhook** — currently placeholders in
   `config.json`.
3. **Dockerize** — write a `Dockerfile` (small — Node + openssl base image,
   e.g. `node:alpine` with `apk add openssl`), confirm `openssl` CLI is
   available in the container since `check.js` shells out to it.
4. **Scheduling inside the container** — decide between a simple loop +
   `setInterval`/`sleep` in the container itself, or an external cron
   trigger (e.g. CasaOS/host cron running `docker exec`). Prototype has no
   built-in scheduler yet — it's a single-run script.
5. **docker-compose.yml with `x-casaos` labels** — for CasaOS Custom
   Install. Needs: `name`, `main`, `description`, `tagline`, `icon`,
   `category`, plus volume mounts for `config.json` and `state.json` so
   they persist outside the container (suggested: `/DATA/AppData/cert-tunnel-check/config`
   and `/DATA/AppData/cert-tunnel-check/state`).
6. **GHCR push workflow** — build, tag (`v1.0` etc.), push. Optionally a
   GitHub Actions workflow to automate the build/push on tag creation.
7. **README** — start/stop/update instructions, troubleshooting, so this
   is maintainable without Matthew needing to explain it from scratch.

## Design decisions already made (don't relitigate unless asked)

- No external npm dependencies — deliberately kept to Node built-ins.
- Manual tag-bump updates, not Watchtower.
- CasaOS (Docker layer), not bare Proxmox host — Proxmox host should stay
  clean, no application containers running directly on the hypervisor.
- State-transition-only alerting, not alert-on-every-run.
