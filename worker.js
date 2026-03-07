// worker.js — macro tracker
var worker_default = {
  async fetch(req, env) {
    const u = new URL(req.url);
    const CORS = { "content-type": "application/json", "access-control-allow-origin": "*" };

    // Health check
    if (u.pathname === "/api/status") {
      return new Response(JSON.stringify({
        ok: true, hasKey: !!env.ANTHROPIC_KEY,
        keyPrefix: env.ANTHROPIC_KEY ? env.ANTHROPIC_KEY.slice(0, 7) + "..." : "NOT SET"
      }), { headers: CORS });
    }

    // ── Daily check-in sync (POST /api/checkin) ───────────────────────────────
    // Body: { date, energy, mood, water_oz, weight_lbs, sleep_hrs, sleep_deep,
    //         sleep_rem, sleep_score, calories_consumed, protein_g, carbs_g,
    //         fat_g, steps, active_cals, notes }
    // Uses INSERT OR REPLACE so re-syncing a day is always safe.
    if (u.pathname === "/api/checkin" && req.method === "POST") {
      try {
        const b = await req.json();
        if (!b.date || !env.DB) {
          return new Response(JSON.stringify({ ok: false, error: "missing date or DB binding" }), { headers: CORS });
        }
        const sql = `
          INSERT INTO daily_checkin
            (date, user_id, energy, mood, water_oz, weight_lbs,
             sleep_hrs, sleep_deep, sleep_rem, sleep_score,
             calories_consumed, protein_g, carbs_g, fat_g,
             steps, active_cals, notes, updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'))
          ON CONFLICT(date, user_id) DO UPDATE SET
            energy             = excluded.energy,
            mood               = excluded.mood,
            water_oz           = excluded.water_oz,
            weight_lbs         = excluded.weight_lbs,
            sleep_hrs          = excluded.sleep_hrs,
            sleep_deep         = excluded.sleep_deep,
            sleep_rem          = excluded.sleep_rem,
            sleep_score        = excluded.sleep_score,
            calories_consumed  = excluded.calories_consumed,
            protein_g          = excluded.protein_g,
            carbs_g            = excluded.carbs_g,
            fat_g              = excluded.fat_g,
            steps              = excluded.steps,
            active_cals        = excluded.active_cals,
            notes              = excluded.notes,
            updated_at         = datetime('now')
        `;
        const params = [
          b.date, b.user_id || "jeremy",
          b.energy       ?? null,
          b.mood         ?? null,
          b.water_oz     ?? null,
          b.weight_lbs   ?? null,
          b.sleep_hrs    ?? null,
          b.sleep_deep   ?? null,
          b.sleep_rem    ?? null,
          b.sleep_score  ?? null,
          b.calories_consumed ?? null,
          b.protein_g    ?? null,
          b.carbs_g      ?? null,
          b.fat_g        ?? null,
          b.steps        ?? null,
          b.active_cals  ?? null,
          b.notes        ?? null,
        ];
        await env.DB.prepare(sql).bind(...params).run();
        return new Response(JSON.stringify({ ok: true }), { headers: CORS });
      } catch (e) {
        return new Response(JSON.stringify({ ok: false, error: e.message }), { status: 500, headers: CORS });
      }
    }

    // ── Read check-in history (GET /api/checkin?days=30) ──────────────────────
    if (u.pathname === "/api/checkin" && req.method === "GET") {
      try {
        const days = Math.min(parseInt(u.searchParams.get("days") || "90"), 365);
        const rows = await env.DB.prepare(
          `SELECT * FROM daily_checkin
           WHERE user_id = 'jeremy'
             AND date >= date('now', '-' || ? || ' days')
           ORDER BY date DESC`
        ).bind(days).all();
        return new Response(JSON.stringify({ ok: true, rows: rows.results }), { headers: CORS });
      } catch (e) {
        return new Response(JSON.stringify({ ok: false, error: e.message }), { status: 500, headers: CORS });
      }
    }

    // ── Barcode proxy ──────────────────────────────────────────────────────────
    if (u.pathname === "/api/barcode" && req.method === "GET") {
      const raw = (u.searchParams.get("code") || "").replace(/\D/g, "");
      if (!raw) return new Response(JSON.stringify({ found: false, error: "no code" }), { headers: CORS });

      const ean13 = raw.length === 12 ? "0" + raw : raw;
      const upcA  = raw.length === 13 && raw.startsWith("0") ? raw.slice(1) : raw;
      const codes = [...new Set([raw, ean13, upcA])];
      const UA = "MacroTracker/1.0 (jeremy@dronenerd.com)";
      const OFF_FIELDS = "product_name,product_name_en,brands,serving_size,serving_quantity,nutriments";

      for (const code of codes) {
        try {
          const r = await fetch(
            `https://world.openfoodfacts.org/api/v2/product/${code}?fields=${OFF_FIELDS}`,
            { headers: { "User-Agent": UA, "Accept": "application/json" } }
          );
          if (!r.ok) continue;
          const d = await r.json();
          if (d.status === 1 && d.product) {
            const p = parseOFF(d.product);
            if (p && p.calories > 0) {
              return new Response(JSON.stringify({ found: true, product: { ...p, source: "Open Food Facts" } }), { headers: CORS });
            }
          }
        } catch (_) {}
      }

      const USDA_KEY = env.USDA_KEY || "DEMO_KEY";
      for (const code of codes) {
        try {
          const r = await fetch(
            `https://api.nal.usda.gov/fdc/v1/foods/search?api_key=${USDA_KEY}` +
            `&query=${encodeURIComponent(code)}&dataType=Branded&pageSize=10`,
            { headers: { "User-Agent": UA } }
          );
          if (!r.ok) continue;
          const d = await r.json();
          const foods = d.foods || [];
          const hit = foods.find(f => f.gtinUpc && codes.includes(f.gtinUpc))
                   || foods.find(f => f.gtinUpc && f.gtinUpc.replace(/^0+/,"") === raw.replace(/^0+/,""));
          if (hit) {
            const p = parseUSDA(hit);
            if (p && p.calories > 0) {
              return new Response(JSON.stringify({ found: true, product: { ...p, source: "USDA FDC" } }), { headers: CORS });
            }
          }
        } catch (_) {}
      }

      try {
        const r = await fetch(`https://api.upcitemdb.com/prod/trial/lookup?upc=${upcA}`, { headers: { "User-Agent": UA } });
        if (r.ok) {
          const d = await r.json();
          const item = (d.items || [])[0];
          if (item && item.title) {
            const nutr = await usdaNameSearch(item.title, USDA_KEY, UA);
            if (nutr && nutr.calories > 0) {
              return new Response(JSON.stringify({ found: true, product: {
                ...nutr, name: item.title, brand: item.brand || nutr.brand, source: "UPC ItemDB + USDA"
              }}), { headers: CORS });
            }
            return new Response(JSON.stringify({ found: true, product: {
              name: item.title, brand: item.brand || "", calories: 0, protein: 0, carbs: 0, fat: 0,
              fiber: 0, sodium: 0, servingSize: "1", servingUnit: "serving", source: "UPC ItemDB", incomplete: true
            }}), { headers: CORS });
          }
        }
      } catch (_) {}

      return new Response(JSON.stringify({ found: false }), { headers: CORS });
    }

    // ── Claude proxy ──────────────────────────────────────────────────────────
    if (u.pathname === "/api/claude" && req.method === "POST") {
      try {
        if (!env.ANTHROPIC_KEY) {
          return new Response(JSON.stringify({ error: { message: "ANTHROPIC_KEY not set" } }), { status: 500, headers: CORS });
        }
        const b = await req.json();
        const r = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: { "content-type": "application/json", "anthropic-version": "2023-06-01", "x-api-key": env.ANTHROPIC_KEY },
          body: JSON.stringify(b)
        });
        const data = await r.json();
        return new Response(JSON.stringify(data), { status: r.ok ? 200 : r.status, headers: CORS });
      } catch (e) {
        return new Response(JSON.stringify({ error: { message: e.message } }), { status: 500, headers: CORS });
      }
    }

    return env.ASSETS.fetch(req);
  }
};

