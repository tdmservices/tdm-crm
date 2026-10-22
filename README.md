# TDM CRM

One shared system for every prospect, deal and commission at TDM. If it is not in the CRM, it did not happen.

Built to the product brief of 19 October 2026 (Phase 1, sales core). Phase 2 payment schedules and Phase 3 automation are not in this build, but the data model already carries the fields they need.

## What is built

All three phases of the brief plus the "Later" items are implemented. Integrations that depend on third-party accounts (Calendly, Meta, Google Ads, SMTP, WhatsApp Cloud API, an IMAP mailbox, ChatFlow) are complete on the CRM side and switched on by entering the keys in Admin → Integrations.

### Phase 1, sales core

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

### Phase 2, money
- Payment schedule on every won deal: full upfront, milestones (percent or amount, must add up to the deal value) or monthly retainer terms (amount, billing day, start month, minimum length). Lines show Expected, Received or Overdue.
- Payments recorded against a schedule line; invoices generated from a line and auto-marked paid when the payment arrives
- Retainer months roll forward automatically; unpaid retainer and overdue payment alerts on Abdul's overview and as notifications
- Project cost (estimated then actual) for the profit split model with true-up

### Phase 3, automation
- Notification channels per user: web push (browser), email (SMTP), WhatsApp (Meta Cloud API). Every in-app notification fans out to the channels the user has on.
- Scheduled reminders: morning digest, end-of-day report reminder, overdue payment alerts, owner alerts (zero activity, follow-ups overdue > 2 days, project overdue)
- Email activity capture: agents BCC the CRM mailbox; sent mail is logged as "emailed", prospect replies become notes and move the stage to Replied
- Calendly webhook: bookings become meeting records credited to the owner; unknown invitees land in the Unassigned pool; cancellations become no-shows with a follow-up
- Meta Lead Ads and Google Ads lead-form webhooks create leads in the Unassigned pool with the ad set or campaign as the campaign tag
- Forecast report, and custom leaderboards on any metric the CRM counts

### Later
- Client portal: a per-deal link (no login) showing the payment schedule, received payments and sent invoices
- ChatFlow / WhatsApp conversation webhook: outbound messages logged as activities, inbound replies logged as notes and advancing the stage
- Proposals and invoices generated from the deal, numbered, printable to PDF, with status tracking
- Packaging for other agencies: agency name, logo, address, bank details, display currency and document prefixes in Admin → Integrations; local time zone via `TZ_OFFSET_HOURS`; one deployment per agency

### Commission rules as decided
- Owner keeps everything: no commission entry is ever created for an owner account. An agent sharing a deal with the Owner is paid as if alone.

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

Environment variables for the server: `PORT`, `JWT_SECRET`, `DB_PATH`, `FX_URL` (defaults to open.er-api.com, free, no key, covers PKR, AED and GBP), `TZ_OFFSET_HOURS` (default 5 for Pakistan).

Tests (end-to-end API scenarios covering the commission rules):

```bash
npm test
```

## Deploy for free

A CRM needs a server that keeps its database between restarts. Free tiers at Render, Koyeb and similar hosts wipe the disk on each deploy, and Fly and Railway now charge for storage, so the free path is a free virtual machine. Oracle Cloud's Always Free tier gives one permanently at no charge (a card is required at sign-up for identity checks but Always Free resources are never billed).

1. Sign up at https://cloud.oracle.com/free and create a VM: shape **VM.Standard.A1.Flex** (Always Free, pick 1 OCPU and 6 GB), image **Ubuntu 24.04**, and let it generate an SSH key. Note its public IP.
2. In the VM's subnet security list, add ingress rules for TCP ports 80 and 443 from 0.0.0.0/0.
3. Get a free hostname: at https://www.duckdns.org create a subdomain (for example `tdmcrm`) and point it at the VM's public IP.
4. SSH in (`ssh ubuntu@<ip>`) and run:
   ```bash
   curl -fsSL https://raw.githubusercontent.com/tdmservices/tdm-crm/main/deploy/setup-free-vm.sh | DOMAIN=tdmcrm.duckdns.org bash
   ```
   That installs Docker, builds the app, and starts it behind Caddy with a free HTTPS certificate. The CRM is at `https://tdmcrm.duckdns.org` a minute later. Data lives in a Docker volume on the VM.
