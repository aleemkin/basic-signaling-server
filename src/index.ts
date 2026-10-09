import { Hono } from "hono";
import { cors } from "hono/cors";

type Bindings = {
  DB: D1Database;
};

const app = new Hono<{ Bindings: Bindings }>();

// Enable CORS for web, desktop, and mobile clients
app.use(
  "*",
  cors({
    origin: "*",
    allowHeaders: [
      "Content-Type",
      "Authorization",
      "X-Channel-Secret",
      "If-None-Match",
    ],
    exposeHeaders: ["ETag", "X-Updated-At", "X-Expires-At"],
  })
);

// Enforced constraints
const MAX_PAYLOAD_BYTES = 64 * 1024; // 64 KB limit
const ID_REGEX = /^[a-zA-Z0-9_-]{6,128}$/; // Safe alphanumeric channel identifier
const DEFAULT_TTL_SECONDS = 7 * 24 * 3600; // 7 days
const MAX_TTL_SECONDS = 30 * 24 * 3600; // 30 days maximum

// Cryptographic SHA-256 helper
async function sha256(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// Constant-time string equality check to prevent timing attacks
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

// Health and database readiness probe
app.get("/healthz", async (c) => {
  try {
    await c.env.DB.prepare("SELECT 1").run();
    return c.json({
      status: "ok",
      service: "signaling-server",
      database: "connected",
      time: Date.now(),
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json(
      {
        status: "degraded",
        service: "signaling-server",
        database: "error",
        error: message,
        time: Date.now(),
      },
      503
    );
  }
});

// Publish or Update a Channel
app.put("/v1/channels/:id", async (c) => {
  const id = c.req.param("id");
  if (!ID_REGEX.test(id)) {
    return c.json(
      {
        error: "invalid_id",
        message: "Channel ID must be 6-128 alphanumeric, hyphen, or underscore characters",
      },
      400
    );
  }

  const body = await c.req.text();
  if (body.length > MAX_PAYLOAD_BYTES) {
    return c.json(
      {
        error: "payload_too_large",
        message: `Payload exceeds ${MAX_PAYLOAD_BYTES} bytes limit`,
      },
      413
    );
  }
  if (!body.trim()) {
    return c.json({ error: "empty_payload" }, 400);
  }

  // Parse TTL parameter (?ttl=seconds)
  const ttlQuery = Number(c.req.query("ttl")) || DEFAULT_TTL_SECONDS;
  const ttl = Math.min(Math.max(60, ttlQuery), MAX_TTL_SECONDS);
  const now = Date.now();
  const expiresAt = now + ttl * 1000;

  // Optional write protection secret
  const providedSecret =
    c.req.header("X-Channel-Secret") ||
    c.req.header("Authorization")?.replace(/^Bearer\s+/i, "");
  const secretHash = providedSecret ? await sha256(providedSecret) : null;

  // Check existing channel secret
  const existing = await c.env.DB.prepare(
    `SELECT secret_hash FROM channels WHERE id = ? AND expires_at > ?`
  )
    .bind(id, now)
    .first<{ secret_hash: string | null }>();

  if (existing?.secret_hash) {
    if (!secretHash || !timingSafeEqual(existing.secret_hash, secretHash)) {
      return c.json(
        {
          error: "unauthorized",
          message: "Invalid or missing channel secret for existing channel",
        },
        403
      );
    }
  }

  const etag = `"${await sha256(body)}"`;

  await c.env.DB.prepare(`
    INSERT INTO channels (id, data, secret_hash, etag, updated_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      data = excluded.data,
      secret_hash = COALESCE(excluded.secret_hash, channels.secret_hash),
      etag = excluded.etag,
      updated_at = excluded.updated_at,
      expires_at = excluded.expires_at
  `)
    .bind(id, body, secretHash, etag, now, expiresAt)
    .run();

  return c.json({
    ok: true,
    id,
    etag,
    updated_at: now,
    expires_at: expiresAt,
  });
});

// Lookup a Channel
app.get("/v1/channels/:id", async (c) => {
  const id = c.req.param("id");
  if (!ID_REGEX.test(id)) {
    return c.json({ error: "invalid_id" }, 400);
  }

  const now = Date.now();
  const row = await c.env.DB.prepare(
    `SELECT data, etag, updated_at, expires_at FROM channels WHERE id = ? AND expires_at > ?`
  )
    .bind(id, now)
    .first<{ data: string; etag: string; updated_at: number; expires_at: number }>();

  if (!row) {
    return c.json({ error: "not_found", message: "Channel not found or expired" }, 404);
  }

  // 304 Not Modified optimization
  const clientEtag = c.req.header("If-None-Match");
  if (clientEtag && clientEtag === row.etag) {
    return new Response(null, { status: 304 });
  }

  return c.newResponse(row.data, 200, {
    "Content-Type": "application/json",
    "ETag": row.etag,
    "X-Updated-At": row.updated_at.toString(),
    "X-Expires-At": row.expires_at.toString(),
    "Cache-Control": "no-cache",
  });
});

// Delete a Channel
app.delete("/v1/channels/:id", async (c) => {
  const id = c.req.param("id");
  if (!ID_REGEX.test(id)) {
    return c.json({ error: "invalid_id" }, 400);
  }

  const providedSecret =
    c.req.header("X-Channel-Secret") ||
    c.req.header("Authorization")?.replace(/^Bearer\s+/i, "");
  const secretHash = providedSecret ? await sha256(providedSecret) : null;

  const existing = await c.env.DB.prepare(
    `SELECT secret_hash FROM channels WHERE id = ?`
  )
    .bind(id)
    .first<{ secret_hash: string | null }>();

  if (!existing) {
    return c.json({ ok: true, deleted: false });
  }

  if (existing.secret_hash) {
    if (!secretHash || !timingSafeEqual(existing.secret_hash, secretHash)) {
      return c.json({ error: "unauthorized" }, 403);
    }
  }

  await c.env.DB.prepare(`DELETE FROM channels WHERE id = ?`).bind(id).run();
  return c.json({ ok: true, deleted: true });
});

// Export worker with fetch handler and scheduled daily cron cleanup
export default {
  fetch: app.fetch,
  async scheduled(event: { scheduledTime: number; cron: string }, env: Bindings) {
    const now = Date.now();
    await env.DB.prepare(`DELETE FROM channels WHERE expires_at <= ?`).bind(now).run();
  },
};
