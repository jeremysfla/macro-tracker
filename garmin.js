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
  await ensureTokenTable(env.DB);
  if (!force) {
    const row = await env.DB.prepare("SELECT access_token, expires_at FROM garmin_token WHERE id = 1").first();
    if (row && row.expires_at - Date.now() > REFRESH_WINDOW_MS) return row.access_token;
  }
  if (!env.GARMIN_API_KEY) throw new Error("Garmin API key is not configured");
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

// ── Sync: pull a date range into wellness / garmin_daily / garmin_activity ──
const G_TO_LBS = 2.2046226 / 1000;
const MAX_RANGE_DAYS = 28;
const WELLNESS_FIELDS = ["weight_lbs", "hrv_ms", "resting_hr_bpm", "sleep_total_hrs", "sleep_deep_hrs", "sleep_light_hrs", "sleep_rem_hrs", "sleep_awake_hrs", "sleep_score", "body_battery_wake", "body_battery_low", "body_battery_high", "stress_avg", "muscle_mass_lbs", "body_fat_pct", "body_water_pct", "bmi"];
const DAILY_FIELDS = ["steps", "step_goal", "active_kcal", "resting_kcal", "total_kcal", "intensity_moderate", "intensity_vigorous", "hrv_status", "hrv_weekly_avg", "sleep_need_min", "spo2_avg", "respiration_avg", "vo2_max"];

const round2 = (v) => Math.round(v * 100) / 100;
const hrs = (sec) => Number.isFinite(sec) ? round2(sec / 3600) : null;
const num = (v) => Number.isFinite(v) ? v : null;
const addDays = (date, n) => new Date(new Date(date + "T12:00:00Z").getTime() + n * 86400000).toISOString().slice(0, 10);

function dateChunks(start, end) {
  const out = [];
  for (let s = start; s <= end; s = addDays(s, MAX_RANGE_DAYS)) {
    const e = addDays(s, MAX_RANGE_DAYS - 1);
    out.push([s, e < end ? e : end]);
  }
  return out;
}

// One failing endpoint (e.g. no scale, no SpO2) must not sink the whole sync
async function tryGet(env, errors, label, path, params) {
  try { return await garminGet(env, path, params); }
  catch (e) { errors.push(`${label}: ${String(e.message).slice(0, 120)}`); return null; }
}