function parseOFF(p) {
  const n = p.nutriments || {};
  const servingQty = parseFloat(p.serving_quantity) || 0;
  const scale = servingQty > 0 ? servingQty / 100 : 1;
  function get(base) {
    const keys = [base, base.replace("-","_"), base.replace("_","-")];
    for (const k of keys) { const sv = n[k+"_serving"]; if (sv != null && !isNaN(+sv) && +sv >= 0) return +sv; }
    for (const k of keys) { const v = n[k+"_100g"];    if (v  != null && !isNaN(+v)  && +v  >= 0) return +v * scale; }
    return 0;
  }
  let cals = get("energy-kcal");
  if (!cals) { const kj = get("energy"); if (kj > 0) cals = kj / 4.184; }
  const name = p.product_name_en || p.product_name || "";
  if (!name) return null;
  const m = (p.serving_size || "").match(/([\d.]+)\s*(g|ml|oz|lb|cup|tbsp|tsp|piece)?/i);
  return {
    name, brand: (p.brands || "").split(",")[0].trim(),
    calories: Math.round(cals),
    protein:  Math.round(get("proteins") * 10) / 10,
    carbs:    Math.round(get("carbohydrates") * 10) / 10,
    fat:      Math.round(get("fat") * 10) / 10,
    fiber:    Math.round(get("fiber") * 10) / 10,
    sodium:   Math.round(get("sodium") * 1000) / 1000,
    servingSize: m ? m[1] : "1",
    servingUnit: m ? (m[2] || "serving") : "serving",
  };
}

