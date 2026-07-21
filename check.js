#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const tls = require("tls");
const https = require("https");
const http = require("http");

// Paths are overridable so the container can mount config/state on volumes.
const CONFIG_PATH = process.env.CONFIG_PATH || path.join(__dirname, "config.json");
const STATE_PATH = process.env.STATE_PATH || path.join(__dirname, "state.json");

// Scheduling: loop inside the container by default, one-shot for local testing.
const RUN_ONCE = process.env.RUN_ONCE === "true" || process.argv.includes("--once");
const INTERVAL_MINUTES = Number(process.env.INTERVAL_MINUTES || 360);

// Dashboard: serves the latest result as a web page instead of only console logs.
const PORT = Number(process.env.PORT || 8080);

// ---------- Utilities ----------

function loadJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (err) {
    if (fallback !== undefined) return fallback;
    throw new Error(`Failed to load ${filePath}: ${err.message}`);
  }
}

function saveState(state) {
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

function daysBetween(dateA, dateB) {
  const msPerDay = 1000 * 60 * 60 * 24;
  return Math.floor((dateB.getTime() - dateA.getTime()) / msPerDay);
}

// ---------- Cert expiry check ----------
// Pulls the peer cert over TLS directly. rejectUnauthorized is off on purpose:
// an Origin CA cert on an NPM backend won't chain to a public root, but we still
// want its expiry date. Trust is reported separately as `authorized`.

function getCertExpiry(hostname, port = 443, timeoutMs = 10000) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (result) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };

    const socket = tls.connect(
      { host: hostname, port, servername: hostname, timeout: timeoutMs, rejectUnauthorized: false },
      () => {
        const cert = socket.getPeerCertificate();
        if (!cert || !cert.valid_to) {
          return done({ hostname, ok: false, error: "No peer certificate returned" });
        }
        const expiryDate = new Date(cert.valid_to);
        if (isNaN(expiryDate.getTime())) {
          return done({ hostname, ok: false, error: `Unparseable date: ${cert.valid_to}` });
        }
        done({
          hostname,
          ok: true,
          expiryDate: expiryDate.toISOString(),
          daysRemaining: daysBetween(new Date(), expiryDate),
          issuer: (cert.issuer && cert.issuer.O) || null,
          authorized: socket.authorized,
          authorizationError: socket.authorized ? null : String(socket.authorizationError || ""),
        });
      }
    );

    socket.on("timeout", () => done({ hostname, ok: false, error: "TLS handshake timeout" }));
    socket.on("error", (err) => done({ hostname, ok: false, error: err.message }));
  });
}

// ---------- HTTP reachability check ----------

function checkReachability(hostname, timeoutMs = 8000) {
  return new Promise((resolve) => {
    const start = Date.now();
    const req = https.get(
      { hostname, path: "/", timeout: timeoutMs, headers: { "User-Agent": "cert-tunnel-check/0.1" } },
      (res) => {
        // Drain response so socket closes cleanly
        res.on("data", () => {});
        res.on("end", () => {
          resolve({
            hostname,
            ok: true,
            statusCode: res.statusCode,
            responseTimeMs: Date.now() - start,
          });
        });
      }
    );
    req.on("timeout", () => {
      req.destroy();
      resolve({ hostname, ok: false, error: "Timeout" });
    });
    req.on("error", (err) => {
      resolve({ hostname, ok: false, error: err.message });
    });
  });
}

// ---------- Cloudflare Tunnel status check (stubbed) ----------

async function checkTunnelStatus(cfConfig) {
  if (!cfConfig || !cfConfig.enabled) {
    return { ok: null, stubbed: true, message: "Tunnel check disabled/stubbed — no credentials configured yet" };
  }

  // Real implementation once you wire up credentials:
  // GET https://api.cloudflare.com/client/v4/accounts/{accountId}/cfd_tunnel/{tunnelId}
  // Authorization: Bearer {apiToken}
  // Check response.result.status === "healthy"
  return new Promise((resolve) => {
    const options = {
      hostname: "api.cloudflare.com",
      path: `/client/v4/accounts/${cfConfig.accountId}/cfd_tunnel/${cfConfig.tunnelId}`,
      headers: { Authorization: `Bearer ${cfConfig.apiToken}` },
    };
    const req = https.get(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          const parsed = JSON.parse(data);
          if (!parsed.success) {
            return resolve({ ok: false, error: JSON.stringify(parsed.errors) });
          }
          resolve({ ok: parsed.result.status === "healthy", status: parsed.result.status });
        } catch (err) {
          resolve({ ok: false, error: `Parse error: ${err.message}` });
        }
      });
    });
    req.on("error", (err) => resolve({ ok: false, error: err.message }));
  });
}

