# Signaling & Rendezvous Server

A generic, high-performance, and lightweight signaling and ephemeral key-value relay server built on **Cloudflare Workers**, **Hono**, and **Cloudflare D1 (Serverless SQLite)**.

Designed for:

- Sharing private LAN IP addresses between local servers and clients.
- WebRTC signaling (SDP offer/answer exchange).
- Peer-to-peer (P2P) network discovery and dynamic rendezvous.

---

## Features

- **Global Edge Performance**: Runs globally on Cloudflare's edge network (<10ms latency).
- **100% Free**: Operates fully within Cloudflare's 100,000 requests/day free tier.
- **Production Security**:
  - Optional write protection via `X-Channel-Secret` or `Authorization: Bearer <secret>`.
  - Constant-time timing-safe secret comparisons to prevent timing attacks.
  - 64 KB payload size cap to protect against storage and bandwidth abuse.
  - Strict channel ID regex validation (`^[a-zA-Z0-9_-]{6,128}$`).
- **Auto-Expiration (TTL)**: Configurable TTL per channel with an automated daily Cloudflare Cron Trigger to clean up dead records.
- **HTTP 304 Caching**: Supports `If-None-Match` (ETag) to minimize mobile bandwidth and device battery.
- **CORS Enabled**: Out-of-the-box support for browsers, WebViews, and mobile apps.
- **Database Health Probe**: `/healthz` tests actual D1 database connectivity.

---

## Deployment Guide (Step-by-Step)

### 1. Install Dependencies

```bash
npm install
```

### 2. Create the Cloudflare D1 Database

Run the following command to create your free D1 database:

```bash
npm run db:create
```

_(or `npx wrangler d1 create signaling-db`)_

Wrangler will output a configuration block with your unique `database_id`, for example:

```jsonc
[[d1_databases]]
binding = "DB"
database_name = "signaling-db"
database_id = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
```

### 3. Update `wrangler.jsonc`

Open `wrangler.jsonc` and replace `"REPLACE_WITH_YOUR_DATABASE_ID"` with your actual `database_id` from step 2.

### 4. Apply Database Schema

Execute the schema against your remote Cloudflare database:

```bash
npm run db:migrate
```

_(or `npx wrangler d1 execute signaling-db --remote --file=./schema.sql`)_

### 5. Deploy to Cloudflare

Deploy the Worker to Cloudflare:

```bash
npm run deploy
```

Wrangler will compile the worker and print your live HTTPS endpoint:

```
https://signaling-server.<your-subdomain>.workers.dev
```

---

## Local Development & Testing

You can run the server locally with a local SQLite database:

```bash
# 1. Apply schema to local D1 emulator:
npm run db:migrate:local

# 2. Start local dev server:
npm run dev
```

---

## API Reference

### 1. Liveness & Database Health Probe

```http
GET /healthz
```

- Response (`200 OK`):
  ```json
  {
    "status": "ok",
    "service": "signaling-server",
    "database": "connected",
    "time": 1710000000000
  }
  ```

### 2. Publish / Update Channel

```http
PUT /v1/channels/:id?ttl=86400
Content-Type: application/json
X-Channel-Secret: <optional-secret>

{
  "endpoints": ["192.168.1.50"],
  "port": 47443,
  "spki": "sha256/..."
}
```

- `:id`: 6-128 alphanumeric, `-`, or `_` characters.
- `?ttl`: Expiration in seconds (60s to 30 days; default: 7 days).
- `X-Channel-Secret`: Optional write-protection secret. If provided on channel creation, subsequent updates and deletes require this secret.
- Response (`200 OK`):
  ```json
  {
    "ok": true,
    "id": "channel-123",
    "etag": "\"a1b2c3...\"",
    "updated_at": 1710000000000,
    "expires_at": 1710086400000
  }
  ```

### 3. Lookup Channel

```http
GET /v1/channels/:id
If-None-Match: <optional-etag>
```

- Returns `200 OK` with data if updated.
- Returns `304 Not Modified` (empty body) if the ETag matches your cached version.
- Returns `404 Not Found` if expired or nonexistent.

### 4. Delete Channel

```http
DELETE /v1/channels/:id
X-Channel-Secret: <optional-secret>
```

- Response (`200 OK`):
  ```json
  {
    "ok": true,
    "deleted": true
  }
  ```
