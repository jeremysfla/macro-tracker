// Body progress photos: image bytes live in R2 (BODY_PHOTOS), metadata in D1.
// Routed from worker.js for every /api/body/* request (session already resolved).

const JSON_HEADERS = { "content-type": "application/json", "access-control-allow-origin": "*" };
const POSES = ["front", "side", "back"];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const EST_TIMEOUT_MS = 180000;
const ANALYSIS_TIMEOUT_MS = 240000;

const EST_SCHEMA = {
  type: "object", additionalProperties: false,
  required: ["usable", "body_fat_pct", "range_low", "range_high", "confidence", "muscle_definition", "notes", "photo_tips"],
  properties: {
    usable: { type: "boolean" },
    body_fat_pct: { type: ["number", "null"] },
    range_low: { type: ["number", "null"] },
    range_high: { type: ["number", "null"] },
    confidence: { type: "string", enum: ["low", "medium", "high"] },
    muscle_definition: { type: "string" },
    notes: { type: "string" },
    photo_tips: { type: ["string", "null"] },
  },
};

const ANALYSIS_SCHEMA = {
  type: "object", additionalProperties: false,
  required: ["headline", "summary", "changes", "est_bf_change_pct", "comparability", "comparability_note", "next_steps"],
  properties: {
    headline: { type: "string" },
    summary: { type: "string" },
    changes: {
      type: "array",
      items: {
        type: "object", additionalProperties: false, required: ["area", "change", "observation"],
        properties: {
          area: { type: "string" },
          change: { type: "string", enum: ["improved", "similar", "regressed", "unclear"] },
          observation: { type: "string" },
        },
      },
    },
    est_bf_change_pct: { type: ["number", "null"] },
    comparability: { type: "string", enum: ["good", "fair", "poor"] },
    comparability_note: { type: "string" },
    next_steps: { type: "array", items: { type: "string" } },
  },
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: JSON_HEADERS });
}

function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToB64(buf) {
  const bytes = new Uint8Array(buf);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

async function claudeJson(env, body) {
  const headers = { "content-type": "application/json", "anthropic-version": "2023-06-01", "x-api-key": env.ANTHROPIC_KEY };
  if (body.model === "claude-opus-5") {
    headers["anthropic-beta"] = "server-side-fallback-2026-07-01";
    body.fallbacks = "default";
  }
  const r = await fetch("https://api.anthropic.com/v1/messages", { method: "POST", headers, body: JSON.stringify(body) });
  const data = await r.json();
  if (!r.ok) throw new Error(data?.error?.message || `Anthropic ${r.status}`);
  if (data.stop_reason === "refusal") throw new Error("The AI declined to analyze this photo");
  if (data.stop_reason === "max_tokens") throw new Error("The AI response was cut off — try again");
  const text = (data.content || []).filter(c => c.type === "text").map(c => c.text).join("");
  return JSON.parse(text);
}

function profileLine(profile) {
  const bits = [];
  if (profile?.gender) bits.push(`sex: ${profile.gender}`);
  if (profile?.age) bits.push(`age: ${profile.age}`);
  if (profile?.height_inches) bits.push(`height: ${profile.height_inches} in`);
  return bits.join(", ") || "no profile details";
}

async function runEstimate(env, userId, photoId, imageB64) {
  try {
    const row = await env.DB.prepare("SELECT pose, weight_lbs FROM body_photo WHERE user_id = ? AND id = ?").bind(userId, photoId).first();
    const profile = await env.DB.prepare("SELECT gender, age, height_inches FROM users WHERE id = ?").bind(userId).first();
    const about = [profileLine(profile), row?.weight_lbs ? `scale weight: ${row.weight_lbs} lbs` : "", `pose: ${row?.pose || "front"}`].filter(Boolean).join(", ");
    const est = await claudeJson(env, {
      model: "claude-sonnet-5",
      max_tokens: 2000,
      output_config: { format: { type: "json_schema", schema: EST_SCHEMA } },
      messages: [{
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: "image/jpeg", data: imageB64 } },
          {
            type: "text",
            text: `This is my own fitness progress photo from my personal training tracker. Estimate my body fat percentage visually, the way an experienced coach would from a physique photo.

About me — ${about}.

Base the estimate on visible cues: abdominal definition, oblique and serratus visibility, vascularity, fat storage at the waist, lower back and chest, muscle separation in the shoulders and arms, and overall leanness. Give one best-guess number plus a realistic low/high range. Visual estimates are approximate, so set confidence by how much of the torso is visible, the lighting, and the clothing.

If the photo cannot support an estimate (no person, torso covered by loose clothing, too dark or blurry), set usable to false, the numeric fields to null, and explain why in notes.

- muscle_definition: one short phrase, for example "visible upper abs, soft lower abdomen".
- notes: 2-3 plain sentences on what drove the estimate. Factual and encouraging, no medical claims.
- photo_tips: one sentence on how to make the next photo more comparable (lighting, distance, pose), or null if this one is already good.`,
          },
        ],
      }],
    });
    const bf = est.usable && Number.isFinite(est.body_fat_pct) ? Math.round(est.body_fat_pct * 10) / 10 : null;
    await env.DB.prepare("UPDATE body_photo SET est_status = 'done', est_bf_pct = ?, est_json = ? WHERE user_id = ? AND id = ?")
      .bind(bf, JSON.stringify(est), userId, photoId).run();
  } catch (e) {
    await env.DB.prepare("UPDATE body_photo SET est_status = 'error', est_json = ? WHERE user_id = ? AND id = ?")
      .bind(JSON.stringify({ error: String(e.message).slice(0, 300) }), userId, photoId).run().catch(() => {});
  }
}

