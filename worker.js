var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

const GOOGLE_CLIENT_ID = '480646952925-03r0p3jkdvfjdpnhlqbam4hnfjq0hp63.apps.googleusercontent.com';

// Only these Google accounts may sign in (override with env.ALLOWED_EMAILS, comma-separated)
const ALLOWED_EMAILS = new Set(['jeremy@dronenerds.com']);

const CLAUDE_ALLOWED_MODELS = new Set([
  'claude-haiku-4-5-20251001',
  'claude-sonnet-4-5-20250929',
  'claude-sonnet-4-6',
  'claude-opus-4-6',   // older bundles cached on devices still request this
  'claude-opus-4-7',
]);
const CLAUDE_MAX_TOKENS_CAP = 8192;  // bloodwork parsing legitimately needs 8k out

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
const SCHEMA_VERSION = 8;

// ── Log sync tables (item 1: server-authoritative food/weight/shoes/lifts) ──
const LOG_TABLES = {
  food:   { table: "food_log",     kind: "dated" },
  weight: { table: "weight_log",   kind: "weight" },
  shoes:  { table: "shoe_mileage", kind: "keyed" },
  lifts:  { table: "lift_log",     kind: "dated" },
  blood:  { table: "blood_log",    kind: "dated" },
};

function logUpsertStmt(db, cfg, userId, e) {
  const updatedAt = Number(e.updated_at);
  if (!Number.isFinite(updatedAt) || updatedAt <= 0) return null;
  const deleted = e.deleted ? 1 : 0;
  const payload = JSON.stringify(e.payload ?? {});
  if (payload.length > (cfg.table === "blood_log" ? 262144 : 32768)) return null;

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

// ── Backups (Tier 2, item 7): nightly D1 → R2 NDJSON dumps ──────────────
const BACKUP_TABLES = ["users", "sessions", "daily_checkin", "brief_cache", "tp_auth",
  "food_log", "weight_log", "shoe_mileage", "lift_log", "training_load", "planned_workout", "user_preferences"];

async function sha256Hex(buf) {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", buf))].map(b => b.toString(16).padStart(2, "0")).join("");
}
__name(sha256Hex, "sha256Hex");

async function runBackup(env) {
  if (!env.BACKUPS) return { ok: false, error: "BACKUPS bucket not bound" };
  const day = new Date().toISOString().slice(0, 10);
  const manifest = { date: day, schema_version: SCHEMA_VERSION, generated_at: Date.now(), tables: {} };
  let totalBytes = 0;
  for (const t of BACKUP_TABLES) {
    let rows;
    try { rows = (await env.DB.prepare(`SELECT * FROM ${t}`).all()).results; }
    catch (e) { manifest.tables[t] = { error: e.message }; continue; }
    const buf = new TextEncoder().encode(rows.map(r => JSON.stringify(r)).join("\n"));
    await env.BACKUPS.put(`backups/${day}/${t}.ndjson`, buf);
    manifest.tables[t] = { rows: rows.length, bytes: buf.length, sha256: await sha256Hex(buf) };
    totalBytes += buf.length;
  }
  manifest.total_bytes = totalBytes;
  manifest.pruned = await pruneBackups(env).catch(e => ({ error: e.message }));
  await env.BACKUPS.put(`backups/${day}/manifest.json`, JSON.stringify(manifest, null, 2));
  await env.BACKUPS.put("backups/latest.json", JSON.stringify(manifest));
  return { ok: true, manifest };
}
__name(runBackup, "runBackup");

// Retention: daily ≤30d; then Mondays only ≤114d; then 1st-of-month only ≤400d; older deleted.
function backupKeep(dateStr, now) {
  const d = new Date(dateStr + "T00:00:00Z");
  const age = (now - d.getTime()) / 86400000;
  if (age <= 30) return true;
  if (age <= 114) return d.getUTCDay() === 1;
  if (age <= 400) return d.getUTCDate() === 1;
  return false;
}
__name(backupKeep, "backupKeep");

async function pruneBackups(env) {
  const now = Date.now();
  const days = [];
  let cursor;
  do {
    const list = await env.BACKUPS.list({ prefix: "backups/", delimiter: "/", cursor });
    for (const p of list.delimitedPrefixes || []) {
      const m = p.match(/^backups\/(\d{4}-\d{2}-\d{2})\/$/);
      if (m) days.push(m[1]);
    }
    cursor = list.truncated ? list.cursor : null;
  } while (cursor);

  const deleted = [];
  for (const day of days) {
    if (backupKeep(day, now)) continue;
    let c;
    do {
      const objs = await env.BACKUPS.list({ prefix: `backups/${day}/`, cursor: c });
      for (const o of objs.objects) await env.BACKUPS.delete(o.key);
      c = objs.truncated ? objs.cursor : null;
    } while (c);
    deleted.push(day);
  }
  return { deleted, kept: days.length - deleted.length };
}
__name(pruneBackups, "pruneBackups");

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
  if (!tok) {
    // Mark expired once; the daily refresh cron owns the push notification
    try {
      if (row.status !== "expired") {
        await env.DB.prepare("UPDATE tp_auth SET status = 'expired', expired_at = COALESCE(expired_at, ?) WHERE id = 1").bind(Date.now()).run();
      }
    } catch(_) {}
    return { error: "cookie_expired" };
  }
  await env.DB.prepare("UPDATE tp_auth SET access_token = ?, token_expires_at = ?, status = 'active', last_refreshed_at = ?, updated_at = datetime('now') WHERE id = 1")
    .bind(tok.accessToken, new Date(tok.expiresAt).toISOString(), Date.now()).run();
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

// ── Brief context (Tier 2, item 6): compact 14-day trend stats (<2KB) ────
function userLocalDate(user) {
  try { return new Date().toLocaleDateString("en-CA", { timeZone: user.tz || "America/New_York" }); }
  catch (_) { return new Date().toISOString().slice(0, 10); }
}
__name(userLocalDate, "userLocalDate");

async function buildBriefContext(env, user) {
  const uid = user.id;
  const q = (sql, ...binds) => env.DB.prepare(sql).bind(...binds).all().then(r => r.results).catch(() => []);
  const [weights, food, checkins, load, planned] = await Promise.all([
    q(`SELECT date, weight_lbs FROM weight_log WHERE user_id = ? AND date >= date('now','-14 days') ORDER BY date ASC`, uid),
    q(`SELECT date, SUM(CAST(json_extract(payload_json,'$.calories') AS REAL)) AS cals,
         SUM(CAST(json_extract(payload_json,'$.protein') AS REAL)) AS prot
       FROM food_log WHERE user_id = ? AND deleted = 0 AND date >= date('now','-14 days') GROUP BY date ORDER BY date ASC`, uid),
    q(`SELECT date, sleep_hrs, sleep_score, mood, energy FROM daily_checkin WHERE user_id = ? AND date >= date('now','-14 days') ORDER BY date ASC`, uid),
    q(`SELECT date, tss, ctl, atl, tsb FROM training_load WHERE user_id = ? AND date >= date('now','-60 days') ORDER BY date ASC`, uid),
    q(`SELECT date, type, duration_min, tss_planned FROM planned_workout WHERE user_id = ? AND date > date('now') AND date <= date('now','+7 days')`, uid),
  ]);
  const r1 = v => v == null ? null : Math.round(v * 10) / 10;
  const mean = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : null;

  const lbs = weights.map(w => w.weight_lbs);
  const wLast7 = weights.slice(-7).map(w => w.weight_lbs);
  let ratePerWeek = null;
  if (weights.length >= 4) {
    const t0 = new Date(weights[0].date).getTime();
    const pts = weights.map(w => [(new Date(w.date).getTime() - t0) / 86400000, w.weight_lbs]);
    const n = pts.length, sx = pts.reduce((s, p) => s + p[0], 0), sy = pts.reduce((s, p) => s + p[1], 0);
    const sxx = pts.reduce((s, p) => s + p[0] * p[0], 0), sxy = pts.reduce((s, p) => s + p[0] * p[1], 0);
    const den = n * sxx - sx * sx;
    if (den) ratePerWeek = r1(((n * sxy - sx * sy) / den) * 7);
  }

  const calTarget = user.calories || null, protTarget = user.protein || null, tdee = user.tdee || null;
  const calDays = food.filter(f => f.cals > 0);
  const protHit = d => protTarget ? d.prot >= protTarget * 0.9 : false;
  let protStreak = 0;
  for (let i = food.length - 1; i >= 0; i--) { if (protHit(food[i])) protStreak++; else break; }

  const today = new Date().toISOString().slice(0, 10);
  const day7 = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
  const tssThisWeek = load.filter(l => l.date > day7).reduce((s, l) => s + l.tss, 0);
  const day14 = new Date(Date.now() - 14 * 86400000).toISOString().slice(0, 10);
  const tssLastWeek = load.filter(l => l.date > day14 && l.date <= day7).reduce((s, l) => s + l.tss, 0);
  const lastWorkout = [...load].reverse().find(l => l.tss > 0);
  const lastHard = [...load].reverse().find(l => l.tss > 80);
  const latest = load[load.length - 1];
  const daysSince = d => d ? Math.round((new Date(today) - new Date(d)) / 86400000) : null;

  const foodDates = new Set(food.map(f => f.date));
  const weighDates = new Set(weights.map(w => w.date));
  const streak = set => {
    let s = 0;
    for (let i = 0; i < 14; i++) {
      const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
      if (set.has(d)) s++;
      else if (i === 0) continue;  // today may not be logged yet
      else break;
    }
    return s;
  };

  const sleeps = checkins.filter(c => c.sleep_hrs > 0);
  const moods = checkins.filter(c => c.mood > 0);
  const energies = checkins.filter(c => c.energy > 0);

  return {
    weight: { n: weights.length, avg7: r1(mean(wLast7)), avg14: r1(mean(lbs)), min: r1(lbs.length ? Math.min(...lbs) : null), max: r1(lbs.length ? Math.max(...lbs) : null), rate_lb_per_wk: ratePerWeek, goal: user.goal_weight || null, goal_date: user.goal_date || null },
    macros: {
      days_logged: calDays.length, mean_cals: r1(mean(calDays.map(f => f.cals))), target_cals: calTarget, tdee,
      mean_deficit: tdee && calDays.length ? Math.round(tdee - mean(calDays.map(f => f.cals))) : null,
      cal_adherence_pct: calTarget && calDays.length ? Math.round(calDays.filter(f => Math.abs(f.cals - calTarget) <= 150).length / calDays.length * 100) : null,
      protein_target_g: protTarget, protein_hit_days: food.filter(protHit).length, protein_days_total: food.length, protein_streak: protStreak,
    },
    sleep: { mean_hrs: r1(mean(sleeps.map(c => c.sleep_hrs))), worst_hrs: r1(sleeps.length ? Math.min(...sleeps.map(c => c.sleep_hrs)) : null), mean_score: r1(mean(checkins.filter(c => c.sleep_score > 0).map(c => c.sleep_score))) },
    mood: { mean: r1(mean(moods.map(c => c.mood))), min: moods.length ? Math.min(...moods.map(c => c.mood)) : null, days_below_3: moods.filter(c => c.mood < 3).length, energy_mean: r1(mean(energies.map(c => c.energy))) },
    training: { ctl: latest ? r1(latest.ctl) : null, atl: latest ? r1(latest.atl) : null, tsb: latest ? r1(latest.tsb) : null, tss_this_week: Math.round(tssThisWeek), tss_last_week: Math.round(tssLastWeek), days_since_workout: daysSince(lastWorkout?.date), days_since_hard: daysSince(lastHard?.date) },
    planned_7d: { sessions: planned.length, total_min: Math.round(planned.reduce((s, p) => s + (p.duration_min || 0), 0)), total_tss: Math.round(planned.reduce((s, p) => s + (p.tss_planned || 0), 0)), longest_min: Math.round(Math.max(0, ...planned.map(p => p.duration_min || 0))) },
    streaks: { logging: streak(foodDates), weigh_in: streak(weighDates) },
    readiness: await (async () => {
      try {
        const today = await env.DB.prepare("SELECT score, band, narrative FROM readiness WHERE user_id = ? ORDER BY date DESC LIMIT 1").bind(uid).first();
        const avg = await env.DB.prepare("SELECT AVG(score) AS a FROM readiness WHERE user_id = ? AND date >= date('now','-7 days')").bind(uid).first();
        return today ? { score: today.score, band: today.band, drivers: today.narrative, avg_7d: avg?.a ? Math.round(avg.a) : null } : null;
      } catch (_) { return null; }
    })(),
  };
}
__name(buildBriefContext, "buildBriefContext");

const COACH_SYSTEM = `You are Jeremy's evidence-based training and nutrition coach. You write one short coach note per day from his tracked data.
Rules:
- Every sentence must reference a specific number from the data or state a concrete decision. Vague encouragement is forbidden.
- If training.tsb < -15: recommend recovery and do NOT push a calorie deficit.
- If weight.rate_lb_per_wk is more than 0.3 lb/wk off what the plan needs: flag it with a specific direction.
- If protein was hit on 12+ of 14 days, acknowledge the streak by number.
- If readiness.band is "compromised" or "guarded": recommend rest/easy and dial the deficit back to maintenance today; verdict must be recover (compromised) or adjust (guarded).
- If readiness.band is "primed" and training.tsb > 0: say today is a good day for a quality session.
- Reference the readiness score and at least one of its drivers when readiness is present.
- Cap at 80 words. Verdict is exactly one of: keep_going, adjust, recover.
GOOD example: {"note":"Weight is down 0.8 lb/wk over 14 days vs the 1.0 you need — hold 1,500 kcal, no change. Protein ≥150g on 11/14 days; the misses were all weekends, front-load 40g at breakfast Sat/Sun. TSB -4 with 168 TSS this week: Thursday's 60-min run fits as planned.","verdict":"keep_going"}
BAD example: {"note":"Great week! You're crushing protein and training hard. Keep up the awesome work!","verdict":"keep_going"}
Return ONLY JSON: {"note":"...","verdict":"keep_going|adjust|recover"}`;

// ── Wellness ingest (Tier 1.5A): Garmin-sourced metrics via TrainingPeaks ──
// GET /metrics/v3/athletes/{id}/consolidatedtimedmetrics/{start}/{end}
// Real detail types observed (uploadClient "Garmin Health"):
//   2 %fat · 5 pulse/RHR · 6 sleep hrs · 9 weight kg · 14 BMI · 46 deep ·
//   47 REM · 48 light · 50 awake · 56 water% · 57 muscle kg · 60 HRV ·
//   62 stress [min,max,avg] · 64 body battery [low,high,avg]
const KG_TO_LBS = 2.2046226;

function tpMapWellnessRecord(rec) {
  const f = {};
  for (const det of rec.details || []) {
    const v = det.value;
    if (v == null) continue;
    switch (det.type) {
      case 9:  f.weight_lbs = Math.round(v * KG_TO_LBS * 100) / 100; break;
      case 60: f.hrv_ms = v; break;
      case 5:  f.resting_hr_bpm = v; break;
      case 6:  f.sleep_total_hrs = Math.round(v * 100) / 100; break;
      case 46: f.sleep_deep_hrs = Math.round(v * 100) / 100; break;
      case 47: f.sleep_rem_hrs = Math.round(v * 100) / 100; break;
      case 48: f.sleep_light_hrs = Math.round(v * 100) / 100; break;
      case 50: f.sleep_awake_hrs = Math.round(v * 100) / 100; break;
      case 62: f.stress_avg = Array.isArray(v) ? (v[2] ?? v[1] ?? null) : v; break;
      case 64:
        if (Array.isArray(v)) {
          f.body_battery_low = v[0] ?? null;
          f.body_battery_high = v[1] ?? null;
          f.body_battery_wake = v[1] ?? null; // wake value not exposed; high ≈ post-sleep peak
        } else f.body_battery_wake = v;
        break;
      case 2:  f.body_fat_pct = v; break;
      case 57: f.muscle_mass_lbs = Math.round(v * KG_TO_LBS * 100) / 100; break;
      case 56: f.body_water_pct = v; break;
      case 14: f.bmi = v; break;
    }
  }
  return f;
}
__name(tpMapWellnessRecord, "tpMapWellnessRecord");

const WELLNESS_FIELDS = ["weight_lbs","hrv_ms","resting_hr_bpm","sleep_total_hrs","sleep_deep_hrs","sleep_light_hrs","sleep_rem_hrs","sleep_awake_hrs","sleep_score","body_battery_wake","body_battery_low","body_battery_high","stress_avg","muscle_mass_lbs","body_fat_pct","body_water_pct","bmi"];

async function tpFetchWellness(env, userId, startDate, endDate) {
  const auth = await tpGetAccessToken(env);
  if (auth.error) return auth;
  const r = await fetch(`${TP_API_BASE}/metrics/v3/athletes/${auth.athleteId}/consolidatedtimedmetrics/${startDate}/${endDate}`, {
    headers: { "Authorization": `Bearer ${auth.token}`, "Accept": "application/json" }
  });
  if (r.status === 401) {
    try { await env.DB.prepare("UPDATE tp_auth SET access_token = NULL WHERE id = 1").run(); } catch(_) {}
    return { error: "cookie_expired" };
  }
  if (!r.ok) return { error: `TP metrics ${r.status}` };
  const recs = await r.json();
  if (!Array.isArray(recs)) return { ok: true, days: 0 };

  const now = Date.now();
  const rawCutoff = new Date(now - 90 * 86400000).toISOString().slice(0, 10);
  const stmts = [];
  for (const rec of recs) {
    const date = (rec.timeStamp || "").slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    const f = tpMapWellnessRecord(rec);
    if (!Object.keys(f).length) continue;
    const raw = date >= rawCutoff ? JSON.stringify(rec).slice(0, 16384) : null;
    // COALESCE keeps previously-ingested values when a later pull is partial
    // (late-arriving scale/sleep data fills in, never blanks out)
    stmts.push(env.DB.prepare(`INSERT INTO wellness (user_id, date, ${WELLNESS_FIELDS.join(", ")}, source, raw_json, updated_at)
      VALUES (?, ?, ${WELLNESS_FIELDS.map(() => "?").join(", ")}, 'trainingpeaks', ?, ?)
      ON CONFLICT(user_id, date) DO UPDATE SET
        ${WELLNESS_FIELDS.map(c => `${c} = COALESCE(excluded.${c}, wellness.${c})`).join(", ")},
        raw_json = COALESCE(excluded.raw_json, wellness.raw_json),
        updated_at = excluded.updated_at`)
      .bind(userId, date, ...WELLNESS_FIELDS.map(c => f[c] ?? null), raw, now));
  }
  for (let i = 0; i < stmts.length; i += 40) await env.DB.batch(stmts.slice(i, i + 40));
  return { ok: true, days: stmts.length };
}
__name(tpFetchWellness, "tpFetchWellness");

// Effective wellness value for a date: override > wellness
async function wellnessWithOverrides(env, userId, days) {
  const [rows, ovs] = await Promise.all([
    env.DB.prepare(`SELECT * FROM wellness WHERE user_id = ? AND date >= date('now','-' || ? || ' days') ORDER BY date DESC`).bind(userId, days).all().then(r => r.results),
    env.DB.prepare(`SELECT date, field, value FROM wellness_override WHERE user_id = ? AND date >= date('now','-' || ? || ' days')`).bind(userId, days).all().then(r => r.results).catch(() => []),
  ]);
  const ovByDate = {};
  for (const o of ovs) (ovByDate[o.date] = ovByDate[o.date] || {})[o.field] = o.value;
  for (const r of rows) {
    delete r.raw_json;
    const o = ovByDate[r.date];
    if (o) { r._overridden = Object.keys(o); Object.assign(r, o); }
  }
  return rows;
}
__name(wellnessWithOverrides, "wellnessWithOverrides");

// ── Readiness (Tier 1.5C) + anomaly detection (1.5E) ─────────────────────
function meanSd(vals) {
  const v = vals.filter(x => x != null && isFinite(x));
  if (v.length < 2) return { n: v.length, mean: v[0] ?? null, sd: null };
  const mean = v.reduce((s, x) => s + x, 0) / v.length;
  const sd = Math.sqrt(v.reduce((s, x) => s + (x - mean) ** 2, 0) / (v.length - 1));
  return { n: v.length, mean, sd };
}
__name(meanSd, "meanSd");

const READINESS_WEIGHTS = { hrv: 0.35, rhr: 0.20, sleep: 0.20, bb: 0.15, tsb: 0.10 };
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

async function computeReadiness(env, userId, date) {
  const rows = await wellnessWithOverrides(env, userId, 45);
  const today = rows.find(r => r.date === date);
  const base = rows.filter(r => r.date < date && r.date >= new Date(new Date(date + "T12:00:00Z").getTime() - 30 * 86400000).toISOString().slice(0, 10));

  const hrvB = meanSd(base.map(r => r.hrv_ms));
  if (hrvB.n < 14) return { ok: false, gathering: true, have: hrvB.n, need: 14 };
  if (!today) return { ok: false, error: "no wellness row for " + date };

  const rhrB = meanSd(base.map(r => r.resting_hr_bpm));
  const scoreB = meanSd(base.map(r => r.sleep_score));
  const sleepB = meanSd(base.map(r => r.sleep_total_hrs));

  const z = (v, b, invert) => (v == null || !b.sd || b.sd < 0.01) ? null
    : invert ? (b.mean - v) / b.sd : (v - b.mean) / b.sd;

  const hrv_z = z(today.hrv_ms, hrvB);
  const rhr_z = z(today.resting_hr_bpm, rhrB, true);
  // Garmin sleep score isn't exposed via TP — fall back to total-hours z
  const sleep_z = (scoreB.n >= 14 && today.sleep_score != null) ? z(today.sleep_score, scoreB) : z(today.sleep_total_hrs, sleepB);

  const comps = {};
  if (hrv_z != null) comps.hrv = clamp(50 + 20 * hrv_z, 0, 100);
  if (rhr_z != null) comps.rhr = clamp(50 + 20 * rhr_z, 0, 100);
  if (sleep_z != null) comps.sleep = clamp(clamp(50 + 15 * sleep_z, 0, 100) + ((today.sleep_deep_hrs ?? 0) >= 1.0 ? 10 : 0), 0, 100);
  const bbVal = today.body_battery_wake ?? today.body_battery_high;
  if (bbVal != null) comps.bb = clamp(bbVal, 0, 100);
  const tl = await env.DB.prepare("SELECT tsb FROM training_load WHERE user_id = ? AND date <= ? ORDER BY date DESC LIMIT 1").bind(userId, date).first();
  const tsbVal = tl?.tsb ?? null;
  if (tsbVal != null) comps.tsb = tsbVal > 5 ? 100 : tsbVal <= -25 ? 0 : ((tsbVal + 25) / 30) * 100;

  const keys = Object.keys(comps);
  if (!keys.length) return { ok: false, error: "no scoreable components" };
  const wSum = keys.reduce((s, k) => s + READINESS_WEIGHTS[k], 0);
  const score = Math.round(keys.reduce((s, k) => s + comps[k] * READINESS_WEIGHTS[k], 0) / wSum);
  const band = score >= 85 ? "primed" : score >= 70 ? "ready" : score >= 50 ? "guarded" : "compromised";

  // Narrative from the two most extreme drivers
  const drivers = [];
  if (hrv_z != null) drivers.push({ k: "hrv", mag: Math.abs(hrv_z), txt: `HRV ${Math.round(today.hrv_ms)}ms (${hrv_z >= 0 ? "+" : ""}${hrv_z.toFixed(1)} SD)` });
  if (rhr_z != null) drivers.push({ k: "rhr", mag: Math.abs(rhr_z), txt: `RHR ${Math.round(today.resting_hr_bpm)} bpm (${rhr_z >= 0 ? "+" : ""}${rhr_z.toFixed(1)} SD${rhr_z < 0 ? " elevated" : ""})` });
  if (sleep_z != null) drivers.push({ k: "sleep", mag: Math.abs(sleep_z) * 0.9, txt: `sleep ${(today.sleep_total_hrs ?? 0).toFixed(1)}h (${sleep_z >= 0 ? "+" : ""}${sleep_z.toFixed(1)} SD)` });
  if (bbVal != null) drivers.push({ k: "bb", mag: Math.abs(bbVal - 70) / 20, txt: `Body Battery ${Math.round(bbVal)}` });
  if (tsbVal != null) drivers.push({ k: "tsb", mag: Math.abs(tsbVal) / 12, txt: `TSB ${tsbVal >= 0 ? "+" : ""}${Math.round(tsbVal)}` });
  drivers.sort((a, b) => b.mag - a.mag);
  const phrase = { primed: "go get it", ready: "solid day to train", guarded: "keep it moderate", compromised: "recovery day" }[band];
  const narrative = `${drivers.slice(0, 2).map(d => d.txt).join(", ")} — ${phrase}.`;

  const inputs = { date, hrv: today.hrv_ms, rhr: today.resting_hr_bpm, sleep_hrs: today.sleep_total_hrs, deep_hrs: today.sleep_deep_hrs, bb: bbVal, tsb: tsbVal, baselines: { hrv: hrvB, rhr: rhrB, sleep: sleepB }, components: comps };
  await env.DB.prepare(`INSERT INTO readiness (user_id, date, score, band, hrv_z, rhr_z, sleep_z, body_battery_val, tsb_val, narrative, inputs_json, computed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, date) DO UPDATE SET score=excluded.score, band=excluded.band, hrv_z=excluded.hrv_z,
      rhr_z=excluded.rhr_z, sleep_z=excluded.sleep_z, body_battery_val=excluded.body_battery_val,
      tsb_val=excluded.tsb_val, narrative=excluded.narrative, inputs_json=excluded.inputs_json, computed_at=excluded.computed_at`)
    .bind(userId, date, score, band, hrv_z, rhr_z, sleep_z, bbVal, tsbVal, narrative, JSON.stringify(inputs), Date.now()).run();

  // ── Anomaly detection (1.5E) with a 3-day cooldown ──
  try {
    const recent = await env.DB.prepare("SELECT MAX(fired_at) AS last FROM anomaly_event WHERE user_id = ?").bind(userId).first();
    const cooling = recent?.last && Date.now() - recent.last < 3 * 86400000;
    if (!cooling) {
      let kind = null, detail = null;
      if (hrv_z != null && rhr_z != null && hrv_z < -1.5 && rhr_z < -1.5) {
        kind = "hrv_rhr_combo";
        detail = { hrv: today.hrv_ms, hrv_z, rhr: today.resting_hr_bpm, rhr_z, hrv_baseline: hrvB.mean, rhr_baseline: rhrB.mean };
      } else if (rhr_z != null && rhr_z < -2.0) {
        kind = "rhr_solo";
        detail = { rhr: today.resting_hr_bpm, rhr_z, rhr_baseline: rhrB.mean };
      } else if (hrvB.mean && today.hrv_ms != null && today.hrv_ms < hrvB.mean * 0.8) {
        const yest = rows.find(r => r.date === new Date(new Date(date + "T12:00:00Z").getTime() - 86400000).toISOString().slice(0, 10));
        if (yest?.hrv_ms != null && yest.hrv_ms < hrvB.mean * 0.8) {
          kind = "hrv_trend";
          detail = { hrv_today: today.hrv_ms, hrv_yesterday: yest.hrv_ms, baseline: hrvB.mean, drop_pct: Math.round((1 - today.hrv_ms / hrvB.mean) * 100) };
        }
      }
      if (kind) {
        await env.DB.prepare(`INSERT INTO anomaly_event (user_id, date, kind, detail_json, fired_at) VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(user_id, date, kind) DO NOTHING`).bind(userId, date, kind, JSON.stringify(detail), Date.now()).run();
        await sendPushToUser(env, userId, "anomaly", "🫀 Recovery warning",
          kind === "hrv_trend" ? `HRV ${detail.drop_pct}% below baseline two days running — treat today as recovery.`
            : `HRV/RHR out of range (${drivers.slice(0, 2).map(d => d.txt).join(", ")}) — possible illness or overreach.`, "/");
      }
    }
  } catch (_) {}

  return { ok: true, score, band, narrative, drivers: drivers.slice(0, 3).map(d => d.txt), components: comps };
}
__name(computeReadiness, "computeReadiness");

// ── TP cookie auto-refresh (Tier 2, item 10) ─────────────────────────────
// Daily silent refresh: exchange the stored cookie for a fresh token so the
// cached token never goes stale unnoticed. On failure: mark expired + push.
// TP does not expose the cookie's own expiry, so the "expiring soon" warning
// fires on cookie AGE (>27 days since it was stored), once per lifecycle.
async function tpDailyRefresh(env) {
  const row = await env.DB.prepare("SELECT * FROM tp_auth WHERE id = 1").first().catch(() => null);
  if (!row) return;
  const user = await env.DB.prepare("SELECT id FROM users LIMIT 1").first();
  if (!user) return;

  const tok = await tpExchangeCookie(row.cookie);
  if (tok) {
    await env.DB.prepare("UPDATE tp_auth SET access_token = ?, token_expires_at = ?, status = 'active', last_refreshed_at = ? WHERE id = 1")
      .bind(tok.accessToken, new Date(tok.expiresAt).toISOString(), Date.now()).run();
    // Proactive age warning, once per cookie lifecycle
    const storedAt = new Date(row.updated_at + "Z").getTime() || Date.now();
    const ageDays = (Date.now() - storedAt) / 86400000;
    if (ageDays > 27 && !row.warned_at) {
      await env.DB.prepare("UPDATE tp_auth SET warned_at = ? WHERE id = 1").bind(Date.now()).run();
      await sendPushToUser(env, user.id, "tp_expiry_warning", "⛰️ TrainingPeaks cookie aging",
        `Your TP cookie is ${Math.round(ageDays)} days old — re-paste it in Settings before it expires.`, "/#settings");
    }
    return;
  }
  // Failure → expired + notify (dedupe: once per day via push_sent)
  if (row.status !== "expired") {
    await env.DB.prepare("UPDATE tp_auth SET status = 'expired', expired_at = COALESCE(expired_at, ?) WHERE id = 1").bind(Date.now()).run();
  }
  await sendPushToUser(env, user.id, "tp_expired", "⛰️ TP disconnected",
    "Your TrainingPeaks cookie expired — reconnect to keep activity syncing.", "/#settings");
}
__name(tpDailyRefresh, "tpDailyRefresh");

// ── Web Push (Tier 2, item 9): VAPID-signed empty pushes; the service
// worker fetches the queued message from /api/push/pending. No payload
// encryption needed, no third-party service.
function b64u(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
__name(b64u, "b64u");

async function vapidAuthHeader(env, endpoint) {
  const jwk = JSON.parse(env.VAPID_PRIVATE_JWK);
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const aud = new URL(endpoint).origin;
  const enc = new TextEncoder();
  const header = b64u(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const payload = b64u(enc.encode(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: "mailto:jeremy@dronenerds.com" })));
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, enc.encode(`${header}.${payload}`));
  return `vapid t=${header}.${payload}.${b64u(sig)}, k=${env.VAPID_PUBLIC_KEY}`;
}
__name(vapidAuthHeader, "vapidAuthHeader");

