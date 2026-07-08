var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

const GOOGLE_CLIENT_ID = '480646952925-03r0p3jkdvfjdpnhlqbam4hnfjq0hp63.apps.googleusercontent.com';

// Only these Google accounts may sign in (override with env.ALLOWED_EMAILS, comma-separated)
const ALLOWED_EMAILS = new Set(['jeremy@dronenerds.com']);

const CLAUDE_ALLOWED_MODELS = new Set([
  'claude-haiku-4-5-20251001',
  'claude-sonnet-4-5-20250929',
  'claude-sonnet-4-6',
  'claude-opus-4-7',
]);
const CLAUDE_MAX_TOKENS_CAP = 4096;

// ── Session helpers ─────────────────────────────────────────────────────
function generateSessionToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}
__name(generateSessionToken, "generateSessionToken");

const SESSION_TTL_DAYS = 90;

// Sessions table is provisioned via migrations/0001_sessions.sql — no runtime DDL.

async function createSession(db, userId) {
  const token = generateSessionToken();
  const expires = new Date(Date.now() + SESSION_TTL_DAYS * 86400000).toISOString();
  await db.prepare(
    "INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)"
  ).bind(token, userId, expires).run();
  return { token, expiresAt: expires };
}
__name(createSession, "createSession");

async function validateSession(db, token) {
  if (!token) return null;
  const row = await db.prepare(
    "SELECT s.*, u.* FROM sessions s JOIN users u ON s.user_id = u.id WHERE s.token = ? AND s.expires_at > datetime('now')"
  ).bind(token).first();
  if (!row) return null;

  // Sliding expiration: if session has less than 30 days left, extend it a full TTL.
  // Keeps active users logged in indefinitely without hammering D1 on every request.
  const msLeft = new Date(row.expires_at).getTime() - Date.now();
  if (msLeft < 30 * 86400000) {
    const newExpires = new Date(Date.now() + SESSION_TTL_DAYS * 86400000).toISOString();
    try {
      await db.prepare("UPDATE sessions SET expires_at = ? WHERE token = ?").bind(newExpires, token).run();
      row.expires_at = newExpires;
    } catch(_) {}
  }
  return row;
}
__name(validateSession, "validateSession");

function parseCookie(req, name) {
  const hdr = req.headers.get("cookie") || "";
  const match = hdr.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return match ? match[1] : null;
}
__name(parseCookie, "parseCookie");

