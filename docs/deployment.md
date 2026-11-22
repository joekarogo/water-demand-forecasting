# Deployment (Heroku)

## Architecture

One Heroku app, one HTTPS domain (`https://<app-name>.herokuapp.com`):

- A single **Basic** dyno runs `backend/index.js` (Express). It serves
  both the `/api/*` routes and the built React app (`frontend/build`) —
  see `backend/app.js`'s static-file/SPA-fallback handling, registered
  after every `/api` route and after the `/api` JSON 404 catch-all, so an
  unknown `/api/*` path still returns JSON 404 rather than the SPA's
  `index.html`.
- A **Heroku Postgres Essential-0** add-on provides the database.

The app is also served at the custom domain `https://waterdemand.me`
(and `https://www.waterdemand.me`), registered through Namecheap
(GitHub Student Developer Pack, free for one year from 22 Nov 2026) and
pointed at the Heroku app with an `ALIAS` record for `@` and a `CNAME`
for `www`. HTTPS on both is handled by Heroku Automated Certificate
Management. Both origins were added to the Google OAuth client's
Authorized JavaScript origins alongside the `herokuapp.com` one.

Combined cost is approximately **$12/month** (Basic dyno + Essential-0
Postgres), which fits inside the **$13/month GitHub Student Developer
Pack Heroku credit**, which lasts until approximately **October 2028**.
See "After the credit runs out" below for the plan once that ends.

The frontend and backend are built and released together as one
`heroku-postbuild` step (root `package.json`) — there is no separate
static-hosting step, and no second dyno.

## Config vars

Set these on the Heroku app (names only below — put the real values in
directly via the Heroku dashboard or `heroku config:set`, never in this
repo):

| Name | Purpose |
|---|---|
| `NODE_ENV` | Set to `production`. Switches on `trust proxy`, same-origin-only CORS, Heroku Postgres SSL, and the SPA-serving behaviour described above. |
| `GOOGLE_CLIENT_ID` | The backend's copy of the Google OAuth client id, used to verify sign-in tokens server-side. |
| `REACT_APP_GOOGLE_CLIENT_ID` | The frontend's copy of the **same** Google OAuth client id, baked into the build at `heroku-postbuild` time (Create React App only reads `REACT_APP_*` vars at build time, not at runtime). |

Also leave `REACT_APP_API_URL` **unset/empty** — with the frontend and
backend on the same origin in production, `frontend/src/api.js` already
defaults `API_BASE` to `''`, i.e. relative paths, which is exactly what's
needed here.

`DATABASE_URL` and `PORT` are **set automatically by Heroku** (by the
Postgres add-on and the dyno manager respectively) — do not set these
yourself.

## Google Cloud Console step

The Google OAuth client used for sign-in needs the deployed origin added
to its allow-list, or sign-in will fail with a redirect/origin-mismatch
error:

1. Google Cloud Console → APIs & Services → Credentials → the OAuth 2.0
   Client ID already used by this app.
2. Under **Authorized JavaScript origins**, add:
   `https://<app-name>.herokuapp.com`
3. Save. (No change to Authorized redirect URIs is needed — this app's
   Google sign-in uses the one-tap/token-based flow, not a redirect-based
   OAuth flow.)

## Copying the local database to Heroku

Done once, to seed the Heroku database with the same schema and data
already loaded locally. On Windows, give the **full path** to
PostgreSQL 17's `bin` folder for both commands, and use `pg_dump -f
<file>` rather than PowerShell's `>` redirection operator — `>` performs
text/newline translation that can corrupt a binary custom-format dump.

```powershell
# 1. Dump the local database (custom format).
& "C:\Program Files\PostgreSQL\17\bin\pg_dump.exe" -Fc -d water_demand_forecasting -f water_demand_forecasting.dump

# 2. Get the Heroku Postgres connection URL for this app.
heroku config:get DATABASE_URL -a <app-name>

# 3. Restore into it. --no-owner/--no-acl drop the local DB's role-ownership
#    and permission grants, which don't exist (and shouldn't be recreated)
#    on Heroku's managed Postgres.
& "C:\Program Files\PostgreSQL\17\bin\pg_restore.exe" --no-owner --no-acl -d "<DATABASE_URL from step 2>" water_demand_forecasting.dump
```

## Running future migrations against Heroku

Always take a Heroku-side backup immediately before running a migration
against the production database, even though it's already backed up
locally:

```powershell
heroku pg:backups:capture -a <app-name>
```

Then apply the migration itself — e.g., with the full path to `psql.exe`
and the Heroku `DATABASE_URL`:

```powershell
heroku config:get DATABASE_URL -a <app-name>
& "C:\Program Files\PostgreSQL\17\bin\psql.exe" "<DATABASE_URL>" -f database/schema/009_some_new_migration.sql
```

Run any loader scripts (`database/load_*.py`) the same way, pointed at
the Heroku `DATABASE_URL` via the same env vars those scripts already
read locally.

## Deploying from `main`

```bash
git push heroku main
```

This triggers `heroku-postbuild` (installs backend production
dependencies, installs frontend dependencies, builds the frontend), then
starts the dyno via the `Procfile`'s `web: node backend/index.js`.

**Buildpack note:** this repo also has a root `requirements.txt` (for the
offline `ml/` scripts — see "The model never trains on the server"
below). Heroku's buildpack auto-detection can see that file and pick the
Python buildpack instead of Node for the actual web app. Set the Node
buildpack explicitly so this doesn't happen:

```bash
heroku buildpacks:set heroku/nodejs -a <app-name>
```

(Check `heroku buildpacks -a <app-name>` after the first deploy if the
build log looks like it ran `pip install` instead of `npm`.)

## Rollback

```bash
heroku releases -a <app-name>      # list recent releases, newest first
heroku rollback -a <app-name>      # revert to the previous release
# or: heroku rollback v123 -a <app-name>   # revert to a specific release
```

A rollback reverts the **code** release only — it does not undo a
database migration or data change. If a release included a migration,
check whether the rolled-back code is still compatible with the
migrated schema before relying on rollback alone.

## Release record

Keep a running record of each production release/model update, e.g. in
this file or a linked log:

| Date | URL | Git commit | Heroku release | Model/forecast version | Verified by | Result |
|---|---|---|---|---|---|---|
| 1 Nov 2026 | https://water-demand-forecast-e93cc52b790c.herokuapp.com | `4f2e277` | v7 | forecast #23 | (pending) | (pending) |
| 22 Nov 2026 | https://waterdemand.me | (fill after merge to main) | (fill after deploy) | unchanged (ensemble) | (pending) | (pending) |
| | | | | | | |

## After the GitHub Students credit runs out (~October 2028)

Before the credit lapses, re-evaluate: downgrade to Heroku's Eco/cheaper
dyno and Postgres tiers if traffic is still low, move to a different free
or low-cost host (e.g. Render, Fly.io, Railway) using this same
single-app/one-origin architecture, or begin paying the standard Heroku
rate (~$12/month) directly if that remains the simplest option. Decide
based on actual usage and cost at the time, not speculatively now.

## The model never trains on the server

Consistent with how this app already works locally (see README.md,
"How It Works" and "Known Limitations"): Heroku only ever **serves** the
latest already-published forecast from the database. `ml/train_model.py`
and `ml/publish_forecast.py` are run **offline** (locally, or wherever
convenient) — never on the Heroku dyno — and their only interaction with
production is updating the `forecasts`/`forecast_results` tables that the
deployed app reads from. This keeps the dyno lightweight (no Python/
Prophet/cmdstan runtime needed on Heroku at all) and avoids retraining on
every request, which the app has never done.
