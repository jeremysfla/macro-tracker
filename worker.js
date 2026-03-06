const GOOGLE_CLIENT_ID = '480646952925-03r0p3jkdvfjdpnhlqbam4hnfjq0hp63.apps.googleusercontent.com';

async function verifyGoogleToken(idToken) {
  const res = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`);
  if (!res.ok) return null;
  const payload = await res.json();
  if (payload.aud !== GOOGLE_CLIENT_ID) return null;
  return payload;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' }
  });
}

function cors() {
  return new Response(null, {
    status: 204,
    headers: {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET,POST,PUT,OPTIONS',
      'access-control-allow-headers': 'content-type,authorization',
      'access-control-max-age': '86400'
    }
  });
}

async function getUser(db, idToken) {
  const payload = await verifyGoogleToken(idToken);
  if (!payload) return null;
  const row = await db.prepare('SELECT * FROM users WHERE id = ?').bind(payload.sub).first();
  return { payload, row };
}

export default {
  async fetch(req, env) {
    const u = new URL(req.url);

    if (req.method === 'OPTIONS') return cors();

    // Existing Claude API proxy
    if (u.pathname === '/api/claude' && req.method === 'POST') {
      try {
        const b = await req.json();
        const r = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: new Headers([
            ['content-type', 'application/json'],
            ['anthropic-version', '2023-06-01'],
            ['x-api-key', env.ANTHROPIC_KEY]
          ]),
          body: JSON.stringify(b)
        });
        const data = await r.json();
        return json(data);
      } catch (e) {
        return json({ error: { message: e.message } }, 500);
      }
    }

    // Auth: Google Sign-In → get or create user
    if (u.pathname === '/api/auth/google' && req.method === 'POST') {
      try {
        const { idToken } = await req.json();
        const payload = await verifyGoogleToken(idToken);
        if (!payload) return json({ error: 'Invalid token' }, 401);

        let user = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(payload.sub).first();

        if (!user) {
          await env.DB.prepare(
            'INSERT INTO users (id, email, name, picture) VALUES (?, ?, ?, ?)'
          ).bind(payload.sub, payload.email, payload.name || '', payload.picture || '').run();
          user = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(payload.sub).first();
        }

        return json({ user });
      } catch (e) {
        return json({ error: e.message }, 500);
      }
    }

    // Get user profile
    if (u.pathname === '/api/user' && req.method === 'GET') {
      const auth = req.headers.get('authorization')?.replace('Bearer ', '');
      if (!auth) return json({ error: 'No token' }, 401);
      const result = await getUser(env.DB, auth);
      if (!result) return json({ error: 'Invalid token' }, 401);
      return json({ user: result.row });
    }

    // Save onboarding / update profile
    if (u.pathname === '/api/user/profile' && req.method === 'PUT') {
      const auth = req.headers.get('authorization')?.replace('Bearer ', '');
      if (!auth) return json({ error: 'No token' }, 401);
      const result = await getUser(env.DB, auth);
      if (!result) return json({ error: 'Invalid token' }, 401);

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
        carbs, fat, result.payload.sub
      ).run();

      const user = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(result.payload.sub).first();
      return json({ user });
    }

    // ── USDA API proxy — keeps API key server-side ──
    if (u.pathname === '/api/usda/search' && req.method === 'GET') {
      try {
        const apiKey = env.USDA_API_KEY || 'DEMO_KEY';
        const query = u.searchParams.get('query') || '';
        const dataType = u.searchParams.get('dataType') || '';
        const pageSize = u.searchParams.get('pageSize') || '6';
        let usdaUrl = `https://api.nal.usda.gov/fdc/v1/foods/search?query=${encodeURIComponent(query)}&pageSize=${pageSize}&api_key=${apiKey}`;
        if (dataType) usdaUrl += `&dataType=${encodeURIComponent(dataType)}`;
        const r = await fetch(usdaUrl);
        const data = await r.json();
        return json(data, r.status);
      } catch (e) {
        return json({ error: e.message }, 500);
      }
    }

    // ── Garmin OAuth proxy — replaces third-party corsproxy.io ──
    if (u.pathname === '/api/garmin/proxy' && req.method === 'POST') {
      try {
        const { url, method: m, headers: h } = await req.json();
        // Only allow Garmin API URLs
        if (!url || !url.startsWith('https://connectapi.garmin.com/')) {
          return json({ error: 'Invalid Garmin URL' }, 400);
        }
        const r = await fetch(url, { method: m || 'POST', headers: h || {} });
        const text = await r.text();
        return new Response(text, {
          status: r.status,
          headers: { 'content-type': 'text/plain', 'access-control-allow-origin': '*' }
        });
      } catch (e) {
        return json({ error: e.message }, 500);
      }
    }

    // ── Strava server-side OAuth ──

    // Step 1: Redirect user to Strava authorization page
    if (u.pathname === '/api/strava/auth' && req.method === 'GET') {
      const clientId = env.STRAVA_CLIENT_ID;
      if (!clientId) return json({ error: 'Strava not configured on server' }, 500);
      const redirectUri = encodeURIComponent(`${u.origin}/api/strava/callback`);
      const scope = 'read,activity:read';
      const stravaUrl = `https://www.strava.com/oauth/authorize?client_id=${clientId}&redirect_uri=${redirectUri}&response_type=code&scope=${scope}&approval_prompt=auto`;
      return Response.redirect(stravaUrl, 302);
    }

    // Step 2: Strava redirects here with ?code=...
    if (u.pathname === '/api/strava/callback' && req.method === 'GET') {
      const code = u.searchParams.get('code');
      if (!code) {
        return new Response('<h2>Strava authorization denied</h2><script>setTimeout(()=>window.close(),2000)</script>', {
          headers: { 'content-type': 'text/html' }
        });
      }

      try {
        const tokenRes = await fetch('https://www.strava.com/oauth/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            client_id: env.STRAVA_CLIENT_ID,
            client_secret: env.STRAVA_CLIENT_SECRET,
            code,
            grant_type: 'authorization_code',
          })
        });
        const data = await tokenRes.json();
        if (!data.access_token) throw new Error(data.message || 'Token exchange failed');

        // Redirect back to app with token data in hash (not query string, so it stays client-side)
        const tokenPayload = encodeURIComponent(JSON.stringify({
          accessToken: data.access_token,
          refreshToken: data.refresh_token,
          expiresAt: data.expires_at,
          athlete: data.athlete,
        }));
        return Response.redirect(`${u.origin}/#strava_token=${tokenPayload}`, 302);
      } catch (e) {
        return new Response(`<h2>Strava connection failed</h2><p>${e.message}</p><script>setTimeout(()=>window.location='${u.origin}',3000)</script>`, {
          headers: { 'content-type': 'text/html' }
        });
      }
    }

    // Step 3: Client-side token refresh via server (keeps secret server-side)
    if (u.pathname === '/api/strava/refresh' && req.method === 'POST') {
      try {
        const { refreshToken } = await req.json();
        if (!refreshToken) return json({ error: 'Missing refreshToken' }, 400);

        const tokenRes = await fetch('https://www.strava.com/oauth/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            client_id: env.STRAVA_CLIENT_ID,
            client_secret: env.STRAVA_CLIENT_SECRET,
            refresh_token: refreshToken,
            grant_type: 'refresh_token',
          })
        });
        const data = await tokenRes.json();
        if (!data.access_token) return json({ error: data.message || 'Refresh failed' }, 400);

        return json({
          accessToken: data.access_token,
          refreshToken: data.refresh_token,
          expiresAt: data.expires_at,
        });
      } catch (e) {
        return json({ error: e.message }, 500);
      }
    }

    return env.ASSETS.fetch(req);
  }
}
