# TDM CRM

One shared system for every prospect, deal and commission at TDM. If it is not in the CRM, it did not happen.

Built to the product brief of 19 October 2026 (Phase 1, sales core). Phase 2 payment schedules and Phase 3 automation are not in this build, but the data model already carries the fields they need.

## What is in Phase 1

- Users and roles (Owner, Manager, Sales agent) with a per-person commission model and rate
- Prospect pipeline with fixed stages, required fields per stage, duplicate detection on email, phone and website domain, partner requests and 15/15 shared deals, Unassigned pool for imported and inbound leads
- Meetings as their own records (logged by Abdul or Adnan, credited to the owner), Held / No-show / Rebooked
- Automatic follow-ups at day 3, 7 and 14, Cold flag after day 14, proposal chase after 5 days
- Today view per agent, Abdul's team overview, end-of-day report, daily minimum of outreach activities
- Tasks with completion notes, blocked reasons and recurrence
- Simple payment-received entry per deal (Abdul or Adnan), commission engine (profit split with per-payment cost apportionment and true-up, revenue share, retainer 30% then 10%, dedicated resource as retainer, shared deals 15/15 and 5/5), Payable / Paid / Reversed, clawback with carry-forward, frozen entries on reassignment
- Targets with weekly and monthly clocks, automatic bonuses, history
- Meetings and Commission leaderboards (PKR display), excluded bonuses, top-three badges
- Reports: pipeline, funnel, revenue, forecast, team, delivery, lost, campaigns, activity, CSV export
- Sheet import with duplicate flagging, bulk reassignment screen
- WhatsApp / call / email click-to-chat logged as activities
- Offline entry with device timestamps and an outbox that syncs when back online
- USD conversion from a daily rate service with last-known fallback (flagged, final), USD frozen on every entry
- Sideloaded APK version gate (minimum version and download link set in Settings)

## Layout

```
server/   Express + SQLite API (TypeScript). All business rules live here.
web/      React web app (agents and Abdul). Also the bundle packaged into the Android APK.
```

## Run it

```bash
npm install
npm run seed          # creates Abdul, Adnan, Haider, Hassaan, Noman (password: Password123!)
npm run dev           # API on :4000, web on :5173 (proxying /api)
```

Production (one process serves API and web):

```bash
npm run build
PORT=4000 JWT_SECRET=change-me DB_PATH=/var/tdm/tdm.db npm start
```

Environment variables for the server: `PORT`, `JWT_SECRET`, `DB_PATH`, `FX_URL` (defaults to open.er-api.com, free, no key, covers PKR, AED and GBP).

Tests (end-to-end API scenarios covering the commission rules):

```bash
npm test
```

## Android APK (sideloaded)

The APK packages the web bundle and talks to the hosted API. Build on a machine with Android Studio or the Android SDK:

```bash
cd web
VITE_API_URL=https://crm.yourdomain.com npm run build   # bundle pointing at the hosted API
npx cap add android                                      # first time only
npx cap sync android
cd android && ./gradlew assembleRelease                  # or assembleDebug for a quick test build
```

The APK lands in `web/android/app/build/outputs/apk/`. Abdul sends it to the team. When a new build is released, bump `APP_VERSION` in `web/src/lib/api.ts`, then set `min_app_version` and `apk_download_url` in Admin → Settings; older installs are blocked at login with the download link.

## Day boundaries and money

All day boundaries (today view, end-of-day report, daily minimums, weekly and monthly targets) use Pakistan time. Rates are fetched daily; the USD amount is frozen on every deal value, payment and commission entry when it is created. A later rate change never moves past entries. If the rate service is unavailable the last fetched rate is used and the entry is flagged for Abdul's information only. The live rate is used only to display PKR on the leaderboards.

## Seed logins

| Who | Email | Role | Model |
|---|---|---|---|
| Abdul | abdul@tdm.services | Owner | Revenue share |
| Adnan | adnan@tdm.services | Manager | Revenue share |
| Haider | haider@tdm.services | Agent | Revenue share 30% |
| Hassaan | hassaan@tdm.services | Agent | Profit split 50/50 |
| Noman | noman@tdm.services | Agent | Revenue share 30% |

Password for all seed accounts: `Password123!`. Change them from Admin → Users after first login.
