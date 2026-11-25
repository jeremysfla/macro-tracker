// Garmin Connect Personal API (https://developer.garmin.com/gc-developer-program/personal/personal-api/)
// A self-generated API key (env.GARMIN_API_KEY, a Worker secret) is exchanged for
// a 24-hour bearer token; there are no refresh tokens and no webhooks, so data is
// pulled. Endpoint paths follow Garmin's official sample client
// (github.com/garmin/connect-personal-api-python).

const BASE = "https://personal.connectapi.garmin.com";
const TOKEN_PATH = "/personalapitoken-service/personal-api/personal-api-key/token";
const REFRESH_WINDOW_MS = 60 * 60 * 1000;   // re-mint when under an hour is left
const JSON_HEADERS = { "content-type": "application/json", "access-control-allow-origin": "*" };

// Read-only paths the diagnostic probe may call (all are the signed-in user's own data)
const PROBE_PREFIXES = [
  "/usersummary-service/", "/sleep-service/", "/hrv-service/", "/wellness-service/",
  "/weight-service/", "/metrics-service/", "/fitnessage-service/", "/biometric-service/",
  "/wellnessactivity-service/", "/activitylist-service/", "/activity-service/",
  "/userprofile-service/", "/goal-service/", "/nutrition-service/",
];

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: JSON_HEADERS });
}

// The token is a JWT; its `exp` claim (seconds) is the only expiry Garmin gives us
function jwtExpiryMs(token) {
  try {
    const part = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    const exp = JSON.parse(atob(part + "=".repeat((4 - part.length % 4) % 4))).exp;
    if (Number.isFinite(exp)) return exp * 1000;
  } catch (_) {}
  return Date.now() + 23 * 60 * 60 * 1000;
}

async function ensureTokenTable(db) {
  await db.prepare("CREATE TABLE IF NOT EXISTS garmin_token (id INTEGER PRIMARY KEY, access_token TEXT NOT NULL, expires_at INTEGER NOT NULL)").run();
}

export async function garminToken(env, force = false) {
  if (!env.GARMIN_API_KEY) throw new Error("Garmin API key is not configured");
  await ensureTokenTable(env.DB);
  if (!force) {
    const row = await env.DB.prepare("SELECT access_token, expires_at FROM garmin_token WHERE id = 1").first();
    if (row && row.expires_at - Date.now() > REFRESH_WINDOW_MS) return row.access_token;
  }
  const r = await fetch(BASE + TOKEN_PATH, { method: "POST", headers: { accept: "*/*", authorization: "ApiKey " + env.GARMIN_API_KEY.trim() } });
  const text = (await r.text()).trim();
  if (!r.ok) throw new Error(`Garmin rejected the API key (${r.status}): ${text.slice(0, 200)}`);
  await env.DB.prepare("INSERT INTO garmin_token (id, access_token, expires_at) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET access_token = excluded.access_token, expires_at = excluded.expires_at")
    .bind(text, jwtExpiryMs(text)).run();
  return text;
}

// GET a Personal API path. A token can die before its expiry, so one 401 triggers a re-mint.
export async function garminGet(env, path, params) {
  const qs = params ? "?" + new URLSearchParams(params).toString() : "";
  const call = async (force) => fetch(BASE + path + qs, { headers: { accept: "application/json", authorization: "Bearer " + await garminToken(env, force) } });
  let r = await call(false);
  if (r.status === 401) r = await call(true);
  const text = await r.text();
  if (!r.ok) {
    const err = new Error(`Garmin ${r.status} on ${path}: ${text.slice(0, 200)}`);
    err.status = r.status;
    throw err;
  }
  return text ? JSON.parse(text) : null;
}

export async function handleGarmin(req, env, ctx, user, u) {
  try {
    if (u.pathname === "/api/garmin/status" && req.method === "GET") {
      if (!env.GARMIN_API_KEY) return json({ ok: true, configured: false });
      try {
        await garminToken(env);
        const row = await env.DB.prepare("SELECT expires_at FROM garmin_token WHERE id = 1").first();
        return json({ ok: true, configured: true, connected: true, token_expires_at: row?.expires_at || null });
      } catch (e) {
        return json({ ok: true, configured: true, connected: false, error: String(e.message).slice(0, 300) });
      }
    }

    // Diagnostic: fetch one allow-listed Personal API path as-is
    if (u.pathname === "/api/garmin/probe" && req.method === "GET") {
      const path = u.searchParams.get("path") || "";
      if (!PROBE_PREFIXES.some(p => path.startsWith(p)) || path.includes("..")) return json({ ok: false, error: "path not allowed" }, 400);
      const params = {};
      for (const [k, v] of u.searchParams) if (k !== "path") params[k] = v;
      try {
        return json({ ok: true, data: await garminGet(env, path, Object.keys(params).length ? params : null) });
      } catch (e) {
        return json({ ok: false, status: e.status || null, error: String(e.message).slice(0, 400) }, 502);
      }
    }
    return json({ ok: false, error: "unknown garmin route" }, 404);
  } catch (e) {
    return json({ ok: false, error: String(e.message).slice(0, 300) }, 500);
  }
}