// ---------- Discord alerting ----------

function postToDiscord(webhookUrl, content) {
  return new Promise((resolve) => {
    if (!webhookUrl || webhookUrl.startsWith("REPLACE_")) {
      console.log("[discord] Webhook not configured — would have sent:\n" + content);
      return resolve({ skipped: true });
    }
    const url = new URL(webhookUrl);
    const payload = JSON.stringify({ content });
    const req = https.request(
      {
        hostname: url.hostname,
        path: url.pathname + url.search,
        method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) },
      },
      (res) => {
        res.on("data", () => {});
        res.on("end", () => resolve({ statusCode: res.statusCode }));
      }
    );
    req.on("error", (err) => {
      console.error("[discord] Failed to send:", err.message);
      resolve({ error: err.message });
    });
    req.write(payload);
    req.end();
  });
}

// ---------- Alert level logic ----------

function certAlertLevel(daysRemaining, thresholds) {
  if (daysRemaining <= thresholds.urgentDays) return "urgent";
  if (daysRemaining <= thresholds.criticalDays) return "critical";
  if (daysRemaining <= thresholds.warnDays) return "warn";
  return "ok";
}

// ---------- Dashboard ----------
// In-memory snapshot of the last run, served as a web page. Not persisted
// separately from state.json — this is just state.json plus run metadata,
// rendered for humans instead of `docker logs`.

const dashboard = { lastRunAt: null, lastError: null, state: null };

// Severity ranking, worst-wins — used both for individual badges and for
// rolling everything up into the one headline status pill.
const LEVEL_RANK = { ok: 0, unknown: 0, warn: 1, critical: 2, urgent: 3 };
const LEVEL_LABEL = { ok: "Operational", warn: "Degraded", critical: "Degraded", urgent: "Issues detected" };

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function pill(level, text) {
  const cls = LEVEL_RANK[level] === undefined ? "unknown" : level;
  return `<span class="pill pill-${cls}"><span class="dot"></span>${escapeHtml(text)}</span>`;
}

function renderTunnelCard(tunnel) {
  if (!tunnel) return "";
  if (tunnel.stubbed) {
    return `<div class="card">
      <div class="card-head">
        <span class="card-title">☁️ Cloudflare Tunnel</span>
        ${pill("unknown", "Not configured")}
      </div>
      <div class="row"><span class="detail">${escapeHtml(tunnel.message || "")}</span></div>
    </div>`;
  }
  const level = tunnel.ok ? "ok" : "urgent";
  const detail = tunnel.ok ? tunnel.status : tunnel.error || tunnel.status;
  return `<div class="card">
    <div class="card-head">
      <span class="card-title">☁️ Cloudflare Tunnel</span>
      ${pill(level, tunnel.ok ? "Healthy" : "Unhealthy")}
    </div>
    <div class="row"><span class="detail">${escapeHtml(detail || "")}</span></div>
  </div>`;
}

function renderHostCard(hostname, hostState, thresholds) {
  const cert = hostState.cert || {};
  const reach = hostState.reach || {};

  let certLevel, certPill, certDetail;
  if (cert.ok) {
    certLevel = certAlertLevel(cert.daysRemaining, thresholds);
    certPill = pill(certLevel, `${cert.daysRemaining}d remaining`);
    certDetail = cert.authorized
      ? escapeHtml(cert.issuer || "")
      : `Untrusted chain (${escapeHtml(cert.authorizationError || "")})`;
  } else {
    certLevel = "urgent";
    certPill = pill("urgent", "Error");
    certDetail = escapeHtml(cert.error || "unknown error");
  }

  let reachLevel, reachPill, reachDetail;
  if (reach.ok) {
    reachLevel = "ok";
    reachPill = pill("ok", `HTTP ${reach.statusCode}`);
    reachDetail = `${reach.responseTimeMs}ms response time`;
  } else {
    reachLevel = "urgent";
    reachPill = pill("urgent", "Unreachable");
    reachDetail = escapeHtml(reach.error || "unknown error");
  }

  return `<div class="card">
    <div class="card-head">
      <span class="card-title">🌐 ${escapeHtml(hostname)}</span>
    </div>
    <div class="row">
      <span class="label">Certificate</span>
      ${certPill}
    </div>
    <div class="row detail-row"><span class="detail">${certDetail}</span></div>
    <div class="row">
      <span class="label">Reachability</span>
      ${reachPill}
    </div>
    <div class="row detail-row"><span class="detail">${reachDetail}</span></div>
  </div>`;
}