function sessionCookie(token, maxAge) {
  return `session=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}
__name(sessionCookie, "sessionCookie");

// Try the Bearer token first, but fall back to the session cookie even when a
// Bearer is present — a stale token in localStorage must not shadow a valid cookie.
async function resolveSession(db, req) {
  const bearer = req.headers.get("authorization")?.replace("Bearer ", "");
  const cookie = parseCookie(req, "session");
  if (bearer) {
    const user = await validateSession(db, bearer);
    if (user) return { user, token: bearer };
  }
  if (cookie && cookie !== bearer) {
    const user = await validateSession(db, cookie);
    if (user) return { user, token: cookie };
  }
  return { user: null, token: null };
}
__name(resolveSession, "resolveSession");

async function getSessionUser(db, req) {
  return (await resolveSession(db, req)).user;
}
__name(getSessionUser, "getSessionUser");

// Bump when D1 schema changes; surfaced via /api/status (authed) to tell what's live.
const SCHEMA_VERSION = 4;

// ── Log sync tables (item 1: server-authoritative food/weight/shoes/lifts) ──
const LOG_TABLES = {
  food:   { table: "food_log",     kind: "dated" },
  weight: { table: "weight_log",   kind: "weight" },
  shoes:  { table: "shoe_mileage", kind: "keyed" },
  lifts:  { table: "lift_log",     kind: "dated" },
};

function logUpsertStmt(db, cfg, userId, e) {
  const updatedAt = Number(e.updated_at);
  if (!Number.isFinite(updatedAt) || updatedAt <= 0) return null;
  const deleted = e.deleted ? 1 : 0;
  const payload = JSON.stringify(e.payload ?? {});
  if (payload.length > 32768) return null;

  if (cfg.kind === "dated") {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(e.date || "") || typeof e.entry_id !== "string" || !e.entry_id || e.entry_id.length > 128) return null;
    return db.prepare(`INSERT INTO ${cfg.table} (user_id, date, entry_id, payload_json, updated_at, deleted)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id, date, entry_id) DO UPDATE SET
        payload_json = excluded.payload_json, updated_at = excluded.updated_at, deleted = excluded.deleted
      WHERE excluded.updated_at > ${cfg.table}.updated_at`)
      .bind(userId, e.date, e.entry_id, payload, updatedAt, deleted);
  }
  if (cfg.kind === "weight") {
    const lbs = Number(e.weight_lbs);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(e.date || "") || !Number.isFinite(lbs) || lbs <= 0 || lbs > 1000) return null;
    return db.prepare(`INSERT INTO weight_log (user_id, date, weight_lbs, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(user_id, date) DO UPDATE SET
        weight_lbs = excluded.weight_lbs, updated_at = excluded.updated_at
      WHERE excluded.updated_at > weight_log.updated_at`)
      .bind(userId, e.date, lbs, updatedAt);
  }
  if (cfg.kind === "keyed") {
    if (typeof e.shoe_id !== "string" || !e.shoe_id || e.shoe_id.length > 128) return null;
    return db.prepare(`INSERT INTO shoe_mileage (user_id, shoe_id, payload_json, updated_at, deleted)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(user_id, shoe_id) DO UPDATE SET
        payload_json = excluded.payload_json, updated_at = excluded.updated_at, deleted = excluded.deleted
      WHERE excluded.updated_at > shoe_mileage.updated_at`)
      .bind(userId, e.shoe_id, payload, updatedAt, deleted);
  }
  return null;
}
__name(logUpsertStmt, "logUpsertStmt");

// ── TrainingPeaks helpers ────────────────────────────────────────────────
const TP_API_BASE = "https://tpapi.trainingpeaks.com";
const TP_RUN_TYPES = new Set([3, 6, 13]); // Run, Race, Walk

async function tpExchangeCookie(cookie) {
  const r = await fetch(`${TP_API_BASE}/users/v3/token`, {
    headers: { "Cookie": `Production_tpAuth=${cookie}`, "Accept": "application/json" }
  });
  if (!r.ok) return null;
  const d = await r.json();
  const t = d?.token;
  if (!t?.access_token) return null;
  return { accessToken: t.access_token, expiresAt: Date.now() + (t.expires_in || 3600) * 1000 };
}
__name(tpExchangeCookie, "tpExchangeCookie");

// Returns { token, athleteId, athleteName } or { error: "not_connected" | "cookie_expired" }
async function tpGetAccessToken(env) {
  let row = null;
  try { row = await env.DB.prepare("SELECT * FROM tp_auth WHERE id = 1").first(); } catch(_) {}
  if (!row) return { error: "not_connected" };
  if (row.access_token && new Date(row.token_expires_at).getTime() - 60000 > Date.now()) {
    return { token: row.access_token, athleteId: row.athlete_id, athleteName: row.athlete_name };
  }
  const tok = await tpExchangeCookie(row.cookie);
  if (!tok) return { error: "cookie_expired" };
  await env.DB.prepare("UPDATE tp_auth SET access_token = ?, token_expires_at = ?, updated_at = datetime('now') WHERE id = 1")
    .bind(tok.accessToken, new Date(tok.expiresAt).toISOString()).run();
  return { token: tok.accessToken, athleteId: row.athlete_id, athleteName: row.athlete_name };
}
__name(tpGetAccessToken, "tpGetAccessToken");

const TP_TYPE_NAMES = { 1:"Swim",2:"Bike",3:"Run",4:"Brick",5:"Crosstrain",6:"Race",7:"DayOff",8:"MtnBike",9:"Strength",10:"Custom",11:"XCSki",12:"Rowing",13:"Walk",100:"Other" };

async function tpFetchRange(auth, startDate, endDate) {
  const r = await fetch(`${TP_API_BASE}/fitness/v6/athletes/${auth.athleteId}/workouts/${startDate}/${endDate}`, {
    headers: { "Authorization": `Bearer ${auth.token}`, "Accept": "application/json" }
  });
  if (!r.ok) throw new Error(`TP workouts ${r.status}`);
  const d = await r.json();
  return Array.isArray(d) ? d : [];
}
__name(tpFetchRange, "tpFetchRange");

// TSS for a completed workout; when tssActual is missing fall back to a
// duration estimate (hrTSS ≈ 60/hr). Planned-only workouts contribute 0.
function tpWorkoutTss(w) {
  const completed = w.totalTime || w.calories || w.distance;
  if (!completed) return 0;
  if (typeof w.tssActual === "number" && w.tssActual > 0) return w.tssActual;
  return (w.totalTime || 0) * 60;
}
__name(tpWorkoutTss, "tpWorkoutTss");

// Recompute CTL/ATL/TSB. First run backfills 90 days from a zero seed;
// after that a 14-day window re-runs, seeded from the row before the window.
async function tpRecomputeLoad(env, userId) {
  const auth = await tpGetAccessToken(env);
  if (auth.error) return auth;

  const today = new Date().toISOString().slice(0, 10);
  const count = (await env.DB.prepare("SELECT COUNT(*) AS n FROM training_load WHERE user_id = ?").bind(userId).first())?.n || 0;
  const windowDays = count === 0 ? 90 : 14;
  const start = new Date(Date.now() - (windowDays - 1) * 86400000).toISOString().slice(0, 10);

  let ctl = 0, atl = 0;
  if (count > 0) {
    const seed = await env.DB.prepare(
      "SELECT ctl, atl FROM training_load WHERE user_id = ? AND date < ? ORDER BY date DESC LIMIT 1"
    ).bind(userId, start).first();
    if (seed) { ctl = seed.ctl; atl = seed.atl; }
  }

  const workouts = await tpFetchRange(auth, start, today);
  const tssByDay = {};
  for (const w of workouts) {
    const day = (w.workoutDay || "").slice(0, 10);
    if (day) tssByDay[day] = (tssByDay[day] || 0) + tpWorkoutTss(w);
  }

  const stmts = [];
  const now = Date.now();
  for (let d = new Date(start + "T12:00:00Z"); ; d = new Date(d.getTime() + 86400000)) {
    const day = d.toISOString().slice(0, 10);
    if (day > today) break;
    const tss = Math.round((tssByDay[day] || 0) * 10) / 10;
    ctl = ctl + (tss - ctl) / 42;
    atl = atl + (tss - atl) / 7;
    stmts.push(env.DB.prepare(`INSERT INTO training_load (user_id, date, tss, ctl, atl, tsb, computed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id, date) DO UPDATE SET tss=excluded.tss, ctl=excluded.ctl, atl=excluded.atl, tsb=excluded.tsb, computed_at=excluded.computed_at`)
      .bind(userId, day, tss, Math.round(ctl * 10) / 10, Math.round(atl * 10) / 10, Math.round((ctl - atl) * 10) / 10, now));
  }
  for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50));
  return { ok: true, days: stmts.length };
}
__name(tpRecomputeLoad, "tpRecomputeLoad");

// ── Google token verification ───────────────────────────────────────────
async function verifyGoogleToken(idToken, env) {
  const res = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`);
  if (!res.ok) return null;
  const payload = await res.json();
  if (payload.aud !== GOOGLE_CLIENT_ID) return null;
  if (payload.iss !== "accounts.google.com" && payload.iss !== "https://accounts.google.com") return null;
  if (payload.email_verified !== true && payload.email_verified !== "true") return null;
  if (Number(payload.exp) * 1000 < Date.now()) return null;
  const allowed = env?.ALLOWED_EMAILS
    ? new Set(env.ALLOWED_EMAILS.split(",").map(s => s.trim().toLowerCase()))
    : ALLOWED_EMAILS;
  if (!allowed.has((payload.email || "").toLowerCase())) return null;
  return payload;
}
__name(verifyGoogleToken, "verifyGoogleToken");

