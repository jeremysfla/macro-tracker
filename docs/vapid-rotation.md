# VAPID key rotation

Web push uses a VAPID P-256 keypair: the **private key** lives in the
Cloudflare secret `VAPID_PRIVATE_JWK` (JWK JSON), the **public key** in the
`VAPID_PUBLIC_KEY` var in `wrangler.toml` (base64url, uncompressed point).

Rotating the keypair invalidates every existing push subscription — each
device must re-subscribe (toggle push off/on in Settings → Notifications).

## Procedure

1. Generate a new pair:

```bash
node -e "
const crypto = require('crypto');
const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
const jwk = privateKey.export({ format: 'jwk' });
const pub = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]);
require('fs').writeFileSync('vapid-private.jwk', JSON.stringify(jwk));
console.log('PUBLIC:', pub.toString('base64url'));
"
```

2. Store the private key as a secret (never commit it):

```bash
cat vapid-private.jwk | npx wrangler secret put VAPID_PRIVATE_JWK
rm vapid-private.jwk
```

3. Replace `VAPID_PUBLIC_KEY` in `wrangler.toml` with the printed PUBLIC value.

4. Clear dead subscriptions (they're signed for the old key):

```bash
npx wrangler d1 execute macro-tracker-db --remote --command "DELETE FROM push_subscription"
```

5. `npx wrangler deploy`, then on each device: Settings → Notifications →
   toggle push off and back on.

## Notes

- The server sends **empty** pushes (no encrypted payload); the service
  worker fetches the actual message from `/api/push/pending` using the
  session cookie. VAPID only authenticates the sender, so rotation never
  risks message contents.
- If pushes silently stop after rotation, check for 403 responses from the
  push endpoints — that means a device is still subscribed with the old key.