function parseUSDA(f) {
  if (!f || !f.description) return null;
  const nutr = (id) => {
    const hit = (f.foodNutrients || []).find(x =>
      x.nutrientId === id || x.nutrientId === String(id) || x.nutrientNumber === String(id));
    return hit ? (hit.value || 0) : 0;
  };
  let servingG = parseFloat(f.servingSize) || 0;
  const unit = (f.servingSizeUnit || "g").toLowerCase();
  if (unit === "oz") servingG *= 28.3495;
  else if (unit === "lb") servingG *= 453.592;
  const scale = servingG > 0 ? servingG / 100 : 1;
  const cal = (nutr(1008) || nutr(208)) * scale;
  if (!cal) return null;
  return {
    name:  f.description, brand: f.brandOwner || f.brandName || "",
    calories: Math.round(cal),
    protein:  Math.round((nutr(1003)||nutr(203)) * scale * 10) / 10,
    carbs:    Math.round((nutr(1005)||nutr(205)) * scale * 10) / 10,
    fat:      Math.round((nutr(1004)||nutr(204)) * scale * 10) / 10,
    fiber:    Math.round((nutr(1079)||nutr(291)) * scale * 10) / 10,
    sodium:   Math.round((nutr(1093)||nutr(307)) * scale) / 1000,
    servingSize: servingG > 0 ? String(Math.round(servingG)) : "1",
    servingUnit: (unit === "g" || unit === "ml") ? unit : "serving",
  };
}

async function usdaNameSearch(name, key, ua) {
  try {
    const r = await fetch(
      `https://api.nal.usda.gov/fdc/v1/foods/search?api_key=${key}&query=${encodeURIComponent(name)}&dataType=Branded,Foundation,SR%20Legacy&pageSize=3`,
      { headers: { "User-Agent": ua } }
    );
    if (!r.ok) return null;
    const d = await r.json();
    return parseUSDA((d.foods || [])[0] || {});
  } catch (_) { return null; }
}

export { worker_default as default };