export async function garminSync(env, userId, startDate, endDate) {
  const errors = [];
  const wellness = {}, daily = {};
  const W = (d) => (wellness[d] = wellness[d] || {});
  const D = (d) => (daily[d] = daily[d] || {});
  const inRange = (d) => typeof d === "string" && d >= startDate && d <= endDate;

  for (const [s, e] of dateChunks(startDate, endDate)) {
    const [summ, sleeps, hrv, weights, vo2] = await Promise.all([
      tryGet(env, errors, "daily", "/usersummary-service/v2/dailysummaries", { startDate: s, endDate: e }),
      tryGet(env, errors, "sleep", "/sleep-service/sleep/dailySleepSummariesByDate", { startDate: s, endDate: e }),
      tryGet(env, errors, "hrv", `/hrv-service/hrv/daily/${s}/${e}`),
      tryGet(env, errors, "weight", `/weight-service/weight/range/${s}/${e}`, { includeAll: "true" }),
      tryGet(env, errors, "vo2", `/metrics-service/metrics/maxmet/daily/${s}/${e}`),
    ]);

    for (const x of summ?.data || []) {
      const d = x.calendarDate;
      if (!inRange(d)) continue;
      Object.assign(W(d), {
        resting_hr_bpm: num(x.heartRate?.restingValue),
        stress_avg: num(x.stress?.avgLevel),
        body_battery_low: num(x.bodyBattery?.minValue),
        body_battery_high: num(x.bodyBattery?.maxValue),
        body_battery_wake: num(x.bodyBattery?.maxValue),   // the day's peak is the post-sleep value
      });
      Object.assign(D(d), {
        steps: num(x.movement?.steps?.value), step_goal: num(x.movement?.steps?.goal),
        active_kcal: num(x.calories?.burnedActive), resting_kcal: num(x.calories?.burnedResting), total_kcal: num(x.calories?.burnedTotal),
        intensity_moderate: num(x.intensityMinutes?.moderate), intensity_vigorous: num(x.intensityMinutes?.vigorous),
        spo2_avg: num(x.pulseOx?.avgValue), respiration_avg: num(x.respiration?.avgValue),
      });
    }
    for (const x of Array.isArray(sleeps) ? sleeps : []) {
      const d = x.calendarDate;
      if (!inRange(d) || !Number.isFinite(x.sleepTimeSeconds)) continue;
      Object.assign(W(d), {
        sleep_total_hrs: hrs(x.sleepTimeSeconds), sleep_deep_hrs: hrs(x.deepSleepSeconds), sleep_light_hrs: hrs(x.lightSleepSeconds),
        sleep_rem_hrs: hrs(x.remSleepSeconds), sleep_awake_hrs: hrs(x.awakeSleepSeconds),
        sleep_score: num(x.sleepScores?.overall?.value),
      });
      D(d).sleep_need_min = num(x.sleepNeed?.actual);
    }
    for (const x of hrv?.hrvSummaries || []) {
      const d = x.calendarDate;
      if (!inRange(d)) continue;
      W(d).hrv_ms = num(x.lastNightAvg);
      Object.assign(D(d), { hrv_status: x.status || null, hrv_weekly_avg: num(x.weeklyAvg) });
    }
    for (const x of weights?.dailyWeightSummaries || []) {
      const d = x.summaryDate, w = x.latestWeight;
      if (!inRange(d) || !w || !Number.isFinite(w.weight)) continue;
      Object.assign(W(d), {
        weight_lbs: round2(w.weight * G_TO_LBS),
        body_fat_pct: num(w.bodyFat), body_water_pct: num(w.bodyWater),
        muscle_mass_lbs: Number.isFinite(w.muscleMass) ? round2(w.muscleMass * G_TO_LBS) : null,
        bmi: Number.isFinite(w.bmi) ? Math.round(w.bmi * 10) / 10 : null,
      });
    }
    for (const x of Array.isArray(vo2) ? vo2 : []) {
      const g = x.generic;
      if (g && inRange(g.calendarDate)) D(g.calendarDate).vo2_max = num(g.vo2MaxPreciseValue ?? g.vo2MaxValue);
    }
  }

  // Activities (paged)
  const acts = [];
  for (let start = 0; start < 400; start += 50) {
    const page = await tryGet(env, errors, "activities", "/activitylist-service/activities/search/activities",
      { start: String(start), limit: "50", startDate, endDate });
    if (!Array.isArray(page) || !page.length) break;
    acts.push(...page);
    if (page.length < 50) break;
  }

  const now = Date.now();
  const stmts = [];
  // Same upsert shape as the TrainingPeaks ingest: a non-null Garmin value wins,
  // a null never blanks out what is already stored.
  for (const [date, f] of Object.entries(wellness)) {
    if (!WELLNESS_FIELDS.some(c => f[c] != null)) continue;
    stmts.push(env.DB.prepare(`INSERT INTO wellness (user_id, date, ${WELLNESS_FIELDS.join(", ")}, source, updated_at)
      VALUES (?, ?, ${WELLNESS_FIELDS.map(() => "?").join(", ")}, 'garmin', ?)
      ON CONFLICT(user_id, date) DO UPDATE SET
        ${WELLNESS_FIELDS.map(c => `${c} = COALESCE(excluded.${c}, wellness.${c})`).join(", ")},
        source = 'garmin', updated_at = excluded.updated_at`)
      .bind(userId, date, ...WELLNESS_FIELDS.map(c => f[c] ?? null), now));
  }
  for (const [date, f] of Object.entries(daily)) {
    if (!DAILY_FIELDS.some(c => f[c] != null)) continue;
    stmts.push(env.DB.prepare(`INSERT INTO garmin_daily (user_id, date, ${DAILY_FIELDS.join(", ")}, updated_at)
      VALUES (?, ?, ${DAILY_FIELDS.map(() => "?").join(", ")}, ?)
      ON CONFLICT(user_id, date) DO UPDATE SET
        ${DAILY_FIELDS.map(c => `${c} = COALESCE(excluded.${c}, garmin_daily.${c})`).join(", ")},
        updated_at = excluded.updated_at`)
      .bind(userId, date, ...DAILY_FIELDS.map(c => f[c] ?? null), now));
  }
  for (const a of acts) {
    if (!a?.activityId) continue;
    const startLocal = String(a.startTimeLocal || "");
    stmts.push(env.DB.prepare(`INSERT INTO garmin_activity (user_id, activity_id, date, start_local, type, name, duration_s, distance_m, calories, bmr_calories, avg_hr, max_hr, training_load, aerobic_te, body_battery_delta, elevation_gain_m, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id, activity_id) DO UPDATE SET
        date = excluded.date, start_local = excluded.start_local, type = excluded.type, name = excluded.name,
        duration_s = excluded.duration_s, distance_m = excluded.distance_m, calories = excluded.calories,
        bmr_calories = excluded.bmr_calories, avg_hr = excluded.avg_hr, max_hr = excluded.max_hr,
        training_load = excluded.training_load, aerobic_te = excluded.aerobic_te,
        body_battery_delta = excluded.body_battery_delta, elevation_gain_m = excluded.elevation_gain_m, updated_at = excluded.updated_at`)
      .bind(userId, String(a.activityId), startLocal.slice(0, 10), startLocal, a.activityType?.typeKey || null, String(a.activityName || "").slice(0, 200),
        num(a.duration), num(a.distance), num(a.calories), num(a.bmrCalories), num(a.averageHR), num(a.maxHR),
        num(a.activityTrainingLoad), num(a.aerobicTrainingEffect), num(a.differenceBodyBattery), num(a.elevationGain), now));
  }
  for (let i = 0; i < stmts.length; i += 40) await env.DB.batch(stmts.slice(i, i + 40));

  const ok = stmts.length > 0 || !errors.length;
  await env.DB.prepare(`INSERT INTO garmin_state (id, last_sync_at, last_ok_at, last_error) VALUES (1, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET last_sync_at = excluded.last_sync_at,
      last_ok_at = COALESCE(excluded.last_ok_at, garmin_state.last_ok_at), last_error = excluded.last_error`)
    .bind(now, ok ? now : null, errors.length ? errors.join(" | ").slice(0, 500) : null).run();
  return { ok, wellness_days: Object.keys(wellness).length, daily_days: Object.keys(daily).length, activities: acts.length, errors };
}