5. Updates: `cd ~/tdm-crm && git pull && sudo docker compose up -d --build`.

Backups: the whole database is one file. `sudo docker cp $(sudo docker compose ps -q app):/data/tdm.db ~/tdm-backup.db` copies it out; a weekly cron doing that into Google Drive or a second machine is enough.

## Deploy (paid hosts)

The app is one container: API, web app and a SQLite file on a mounted volume. Any host that runs Docker with a persistent disk works. Two ready-made options:

**Fly.io** (cheapest, about $5/month, Singapore region is closest to Pakistan):

```bash
fly auth login
fly launch --copy-config --no-deploy      # accepts fly.toml, creates the app
fly volumes create tdm_data --size 1 --region sin
fly secrets set JWT_SECRET=$(openssl rand -hex 32)
fly deploy
```

The CRM is then at `https://tdm-crm.fly.dev` (or whatever app name you chose). Seed accounts are created automatically on first start.

**Render**: New → Blueprint → choose this repository. `render.yaml` sets up the service, disk and secret. The starter plan is needed for the persistent disk.

After deploying, log in as Abdul, change the seed passwords in Admin → Users, and create the real agent accounts.

## Android APK (sideloaded)

**Automatic (recommended):** GitHub Actions builds the APK on every push to `main` and attaches it to a GitHub Release. Set the repository variable `API_URL` (Settings → Secrets and variables → Actions → Variables) to the deployed address, for example `https://tdm-crm.fly.dev`, then run the "Android APK" workflow from the Actions tab or push a change. Download the `.apk` from the Releases page, send it to the team, and paste the release link into Admin → Settings as the APK download URL.

**Manual:**

The APK packages the web bundle and talks to the hosted API. Build on a machine with Android Studio or the Android SDK:

```bash
cd web
VITE_API_URL=https://crm.yourdomain.com npm run build   # bundle pointing at the hosted API
npx cap add android                                      # first time only
npx cap sync android
cd android && ./gradlew assembleRelease                  # or assembleDebug for a quick test build
```

The APK lands in `web/android/app/build/outputs/apk/`. Abdul sends it to the team. When a new build is released, bump `APP_VERSION` in `web/src/lib/api.ts`, then set `min_app_version` and `apk_download_url` in Admin → Settings; older installs are blocked at login with the download link.

## Switching on the integrations

All in Admin → Integrations (Owner only; the Manager sees them masked). Each card shows the exact URL to paste into the other service.

| Integration | What you need | Where it goes |
|---|---|---|
| Email alerts | SMTP host, port, user, password, from address (Gmail: an App Password) | SMTP card |
| WhatsApp alerts | Meta Cloud API access token and phone number ID | WhatsApp card; each user turns WhatsApp alerts on in their profile and enters their number |
| Push alerts | Nothing to configure; keys are generated on first start | Each user turns push on in their profile (browser only) |
| Calendly | Create a webhook subscription for invitee.created and invitee.canceled pointing at `/api/webhooks/calendly`; paste the signing key | Calendly card |
| Meta Lead Ads | App secret, a verify token you choose, and a page access token; subscribe the page to leadgen with callback `/api/webhooks/meta` | Meta card |
| Google Ads lead forms | Choose a key; set the webhook URL `/api/webhooks/google` and that key on the lead form extension | Google card |
| ChatFlow | Choose a key; have ChatFlow POST each message to `/api/webhooks/chatflow` with `{key, phone, direction, text, agent_email, timestamp, id}` | ChatFlow card |
| Email capture | An IMAP mailbox (host, user, password) that agents BCC on outreach | IMAP card |

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