function renderDashboard() {
  const config = loadJson(CONFIG_PATH, { hostnames: [], certThresholds: { warnDays: 30, criticalDays: 14, urgentDays: 7 } });
  const state = dashboard.state || { hosts: {}, tunnel: null };
  const hostnames = Object.keys(state.hosts || {});

  // Worst level across everything, for the headline pill. A stubbed tunnel
  // check doesn't count against overall health — it's not configured yet,
  // not broken.
  let overall = "ok";
  const bump = (level) => {
    if (LEVEL_RANK[level] > LEVEL_RANK[overall]) overall = level;
  };
  if (state.tunnel && !state.tunnel.stubbed) bump(state.tunnel.ok ? "ok" : "urgent");
  for (const h of hostnames) {
    const { cert, reach } = state.hosts[h];
    bump(cert && cert.ok ? certAlertLevel(cert.daysRemaining, config.certThresholds) : "urgent");
    bump(reach && reach.ok ? "ok" : "urgent");
  }

  const hostCards = hostnames.map((h) => renderHostCard(h, state.hosts[h], config.certThresholds)).join("\n");
  const tunnelCard = renderTunnelCard(state.tunnel);
  const hasData = dashboard.lastRunAt !== null;

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="30">
<link rel="icon" href="data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><text y=%22.9em%22 font-size=%2290%22>🛡️</text></svg>">
<title>cert-tunnel-check</title>
<style>
  :root {
    --bg: #f5f6f8; --surface: #ffffff; --border: #e3e6ea;
    --text: #14171f; --text-muted: #6b7280;
    --shadow: 0 1px 2px rgba(16,24,40,.04), 0 1px 6px rgba(16,24,40,.04);
    --ok-bg: #e6f7ec; --ok-fg: #0f7a3d; --ok-dot: #22c55e;
    --warn-bg: #fff5df; --warn-fg: #8a5b00; --warn-dot: #f5a524;
    --critical-bg: #ffece0; --critical-fg: #9a3d00; --critical-dot: #f97316;
    --urgent-bg: #fdeaea; --urgent-fg: #b3261e; --urgent-dot: #ef4444;
    --unknown-bg: #eef0f3; --unknown-fg: #5b6270; --unknown-dot: #9aa1ac;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0d1117; --surface: #161b22; --border: #2d333b;
      --text: #e6edf3; --text-muted: #8b949e;
      --shadow: 0 1px 2px rgba(0,0,0,.4), 0 4px 16px rgba(0,0,0,.3);
      --ok-bg: rgba(34,197,94,.14); --ok-fg: #4ade80;
      --warn-bg: rgba(245,165,36,.14); --warn-fg: #fbbf24;
      --critical-bg: rgba(249,115,22,.14); --critical-fg: #fb923c;
      --urgent-bg: rgba(239,68,68,.16); --urgent-fg: #f87171;
      --unknown-bg: rgba(154,161,172,.14); --unknown-fg: #9aa1ac;
    }
  }
  * { box-sizing: border-box; }
  body {
    font-family: -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    background: var(--bg); color: var(--text);
    margin: 0; padding: 32px 24px 48px;
  }
  .wrap { max-width: 1040px; margin: 0 auto; }
  header {
    display: flex; justify-content: space-between; align-items: flex-start;
    flex-wrap: wrap; gap: 16px; margin-bottom: 28px;
  }
  h1 { font-size: 21px; font-weight: 700; letter-spacing: -.01em; margin: 0; }
  .subtitle { color: var(--text-muted); font-size: 13px; margin-top: 5px; }
  .headline-pill {
    display: inline-flex; align-items: center; gap: 8px;
    padding: 8px 16px; border-radius: 999px; font-size: 14px; font-weight: 600;
    background: var(--${overall}-bg); color: var(--${overall}-fg);
  }
  .headline-pill .dot { width: 8px; height: 8px; border-radius: 50%; background: currentColor; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 16px; }
  .card {
    background: var(--surface); border: 1px solid var(--border); border-radius: 14px;
    padding: 18px 20px; box-shadow: var(--shadow);
  }
  .card-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px; }
  .card-title { font-size: 14px; font-weight: 600; }
  .row { display: flex; justify-content: space-between; align-items: center; padding: 9px 0; }
  .row + .row { border-top: 1px solid var(--border); }
  .detail-row { padding-top: 0; padding-bottom: 9px; border-top: none !important; }
  .label { color: var(--text-muted); font-size: 13px; }
  .detail { color: var(--text-muted); font-size: 12px; }
  .pill {
    display: inline-flex; align-items: center; gap: 6px;
    padding: 3px 10px; border-radius: 999px; font-size: 12px; font-weight: 600;
  }
  .pill .dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
  .pill-ok { background: var(--ok-bg); color: var(--ok-fg); }
  .pill-warn { background: var(--warn-bg); color: var(--warn-fg); }
  .pill-critical { background: var(--critical-bg); color: var(--critical-fg); }
  .pill-urgent { background: var(--urgent-bg); color: var(--urgent-fg); }
  .pill-unknown { background: var(--unknown-bg); color: var(--unknown-fg); }
  .empty {
    color: var(--text-muted); font-size: 14px; text-align: center;
    padding: 48px 20px; border: 1px dashed var(--border); border-radius: 14px;
  }
  footer { color: var(--text-muted); font-size: 12px; margin-top: 28px; }
  .error-banner {
    background: var(--urgent-bg); color: var(--urgent-fg);
    border-radius: 10px; padding: 10px 14px; font-size: 13px; margin-bottom: 20px;
  }