async function runAnalysis(env, userId, analysisId, fromRow, toRow) {
  try {
    const [a, b] = await Promise.all([env.BODY_PHOTOS.get(fromRow.r2_key), env.BODY_PHOTOS.get(toRow.r2_key)]);
    if (!a || !b) throw new Error("photo file missing from storage");
    const aB64 = bytesToB64(await a.arrayBuffer());
    const bB64 = bytesToB64(await b.arrayBuffer());
    const profile = await env.DB.prepare("SELECT gender, age, height_inches, goal_weight FROM users WHERE id = ?").bind(userId).first();
    const describe = (r) => [
      `date ${r.date}`, `pose ${r.pose}`,
      r.weight_lbs ? `scale weight ${r.weight_lbs} lbs` : null,
      r.scale_bf_pct ? `smart-scale body fat ${r.scale_bf_pct}%` : null,
      r.est_bf_pct ? `earlier visual estimate ${r.est_bf_pct}%` : null,
    ].filter(Boolean).join(", ");
    const days = Math.round((new Date(toRow.date + "T12:00:00Z") - new Date(fromRow.date + "T12:00:00Z")) / 86400000);
    const result = await claudeJson(env, {
      model: "claude-opus-5",
      max_tokens: 6000,
      output_config: { format: { type: "json_schema", schema: ANALYSIS_SCHEMA } },
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "BEFORE photo — " + describe(fromRow) },
          { type: "image", source: { type: "base64", media_type: "image/jpeg", data: aB64 } },
          { type: "text", text: "AFTER photo — " + describe(toRow) },
          { type: "image", source: { type: "base64", media_type: "image/jpeg", data: bB64 } },
          {
            type: "text",
            text: `These are my own fitness progress photos from my personal training tracker, taken ${days} day${days === 1 ? "" : "s"} apart. About me — ${profileLine(profile)}${profile?.goal_weight ? `, goal weight ${profile.goal_weight} lbs` : ""}. I run a lot and I am working on body composition.

Compare BEFORE to AFTER like an honest, experienced physique coach.

- headline: one short line summing up the change.
- summary: 3-4 sentences. Say plainly what changed and what did not. If the photos are too close in time or too different in setup to show real change, say so rather than inventing differences.
- changes: one entry per area you can actually see (for example midsection, chest, shoulders, arms, back, legs, posture), each marked improved, similar, regressed or unclear, with a specific observation.
- est_bf_change_pct: your estimated change in body fat percentage points from BEFORE to AFTER (negative means leaner), or null if the photos cannot support one.
- comparability and comparability_note: how comparable the two photos are (lighting, distance, pose, clothing) and what to fix next time.
- next_steps: 2-4 concrete training or nutrition suggestions that follow from what you see and the numbers given.

Use the scale numbers to sanity-check what you see. Be direct and encouraging; no medical claims.`,
          },
        ],
      }],
    });
    await env.DB.prepare("UPDATE body_analysis SET status = 'done', result_json = ? WHERE user_id = ? AND id = ?")
      .bind(JSON.stringify(result), userId, analysisId).run();
  } catch (e) {
    await env.DB.prepare("UPDATE body_analysis SET status = 'error', error = ? WHERE user_id = ? AND id = ?")
      .bind(String(e.message).slice(0, 300), userId, analysisId).run().catch(() => {});
  }
}