// ── Goal plan: a daily calorie target that works backward from a goal weight and date ──
// base target  = average non-exercise burn (Garmin all-day total minus net workout
//                calories) minus the deficit the goal needs, within safety limits
// today's target = base + today's net workout calories (eaten back in full, since
//                the deficit is already built into the base)
const KCAL_PER_LB = 3500;
const MAX_DEFICIT_KCAL = 750;          // about 1.5 lb/week
const MIN_BASE_KCAL = 1500;            // never plan a base intake below this
const BURN_WINDOW_DAYS = 14;
const WEIGHT_WINDOW_DAYS = 10;
const round10 = (v) => Math.round(v / 10) * 10;
const daysBetween = (a, b) => Math.round((new Date(b + "T12:00:00Z") - new Date(a + "T12:00:00Z")) / 86400000);

async function ensurePlanTable(db) {
  await db.prepare("CREATE TABLE IF NOT EXISTS goal_plan (id INTEGER PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 1, goal_weight REAL NOT NULL, goal_date TEXT NOT NULL, updated_at INTEGER NOT NULL)").run();
}

export async function computeGoalPlan(env, user, today) {
  await ensurePlanTable(env.DB);
  const cfg = await env.DB.prepare("SELECT enabled, goal_weight, goal_date FROM goal_plan WHERE id = 1").first();
  if (!cfg || !cfg.enabled) return { ok: true, active: false, reason: cfg ? "off" : "not set up" };

  // Trend weight: mean of the weigh-ins in the last 10 days (scale via Garmin, or logged by hand)
  const since = addDays(today, -(WEIGHT_WINDOW_DAYS - 1));
  const [wl, ml] = await Promise.all([
    env.DB.prepare("SELECT date, weight_lbs FROM wellness WHERE user_id = ? AND weight_lbs IS NOT NULL AND date BETWEEN ? AND ?").bind(user.id, since, today).all(),
    env.DB.prepare("SELECT date, weight_lbs FROM weight_log WHERE user_id = ? AND date BETWEEN ? AND ?").bind(user.id, since, today).all().catch(() => ({ results: [] })),
  ]);
  const byDate = {};
  for (const r of ml.results || []) byDate[r.date] = r.weight_lbs;
  for (const r of wl.results || []) byDate[r.date] = r.weight_lbs;      // the scale wins on a shared date
  const weighIns = Object.entries(byDate).sort((a, b) => a[0].localeCompare(b[0])).slice(-5);
  let trend = weighIns.length ? weighIns.reduce((s, [, w]) => s + w, 0) / weighIns.length : null;
  let weightStale = false;
  if (trend == null) {
    const last = await env.DB.prepare("SELECT weight_lbs FROM wellness WHERE user_id = ? AND weight_lbs IS NOT NULL AND date <= ? ORDER BY date DESC LIMIT 1").bind(user.id, today).first();
    trend = last?.weight_lbs ?? user.current_weight ?? null;
    weightStale = true;
  }
  if (trend == null) return { ok: true, active: false, reason: "no weight on record" };

  // Non-exercise burn over the last 14 complete days
  const burnRows = await env.DB.prepare(`SELECT d.date, d.total_kcal,
      (SELECT SUM(MAX(0, a.calories - COALESCE(a.bmr_calories, 0))) FROM garmin_activity a WHERE a.user_id = d.user_id AND a.date = d.date) AS ex_net
    FROM garmin_daily d WHERE d.user_id = ? AND d.date BETWEEN ? AND ? AND d.total_kcal > 1200`)
    .bind(user.id, addDays(today, -BURN_WINDOW_DAYS), addDays(today, -1)).all();
  const nonEx = (burnRows.results || []).map(r => r.total_kcal - (r.ex_net || 0)).filter(v => v > 1200);
  const burnFromGarmin = nonEx.length >= 5;
  const baseBurn = burnFromGarmin ? nonEx.reduce((s, v) => s + v, 0) / nonEx.length : (user.tdee || 2200);

  const todayEx = await env.DB.prepare("SELECT SUM(MAX(0, calories - COALESCE(bmr_calories, 0))) AS net, COUNT(*) AS n FROM garmin_activity WHERE user_id = ? AND date = ?").bind(user.id, today).first();
  const exerciseNet = Math.round(todayEx?.net || 0);

  const daysLeft = daysBetween(today, cfg.goal_date);
  const toLose = trend - cfg.goal_weight;
  let needed = 0, deficit = 0, limit = null;
  if (toLose > 0 && daysLeft > 0) {
    needed = toLose * KCAL_PER_LB / daysLeft;
    deficit = needed;
    if (deficit > MAX_DEFICIT_KCAL) { deficit = MAX_DEFICIT_KCAL; limit = "max_deficit"; }
    if (baseBurn - deficit < MIN_BASE_KCAL) { deficit = Math.max(0, baseBurn - MIN_BASE_KCAL); limit = "min_intake"; }
  }
  const baseCalories = round10(baseBurn - deficit);
  const realDeficit = baseBurn - baseCalories;
  const projected = daysLeft > 0 ? trend - realDeficit * daysLeft / KCAL_PER_LB : trend;
  const daysToGoal = toLose > 0 && realDeficit > 0 ? Math.ceil(toLose * KCAL_PER_LB / realDeficit) : (toLose <= 0 ? 0 : null);

  const protein = user.protein || 165, fat = user.fat || 55;
  const macros = { calories: baseCalories, protein, fat, carbs: Math.max(50, Math.round((baseCalories - protein * 4 - fat * 9) / 4)) };

  return {
    ok: true, active: true, date: today,
    goal_weight: cfg.goal_weight, goal_date: cfg.goal_date, days_left: daysLeft,
    trend_weight: Math.round(trend * 10) / 10, weigh_ins: weighIns.length, weight_stale: weightStale,
    to_lose: Math.round(toLose * 10) / 10,
    base_burn: Math.round(baseBurn), burn_from_garmin: burnFromGarmin, burn_days: nonEx.length,
    needed_deficit: Math.round(needed), deficit: Math.round(realDeficit), limit,
    lbs_per_week: Math.round(realDeficit * 7 / KCAL_PER_LB * 10) / 10,
    on_track: toLose <= 0 || (limit === null && daysLeft > 0),
    projected_weight: Math.round(projected * 10) / 10,
    projected_goal_date: daysToGoal == null ? null : addDays(today, daysToGoal),
    macros, exercise_net_today: exerciseNet, exercise_count_today: todayEx?.n || 0,
    target_today: baseCalories + exerciseNet,
  };
}

