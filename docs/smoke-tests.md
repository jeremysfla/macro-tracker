# Smoke tests — run after every deploy

Tier 1 + Tier 2 happy paths. ~10 minutes on a phone plus a couple of curl
checks. Everything session-gated needs you signed in.

## Auth & shell
- [ ] Open the app → lands on Today without a login prompt (session persists)
- [ ] `curl https://macro.jeremy-39c.workers.dev/api/status` → `{"ok":true}` (no key info anonymously)
- [ ] Kill network, reopen app → loads in cached mode, no logout

## Tier 1
- [ ] **Sync (1):** log a food entry on the phone → appears on the laptop after reload (≤5s)
- [ ] **Sync (1):** delete an entry on one device → gone on the other after its next boot
- [ ] **Voice (2):** 🎤 → "two eggs and toast" → confirm sheet with 2 items → edit a number → log
- [ ] **Photo (2):** 🤖 Photo → snap a meal → macros appear → log
- [ ] **Load (3):** Workout tab → CTL/ATL/TSB card shows numbers + sparkline
- [ ] **Fueling (4):** with a ≥75-min planned session tomorrow, after 4pm the food screen shows the +carbs banner; dismiss sticks for the day
- [ ] **Trends (5):** History → 📈 Trends → five insight charts render; weekly AI summary paragraph shows

## Tier 2
- [ ] **Coach (6):** greeting tile shows 🎯 Coach with ≥2 cited numbers and a verdict chip; long-press regenerates
- [ ] **Backups (7):** Settings → Backups dot is 🟢 (<36h); "Back up now" completes with a row count toast
- [ ] **Favorites (8):** ⚡ Quick add chips render on the food card; tap logs instantly; long-press opens edit sheet with 📌 pin
- [ ] **Copy (8):** food screen button reads "Copy yesterday's <meal>"; preview sheet lets you uncheck items
- [ ] **PWA (9):** app installed to home screen opens standalone; a deploy causes an "Update ready" toast on next open
- [ ] **Push (9):** Settings → Notifications → toggle on → permission prompt → "Send test notification" arrives
- [ ] **TP lifecycle (10):** Settings TP tile shows "Token refreshed <recent>"; if expired, amber banners on Workout tab + greeting link to Settings

## Server spot-checks (curl with a Bearer session token)
```bash
B=https://macro.jeremy-39c.workers.dev
curl -H "$AUTH" $B/api/training/load?days=7      # rows for the last week
curl -H "$AUTH" $B/api/trends?days=30            # weights/food/load arrays
curl -H "$AUTH" $B/api/log/favorites             # ok:true with favorites
curl -H "$AUTH" $B/api/backup/status             # last < 36h ago
curl -H "$AUTH" $B/api/tp/status                 # status: active
curl -X POST -H "$AUTH" $B/api/push/test         # sent ≥ 1 if subscribed
```

## Cron expectations (next morning)
- 06:00 UTC — TP token silently refreshed (`last_refreshed_at` is today)
- 08:00 UTC — training_load has today's row
- 08:15 UTC — new `backups/<today>/manifest.json` in R2; Settings dot green
- Reminders — morning weigh-in push at 7:00 local if enabled
