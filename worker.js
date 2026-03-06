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

    return env.ASSETS.fetch(req);
  }
}
