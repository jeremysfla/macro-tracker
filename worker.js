var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

const GOOGLE_CLIENT_ID = '480646952925-03r0p3jkdvfjdpnhlqbam4hnfjq0hp63.apps.googleusercontent.com';

// ── Session helpers ─────────────────────────────────────────────────────
function generateSessionToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}
__name(generateSessionToken, "generateSessionToken");

const SESSION_TTL_DAYS = 30;

async function ensureSessionsTable(db) {
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      expires_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id)
    )
  `).run();
}
__name(ensureSessionsTable, "ensureSessionsTable");

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
  return row;
}
__name(validateSession, "validateSession");

async function getSessionUser(db, req) {
  const auth = req.headers.get("authorization")?.replace("Bearer ", "");
  if (!auth) return null;
  return validateSession(db, auth);
}
__name(getSessionUser, "getSessionUser");

// ── Google token verification ───────────────────────────────────────────
async function verifyGoogleToken(idToken) {
  const res = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`);
  if (!res.ok) return null;
  const payload = await res.json();
  if (payload.aud !== GOOGLE_CLIENT_ID) return null;
  return payload;
}
__name(verifyGoogleToken, "verifyGoogleToken");

var worker_default = {
  async fetch(req, env) {
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
      return new Response(JSON.stringify({
        ok: true, hasKey: !!env.ANTHROPIC_KEY,
        keyPrefix: env.ANTHROPIC_KEY ? env.ANTHROPIC_KEY.slice(0, 7) + "..." : "NOT SET"
      }), { headers: CORS });
    }

    // ── Ensure sessions table exists (runs once, cached by D1) ────────
    if (env.DB) {
      try { await ensureSessionsTable(env.DB); } catch(_) {}
    }

    // ── Auth: Google Sign-In → create session ───────────────────────────
    if (u.pathname === "/api/auth/google" && req.method === "POST") {
      try {
        const { idToken } = await req.json();
        const payload = await verifyGoogleToken(idToken);
        if (!payload) return new Response(JSON.stringify({ error: "Invalid token" }), { status: 401, headers: CORS });

        let user = await env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(payload.sub).first();

        if (!user) {
          await env.DB.prepare(
            "INSERT INTO users (id, email, name, picture) VALUES (?, ?, ?, ?)"
          ).bind(payload.sub, payload.email, payload.name || "", payload.picture || "").run();
          user = await env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(payload.sub).first();
        }

        // Create a long-lived session token
        const session = await createSession(env.DB, payload.sub);

        return new Response(JSON.stringify({ user, sessionToken: session.token, expiresAt: session.expiresAt }), { headers: CORS });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: CORS });
      }
    }

    // ── Get user profile (now uses session token) ────────────────────────
    if (u.pathname === "/api/user" && req.method === "GET") {
      const user = await getSessionUser(env.DB, req);
      if (!user) return new Response(JSON.stringify({ error: "Invalid or expired session" }), { status: 401, headers: CORS });
      return new Response(JSON.stringify({ user }), { headers: CORS });
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
      const auth = req.headers.get("authorization")?.replace("Bearer ", "");
      if (auth) {
        try { await env.DB.prepare("DELETE FROM sessions WHERE token = ?").bind(auth).run(); } catch(_) {}
      }
      return new Response(JSON.stringify({ ok: true }), { headers: CORS });
    }

    // ── Protected endpoints — require valid session ─────────────────────

    // Brief context (email cache from D1)
    if (u.pathname === "/api/brief-context" && req.method === "GET") {
      const user = await getSessionUser(env.DB, req);
      if (!user) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: CORS });
      try {
        const date = u.searchParams.get("date") || new Date().toISOString().slice(0,10);
        if (!env.DB) return new Response(JSON.stringify({ ok: false }), { headers: CORS });
        const row = await env.DB.prepare("SELECT * FROM brief_cache WHERE date=?").bind(date).first();
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
        const daysToMarathon = Math.ceil((new Date("2026-06-20") - new Date()) / 86400000);
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
        await env.DB.prepare(sql).bind(b.date,b.user_id||"jeremy",b.energy??null,b.mood??null,b.water_oz??null,b.weight_lbs??null,b.sleep_hrs??null,b.sleep_deep??null,b.sleep_rem??null,b.sleep_score??null,b.calories_consumed??null,b.protein_g??null,b.carbs_g??null,b.fat_g??null,b.steps??null,b.active_cals??null,b.notes??null).run();
        return new Response(JSON.stringify({ ok: true }), { headers: CORS });
      } catch(e) { return new Response(JSON.stringify({ ok: false, error: e.message }), { status: 500, headers: CORS }); }
    }

    if (u.pathname === "/api/checkin" && req.method === "GET") {
      const user = await getSessionUser(env.DB, req);
      if (!user) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: CORS });
      try {
        const days = Math.min(parseInt(u.searchParams.get("days")||"90"), 365);
        const rows = await env.DB.prepare(`SELECT * FROM daily_checkin WHERE user_id='jeremy' AND date>=date('now','-'||?||' days') ORDER BY date DESC`).bind(days).all();
        return new Response(JSON.stringify({ ok: true, rows: rows.results }), { headers: CORS });
      } catch(e) { return new Response(JSON.stringify({ ok: false, error: e.message }), { status: 500, headers: CORS }); }
    }

    // ── Barcode lookup ─────────────────────────────────────────────────────
    if (u.pathname === "/api/barcode" && req.method === "GET") {
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
      const USDA_KEY = env.USDA_KEY || "DEMO_KEY";
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

    // ── Garmin OAuth proxy ──────────────────────────────────────────────
    if (u.pathname === "/api/garmin/proxy" && req.method === "POST") {
      const user = await getSessionUser(env.DB, req);
      if (!user) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: CORS });
      try {
        const { url, method: m, headers: h } = await req.json();
        if (!url || !url.startsWith("https://connectapi.garmin.com/")) {
          return new Response(JSON.stringify({ error: "Invalid Garmin URL" }), { status: 400, headers: CORS });
        }
        const r = await fetch(url, { method: m || "POST", headers: h || {} });
        const text = await r.text();
        return new Response(text, {
          status: r.status,
          headers: { "content-type": "text/plain", "access-control-allow-origin": "*" }
        });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: CORS });
      }
    }

    // ── Strava: redirect to auth page ───────────────────────────────────
    if (u.pathname === "/api/strava/auth" && req.method === "GET") {
      const clientId = env.STRAVA_CLIENT_ID;
      if (!clientId) return new Response(JSON.stringify({ error: "Strava not configured on server" }), { status: 500, headers: CORS });
      const redirectUri = encodeURIComponent(`${u.origin}/api/strava/callback`);
      const scope = "read,activity:read";
      const stravaUrl = `https://www.strava.com/oauth/authorize?client_id=${clientId}&redirect_uri=${redirectUri}&response_type=code&scope=${scope}&approval_prompt=auto`;
      return Response.redirect(stravaUrl, 302);
    }

    // ── Strava: OAuth callback ──────────────────────────────────────────
    if (u.pathname === "/api/strava/callback" && req.method === "GET") {
      const code = u.searchParams.get("code");
      if (!code) {
        return new Response("<h2>Strava authorization denied</h2><script>setTimeout(()=>window.close(),2000)</script>", {
          headers: { "content-type": "text/html" }
        });
      }
      try {
        const tokenRes = await fetch("https://www.strava.com/oauth/token", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            client_id: env.STRAVA_CLIENT_ID,
            client_secret: env.STRAVA_CLIENT_SECRET,
            code,
            grant_type: "authorization_code",
          })
        });
        const data = await tokenRes.json();
        if (!data.access_token) throw new Error(data.message || "Token exchange failed");
        const tokenPayload = encodeURIComponent(JSON.stringify({
          accessToken: data.access_token,
          refreshToken: data.refresh_token,
          expiresAt: data.expires_at,
          athlete: data.athlete,
        }));
        return Response.redirect(`${u.origin}/#strava_token=${tokenPayload}`, 302);
      } catch (e) {
        return new Response(`<h2>Strava connection failed</h2><p>${e.message}</p><script>setTimeout(()=>window.location='${u.origin}',3000)</script>`, {
          headers: { "content-type": "text/html" }
        });
      }
    }

    // ── Strava: token refresh ───────────────────────────────────────────
    if (u.pathname === "/api/strava/refresh" && req.method === "POST") {
      try {
        const { refreshToken } = await req.json();
        if (!refreshToken) return new Response(JSON.stringify({ error: "Missing refreshToken" }), { status: 400, headers: CORS });
        const tokenRes = await fetch("https://www.strava.com/oauth/token", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            client_id: env.STRAVA_CLIENT_ID,
            client_secret: env.STRAVA_CLIENT_SECRET,
            refresh_token: refreshToken,
            grant_type: "refresh_token",
          })
        });
        const data = await tokenRes.json();
        if (!data.access_token) return new Response(JSON.stringify({ error: data.message || "Refresh failed" }), { status: 400, headers: CORS });
        return new Response(JSON.stringify({
          accessToken: data.access_token,
          refreshToken: data.refresh_token,
          expiresAt: data.expires_at,
        }), { headers: CORS });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: CORS });
      }
    }

    return env.ASSETS.fetch(req);
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
