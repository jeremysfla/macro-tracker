# Restoring from R2 backups

Nightly backups run at 08:15 UTC and write newline-delimited JSON per table to
the `macro-tracker-backups` R2 bucket, at `backups/{YYYY-MM-DD}/{table}.ndjson` (always pass `--remote` to wrangler r2 commands — without it wrangler reads a local simulation)
plus a `manifest.json` with row counts and SHA-256 checksums. Retention:
daily for 30 days, Mondays for ~12 weeks, 1st-of-month for ~12 months.

There is intentionally **no restore UI** — restores are rare, dangerous, and
better done deliberately from a terminal.

## 1. Inspect what's available

```bash
npx wrangler r2 object get macro-tracker-backups/backups/2026-07-08/manifest.json --pipe --remote
```

Check `tables.<name>.rows` and `sha256` before trusting a file.

## 2. Download the table dump

```bash
npx wrangler r2 object get macro-tracker-backups/backups/2026-07-08/food_log.ndjson \
  --file food_log.ndjson --remote
shasum -a 256 food_log.ndjson   # compare to manifest
```

## 3. Convert NDJSON → INSERT statements

Each line is one row as JSON, column names matching the table. Example for
`food_log` (adjust column list per table — see `migrations/` for schemas):

```bash
python3 - <<'EOF'
import json
cols = ["user_id","date","entry_id","payload_json","updated_at","deleted"]
def q(v):
    if v is None: return "NULL"
    if isinstance(v,(int,float)): return str(v)
    return "'" + str(v).replace("'","''") + "'"
with open("food_log.ndjson") as f, open("restore.sql","w") as out:
    for line in f:
        r = json.loads(line)
        out.write(f"INSERT OR REPLACE INTO food_log ({','.join(cols)}) VALUES ({','.join(q(r.get(c)) for c in cols)});\n")
EOF
```

## 4. (Optional) wipe the damaged rows first

Only if you're replacing the whole table:

```bash
npx wrangler d1 execute macro-tracker-db --remote \
  --command "DELETE FROM food_log WHERE user_id='<your-user-id>'"
```

## 5. Apply

```bash
npx wrangler d1 execute macro-tracker-db --remote --file restore.sql
```

## 6. Verify

```bash
npx wrangler d1 execute macro-tracker-db --remote \
  --command "SELECT COUNT(*) FROM food_log"
```

Compare against the manifest row count. Then open the app and spot-check the
affected dates.

## Notes

- Always restore with `INSERT OR REPLACE` so re-runs are idempotent.
- `sessions` and `tp_auth` contain secrets — treat downloaded dumps as
  sensitive and delete them after the restore.
- A manual backup can be triggered any time from Settings → "Back up now",
  or `POST /api/backup/run` with a valid session. Do this **before** every
  schema migration.