var worker_default = {
  async fetch(req, env, ctx) {
    const u = new URL(req.url);
    const CORS = { "content-type": "application/json", "access-control-allow-origin": "*" };

    // ── CORS preflight ──────────────────────────────────────────────────
    if (req.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "GET,POST,PUT,DELETE,OPTIONS",
          "access-control-allow-headers": "content-type,authorization",
          "access-control-max-age": "86400"
        }
      });
    }

    if (u.pathname === "/api/status") {
      // Key details only for an authenticated session — public callers get a bare health check
      const statusUser = await getSessionUser(env.DB, req).catch(() => null);
      const body = statusUser
        ? { ok: true, hasKey: !!env.ANTHROPIC_KEY, schemaVersion: SCHEMA_VERSION }
        : { ok: true };
      return new Response(JSON.stringify(body), { headers: CORS });
    }

    // ── Auth: Google Sign-In → create session ───────────────────────────
    if (u.pathname === "/api/auth/google" && req.method === "POST") {
      try {
        const { idToken } = await req.json();
        const payload = await verifyGoogleToken(idToken, env);
        if (!payload) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: CORS });

        let user = await env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(payload.sub).first();

        if (!user) {
          await env.DB.prepare(
            "INSERT INTO users (id, email, name, picture) VALUES (?, ?, ?, ?)"
          ).bind(payload.sub, payload.email, payload.name || "", payload.picture || "").run();
          user = await env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(payload.sub).first();
        }

        // Create a long-lived session token; prune expired rows while we're here
        const session = await createSession(env.DB, payload.sub);
        try { await env.DB.prepare("DELETE FROM sessions WHERE expires_at <= datetime('now')").run(); } catch(_) {}

        return new Response(JSON.stringify({ user, sessionToken: session.token, expiresAt: session.expiresAt }), {
          headers: { ...CORS, "set-cookie": sessionCookie(session.token, SESSION_TTL_DAYS * 86400) }
        });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: CORS });
      }
    }

    // ── Get user profile (Bearer or cookie; cookie wins if Bearer is stale) ──
    if (u.pathname === "/api/user" && req.method === "GET") {
      const { user, token } = await resolveSession(env.DB, req);
      if (!user) return new Response(JSON.stringify({ error: "Invalid or expired session" }), { status: 401, headers: CORS });
      return new Response(JSON.stringify({ user, sessionToken: token }), {
        headers: { ...CORS, "set-cookie": sessionCookie(token, SESSION_TTL_DAYS * 86400) }
      });
    }

    // ── Save onboarding / update profile ────────────────────────────────
    if (u.pathname === "/api/user/profile" && req.method === "PUT") {
      const user = await getSessionUser(env.DB, req);
      if (!user) return new Response(JSON.stringify({ error: "Invalid or expired session" }), { status: 401, headers: CORS });

      const body = await req.json();
      const { gender, age, height_inches, current_weight, goal_weight, goal_date,
              activity_level, tdee, calories, protein, carbs, fat } = body;

      await env.DB.prepare(`
        UPDATE users SET
          gender = ?, age = ?, height_inches = ?, current_weight = ?, goal_weight = ?,
          goal_date = ?, activity_level = ?, tdee = ?, calories = ?, protein = ?,
          carbs = ?, fat = ?, onboarded = 1, updated_at = datetime('now')
        WHERE id = ?
      `).bind(
        gender, age, height_inches, current_weight, goal_weight,
        goal_date, activity_level, tdee, calories, protein,
        carbs, fat, user.id
      ).run();

      const updated = await env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(user.id).first();
      return new Response(JSON.stringify({ user: updated }), { headers: CORS });
    }

    // ── Logout: delete session ──────────────────────────────────────────
    if (u.pathname === "/api/auth/logout" && req.method === "POST") {
      const auth = req.headers.get("authorization")?.replace("Bearer ", "") || parseCookie(req, "session");
      if (auth) {
        try { await env.DB.prepare("DELETE FROM sessions WHERE token = ?").bind(auth).run(); } catch(_) {}
      }
      return new Response(JSON.stringify({ ok: true }), {
        headers: { ...CORS, "set-cookie": sessionCookie("", 0) }
      });
    }

    // ── Protected endpoints — require valid session ─────────────────────

    // Brief context (email cache from D1)
    if (u.pathname === "/api/brief-context" && req.method === "GET") {
      const user = await getSessionUser(env.DB, req);
      if (!user) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: CORS });
      try {
        const date = u.searchParams.get("date") || new Date().toISOString().slice(0,10);
        if (!env.DB) return new Response(JSON.stringify({ ok: false }), { headers: CORS });
        const row = await env.DB.prepare("SELECT email_context, calendar_context FROM brief_cache WHERE user_id = ? AND date = ?").bind(user.id, date).first();
        return new Response(JSON.stringify({
          ok: true,
          emails: row?.email_context ? JSON.parse(row.email_context) : [],
          calendar: row?.calendar_context ? JSON.parse(row.calendar_context) : []
        }), { headers: CORS });
      } catch(e) { return new Response(JSON.stringify({ ok: false, emails: [], calendar: [] }), { headers: CORS }); }
    }

    // Daily Brief
    if (u.pathname === "/api/brief" && req.method === "POST") {
      const user = await getSessionUser(env.DB, req);
      if (!user) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: CORS });
      try {
        if (!env.ANTHROPIC_KEY) return new Response(JSON.stringify({ ok: false, error: "no key" }), { status: 500, headers: CORS });

        const body = await req.json();
        const { healthContext: h = {}, date = new Date().toISOString().slice(0, 10), emailContext = [] } = body;
        const daysToMarathon = Math.max(0, Math.ceil((new Date("2026-06-20") - new Date()) / 86400000));
        const hr = new Date().getHours();
        const greeting = hr < 12 ? "Good Morning" : hr < 17 ? "Good Afternoon" : "Good Evening";

        const emailSection = emailContext.length
          ? emailContext.map(e => `- From: ${e.from}\n  Subject: ${e.subject}\n  Preview: ${e.snippet}`).join("\n")
          : "No urgent emails";

        const prompt = `You are Jeremy's personal AI chief-of-staff. Write a tight daily brief as JSON.

HEALTH:
- Weight: ${h.weight ? h.weight + " lbs (goal: " + (h.targetWeight||163) + " lbs)" : "not logged yet today"}
- Macros: ${h.calories||0} kcal, ${h.protein||0}g protein
- Energy: ${h.energy||"?"}/5, Mood: ${h.mood||"?"}/5
- Water: ${h.water||0} oz
- Marathon: ${daysToMarathon} days to Grandma's Marathon (June 20 2026)

URGENT EMAILS:
${emailSection}

Return ONLY valid JSON, no markdown:
{"greeting":"${greeting}, Jeremy","date":"${new Date().toLocaleDateString('en-US',{weekday:'long',month:'long',day:'numeric'})}","urgent_emails":[{"from":"Name","subject":"Subject","flag":"why urgent"}],"health_note":"one sentence with numbers","focus":"most important thing today"}

Rules: urgent_emails max 3, skip promos/newsletters; health_note use actual numbers; Return ONLY JSON`;

        const r = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: { "content-type": "application/json", "anthropic-version": "2023-06-01", "x-api-key": env.ANTHROPIC_KEY },
          body: JSON.stringify({ model: "claude-haiku-4-5-20251001", max_tokens: 600, messages: [{ role: "user", content: prompt }] })
        });

        const data = await r.json();
        if (!r.ok) return new Response(JSON.stringify({ ok: false, error: data?.error?.message }), { status: r.status, headers: CORS });

        const text = (data.content||[]).filter(b => b.type==="text").map(b => b.text).join("");
        let brief = null;
        try {
          const clean = text.replace(/```json|```/g,"").trim();
          const s = clean.indexOf("{"), e = clean.lastIndexOf("}");
          if (s>=0 && e>s) brief = JSON.parse(clean.slice(s, e+1));
        } catch(_) {}

        return new Response(JSON.stringify({ ok: true, brief, raw: text }), { headers: CORS });
      } catch(e) {
        return new Response(JSON.stringify({ ok: false, error: e.message }), { status: 500, headers: CORS });
      }
    }

    // ── Checkin upsert ─────────────────────────────────────────────────────
    if (u.pathname === "/api/checkin" && req.method === "POST") {
      const user = await getSessionUser(env.DB, req);
      if (!user) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: CORS });
      try {
        const b = await req.json();
        if (!b.date || !env.DB) return new Response(JSON.stringify({ ok: false, error: "missing date or DB" }), { headers: CORS });
        const sql = `INSERT INTO daily_checkin (date,user_id,energy,mood,water_oz,weight_lbs,sleep_hrs,sleep_deep,sleep_rem,sleep_score,calories_consumed,protein_g,carbs_g,fat_g,steps,active_cals,notes,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now')) ON CONFLICT(date,user_id) DO UPDATE SET energy=excluded.energy,mood=excluded.mood,water_oz=excluded.water_oz,weight_lbs=excluded.weight_lbs,sleep_hrs=excluded.sleep_hrs,sleep_deep=excluded.sleep_deep,sleep_rem=excluded.sleep_rem,sleep_score=excluded.sleep_score,calories_consumed=excluded.calories_consumed,protein_g=excluded.protein_g,carbs_g=excluded.carbs_g,fat_g=excluded.fat_g,steps=excluded.steps,active_cals=excluded.active_cals,notes=excluded.notes,updated_at=datetime('now')`;
        await env.DB.prepare(sql).bind(b.date,user.id,b.energy??null,b.mood??null,b.water_oz??null,b.weight_lbs??null,b.sleep_hrs??null,b.sleep_deep??null,b.sleep_rem??null,b.sleep_score??null,b.calories_consumed??null,b.protein_g??null,b.carbs_g??null,b.fat_g??null,b.steps??null,b.active_cals??null,b.notes??null).run();
        return new Response(JSON.stringify({ ok: true }), { headers: CORS });
      } catch(e) { return new Response(JSON.stringify({ ok: false, error: e.message }), { status: 500, headers: CORS }); }
    }

    if (u.pathname === "/api/checkin" && req.method === "GET") {
      const user = await getSessionUser(env.DB, req);
      if (!user) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: CORS });
      try {
        const days = Math.min(parseInt(u.searchParams.get("days")||"90"), 365);
        const rows = await env.DB.prepare(`SELECT * FROM daily_checkin WHERE user_id = ? AND date>=date('now','-'||?||' days') ORDER BY date DESC`).bind(user.id, days).all();
        return new Response(JSON.stringify({ ok: true, rows: rows.results }), { headers: CORS });
      } catch(e) { return new Response(JSON.stringify({ ok: false, error: e.message }), { status: 500, headers: CORS }); }
    }

    // ── Barcode lookup ─────────────────────────────────────────────────────
    if (u.pathname === "/api/barcode" && req.method === "GET") {
      const bcUser = await getSessionUser(env.DB, req);
      if (!bcUser) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: CORS });
      const raw = (u.searchParams.get("code")||"").replace(/\D/g,"");
      if (!raw) return new Response(JSON.stringify({ found: false }), { headers: CORS });
      const ean13 = raw.length===12 ? "0"+raw : raw;
      const upcA  = raw.length===13 && raw.startsWith("0") ? raw.slice(1) : raw;
      const codes = [...new Set([raw, ean13, upcA])];
      const UA = "MacroTracker/1.0 (jeremy@dronenerd.com)";
      for (const code of codes) {
        try {
          const r = await fetch(`https://world.openfoodfacts.org/api/v2/product/${code}?fields=product_name,product_name_en,brands,serving_size,serving_quantity,nutriments`, { headers: { "User-Agent": UA, "Accept": "application/json" } });
          if (!r.ok) continue;
          const d = await r.json();
          if (d.status===1 && d.product) { const p = parseOFF(d.product); if (p?.calories>0) return new Response(JSON.stringify({ found:true, product:{...p,source:"Open Food Facts"} }), { headers: CORS }); }
        } catch(_) {}
      }
      const USDA_KEY = env.USDA_API_KEY || env.USDA_KEY || "DEMO_KEY";
      for (const code of codes) {
        try {
          const r = await fetch(`https://api.nal.usda.gov/fdc/v1/foods/search?api_key=${USDA_KEY}&query=${encodeURIComponent(code)}&dataType=Branded&pageSize=10`, { headers: { "User-Agent": UA } });
          if (!r.ok) continue;
          const d = await r.json();
          const hit = (d.foods||[]).find(f => f.gtinUpc && codes.includes(f.gtinUpc));
          if (hit) { const p = parseUSDA(hit); if (p?.calories>0) return new Response(JSON.stringify({ found:true, product:{...p,source:"USDA FDC"} }), { headers: CORS }); }
        } catch(_) {}
      }
      try {
        const r = await fetch(`https://api.upcitemdb.com/prod/trial/lookup?upc=${upcA}`, { headers: { "User-Agent": UA } });
        if (r.ok) {
          const d = await r.json();
          const item = (d.items||[])[0];
          if (item?.title) {
            const nutr = await usdaNameSearch(item.title, USDA_KEY, UA);
            if (nutr?.calories>0) return new Response(JSON.stringify({ found:true, product:{...nutr,name:item.title,brand:item.brand||nutr.brand,source:"UPC ItemDB+USDA"} }), { headers: CORS });
            return new Response(JSON.stringify({ found:true, product:{name:item.title,brand:item.brand||"",calories:0,protein:0,carbs:0,fat:0,servingSize:"1",servingUnit:"serving",source:"UPC ItemDB",incomplete:true} }), { headers: CORS });
          }
        }
      } catch(_) {}
      return new Response(JSON.stringify({ found: false }), { headers: CORS });
    }

    // ── Claude proxy (now auth-protected) ───────────────────────────────
    if (u.pathname === "/api/claude" && req.method === "POST") {
      const user = await getSessionUser(env.DB, req);
      if (!user) return new Response(JSON.stringify({ error: { message: "Unauthorized" } }), { status: 401, headers: CORS });
      try {
        if (!env.ANTHROPIC_KEY) return new Response(JSON.stringify({ error: { message: "no key" } }), { status: 500, headers: CORS });
        const b = await req.json();
        if (!b || typeof b !== "object" || !CLAUDE_ALLOWED_MODELS.has(b.model)) {
          return new Response(JSON.stringify({ error: { message: "model not allowed" } }), { status: 400, headers: CORS });
        }
        b.max_tokens = Math.min(Number(b.max_tokens) || 1024, CLAUDE_MAX_TOKENS_CAP);
        delete b.stream;
        delete b.metadata;
        // Cap image payloads (~2MB binary ≈ 2.8M base64 chars) — client downscales first
        for (const m of (Array.isArray(b.messages) ? b.messages : [])) {
          if (!Array.isArray(m?.content)) continue;
          for (const block of m.content) {
            if (block?.type === "image" && (block.source?.data?.length || 0) > 2800000) {
              return new Response(JSON.stringify({ error: { message: "image too large — max ~2MB" } }), { status: 400, headers: CORS });
            }
          }
        }
        const r = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: { "content-type": "application/json", "anthropic-version": "2023-06-01", "x-api-key": env.ANTHROPIC_KEY },
          body: JSON.stringify(b)
        });
        const data = await r.json();
        return new Response(JSON.stringify(data), { status: r.ok?200:r.status, headers: CORS });
      } catch(e) { return new Response(JSON.stringify({ error: { message: e.message } }), { status: 500, headers: CORS }); }
    }

    // ── USDA API proxy ──────────────────────────────────────────────────
    if (u.pathname === "/api/usda/search" && req.method === "GET") {
      const usdaUser = await getSessionUser(env.DB, req);
      if (!usdaUser) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: CORS });
      try {
        const apiKey = env.USDA_API_KEY || "DEMO_KEY";
        const query = u.searchParams.get("query") || "";
        const dataType = u.searchParams.get("dataType") || "";
        const pageSize = u.searchParams.get("pageSize") || "6";
        let usdaUrl = `https://api.nal.usda.gov/fdc/v1/foods/search?query=${encodeURIComponent(query)}&pageSize=${pageSize}&api_key=${apiKey}`;
        if (dataType) usdaUrl += `&dataType=${encodeURIComponent(dataType)}`;
        const r = await fetch(usdaUrl);
        const data = await r.json();
        return new Response(JSON.stringify(data), { status: r.ok ? 200 : r.status, headers: CORS });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: CORS });
      }
    }

    // ── Log sync: GET pulls rows since cursor, POST upserts (LWW on updated_at) ──
    if (u.pathname.startsWith("/api/log/")) {
      const cfg = LOG_TABLES[u.pathname.slice("/api/log/".length)];
      if (!cfg) return new Response(JSON.stringify({ error: "Unknown log" }), { status: 404, headers: CORS });
      const logUser = await getSessionUser(env.DB, req);
      if (!logUser) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: CORS });

      if (req.method === "GET") {
        try {
          const since = Number(u.searchParams.get("since") || 0) || 0;
          const rows = (await env.DB.prepare(
            `SELECT * FROM ${cfg.table} WHERE user_id = ? AND updated_at > ? ORDER BY updated_at ASC LIMIT 4000`
          ).bind(logUser.id, since).all()).results.map(r => {
            if (r.payload_json !== undefined) { try { r.payload = JSON.parse(r.payload_json); } catch(_) { r.payload = null; } delete r.payload_json; }
            return r;
          });
          return new Response(JSON.stringify({ ok: true, now: Date.now(), rows }), { headers: CORS });
        } catch (e) {
          return new Response(JSON.stringify({ ok: false, error: e.message }), { status: 500, headers: CORS });
        }
      }

      if (req.method === "POST") {
        try {
          const { entries } = await req.json();
          if (!Array.isArray(entries) || entries.length > 500) {
            return new Response(JSON.stringify({ ok: false, error: "entries must be an array of ≤500" }), { status: 400, headers: CORS });
          }
          const stmts = entries.map(e => logUpsertStmt(env.DB, cfg, logUser.id, e)).filter(Boolean);
          if (stmts.length) await env.DB.batch(stmts);
          return new Response(JSON.stringify({ ok: true, applied: stmts.length, skipped: entries.length - stmts.length, now: Date.now() }), { headers: CORS });
        } catch (e) {
          return new Response(JSON.stringify({ ok: false, error: e.message }), { status: 500, headers: CORS });
        }
      }
    }

    // ── TrainingPeaks: connect (store cookie, exchange for token) ───────
    if (u.pathname === "/api/tp/auth" && req.method === "POST") {
      const tpAuthUser = await getSessionUser(env.DB, req);
      if (!tpAuthUser) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: CORS });
      try {
        const { cookie } = await req.json();
        const trimmed = (cookie || "").trim();
        if (!trimmed) return new Response(JSON.stringify({ ok: false, error: "Missing cookie" }), { status: 400, headers: CORS });

        const tok = await tpExchangeCookie(trimmed);
        if (!tok) return new Response(JSON.stringify({ ok: false, error: "Cookie rejected by TrainingPeaks — copy a fresh Production_tpAuth value" }), { status: 401, headers: CORS });

        const userRes = await fetch(`${TP_API_BASE}/users/v3/user`, {
          headers: { "Authorization": `Bearer ${tok.accessToken}`, "Accept": "application/json" }
        });
        if (!userRes.ok) return new Response(JSON.stringify({ ok: false, error: "Could not load TrainingPeaks profile" }), { status: 502, headers: CORS });
        const userData = (await userRes.json());
        const tpUser = userData.user || userData;
        const athleteId = tpUser.athletes?.[0]?.athleteId || tpUser.personId;
        const athleteName = `${tpUser.firstName || ""} ${tpUser.lastName || ""}`.trim() || tpUser.email || "Athlete";
        if (!athleteId) return new Response(JSON.stringify({ ok: false, error: "No athlete ID on this TrainingPeaks account" }), { status: 502, headers: CORS });

        await env.DB.prepare(`CREATE TABLE IF NOT EXISTS tp_auth (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          cookie TEXT NOT NULL,
          access_token TEXT,
          token_expires_at TEXT,
          athlete_id INTEGER,
          athlete_name TEXT,
          updated_at TEXT DEFAULT (datetime('now'))
        )`).run();
        await env.DB.prepare(`INSERT INTO tp_auth (id, cookie, access_token, token_expires_at, athlete_id, athlete_name, updated_at)
          VALUES (1, ?, ?, ?, ?, ?, datetime('now'))
          ON CONFLICT(id) DO UPDATE SET cookie=excluded.cookie, access_token=excluded.access_token,
            token_expires_at=excluded.token_expires_at, athlete_id=excluded.athlete_id,
            athlete_name=excluded.athlete_name, updated_at=datetime('now')`)
          .bind(trimmed, tok.accessToken, new Date(tok.expiresAt).toISOString(), athleteId, athleteName).run();

        return new Response(JSON.stringify({ ok: true, athlete: { id: athleteId, name: athleteName } }), { headers: CORS });
      } catch (e) {
        return new Response(JSON.stringify({ ok: false, error: e.message }), { status: 500, headers: CORS });
      }
    }

    // ── TrainingPeaks: connection status ─────────────────────────────────
    if (u.pathname === "/api/tp/status" && req.method === "GET") {
      const tpStatusUser = await getSessionUser(env.DB, req);
      if (!tpStatusUser) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: CORS });
      try {
        const auth = await tpGetAccessToken(env);
        if (auth.error) return new Response(JSON.stringify({ ok: true, connected: false, error: auth.error }), { headers: CORS });
        return new Response(JSON.stringify({ ok: true, connected: true, athlete: { id: auth.athleteId, name: auth.athleteName } }), { headers: CORS });
      } catch (e) {
        return new Response(JSON.stringify({ ok: false, error: e.message }), { status: 500, headers: CORS });
      }
    }

    // ── TrainingPeaks: disconnect ─────────────────────────────────────────
    if (u.pathname === "/api/tp/disconnect" && req.method === "POST") {
      const tpDiscUser = await getSessionUser(env.DB, req);
      if (!tpDiscUser) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: CORS });
      try { await env.DB.prepare("DELETE FROM tp_auth WHERE id = 1").run(); } catch(_) {}
      return new Response(JSON.stringify({ ok: true }), { headers: CORS });
    }

    // ── TrainingPeaks: today's completed runs ─────────────────────────────
    if (u.pathname === "/api/tp/today" && req.method === "GET") {
      const tpUser = await getSessionUser(env.DB, req);
      if (!tpUser) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: CORS });
      try {
        const date = u.searchParams.get("date") || new Date().toISOString().slice(0, 10);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return new Response(JSON.stringify({ ok: false, error: "Bad date" }), { status: 400, headers: CORS });

        const auth = await tpGetAccessToken(env);
        if (auth.error) return new Response(JSON.stringify({ ok: false, error: auth.error }), { status: auth.error === "not_connected" ? 400 : 401, headers: CORS });

        const wRes = await fetch(`${TP_API_BASE}/fitness/v6/athletes/${auth.athleteId}/workouts/${date}/${date}`, {
          headers: { "Authorization": `Bearer ${auth.token}`, "Accept": "application/json" }
        });
        if (wRes.status === 401) {
          // Token went stale mid-flight — force a re-exchange next call
          try { await env.DB.prepare("UPDATE tp_auth SET access_token = NULL WHERE id = 1").run(); } catch(_) {}
          return new Response(JSON.stringify({ ok: false, error: "cookie_expired" }), { status: 401, headers: CORS });
        }
        if (!wRes.ok) return new Response(JSON.stringify({ ok: false, error: `TrainingPeaks API ${wRes.status}` }), { status: 502, headers: CORS });

        const all = await wRes.json();
        // Completed run-type workouts only: Run(3), Race(6), Walk(13); totalTime is hours
        const runs = (Array.isArray(all) ? all : []).filter(w =>
          TP_RUN_TYPES.has(w.workoutTypeValueId) && (w.totalTime || w.calories || w.distance));

        let calories = 0, distance = 0, duration = 0;
        const workouts = runs.map(w => {
          const cal = Math.round(w.calories || 0);
          const dist = Math.round(w.distance || 0);
          const dur = Math.round((w.totalTime || 0) * 3600);
          calories += cal; distance += dist; duration += dur;
          return { id: w.workoutId, title: w.title || "", type: w.workoutTypeValueId, calories: cal, distance: dist, duration: dur, tss: w.tssActual || null };
        });

        // Item 3: refresh training load in the background after each sync
        if (ctx?.waitUntil) ctx.waitUntil(tpRecomputeLoad(env, tpUser.id).catch(() => {}));

        return new Response(JSON.stringify({ ok: true, date, count: workouts.length, calories, distance, duration, workouts }), { headers: CORS });
      } catch (e) {
        return new Response(JSON.stringify({ ok: false, error: e.message }), { status: 500, headers: CORS });
      }
    }

    // ── Item 3: daily training load (CTL/ATL/TSB) ─────────────────────────
    if (u.pathname === "/api/training/load" && req.method === "GET") {
      const loadUser = await getSessionUser(env.DB, req);
      if (!loadUser) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: CORS });
      try {
        const days = Math.min(parseInt(u.searchParams.get("days") || "90") || 90, 365);
        let rows = (await env.DB.prepare(
          `SELECT date, tss, ctl, atl, tsb FROM training_load WHERE user_id = ? AND date >= date('now', '-' || ? || ' days') ORDER BY date ASC`
        ).bind(loadUser.id, days).all()).results;
        if (rows.length === 0) {
          // First call after connecting TP: backfill synchronously
          const res = await tpRecomputeLoad(env, loadUser.id);
          if (res.error) return new Response(JSON.stringify({ ok: false, error: res.error }), { status: 400, headers: CORS });
          rows = (await env.DB.prepare(
            `SELECT date, tss, ctl, atl, tsb FROM training_load WHERE user_id = ? AND date >= date('now', '-' || ? || ' days') ORDER BY date ASC`
          ).bind(loadUser.id, days).all()).results;
        }
        return new Response(JSON.stringify({ ok: true, rows }), { headers: CORS });
      } catch (e) {
        return new Response(JSON.stringify({ ok: false, error: e.message }), { status: 500, headers: CORS });
      }
    }

    // ── Item 5: all trend series in one payload ───────────────────────────
    if (u.pathname === "/api/trends" && req.method === "GET") {
      const trUser = await getSessionUser(env.DB, req);
      if (!trUser) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: CORS });
      try {
        const days = Math.min(parseInt(u.searchParams.get("days") || "180") || 180, 365);
        const cutoffSql = `date('now', '-' || ? || ' days')`;
        const [weights, checkins, load, foodDaily] = await Promise.all([
          env.DB.prepare(`SELECT date, weight_lbs FROM weight_log WHERE user_id = ? AND date >= ${cutoffSql} ORDER BY date ASC`).bind(trUser.id, days).all(),
          env.DB.prepare(`SELECT date, energy, mood, sleep_hrs, calories_consumed, protein_g, weight_lbs FROM daily_checkin WHERE user_id = ? AND date >= ${cutoffSql} ORDER BY date ASC`).bind(trUser.id, days).all(),
          env.DB.prepare(`SELECT date, tss, ctl, atl, tsb FROM training_load WHERE user_id = ? AND date >= ${cutoffSql} ORDER BY date ASC`).bind(trUser.id, days).all(),
          // Daily calorie/protein totals straight from the synced food log —
          // covers days where no check-in row was written
          env.DB.prepare(`SELECT date,
              SUM(CAST(json_extract(payload_json, '$.calories') AS REAL)) AS calories,
              SUM(CAST(json_extract(payload_json, '$.protein') AS REAL)) AS protein
            FROM food_log WHERE user_id = ? AND deleted = 0 AND date >= ${cutoffSql}
            GROUP BY date ORDER BY date ASC`).bind(trUser.id, days).all(),
        ]);
        // Weight: prefer explicit weight_log, fall back to check-in weigh-ins
        const wmap = {};
        for (const c of checkins.results) if (c.weight_lbs > 0) wmap[c.date] = c.weight_lbs;
        for (const w of weights.results) wmap[w.date] = w.weight_lbs;
        const weightSeries = Object.entries(wmap).sort(([a], [b]) => a.localeCompare(b)).map(([date, lbs]) => ({ date, lbs }));
        const profile = {
          calories: trUser.calories, protein: trUser.protein, carbs: trUser.carbs, fat: trUser.fat,
          tdee: trUser.tdee, current_weight: trUser.current_weight, goal_weight: trUser.goal_weight, goal_date: trUser.goal_date,
        };
        return new Response(JSON.stringify({ ok: true, days, profile, weights: weightSeries, checkins: checkins.results, load: load.results, food: foodDaily.results }), { headers: CORS });
      } catch (e) {
        return new Response(JSON.stringify({ ok: false, error: e.message }), { status: 500, headers: CORS });
      }
    }

    // ── Item 5: weekly "what changed" summary (Claude, cached per ISO week) ──
    if (u.pathname === "/api/trends/summary" && req.method === "GET") {
      const tsUser = await getSessionUser(env.DB, req);
      if (!tsUser) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: CORS });
      try {
        // ISO week key
        const d = new Date();
        const jan4 = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
        const week = Math.ceil((((d - jan4) / 86400000) + jan4.getUTCDay() + 1) / 7);
        const cacheKey = `trends-${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;

        const cached = await env.DB.prepare("SELECT email_context FROM brief_cache WHERE user_id = ? AND date = ?").bind(tsUser.id, cacheKey).first();
        if (cached?.email_context) {
          try {
            const c = JSON.parse(cached.email_context);
            if (Date.now() - (c.generated_at || 0) < 86400000) {
              return new Response(JSON.stringify({ ok: true, summary: c.summary, cached: true }), { headers: CORS });
            }
          } catch(_) {}
        }
        if (!env.ANTHROPIC_KEY) return new Response(JSON.stringify({ ok: false, error: "no key" }), { status: 500, headers: CORS });

        // Calories/protein from the synced food log; weight from weight_log;
        // sleep/mood from check-ins when present; TSS from training_load.
        const foodWeek = (win) => env.DB.prepare(`SELECT AVG(c) AS cals, AVG(p) AS prot FROM (
            SELECT SUM(CAST(json_extract(payload_json,'$.calories') AS REAL)) AS c,
                   SUM(CAST(json_extract(payload_json,'$.protein') AS REAL)) AS p
            FROM food_log WHERE user_id = ? AND deleted = 0 AND ${win} GROUP BY date)`).bind(tsUser.id).first();
        const [wkFood, prevFood, wkW, prevW, wkCk, tssWk] = await Promise.all([
          foodWeek(`date >= date('now', '-7 days')`),
          foodWeek(`date >= date('now', '-14 days') AND date < date('now', '-7 days')`),
          env.DB.prepare(`SELECT MIN(weight_lbs) AS wmin, MAX(weight_lbs) AS wmax, AVG(weight_lbs) AS wavg FROM weight_log WHERE user_id = ? AND date >= date('now', '-7 days')`).bind(tsUser.id).first(),
          env.DB.prepare(`SELECT AVG(weight_lbs) AS wavg FROM weight_log WHERE user_id = ? AND date >= date('now', '-14 days') AND date < date('now', '-7 days')`).bind(tsUser.id).first(),
          env.DB.prepare(`SELECT AVG(sleep_hrs) AS sleep, AVG(mood) AS mood, AVG(energy) AS energy FROM daily_checkin WHERE user_id = ? AND date >= date('now', '-7 days')`).bind(tsUser.id).first(),
          env.DB.prepare(`SELECT SUM(tss) AS tss FROM training_load WHERE user_id = ? AND date >= date('now', '-7 days')`).bind(tsUser.id).first(),
        ]);
        const fmt = (v, f) => (v == null ? "not tracked" : f(v));
        const stats = `THIS WEEK: avg calories ${fmt(wkFood?.cals, v => Math.round(v))} (target ${tsUser.calories || "?"}), avg protein ${fmt(wkFood?.prot, v => Math.round(v) + "g")} (target ${tsUser.protein || "?"}g), weight ${fmt(wkW?.wavg, v => wkW.wmin + "–" + wkW.wmax + " lbs")}, weekly TSS ${Math.round(tssWk?.tss || 0)}, sleep ${fmt(wkCk?.sleep, v => v.toFixed(1) + "h")}, mood ${fmt(wkCk?.mood, v => v.toFixed(1) + "/5")}.
LAST WEEK: avg calories ${fmt(prevFood?.cals, v => Math.round(v))}, avg protein ${fmt(prevFood?.prot, v => Math.round(v) + "g")}, avg weight ${fmt(prevW?.wavg, v => v.toFixed(1) + " lbs")}.
GOAL: ${tsUser.goal_weight || "?"} lbs by ${tsUser.goal_date || "?"}. This data comes from Jeremy's own tracking app (the one showing this summary) — never recommend other tracking apps; if a metric is "not tracked", at most gently note it.`;

        const r = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: { "content-type": "application/json", "anthropic-version": "2023-06-01", "x-api-key": env.ANTHROPIC_KEY },
          body: JSON.stringify({
            model: "claude-haiku-4-5-20251001", max_tokens: 200,
            messages: [{ role: "user", content: `Write a "what changed this week" health summary for Jeremy. Second person, under 80 words, cite specific numbers, mention the single most important trend and one action. No preamble, no markdown.\n\n${stats}` }]
          })
        });
        const data = await r.json();
        if (!r.ok) return new Response(JSON.stringify({ ok: false, error: data?.error?.message }), { status: r.status, headers: CORS });
        const summary = (data.content || []).filter(b => b.type === "text").map(b => b.text).join("").trim();

        await env.DB.prepare(`INSERT INTO brief_cache (user_id, date, email_context) VALUES (?, ?, ?)
          ON CONFLICT(user_id, date) DO UPDATE SET email_context = excluded.email_context`)
          .bind(tsUser.id, cacheKey, JSON.stringify({ summary, generated_at: Date.now() })).run()
          .catch(async () => {
            // brief_cache may lack a (user_id,date) unique constraint — fall back to delete+insert
            await env.DB.prepare("DELETE FROM brief_cache WHERE user_id = ? AND date = ?").bind(tsUser.id, cacheKey).run();
            await env.DB.prepare("INSERT INTO brief_cache (user_id, date, email_context) VALUES (?, ?, ?)").bind(tsUser.id, cacheKey, JSON.stringify({ summary, generated_at: Date.now() })).run();
          });

        return new Response(JSON.stringify({ ok: true, summary, cached: false }), { headers: CORS });
      } catch (e) {
        return new Response(JSON.stringify({ ok: false, error: e.message }), { status: 500, headers: CORS });
      }
    }

    // ── Item 4: tomorrow's planned sessions (fetch live, cache in D1) ─────
    if (u.pathname === "/api/tp/planned" && req.method === "GET") {
      const plannedUser = await getSessionUser(env.DB, req);
      if (!plannedUser) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: CORS });
      try {
        const date = u.searchParams.get("date") || new Date(Date.now() + 86400000).toISOString().slice(0, 10);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return new Response(JSON.stringify({ ok: false, error: "Bad date" }), { status: 400, headers: CORS });
        const auth = await tpGetAccessToken(env);
        if (auth.error) return new Response(JSON.stringify({ ok: false, error: auth.error }), { status: auth.error === "not_connected" ? 400 : 401, headers: CORS });

        const all = await tpFetchRange(auth, date, date);
        // Planned = has planned fields and no completed metrics yet
        const planned = all.filter(w => !(w.totalTime || w.calories || w.distance) && (w.totalTimePlanned || w.tssPlanned || w.distancePlanned))
          .map(w => ({
            workout_id: String(w.workoutId),
            type: TP_TYPE_NAMES[w.workoutTypeValueId] || String(w.workoutTypeValueId || ""),
            duration_min: w.totalTimePlanned ? Math.round(w.totalTimePlanned * 60) : null,
            distance_mi: w.distancePlanned ? Math.round(w.distancePlanned / 1609.34 * 10) / 10 : null,
            tss_planned: w.tssPlanned || null,
            description: (w.title || "").slice(0, 200),
          }));

        const now = Date.now();
        const stmts = [env.DB.prepare("DELETE FROM planned_workout WHERE user_id = ? AND date = ?").bind(plannedUser.id, date)];
        for (const p of planned) {
          stmts.push(env.DB.prepare(`INSERT INTO planned_workout (user_id, date, workout_id, type, duration_min, distance_mi, tss_planned, description, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(user_id, date, workout_id) DO UPDATE SET type=excluded.type, duration_min=excluded.duration_min,
              distance_mi=excluded.distance_mi, tss_planned=excluded.tss_planned, description=excluded.description, updated_at=excluded.updated_at`)
            .bind(plannedUser.id, date, p.workout_id, p.type, p.duration_min, p.distance_mi, p.tss_planned, p.description, now));
        }
        await env.DB.batch(stmts);
        return new Response(JSON.stringify({ ok: true, date, planned }), { headers: CORS });
      } catch (e) {
        return new Response(JSON.stringify({ ok: false, error: e.message }), { status: 500, headers: CORS });
      }
    }

    return env.ASSETS.fetch(req);
  },

  // Daily cron (8:00 UTC): keep training load current even without an app open
  async scheduled(event, env, ctx) {
    try {
      const user = await env.DB.prepare("SELECT id FROM users LIMIT 1").first();
      if (user) ctx.waitUntil(tpRecomputeLoad(env, user.id).catch(() => {}));
    } catch (_) {}
  }
};

