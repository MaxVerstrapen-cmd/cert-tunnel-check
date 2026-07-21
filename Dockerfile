FROM node:22-alpine

# No openssl needed — cert expiry is read via Node's built-in tls module.
# No npm install either — the script uses Node built-ins only.

WORKDIR /app

COPY package.json ./
COPY check.js ./

# config.json is deliberately NOT copied in: it holds the Cloudflare API token
# and Discord webhook, and is mounted from the host at runtime instead.
ENV CONFIG_PATH=/config/config.json \
    STATE_PATH=/state/state.json \
    INTERVAL_MINUTES=360

# Runs as root so it can always write to the CasaOS-created /DATA/AppData dirs.
# It exposes no ports and only makes outbound HTTPS requests.
CMD ["node", "check.js"]