</style>
</head>
<body>
<div class="wrap">
<header>
  <div>
    <h1>cert-tunnel-check</h1>
    <div class="subtitle">TLS, reachability &amp; tunnel monitoring</div>
  </div>
  ${hasData ? `<span class="headline-pill"><span class="dot"></span>${LEVEL_LABEL[overall]}</span>` : ""}
</header>
${dashboard.lastError ? `<div class="error-banner">Last run failed: ${escapeHtml(dashboard.lastError)}</div>` : ""}
${hasData
  ? `<div class="grid">\n${tunnelCard}\n${hostCards}\n</div>`
  : `<div class="empty">No data yet — waiting on the first check to complete.</div>`}
<footer>
  Last run: ${dashboard.lastRunAt ? escapeHtml(dashboard.lastRunAt.toISOString()) : "never"} ·
  next check ~every ${INTERVAL_MINUTES}m · page refreshes every 30s
</footer>
</div>
</body>
</html>`;
}

function startDashboardServer() {
  const server = http.createServer((req, res) => {
    if (req.method !== "GET") {
      res.writeHead(405).end();
      return;
    }
    const url = new URL(req.url, "http://localhost");
    if (url.pathname === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(renderDashboard());
    } else if (url.pathname === "/api/state") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(dashboard));
    } else if (url.pathname === "/healthz") {
      res.writeHead(200, { "Content-Type": "text/plain" }).end("ok");
    } else {
      res.writeHead(404).end("Not found");
    }
  });
  server.listen(PORT, () => console.log(`Dashboard listening on :${PORT}`));
  return server;
}

// ---------- Main ----------

async function main() {
  const config = loadJson(CONFIG_PATH);
  const previousState = loadJson(STATE_PATH, { hosts: {}, tunnel: {} });
  const newState = { hosts: {}, tunnel: {} };
  const alerts = [];

  console.log(`\n=== cert-tunnel-check run @ ${new Date().toISOString()} ===\n`);

  // Tunnel check (once, not per-host)
  const tunnelResult = await checkTunnelStatus(config.cloudflare);
  newState.tunnel = tunnelResult;
  console.log("[tunnel]", tunnelResult);

  if (!tunnelResult.stubbed) {
    const wasOk = previousState.tunnel && previousState.tunnel.ok;
    if (tunnelResult.ok === false && wasOk !== false) {
      alerts.push(`🔴 **Tunnel unhealthy** — status: ${tunnelResult.status || tunnelResult.error}`);
    } else if (tunnelResult.ok === true && wasOk === false) {
      alerts.push(`🟢 **Tunnel recovered** — status healthy again`);
    }
  }

  // Per-hostname checks
  for (const hostname of config.hostnames) {
    const cert = await getCertExpiry(hostname);
    const reach = await checkReachability(hostname, config.httpCheck.timeoutMs);

    console.log(
      `[cert] ${hostname}:`,
      cert.ok
        ? `${cert.daysRemaining} days remaining${cert.authorized ? "" : ` (untrusted chain: ${cert.authorizationError})`}`
        : cert.error
    );
    console.log(`[http] ${hostname}:`, reach.ok ? `${reach.statusCode} in ${reach.responseTimeMs}ms` : reach.error);

    newState.hosts[hostname] = { cert, reach };
    const prevHost = (previousState.hosts && previousState.hosts[hostname]) || {};

    // Cert threshold transitions
    if (cert.ok) {
      const level = certAlertLevel(cert.daysRemaining, config.certThresholds);
      const prevLevel = prevHost.cert && prevHost.cert.ok
        ? certAlertLevel(prevHost.cert.daysRemaining, config.certThresholds)
        : "ok";
      if (level !== "ok" && level !== prevLevel) {
        alerts.push(`🟡 **${hostname}** cert expires in ${cert.daysRemaining} days (${level})`);
      }
    } else {
      alerts.push(`🔴 **${hostname}** cert check failed: ${cert.error}`);
    }

    // Reachability transitions
    const wasReachable = prevHost.reach ? prevHost.reach.ok : true;
    if (!reach.ok && wasReachable) {
      alerts.push(`🔴 **${hostname}** unreachable — ${reach.error}`);
    } else if (reach.ok && !wasReachable) {
      alerts.push(`🟢 **${hostname}** back online — ${reach.statusCode}`);
    }
  }

  saveState(newState);
  dashboard.state = newState;
  dashboard.lastRunAt = new Date();
  dashboard.lastError = null;

  if (alerts.length > 0) {
    const message = `**Cert/Tunnel Check Alert** (${new Date().toISOString()})\n` + alerts.join("\n");
    await postToDiscord(config.discord.webhookUrl, message);
  } else {
    console.log("\nNo state changes — no alert sent.");
  }

  console.log("\n=== run complete ===\n");
}

// ---------- Entrypoint ----------
// One-shot for local testing (--once / RUN_ONCE=true), otherwise loop forever so
// the container is self-scheduling and needs no external cron.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function run() {
  if (RUN_ONCE) {
    await main();
    return;
  }

  if (!Number.isFinite(INTERVAL_MINUTES) || INTERVAL_MINUTES <= 0) {
    console.error(`Invalid INTERVAL_MINUTES: ${process.env.INTERVAL_MINUTES}`);
    process.exit(1);
  }

  // A missing/broken config is fatal, not something to retry every 6 hours in
  // silence — fail loudly on startup so the container visibly stops.
  loadJson(CONFIG_PATH);

  // Seed the dashboard with the last saved run so the page isn't blank
  // immediately after a restart, before the first new check completes.
  dashboard.state = loadJson(STATE_PATH, null);

  startDashboardServer();

  console.log(`Scheduler: running every ${INTERVAL_MINUTES} minutes.`);
  for (;;) {
    // A single failed run shouldn't kill the container — log and wait it out.
    try {
      await main();
    } catch (err) {
      console.error("Run failed:", err.message);
      dashboard.lastError = err.message;
    }
    await sleep(INTERVAL_MINUTES * 60 * 1000);
  }
}

// Docker sends SIGTERM on stop; exit promptly instead of waiting out the grace period.
for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => {
    console.log(`\nReceived ${signal}, exiting.`);
    process.exit(0);
  });
}

run().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