// Queue the message, then poke every subscription with an empty push.
async function sendPushToUser(env, userId, kind, title, body, url) {
  const today = new Date().toISOString().slice(0, 10);
  // Dedupe: one send per (user, day, kind)
  const ins = await env.DB.prepare(`INSERT INTO push_sent (user_id, date, kind, sent_at, title, body, url, delivered)
    VALUES (?, ?, ?, ?, ?, ?, ?, 0) ON CONFLICT(user_id, date, kind) DO NOTHING`)
    .bind(userId, today, kind, Date.now(), title, body, url || "/").run();
  if (!ins.meta.changes) return { ok: true, deduped: true };

  const subs = (await env.DB.prepare("SELECT * FROM push_subscription WHERE user_id = ?").bind(userId).all()).results;
  let sent = 0, pruned = 0;
  for (const s of subs) {
    try {
      const r = await fetch(s.endpoint, {
        method: "POST",
        headers: { "Authorization": await vapidAuthHeader(env, s.endpoint), "TTL": "3600" },
      });
      if (r.status === 404 || r.status === 410) {
        await env.DB.prepare("DELETE FROM push_subscription WHERE user_id = ? AND endpoint = ?").bind(userId, s.endpoint).run();
        pruned++;
      } else if (r.ok || r.status === 201) {
        sent++;
        await env.DB.prepare("UPDATE push_subscription SET last_used_at = ? WHERE user_id = ? AND endpoint = ?").bind(Date.now(), userId, s.endpoint).run();
      }
    } catch (_) {}
  }
  return { ok: true, sent, pruned, subs: subs.length };
}
__name(sendPushToUser, "sendPushToUser");