function parseOFF(p) {
  const n=p.nutriments||{}, sq=parseFloat(p.serving_quantity)||0, sc=sq>0?sq/100:1;
  const get=base=>{const ks=[base,base.replace("-","_"),base.replace("_","-")];for(const k of ks){const sv=n[k+"_serving"];if(sv!=null&&!isNaN(+sv))return+sv;}for(const k of ks){const v=n[k+"_100g"];if(v!=null&&!isNaN(+v))return+v*sc;}return 0;};
  let cal=get("energy-kcal")||get("energy")/4.184;
  const name=p.product_name_en||p.product_name||""; if(!name)return null;
  const m=(p.serving_size||"").match(/([\d.]+)\s*(g|ml|oz|lb|cup|tbsp|tsp)?/i);
  return {name,brand:(p.brands||"").split(",")[0].trim(),calories:Math.round(cal),protein:Math.round(get("proteins")*10)/10,carbs:Math.round(get("carbohydrates")*10)/10,fat:Math.round(get("fat")*10)/10,fiber:Math.round(get("fiber")*10)/10,sodium:Math.round(get("sodium")*1000)/1000,servingSize:m?m[1]:"1",servingUnit:m?m[2]||"serving":"serving"};
}
__name(parseOFF,"parseOFF");

function parseUSDA(f) {
  if(!f?.description)return null;
  const nutr=id=>{const h=(f.foodNutrients||[]).find(x=>x.nutrientId===id||x.nutrientId===String(id)||x.nutrientNumber===String(id));return h?h.value||0:0;};
  let sg=parseFloat(f.servingSize)||0; const u=(f.servingSizeUnit||"g").toLowerCase();
  if(u==="oz")sg*=28.3495; else if(u==="lb")sg*=453.592;
  const sc=sg>0?sg/100:1, cal=(nutr(1008)||nutr(208))*sc; if(!cal)return null;
  return {name:f.description,brand:f.brandOwner||f.brandName||"",calories:Math.round(cal),protein:Math.round((nutr(1003)||nutr(203))*sc*10)/10,carbs:Math.round((nutr(1005)||nutr(205))*sc*10)/10,fat:Math.round((nutr(1004)||nutr(204))*sc*10)/10,fiber:Math.round((nutr(1079)||nutr(291))*sc*10)/10,sodium:Math.round((nutr(1093)||nutr(307))*sc)/1000,servingSize:sg>0?String(Math.round(sg)):"1",servingUnit:u==="g"||u==="ml"?u:"serving"};
}
__name(parseUSDA,"parseUSDA");

async function usdaNameSearch(name,key,ua) {
  try {
    const r=await fetch(`https://api.nal.usda.gov/fdc/v1/foods/search?api_key=${key}&query=${encodeURIComponent(name)}&dataType=Branded,Foundation,SR%20Legacy&pageSize=3`,{headers:{"User-Agent":ua}});
    if(!r.ok)return null; const d=await r.json(); return parseUSDA((d.foods||[])[0]||{});
  } catch(_){return null;}
}
__name(usdaNameSearch,"usdaNameSearch");

export { worker_default as default };