// Keep the stored profile in step with the plan so every screen and the
// server-side features read the same base target
export async function applyGoalPlanToProfile(env, user, today) {
  const plan = await computeGoalPlan(env, user, today);
  if (!plan.active) return plan;
  await env.DB.prepare("UPDATE users SET calories = ?, protein = ?, carbs = ?, fat = ?, tdee = ?, goal_weight = ?, goal_date = ?, current_weight = ? WHERE id = ?")
    .bind(plan.macros.calories, plan.macros.protein, plan.macros.carbs, plan.macros.fat, plan.base_burn, plan.goal_weight, plan.goal_date, plan.trend_weight, user.id).run();
  return plan;
}

export async function handleGarmin(req, env, ctx, user, u, hooks = {}) {
  try {
    if (u.pathname === "/api/garmin/plan" && req.method === "GET") {
      const date = /^\d{4}-\d{2}-\d{2}$/.test(u.searchParams.get("date") || "") ? u.searchParams.get("date") : new Date().toISOString().slice(0, 10);
      return json(await applyGoalPlanToProfile(env, user, date));
    }
    if (u.pathname === "/api/garmin/plan" && req.method === "POST") {
      const b = await req.json();
      await ensurePlanTable(env.DB);
      const cur = await env.DB.prepare("SELECT enabled, goal_weight, goal_date FROM goal_plan WHERE id = 1").first();
      const goalWeight = Number.isFinite(Number(b.goal_weight)) && Number(b.goal_weight) > 80 && Number(b.goal_weight) < 400 ? Number(b.goal_weight) : cur?.goal_weight;
      const goalDate = /^\d{4}-\d{2}-\d{2}$/.test(b.goal_date || "") ? b.goal_date : cur?.goal_date;
      const enabled = b.enabled === undefined ? (cur?.enabled ?? 1) : (b.enabled ? 1 : 0);
      if (!goalWeight || !goalDate) return json({ ok: false, error: "goal_weight and goal_date are required" }, 400);
      await env.DB.prepare("INSERT INTO goal_plan (id, enabled, goal_weight, goal_date, updated_at) VALUES (1, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET enabled = excluded.enabled, goal_weight = excluded.goal_weight, goal_date = excluded.goal_date, updated_at = excluded.updated_at")
        .bind(enabled, goalWeight, goalDate, Date.now()).run();
      return json({ ok: true, enabled: !!enabled, goal_weight: goalWeight, goal_date: goalDate });
    }

    if (u.pathname === "/api/garmin/status" && req.method === "GET") {
      if (!env.GARMIN_API_KEY) return json({ ok: true, configured: false });
      const state = await env.DB.prepare("SELECT last_sync_at, last_ok_at, last_error FROM garmin_state WHERE id = 1").first().catch(() => null);
      try {
        await garminToken(env);
        const row = await env.DB.prepare("SELECT expires_at FROM garmin_token WHERE id = 1").first();
        return json({ ok: true, configured: true, connected: true, token_expires_at: row?.expires_at || null, ...(state || {}) });
      } catch (e) {
        return json({ ok: true, configured: true, connected: false, error: String(e.message).slice(0, 300), ...(state || {}) });
      }
    }

    // Manual sync / backfill: POST /api/garmin/sync?days=N (default 3, max 120)
    if (u.pathname === "/api/garmin/sync" && req.method === "POST") {
      const days = Math.min(120, Math.max(1, parseInt(u.searchParams.get("days") || "3", 10) || 3));
      const end = hooks.localDate ? hooks.localDate(user) : new Date().toISOString().slice(0, 10);
      const result = await garminSync(env, user.id, addDays(end, -(days - 1)), end);
      if (hooks.afterSync) await hooks.afterSync(user, end).catch(() => {});
      return json({ ...result, range: [addDays(end, -(days - 1)), end] });
    }

    if (u.pathname === "/api/garmin/today" && req.method === "GET") {
      const end = hooks.localDate ? hooks.localDate(user) : new Date().toISOString().slice(0, 10);
      const [daily, acts] = await Promise.all([
        env.DB.prepare("SELECT * FROM garmin_daily WHERE user_id = ? AND date >= ? ORDER BY date DESC").bind(user.id, addDays(end, -13)).all(),
        env.DB.prepare("SELECT * FROM garmin_activity WHERE user_id = ? AND date >= ? ORDER BY start_local DESC").bind(user.id, addDays(end, -13)).all(),
      ]);
      return json({ ok: true, date: end, daily: daily.results || [], activities: acts.results || [] });
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