function userLocalHHMM(user) {
  try {
    return new Date().toLocaleTimeString("en-GB", { timeZone: user.tz || "America/New_York", hour: "2-digit", minute: "2-digit" });
  } catch (_) { return "00:00"; }
}
__name(userLocalHHMM, "userLocalHHMM");

// Runs every 15 min from the cron. Fires enabled reminders inside their
// [HH:MM, HH:MM+15) local window, at most once per day each.
async function runPushScheduler(env) {
  const user = await env.DB.prepare("SELECT * FROM users LIMIT 1").first();
  if (!user) return;
  const nsubs = (await env.DB.prepare("SELECT COUNT(*) AS n FROM push_subscription WHERE user_id = ?").bind(user.id).first())?.n || 0;
  if (!nsubs) return;

  let prefs = {};
  try {
    const row = await env.DB.prepare("SELECT payload_json FROM user_preferences WHERE user_id = ?").bind(user.id).first();
    if (row) prefs = JSON.parse(row.payload_json);
  } catch (_) {}
  const rem = prefs.reminders || {};
  const nowHHMM = userLocalHHMM(user);
  const inWindow = target => {
    const [th, tm] = target.split(":").map(Number);
    const [nh, nm] = nowHHMM.split(":").map(Number);
    const t = th * 60 + tm, n = nh * 60 + nm;
    return n >= t && n < t + 15;
  };

  if (rem.morning_weighin?.on && inWindow(rem.morning_weighin.time || "07:00")) {
    await sendPushToUser(env, user.id, "morning_weighin", "⚖️ Morning weigh-in",
      "Hop on the scale before coffee — trend data works best fasted.", "/");
  }

  if (rem.evening_log?.on && inWindow(rem.evening_log.time || "20:30")) {
    // Fire only when actually behind target
    const localDate = userLocalDate(user);
    const totals = await env.DB.prepare(`SELECT SUM(CAST(json_extract(payload_json,'$.calories') AS REAL)) AS cals,
        SUM(CAST(json_extract(payload_json,'$.protein') AS REAL)) AS prot
      FROM food_log WHERE user_id = ? AND deleted = 0 AND date = ?`).bind(user.id, localDate).first();
    const protBehind = user.protein && (totals?.prot || 0) < user.protein * 0.8;
    const calsBehind = user.calories && (totals?.cals || 0) < user.calories * 0.6;
    if (protBehind || calsBehind) {
      const missing = protBehind ? `Protein is at ${Math.round(totals?.prot || 0)}g of ${user.protein}g` : `Calories are at ${Math.round(totals?.cals || 0)} of ${user.calories}`;
      await sendPushToUser(env, user.id, "evening_log", "🌙 Evening check", `${missing} — log dinner or grab a protein snack.`, "/");
    }
  }
}
__name(runPushScheduler, "runPushScheduler");

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
        let trendSection = "";
        try { trendSection = `\n14-DAY TRENDS:\n${JSON.stringify(await buildBriefContext(env, user))}\n`; } catch(_) {}

        const prompt = `You are Jeremy's personal AI chief-of-staff. Write a tight daily brief as JSON.

HEALTH:
- Weight: ${h.weight ? h.weight + " lbs (goal: " + (h.targetWeight||163) + " lbs)" : "not logged yet today"}
- Macros: ${h.calories||0} kcal, ${h.protein||0}g protein
- Energy: ${h.energy||"?"}/5, Mood: ${h.mood||"?"}/5
- Water: ${h.water||0} oz
- Marathon: ${daysToMarathon} days to Grandma's Marathon (June 20 2026)

URGENT EMAILS:
${emailSection}
${trendSection}
Return ONLY valid JSON, no markdown:
{"greeting":"${greeting}, Jeremy","date":"${new Date().toLocaleDateString('en-US',{weekday:'long',month:'long',day:'numeric'})}","urgent_emails":[{"from":"Name","subject":"Subject","flag":"why urgent"}],"health_note":"one sentence with numbers","coach_note":"prescriptive note citing 2+ numbers from the 14-day trends, max 80 words, no vague encouragement","focus":"most important thing today"}

Rules: urgent_emails max 3, skip promos/newsletters; health_note use actual numbers; coach_note must cite specific numbers; Return ONLY JSON`;

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

    // ── Client error telemetry (debugging mobile failures) ────────────────
    if (u.pathname === "/api/debug/client" && req.method === "POST") {
      const dbgUser = await getSessionUser(env.DB, req);
      if (!dbgUser) return new Response(JSON.stringify({ ok: false }), { status: 401, headers: CORS });
      try {
        const b = await req.json();
        await env.DB.prepare("INSERT OR REPLACE INTO client_log (user_id, ts, kind, detail_json) VALUES (?, ?, ?, ?)")
          .bind(dbgUser.id, Date.now(), String(b.kind || "error").slice(0, 40), JSON.stringify(b).slice(0, 8000)).run();
        return new Response(JSON.stringify({ ok: true }), { headers: CORS });
      } catch (e) {
        return new Response(JSON.stringify({ ok: false }), { status: 500, headers: CORS });
      }
    }

    // ── Async Claude proxy: submit → poll (mobile-safe for long analyses) ──
    if (u.pathname === "/api/claude/async" && req.method === "POST") {
      const ajUser = await getSessionUser(env.DB, req);
      if (!ajUser) return new Response(JSON.stringify({ error: { message: "Unauthorized" } }), { status: 401, headers: CORS });
      try {
        if (!env.ANTHROPIC_KEY) return new Response(JSON.stringify({ error: { message: "no key" } }), { status: 500, headers: CORS });
        const b = await req.json();
        if (!b || typeof b !== "object" || !CLAUDE_ALLOWED_MODELS.has(b.model)) {
          return new Response(JSON.stringify({ error: { message: "model not allowed" } }), { status: 400, headers: CORS });
        }
        b.max_tokens = Math.min(Number(b.max_tokens) || 1024, CLAUDE_MAX_TOKENS_CAP);
        delete b.stream; delete b.metadata;
        for (const m of (Array.isArray(b.messages) ? b.messages : [])) {
          if (!Array.isArray(m?.content)) continue;
          for (const block of m.content) {
            const len = block?.source?.data?.length || 0;
            if ((block?.type === "image" && len > 2800000) || (block?.type === "document" && len > 8000000)) {
              return new Response(JSON.stringify({ error: { message: "file too large" } }), { status: 400, headers: CORS });
            }
          }
        }
        const jobId = crypto.randomUUID();
        await env.DB.prepare("INSERT INTO ai_job (user_id, id, status, created_at, updated_at) VALUES (?, ?, 'running', ?, ?)")
          .bind(ajUser.id, jobId, Date.now(), Date.now()).run();

        const run = (async () => {
          try {
            const r = await fetch("https://api.anthropic.com/v1/messages", {
              method: "POST",
              headers: { "content-type": "application/json", "anthropic-version": "2023-06-01", "x-api-key": env.ANTHROPIC_KEY },
              body: JSON.stringify(b)
            });
            const data = await r.json();
            if (!r.ok) throw new Error(data?.error?.message || `Anthropic ${r.status}`);
            await env.DB.prepare("UPDATE ai_job SET status='done', result_json=?, updated_at=? WHERE user_id=? AND id=?")
              .bind(JSON.stringify(data).slice(0, 200000), Date.now(), ajUser.id, jobId).run();
          } catch (e) {
            await env.DB.prepare("UPDATE ai_job SET status='error', error=?, updated_at=? WHERE user_id=? AND id=?")
              .bind(String(e.message).slice(0, 500), Date.now(), ajUser.id, jobId).run().catch(() => {});
          }
        })();
        if (ctx?.waitUntil) ctx.waitUntil(run);

        return new Response(JSON.stringify({ ok: true, job_id: jobId }), { headers: CORS });
      } catch (e) {
        return new Response(JSON.stringify({ error: { message: e.message } }), { status: 500, headers: CORS });
      }
    }
    if (u.pathname === "/api/claude/job" && req.method === "GET") {
      const jUser = await getSessionUser(env.DB, req);
      if (!jUser) return new Response(JSON.stringify({ error: { message: "Unauthorized" } }), { status: 401, headers: CORS });
      const id = u.searchParams.get("id") || "";
      const row = await env.DB.prepare("SELECT status, result_json, error FROM ai_job WHERE user_id = ? AND id = ?").bind(jUser.id, id).first();
      if (!row) return new Response(JSON.stringify({ ok: false, error: "unknown job" }), { status: 404, headers: CORS });
      // prune old jobs opportunistically
      if (Math.random() < 0.1) ctx?.waitUntil?.(env.DB.prepare("DELETE FROM ai_job WHERE updated_at < ?").bind(Date.now() - 86400000).run().catch(() => {}));
      const body = { ok: true, status: row.status };
      if (row.status === "done") { try { body.result = JSON.parse(row.result_json); } catch(_) { body.status = "error"; body.error = "corrupt result"; } }
      if (row.status === "error") body.error = row.error;
      return new Response(JSON.stringify(body), { headers: CORS });
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
    // Unknown names fall through — /api/log/favorites is handled further down.
    if (u.pathname.startsWith("/api/log/") && LOG_TABLES[u.pathname.slice("/api/log/".length)]) {
      const cfg = LOG_TABLES[u.pathname.slice("/api/log/".length)];
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
        // Fresh cookie = fresh lifecycle (item 10)
        try { await env.DB.prepare("UPDATE tp_auth SET status = 'active', last_refreshed_at = ?, expired_at = NULL, warned_at = NULL WHERE id = 1").bind(Date.now()).run(); } catch(_) {}

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
        const row = await env.DB.prepare("SELECT status, last_refreshed_at, expired_at, athlete_name, athlete_id FROM tp_auth WHERE id = 1").first().catch(() => null);
        const auth = await tpGetAccessToken(env);
        if (auth.error) return new Response(JSON.stringify({ ok: true, connected: false, error: auth.error, status: row?.status || "not_connected", expired_at: row?.expired_at || null }), { headers: CORS });
        return new Response(JSON.stringify({ ok: true, connected: true, status: "active", last_refreshed_at: row?.last_refreshed_at || null, athlete: { id: auth.athleteId, name: auth.athleteName } }), { headers: CORS });
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

        // Item 3: refresh training load in the background after each sync;
        // Tier 1.5A: wellness (last 3 days) + today's readiness ride along
        if (ctx?.waitUntil) {
          ctx.waitUntil(tpRecomputeLoad(env, tpUser.id).catch(() => {}));
          ctx.waitUntil((async () => {
            const end = userLocalDate(tpUser);
            const start = new Date(new Date(end + "T12:00:00Z").getTime() - 3 * 86400000).toISOString().slice(0, 10);
            await tpFetchWellness(env, tpUser.id, start, end);
            await computeReadiness(env, tpUser.id, end);
          })().catch(() => {}));
        }

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

    // ── Item 6: trend-grounded coach note (cached by context hash) ────────
    if (u.pathname === "/api/brief/coach" && req.method === "GET") {
      const coachUser = await getSessionUser(env.DB, req);
      if (!coachUser) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: CORS });
      try {
        if (!env.ANTHROPIC_KEY) return new Response(JSON.stringify({ ok: false, error: "no key" }), { status: 500, headers: CORS });
        const force = u.searchParams.get("force") === "1";
        const context = await buildBriefContext(env, coachUser);
        const ctxJson = JSON.stringify(context);
        const hash = (await sha256Hex(new TextEncoder().encode(ctxJson))).slice(0, 12);
        const cacheKey = "coach-" + userLocalDate(coachUser);

        if (!force) {
          const cached = await env.DB.prepare("SELECT email_context FROM brief_cache WHERE user_id = ? AND date = ?").bind(coachUser.id, cacheKey).first();
          if (cached?.email_context) {
            try {
              const c = JSON.parse(cached.email_context);
              // Same context → same note; new check-in/weight/workout changes the hash
              if (c.hash === hash) return new Response(JSON.stringify({ ok: true, note: c.note, verdict: c.verdict, cached: true, context }), { headers: CORS });
            } catch(_) {}
          }
        }

        const r = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: { "content-type": "application/json", "anthropic-version": "2023-06-01", "x-api-key": env.ANTHROPIC_KEY },
          body: JSON.stringify({
            model: "claude-haiku-4-5-20251001", max_tokens: 300, system: COACH_SYSTEM,
            messages: [{ role: "user", content: `Jeremy's last-14-day data:\n${ctxJson}\n\nWrite today's coach note.` }]
          })
        });
        const data = await r.json();
        if (!r.ok) return new Response(JSON.stringify({ ok: false, error: data?.error?.message }), { status: r.status, headers: CORS });
        const text = (data.content || []).filter(b => b.type === "text").map(b => b.text).join("");
        let note = null, verdict = "keep_going";
        try {
          const clean = text.replace(/```json|```/g, "").trim();
          const p = JSON.parse(clean.slice(clean.indexOf("{"), clean.lastIndexOf("}") + 1));
          note = p.note; verdict = ["keep_going", "adjust", "recover"].includes(p.verdict) ? p.verdict : "keep_going";
        } catch(_) { note = text.slice(0, 400); }

        await env.DB.prepare(`INSERT INTO brief_cache (user_id, date, email_context) VALUES (?, ?, ?)
          ON CONFLICT(user_id, date) DO UPDATE SET email_context = excluded.email_context`)
          .bind(coachUser.id, cacheKey, JSON.stringify({ hash, note, verdict, generated_at: Date.now() })).run();

        return new Response(JSON.stringify({ ok: true, note, verdict, cached: false, context }), { headers: CORS });
      } catch (e) {
        return new Response(JSON.stringify({ ok: false, error: e.message }), { status: 500, headers: CORS });
      }
    }

    // ── Tier 1.5A: wellness data ──────────────────────────────────────────
    if (u.pathname === "/api/wellness" && req.method === "GET") {
      const wUser = await getSessionUser(env.DB, req);
      if (!wUser) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: CORS });
      try {
        const days = Math.min(parseInt(u.searchParams.get("days") || "180") || 180, 400);
        const rows = await wellnessWithOverrides(env, wUser.id, days);
        return new Response(JSON.stringify({ ok: true, rows }), { headers: CORS });
      } catch (e) { return new Response(JSON.stringify({ ok: false, error: e.message }), { status: 500, headers: CORS }); }
    }
    if (u.pathname === "/api/wellness/latest" && req.method === "GET") {
      const wlUser = await getSessionUser(env.DB, req);
      if (!wlUser) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: CORS });
      try {
        const rows = await wellnessWithOverrides(env, wlUser.id, 30);
        const latest = {};
        for (const field of WELLNESS_FIELDS) {
          for (const r of rows) {  // rows are date DESC
            if (r[field] != null) { latest[field] = { value: r[field], date: r.date }; break; }
          }
        }
        return new Response(JSON.stringify({ ok: true, latest }), { headers: CORS });
      } catch (e) { return new Response(JSON.stringify({ ok: false, error: e.message }), { status: 500, headers: CORS }); }
    }
    if (u.pathname === "/api/wellness/refresh" && req.method === "POST") {
      const wrUser = await getSessionUser(env.DB, req);
      if (!wrUser) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: CORS });
      try {
        const body = await req.json().catch(() => ({}));
        const days = Math.min(Math.max(parseInt(body.days) || 3, 1), 200);
        const end = userLocalDate(wrUser);
        const start = new Date(new Date(end + "T12:00:00Z").getTime() - days * 86400000).toISOString().slice(0, 10);
        const res = await tpFetchWellness(env, wrUser.id, start, end);
        if (res.error) return new Response(JSON.stringify({ ok: false, error: res.error }), { status: 502, headers: CORS });
        const readiness = await computeReadiness(env, wrUser.id, end).catch(e => ({ ok: false, error: e.message }));
        return new Response(JSON.stringify({ ok: true, days: res.days, readiness }), { headers: CORS });
      } catch (e) { return new Response(JSON.stringify({ ok: false, error: e.message }), { status: 500, headers: CORS }); }
    }
    if (u.pathname === "/api/wellness/override" && req.method === "POST") {
      const woUser = await getSessionUser(env.DB, req);
      if (!woUser) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: CORS });
      try {
        const { date, field, value } = await req.json();
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date || "") || !WELLNESS_FIELDS.includes(field)) {
          return new Response(JSON.stringify({ ok: false, error: "bad date or field" }), { status: 400, headers: CORS });
        }
        if (value == null) {
          await env.DB.prepare("DELETE FROM wellness_override WHERE user_id = ? AND date = ? AND field = ?").bind(woUser.id, date, field).run();
        } else {
          const num = Number(value);
          if (!isFinite(num)) return new Response(JSON.stringify({ ok: false, error: "bad value" }), { status: 400, headers: CORS });
          await env.DB.prepare(`INSERT INTO wellness_override (user_id, date, field, value, updated_at) VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(user_id, date, field) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
            .bind(woUser.id, date, field, num, Date.now()).run();
        }
        await computeReadiness(env, woUser.id, date).catch(() => {});
        return new Response(JSON.stringify({ ok: true }), { headers: CORS });
      } catch (e) { return new Response(JSON.stringify({ ok: false, error: e.message }), { status: 500, headers: CORS }); }
    }

    // ── Tier 1.5C: readiness ──────────────────────────────────────────────
    if (u.pathname === "/api/readiness/today" && req.method === "GET") {
      const rUser = await getSessionUser(env.DB, req);
      if (!rUser) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: CORS });
      try {
        const date = userLocalDate(rUser);
        let row = await env.DB.prepare("SELECT * FROM readiness WHERE user_id = ? AND date = ?").bind(rUser.id, date).first();
        if (!row) {
          const res = await computeReadiness(env, rUser.id, date);
          if (!res.ok) return new Response(JSON.stringify({ ok: true, gathering: !!res.gathering, have: res.have, need: res.need, error: res.error || null, row: null }), { headers: CORS });
          row = await env.DB.prepare("SELECT * FROM readiness WHERE user_id = ? AND date = ?").bind(rUser.id, date).first();
        }
        if (row) { try { row.inputs = JSON.parse(row.inputs_json); } catch(_) {} delete row.inputs_json; }
        const anomaly = await env.DB.prepare("SELECT kind, detail_json FROM anomaly_event WHERE user_id = ? AND date = ?").bind(rUser.id, date).all().then(r => r.results).catch(() => []);
        return new Response(JSON.stringify({ ok: true, row, anomalies: anomaly }), { headers: CORS });
      } catch (e) { return new Response(JSON.stringify({ ok: false, error: e.message }), { status: 500, headers: CORS }); }
    }
    if (u.pathname === "/api/readiness" && req.method === "GET") {
      const rsUser = await getSessionUser(env.DB, req);
      if (!rsUser) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: CORS });
      const days = Math.min(parseInt(u.searchParams.get("days") || "90") || 90, 365);
      const rows = (await env.DB.prepare(`SELECT date, score, band, hrv_z, rhr_z, sleep_z, body_battery_val, tsb_val, narrative FROM readiness
        WHERE user_id = ? AND date >= date('now','-' || ? || ' days') ORDER BY date ASC`).bind(rsUser.id, days).all()).results;
      return new Response(JSON.stringify({ ok: true, rows }), { headers: CORS });
    }
    if (u.pathname === "/api/readiness/compute" && req.method === "POST") {
      const rcUser = await getSessionUser(env.DB, req);
      if (!rcUser) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: CORS });
      try {
        const body = await req.json().catch(() => ({}));
        const date = /^\d{4}-\d{2}-\d{2}$/.test(body.date || "") ? body.date : userLocalDate(rcUser);
        const res = await computeReadiness(env, rcUser.id, date);
        return new Response(JSON.stringify(res), { status: res.ok || res.gathering ? 200 : 400, headers: CORS });
      } catch (e) { return new Response(JSON.stringify({ ok: false, error: e.message }), { status: 500, headers: CORS }); }
    }

    // ── Item 9: store browser timezone for local-time reminders ───────────
    if (u.pathname === "/api/user/tz" && req.method === "POST") {
      const tzUser = await getSessionUser(env.DB, req);
      if (!tzUser) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: CORS });
      try {
        const { tz } = await req.json();
        if (typeof tz === "string" && tz.length < 64 && /^[A-Za-z_/+-]+$/.test(tz)) {
          await env.DB.prepare("UPDATE users SET tz = ? WHERE id = ?").bind(tz, tzUser.id).run();
        }
        return new Response(JSON.stringify({ ok: true }), { headers: CORS });
      } catch (e) {
        return new Response(JSON.stringify({ ok: false, error: e.message }), { status: 500, headers: CORS });
      }
    }

    // ── Item 9: web push subscribe/unsubscribe/list/pending/test ──────────
    if (u.pathname === "/api/push/vapid" && req.method === "GET") {
      const vUser = await getSessionUser(env.DB, req);
      if (!vUser) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: CORS });
      return new Response(JSON.stringify({ ok: true, key: env.VAPID_PUBLIC_KEY || null }), { headers: CORS });
    }
    if (u.pathname === "/api/push/subscribe" && req.method === "POST") {
      const sUser = await getSessionUser(env.DB, req);
      if (!sUser) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: CORS });
      try {
        const b = await req.json();
        const endpoint = b.endpoint, p256dh = b.keys?.p256dh, auth = b.keys?.auth;
        if (!endpoint || !p256dh || !auth) return new Response(JSON.stringify({ ok: false, error: "bad subscription" }), { status: 400, headers: CORS });
        await env.DB.prepare(`INSERT INTO push_subscription (user_id, endpoint, p256dh, auth, device_label, created_at)
          VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(user_id, endpoint) DO UPDATE SET p256dh=excluded.p256dh, auth=excluded.auth, device_label=excluded.device_label`)
          .bind(sUser.id, endpoint, p256dh, auth, (b.device_label || "").slice(0, 80), Date.now()).run();
        return new Response(JSON.stringify({ ok: true }), { headers: CORS });
      } catch (e) {
        return new Response(JSON.stringify({ ok: false, error: e.message }), { status: 500, headers: CORS });
      }
    }
    if (u.pathname === "/api/push/unsubscribe" && req.method === "POST") {
      const uUser = await getSessionUser(env.DB, req);
      if (!uUser) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: CORS });
      try {
        const { endpoint } = await req.json();
        await env.DB.prepare("DELETE FROM push_subscription WHERE user_id = ? AND endpoint = ?").bind(uUser.id, endpoint || "").run();
        return new Response(JSON.stringify({ ok: true }), { headers: CORS });
      } catch (e) {
        return new Response(JSON.stringify({ ok: false, error: e.message }), { status: 500, headers: CORS });
      }
    }
    if (u.pathname === "/api/push/subscriptions" && req.method === "GET") {
      const lUser = await getSessionUser(env.DB, req);
      if (!lUser) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: CORS });
      const rows = (await env.DB.prepare("SELECT endpoint, device_label, created_at, last_used_at FROM push_subscription WHERE user_id = ?").bind(lUser.id).all()).results;
      return new Response(JSON.stringify({ ok: true, subscriptions: rows }), { headers: CORS });
    }
    // Called by the service worker on push receipt (cookie-authenticated)
    if (u.pathname === "/api/push/pending" && req.method === "GET") {
      const pUser = await getSessionUser(env.DB, req);
      if (!pUser) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: CORS });
      try {
        const row = await env.DB.prepare(`SELECT date, kind, title, body, url FROM push_sent
          WHERE user_id = ? AND delivered = 0 ORDER BY sent_at DESC LIMIT 1`).bind(pUser.id).first();
        if (row) {
          await env.DB.prepare("UPDATE push_sent SET delivered = 1 WHERE user_id = ? AND date = ? AND kind = ?").bind(pUser.id, row.date, row.kind).run();
          return new Response(JSON.stringify({ ok: true, notification: { title: row.title, body: row.body, url: row.url } }), { headers: CORS });
        }
        return new Response(JSON.stringify({ ok: true, notification: null }), { headers: CORS });
      } catch (e) {
        return new Response(JSON.stringify({ ok: false, error: e.message }), { status: 500, headers: CORS });
      }
    }
    if (u.pathname === "/api/push/test" && req.method === "POST") {
      const tUser = await getSessionUser(env.DB, req);
      if (!tUser) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: CORS });
      try {
        // unique kind per test so dedupe never blocks it
        const res = await sendPushToUser(env, tUser.id, "test-" + Date.now(), "🔔 Test notification", "Push is working — you're all set.", "/");
        return new Response(JSON.stringify(res), { headers: CORS });
      } catch (e) {
        return new Response(JSON.stringify({ ok: false, error: e.message }), { status: 500, headers: CORS });
      }
    }

    // ── Item 8: quick-add favorites + user preferences ────────────────────
    if (u.pathname === "/api/log/favorites" && req.method === "GET") {
      const favUser = await getSessionUser(env.DB, req);
      if (!favUser) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: CORS });
      try {
        const rows = (await env.DB.prepare(
          `SELECT date, payload_json FROM food_log WHERE user_id = ? AND deleted = 0 AND date >= date('now','-60 days')`
        ).bind(favUser.id).all()).results;
        const today = Date.now();
        const agg = {};
        for (const r of rows) {
          let e; try { e = JSON.parse(r.payload_json); } catch(_) { continue; }
          if (!e?.name || !(e.calories > 0)) continue;
          // Dedupe on normalized name + calories within ±10 kcal buckets
          const key = e.name.trim().toLowerCase().replace(/\s+/g, " ") + "|" + Math.round(e.calories / 20);
          const a = agg[key] || (agg[key] = { key, count: 0, last: "1970-01-01", entry: null });
          a.count++;
          if (r.date >= a.last) { a.last = r.date; a.entry = e; }
        }
        let prefs = {};
        try {
          const pr = await env.DB.prepare("SELECT payload_json FROM user_preferences WHERE user_id = ?").bind(favUser.id).first();
          if (pr) prefs = JSON.parse(pr.payload_json);
        } catch(_) {}
        const pinned = new Set(prefs.pinned_foods || []);
        const favorites = Object.values(agg)
          .map(a => {
            const daysSince = Math.max(1, Math.round((today - new Date(a.last).getTime()) / 86400000));
            return {
              key: a.key, name: a.entry.name, icon: a.entry.icon || "🍽️",
              calories: Math.round(a.entry.calories || 0), protein: a.entry.protein || 0,
              carbs: a.entry.carbs || 0, fat: a.entry.fat || 0,
              count: a.count, score: a.count / daysSince, pinned: pinned.has(a.key),
            };
          })
          .sort((x, y) => (y.pinned - x.pinned) || (y.score - x.score))
          .slice(0, 25);
        return new Response(JSON.stringify({ ok: true, favorites, pinned: [...pinned] }), { headers: CORS });
      } catch (e) {
        return new Response(JSON.stringify({ ok: false, error: e.message }), { status: 500, headers: CORS });
      }
    }

    if (u.pathname === "/api/prefs" && (req.method === "GET" || req.method === "PUT")) {
      const prefUser = await getSessionUser(env.DB, req);
      if (!prefUser) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: CORS });
      try {
        const row = await env.DB.prepare("SELECT payload_json FROM user_preferences WHERE user_id = ?").bind(prefUser.id).first();
        let prefs = {};
        try { if (row) prefs = JSON.parse(row.payload_json); } catch(_) {}
        if (req.method === "PUT") {
          const patch = await req.json();
          if (patch && typeof patch === "object") prefs = { ...prefs, ...patch };
          const blob = JSON.stringify(prefs);
          if (blob.length > 16384) return new Response(JSON.stringify({ ok: false, error: "prefs too large" }), { status: 400, headers: CORS });
          await env.DB.prepare(`INSERT INTO user_preferences (user_id, payload_json, updated_at) VALUES (?, ?, ?)
            ON CONFLICT(user_id) DO UPDATE SET payload_json = excluded.payload_json, updated_at = excluded.updated_at`)
            .bind(prefUser.id, blob, Date.now()).run();
        }
        return new Response(JSON.stringify({ ok: true, prefs }), { headers: CORS });
      } catch (e) {
        return new Response(JSON.stringify({ ok: false, error: e.message }), { status: 500, headers: CORS });
      }
    }

    // ── Item 7: backup status + manual trigger ────────────────────────────
    if (u.pathname === "/api/backup/status" && req.method === "GET") {
      const bkUser = await getSessionUser(env.DB, req);
      if (!bkUser) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: CORS });
      try {
        const latest = await env.BACKUPS?.get("backups/latest.json");
        if (!latest) return new Response(JSON.stringify({ ok: true, last: null }), { headers: CORS });
        const manifest = JSON.parse(await latest.text());
        return new Response(JSON.stringify({ ok: true, last: manifest.generated_at, date: manifest.date, total_bytes: manifest.total_bytes, tables: manifest.tables, pruned: manifest.pruned }), { headers: CORS });
      } catch (e) {
        return new Response(JSON.stringify({ ok: false, error: e.message }), { status: 500, headers: CORS });
      }
    }
    if (u.pathname === "/api/backup/run" && req.method === "POST") {
      const bkrUser = await getSessionUser(env.DB, req);
      if (!bkrUser) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: CORS });
      try {
        const res = await runBackup(env);
        return new Response(JSON.stringify(res), { status: res.ok ? 200 : 500, headers: CORS });
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
        // Coalesced weight (Tier 1.5): override > wellness > weight_log > legacy check-in
        const wmap = {};
        for (const c of checkins.results) if (c.weight_lbs > 0) wmap[c.date] = c.weight_lbs;
        for (const w of weights.results) wmap[w.date] = w.weight_lbs;
        try {
          const wellRows = await wellnessWithOverrides(env, trUser.id, days);
          for (const r of wellRows) if (r.weight_lbs > 0) wmap[r.date] = r.weight_lbs;
        } catch(_) {}
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

  // 15-minute cron; dispatch by wall clock so one trigger covers everything:
  //  08:00 UTC — training-load recompute · 08:15 UTC — nightly backup
  async scheduled(event, env, ctx) {
    const t = new Date(event.scheduledTime);
    const h = t.getUTCHours(), m = t.getUTCMinutes();
    try {
      const user = await env.DB.prepare("SELECT id FROM users LIMIT 1").first();
      if (h === 6 && m === 0) ctx.waitUntil(tpDailyRefresh(env).catch(() => {}));
      if (h === 8 && m === 0 && user) {
        ctx.waitUntil(tpRecomputeLoad(env, user.id).catch(() => {}));
        ctx.waitUntil((async () => {
          const full = await env.DB.prepare("SELECT * FROM users LIMIT 1").first();
          const end = userLocalDate(full);
          const start = new Date(new Date(end + "T12:00:00Z").getTime() - 14 * 86400000).toISOString().slice(0, 10);
          await tpFetchWellness(env, full.id, start, end);
        })().catch(() => {}));
      }
      if (h === 8 && m === 15 && user) {
        ctx.waitUntil(runBackup(env).catch(() => {}));
        ctx.waitUntil((async () => {
          const full = await env.DB.prepare("SELECT * FROM users LIMIT 1").first();
          await computeReadiness(env, full.id, userLocalDate(full));
        })().catch(() => {}));
      }
      ctx.waitUntil(runPushScheduler(env).catch(() => {}));  // every 15 min
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