const PHOTO_COLS = "id, date, pose, width, height, weight_lbs, scale_bf_pct, est_status, est_bf_pct, est_json, landmarks_json, align_json, created_at, est_started_at";

function parsePhotoRow(r) {
  const out = { ...r };
  for (const col of ["est_json", "landmarks_json", "align_json"]) {
    const key = col.replace("_json", "");
    try { out[key] = r[col] ? JSON.parse(r[col]) : null; } catch (_) { out[key] = null; }
    delete out[col];
  }
  // An estimate whose background task died should not show a spinner forever
  if (out.est_status === "pending" && Date.now() - (out.est_started_at || out.created_at) > EST_TIMEOUT_MS) {
    out.est_status = "error";
    out.est = { error: "The estimate did not finish" };
  }
  delete out.est_started_at;
  return out;
}

export async function handleBody(req, env, ctx, user, u) {
  if (!env.BODY_PHOTOS) return json({ ok: false, error: "photo storage not configured" }, 500);
  const db = env.DB;
  try {
    if (u.pathname === "/api/body/photo" && req.method === "POST") {
      const b = await req.json();
      const date = String(b.date || "");
      const pose = POSES.includes(b.pose) ? b.pose : "front";
      if (!DATE_RE.test(date)) return json({ ok: false, error: "bad date" }, 400);
      if (typeof b.image !== "string" || b.image.length < 1000 || b.image.length > 2800000) {
        return json({ ok: false, error: "image missing or too large" }, 400);
      }
      const bytes = b64ToBytes(b.image);
      if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return json({ ok: false, error: "image must be a JPEG" }, 400);

      const id = crypto.randomUUID();
      const key = `body/${user.id}/${id}.jpg`;
      await env.BODY_PHOTOS.put(key, bytes, { httpMetadata: { contentType: "image/jpeg" } });
      let thumbKey = null;
      if (typeof b.thumb === "string" && b.thumb.length > 200 && b.thumb.length < 200000) {
        thumbKey = `body/${user.id}/${id}.thumb.jpg`;
        await env.BODY_PHOTOS.put(thumbKey, b64ToBytes(b.thumb), { httpMetadata: { contentType: "image/jpeg" } });
      }

      const w = await db.prepare("SELECT weight_lbs FROM weight_log WHERE user_id = ? AND date <= ? ORDER BY date DESC LIMIT 1").bind(user.id, date).first();
      const wl = await db.prepare("SELECT weight_lbs, body_fat_pct FROM wellness WHERE user_id = ? AND date <= ? AND (weight_lbs IS NOT NULL OR body_fat_pct IS NOT NULL) ORDER BY date DESC LIMIT 1").bind(user.id, date).first();
      const landmarks = b.landmarks && typeof b.landmarks === "object" ? JSON.stringify(b.landmarks).slice(0, 4000) : null;
      const now = Date.now();
      await db.prepare(`INSERT INTO body_photo (user_id, id, date, pose, r2_key, thumb_key, width, height, weight_lbs, scale_bf_pct, landmarks_json, created_at, est_started_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(user.id, id, date, pose, key, thumbKey, Number(b.width) || null, Number(b.height) || null,
          w?.weight_lbs ?? wl?.weight_lbs ?? null, wl?.body_fat_pct ?? null, landmarks, now, now).run();
      if (env.ANTHROPIC_KEY && ctx?.waitUntil) ctx.waitUntil(runEstimate(env, user.id, id, b.image));
      return json({ ok: true, id });
    }

    if (u.pathname === "/api/body/photos" && req.method === "GET") {
      const rows = await db.prepare(`SELECT ${PHOTO_COLS} FROM body_photo WHERE user_id = ? AND deleted = 0 ORDER BY date ASC, created_at ASC`).bind(user.id).all();
      const photos = (rows.results || []).map(parsePhotoRow);
      const an = await db.prepare("SELECT id, from_id, to_id, status, result_json, error, created_at FROM body_analysis WHERE user_id = ? ORDER BY created_at DESC LIMIT 1").bind(user.id).first();
      let analysis = null;
      if (an) {
        analysis = { id: an.id, from_id: an.from_id, to_id: an.to_id, status: an.status, error: an.error, created_at: an.created_at, result: null };
        try { if (an.result_json) analysis.result = JSON.parse(an.result_json); } catch (_) {}
        if (an.status === "running" && Date.now() - an.created_at > ANALYSIS_TIMEOUT_MS) {
          analysis.status = "error";
          analysis.error = "The analysis did not finish";
        }
      }
      return json({ ok: true, photos, analysis });
    }

    if (u.pathname === "/api/body/img" && req.method === "GET") {
      const row = await db.prepare("SELECT r2_key, thumb_key FROM body_photo WHERE user_id = ? AND id = ? AND deleted = 0").bind(user.id, u.searchParams.get("id") || "").first();
      if (!row) return json({ ok: false, error: "not found" }, 404);
      const obj = await env.BODY_PHOTOS.get((u.searchParams.get("t") && row.thumb_key) ? row.thumb_key : row.r2_key);
      if (!obj) return json({ ok: false, error: "file missing" }, 404);
      return new Response(obj.body, { headers: { "content-type": "image/jpeg", "cache-control": "private, max-age=31536000, immutable" } });
    }

    // Everything below acts on one existing photo (or two, for analyze)
    if (req.method !== "POST") return json({ ok: false, error: "unknown body route" }, 404);
    const b = await req.json();

    if (u.pathname === "/api/body/analyze") {
      const sel = "SELECT id, date, pose, r2_key, weight_lbs, scale_bf_pct, est_bf_pct FROM body_photo WHERE user_id = ? AND id = ? AND deleted = 0";
      const fromRow = await db.prepare(sel).bind(user.id, String(b.from_id || "")).first();
      const toRow = await db.prepare(sel).bind(user.id, String(b.to_id || "")).first();
      if (!fromRow || !toRow || fromRow.id === toRow.id) return json({ ok: false, error: "need two different photos" }, 400);
      const id = crypto.randomUUID();
      await db.prepare("INSERT INTO body_analysis (user_id, id, from_id, to_id, status, created_at) VALUES (?, ?, ?, ?, 'running', ?)")
        .bind(user.id, id, fromRow.id, toRow.id, Date.now()).run();
      if (ctx?.waitUntil) ctx.waitUntil(runAnalysis(env, user.id, id, fromRow, toRow));
      return json({ ok: true, id });
    }

    const row = await db.prepare("SELECT id, r2_key, thumb_key FROM body_photo WHERE user_id = ? AND id = ? AND deleted = 0").bind(user.id, String(b.id || "")).first();
    if (!row) return json({ ok: false, error: "not found" }, 404);

    if (u.pathname === "/api/body/update") {
      if (b.align !== undefined) {
        const clamp = (v, lo, hi, d) => Number.isFinite(Number(v)) ? Math.min(hi, Math.max(lo, Number(v))) : d;
        const a = b.align || {};
        const align = b.align === null ? null : JSON.stringify({ zoom: clamp(a.zoom, 0.5, 2.5, 1), dx: clamp(a.dx, -60, 60, 0), dy: clamp(a.dy, -60, 60, 0) });
        await db.prepare("UPDATE body_photo SET align_json = ? WHERE user_id = ? AND id = ?").bind(align, user.id, row.id).run();
      }
      if (POSES.includes(b.pose)) await db.prepare("UPDATE body_photo SET pose = ? WHERE user_id = ? AND id = ?").bind(b.pose, user.id, row.id).run();
      if (DATE_RE.test(b.date || "")) await db.prepare("UPDATE body_photo SET date = ? WHERE user_id = ? AND id = ?").bind(b.date, user.id, row.id).run();
      return json({ ok: true });
    }

    if (u.pathname === "/api/body/delete") {
      await env.BODY_PHOTOS.delete([row.r2_key, row.thumb_key].filter(Boolean));
      await db.prepare("UPDATE body_photo SET deleted = 1 WHERE user_id = ? AND id = ?").bind(user.id, row.id).run();
      return json({ ok: true });
    }

    if (u.pathname === "/api/body/estimate") {
      const obj = await env.BODY_PHOTOS.get(row.r2_key);
      if (!obj) return json({ ok: false, error: "file missing" }, 404);
      const b64 = bytesToB64(await obj.arrayBuffer());
      await db.prepare("UPDATE body_photo SET est_status = 'pending', est_started_at = ? WHERE user_id = ? AND id = ?").bind(Date.now(), user.id, row.id).run();
      if (ctx?.waitUntil) ctx.waitUntil(runEstimate(env, user.id, row.id, b64));
      return json({ ok: true });
    }

    return json({ ok: false, error: "unknown body route" }, 404);
  } catch (e) {
    return json({ ok: false, error: String(e.message).slice(0, 300) }, 500);
  }
}
