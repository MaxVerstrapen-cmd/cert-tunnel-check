#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const tls = require("tls");
const https = require("https");

// Paths are overridable so the container can mount config/state on volumes.
const CONFIG_PATH = process.env.CONFIG_PATH || path.join(__dirname, "config.json");
const STATE_PATH = process.env.STATE_PATH || path.join(__dirname, "state.json");

// Scheduling: loop inside the container by default, one-shot for local testing.
const RUN_ONCE = process.env.RUN_ONCE === "true" || process.argv.includes("--once");
const INTERVAL_MINUTES = Number(process.env.INTERVAL_MINUTES || 360);

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

  console.log(`Scheduler: running every ${INTERVAL_MINUTES} minutes.`);
  for (;;) {
    // A single failed run shouldn't kill the container — log and wait it out.
    try {
      await main();
    } catch (err) {
      console.error("Run failed:", err.message);
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
