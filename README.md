# BuildFlow — ERP Construction Schedule Module

A scheduling system for the ERP of a large construction company. Built to plan,
sequence, and track field work across multiple projects, crews, and trades.

> **Design call (the brief left the views up to me): ship all three.**
> Construction scheduling genuinely needs each one — they're different lenses on
> the *same* data, not redundant. Edit a task in any view and the others update.

| View | Why it's here |
|------|---------------|
| **▦ Gantt** | The schedule backbone. Time-scaled bars, finish-to-start dependency arrows, a live **Critical Path** overlay (CPM forward/backward pass), per-task % complete, milestones (◆), weekend bands, and a "today" line. This is how a PM sees float and what's driving the end date. |
| **▤ Board** | Kanban by status (Not Started → In Progress → Blocked → Done). **Drag a card** between columns to update status in the field. This is the daily-standup / superintendent view. |
| **▣ Calendar** | Month grid with task spans and milestone/inspection markers. This is the crew-dispatch and "what's happening this week" view. |
| **☷ Resources** | Resource-leveling view — one row per crew, their tasks lane-packed so over-allocation is visible, with double-booked tasks ringed in red. This is the "who's overcommitted" view. |
| **▥ Cost / EVM** | Earned-Value dashboard — BAC/PV/EV/AC, CPI & SPI, cost/schedule variances, and a forecast at completion (EAC/VAC), with a cost-performance S-curve and a per-project table. This is the controls/finance view. |
| **＄ Billing** | Schedule of Values & progress billing — AIA G702/G703-style payment applications driven by each task's cost + % complete, with retainage, "from previous / this period", current payment due, application history, and CSV export. |
| **✉ Documents** | Submittal & RFI tracking — per-project logs with status workflows, ball-in-court / assignee, due dates, and a link to the related task. Overdue open items feed the alert center. |
| **☰ Field** | Daily field reports — weather, temperature, manpower, work performed, deliveries and delays, newest first. The site's daily log. |
| **✔ Punch** | Punch list & closeout — deficiency items with status (open → ready → accepted/rejected), priority, location, trade, assignee, and a closeout-readiness roll-up. |

## 📱 Corefield — the mobile field app

**Corefield** is the phone-first companion to BuildFlow for crews on-site. It's a
separate, installable **PWA** that talks to the *same* REST API and shares the
*same* domain core (`src/js/seed.js`) — so a superintendent's edit on the desktop
Gantt and a foreman's `% complete` bump from Corefield are the same data, live.

Open it at **`/mobile/`** (e.g. http://localhost:8000/mobile/) and sign in with
the same accounts. On a phone, "Add to Home Screen" installs it standalone.

| Tab | What a crew does |
|-----|------------------|
| **🪧 Work** | "My Work" — work packages bucketed **Overdue → In progress → Upcoming → Done**, with a progress ring and per-task trade/crew/due. Tap a task to bump **% complete** (thumb-friendly ±25% stepper + quick 0/25/50/75/100 chips) and flip **status** — status/​progress coherence matches the server. |
| **✔ Punch** | The punch list, sorted open-first, with a one-tap status change (open → ready → accepted/rejected) and a **+ Punch item** quick-add. |
| **📋 Reports** | The daily field log + a fast **+ Daily report** form (weather, temps, manpower, work performed, deliveries, delays). |
| **👷 Me** | Who you are, your role/scope, live connection + pending-sync status, sign-out, and a link back to the full desktop app. |

**Built for the field — works with no signal.** Corefield caches the last
schedule for instant/offline boot, and any change you make while disconnected is
queued in an **offline outbox** (persisted to LocalStorage) and **replayed in
order when you reconnect** — the app bar shows `Offline · N queued`, optimistic
edits are tagged `⟳ queued`, and a server-rejected op (conflict/permission) is
dropped with a notice so the queue can never wedge. A **service worker**
(`mobile/sw.js`) precaches the app shell (cache-first) and the schedule read
(network-first → cache), which is also what makes it installable. RBAC and
project scope are mirrored client-side and enforced server-side, exactly as on
desktop.

The field rules (task bucketing, the progress stepper, status coherence, and the
outbox reducers) live in pure, unit-tested **`src/mobile/core.js`** — no DOM, no
browser globals — so they ship in one place and are covered by `npm test`.

## 💬 Messages — team communication & monitoring

Built-in team messaging connects the office and the field, and gives PMs/admins a
**communication monitor** on the web. It's **server-persistent** (history,
search, audit, RBAC) — the deliberate Slack/Teams trade-off over consumer E2EE,
so oversight is actually possible. See
[`docs/messaging-research-and-plan.md`](docs/messaging-research-and-plan.md) for
the research (WhatsApp/Slack/Procore) behind the design.

- **One channel per project**, auto-provisioned. Posting to a project channel is
  gated by that project's write **scope** (server-enforced); **reads are
  portfolio-wide**, matching the rest of the app.
- **Desktop — Messages view (the monitor):** channel list with unread badges +
  last-message previews, the full conversation, `@mention` highlighting, a
  composer, **search across all messages**, and **CSV export** per channel. A
  scoped PM/viewer sees everything read-only where they can't post.
- **Corefield — 💬 Chat tab:** WhatsApp-style bubbles with delivery ticks, day
  separators, unread badges, and **offline send** (messages queue in the outbox
  and replay on reconnect, just like every other field write).
- **🎤 Voice notes + dictation:** record a voice note in either app (MediaRecorder
  → uploaded to `POST /api/voice`, streamed back from `GET /api/voice/:id` so
  audio never bloats the polled state; capped ~45s, demo mode embeds it locally),
  or tap the 🎙 mic to **dictate** a message via on-device speech-to-text.
- **Shared, tested core** (`src/js/messaging.js`): channels, messages, unread
  counts, `@mention` parsing, search, and a per-channel **cap** (last 200) that
  keeps the zero-DB JSON store bounded. Every send is **audited**
  (`message.send`) and attributed to the session user.

| Method & path | Action |
|---|---|
| `POST /api/messages` | send `{channelId, body}` (write + project scope) |
| `POST /api/channels/:id/read` | set your read marker (any signed-in user) |

Messages ride the existing `/api/state` + ETag polling for live delivery (a
push **SSE** stream is the documented next step). On the static GitHub Pages
demo, chat runs in local mode on the seeded channels.

## 🤖 AI Dispatcher

The **Dispatcher** is an AI agent that watches the field and acts on it. It posts
as a participant in the team channels (purple 🤖 bubbles), so crews and PMs
interact with it right where they already talk.

- **Proactive monitoring:** scans the schedule + deliveries and posts **new**
  findings into the relevant project channel — late/at-risk **deliveries**,
  overdue & blocked tasks, slipping **milestones**, overdue RFIs, high-priority
  punch items. It dedupes (never repeats a finding) and runs on a timer, or on
  demand via **⚡ Scan now** in the Deliveries view (`POST /api/dispatcher/scan`).
- **Conversational + action-taking:** `@dispatcher` in any channel and it
  replies. With a Claude API key it runs a **tool-use agent** that can read
  status and take **real, audited actions** — reschedule a task, change a task
  status, update a delivery, or open a punch item — attributed to the dispatcher
  on behalf of the asker.
- **Deliveries** are a first-class entity (`src/js/deliveries.js`): item,
  supplier, due date, status, and the task they feed. Managed from the
  **🚚 Deliveries** view; the dispatcher's late/due-soon logic runs off them.

**Wiring the key (optional but recommended):** copy `.env.example` to `.env` and
set `ANTHROPIC_API_KEY` (the server auto-loads `.env`, which is gitignored).
**Without a key the dispatcher still works** — it falls back to a deterministic
rule-based field digest (and tells you the AI is offline). `DISPATCHER_MODEL`
overrides the model. The brain is pure + tested (`src/js/dispatcher.js`); the
server (`server.mjs`) owns the side-effects (posting, tool execution, the Claude
Messages-API loop).

> Like the rest of the app, the dispatcher needs the Node server — it's off on
> the static GitHub Pages demo (no server, no key).

## Run it

No build step, no `npm install` — pure ES modules + a zero-dependency Node server.

```bash
# Recommended: static host + REST API (server-backed persistence)
npm start            # → http://localhost:8000

# Or any static server (no API → the app runs on LocalStorage only)
python3 -m http.server 8000
```

Then open **http://localhost:8000**. (Open via a server, not `file://`, so ES
module imports resolve.)

The footer shows a live pill: **Synced to server** when the REST API is reachable,
**Local cache** otherwise.

## Tests

Zero-dependency, so the suite runs on stock Node:

```bash
npm run lint     # node --check across every module
npm test         # pure-logic unit tests + a live API/RBAC integration run
```

`test/units.mjs` covers the pure logic (CPM, EVM, variance, leveling + auto-level,
billing G702/G703, documents, change orders, field reports, punch, alerts);
`test/api.mjs` boots `server.mjs` on a test port and checks auth, optimistic
locking, project scope, and CRUD over HTTP. A **SessionStart hook**
(`.claude/hooks/session-start.sh`) makes these ready in Claude Code on the web.

## Persistence — server-backed, with offline fallback

`npm start` runs `server.mjs`, which serves the static app **and** a small REST
API that persists schedule state to `data/schedule.json`. The browser store
hydrates from the API on load and writes changes back optimistically; if the API
isn't there (e.g. you opened it through a plain static server), it transparently
falls back to **LocalStorage** with the identical interface — no code path in the
views changes.

| Method & path | Action |
|---|---|
| `GET /api/state` | full schedule `{ projects, crews, tasks }` |
| `POST /api/tasks` | create a work package |
| `PATCH /api/tasks/:id` | update (progress/status coherence applied server-side) |
| `DELETE /api/tasks/:id` | delete + strip dangling dependency refs |
| `POST /api/reset` | reseed the sample data |
| `POST /api/baseline` | capture a new baseline (becomes active) |
| `POST /api/baseline/:id/activate` | switch the active baseline (`/none` = off) |
| `DELETE /api/baseline/:id` | delete a baseline from history |
| `POST /api/auth/login` · `POST /api/auth/logout` · `GET /api/auth/me` | session auth |
| `GET/POST /api/users`, `PATCH/DELETE /api/users/:username` | admin user management (role + project scope) |
| `GET /api/audit` | activity log, newest first (`?all=1` for the full log; write role) |
| `GET /api/tasks/:id/history` | full audit trail for one task (read) |
| `POST /api/billing`, `DELETE /api/billing/:id` | generate / delete a payment application |
| `POST/PATCH/DELETE /api/docs/:id?` | submittal & RFI CRUD |
| `POST/PATCH/DELETE /api/changeorders/:id?` | change-order CRUD (approved → billing) |
| `POST/PATCH/DELETE /api/reports/:id?` | daily field report CRUD |
| `POST/PATCH/DELETE /api/punch/:id?` | punch-list item CRUD |

All `/api` routes except `auth/*` require a valid session; writes require `pm`+,
task writes are checked against the caller's **project scope**, baselines need
unrestricted access, and `reset`/`users` require `admin`.

The domain core (seed data, date math, `makeTask`, `applyTaskPatch`) lives in
**`src/js/seed.js`** and is imported by *both* the browser and the server, so the
business rules exist in exactly one place.

### Multi-user concurrency (optimistic locking + live sync)

The API is safe for two people editing at once:

- Every task carries a `rev`; the whole state carries a global `rev` surfaced as
  an **`ETag`**.
- `PATCH` sends **`If-Match: "<task rev>"`**. If someone else changed the task
  first, the server returns **`409 Conflict`** with the current task — the client
  then reloads the latest and shows a toast instead of silently clobbering.
- The browser **polls `GET /api/state` with `If-None-Match`** every few seconds;
  the server answers **`304 Not Modified`** when nothing changed, or sends the new
  state when another user edits — so a change in one tab appears in another within
  the poll interval. Open the app in two browser windows to see it.

### Baseline vs. actual variance

Snapshot the current schedule as a **baseline** (the toolbar's *Save Baseline* /
*Re-baseline* / *Clear*), then the app measures slip against it:

- The Gantt draws a **ghost baseline bar** beneath each task (grey = on plan,
  red = finishing late, green = early); the bar's tooltip shows the day slip.
  Toggle it with the **Baseline** switch.
- The KPI bar swaps in **Behind Baseline** (task count) and **Avg Finish Slip**
  (days) once a baseline exists.
- The task dialog shows that task's baseline dates and finish variance.

The demo ships with a baseline already captured and a few work packages drifted,
so the variance is visible immediately.

**Baseline history** — you can keep **multiple** baselines (e.g. *Original Plan*,
*Rev B — after client changes*) and switch which one variance compares against
from the **Baselines** panel. Each row shows when/who saved it and how many tasks
were **re-planned versus the previous revision**, so you can see how the plan
itself evolved. `POST /api/baseline` captures a new one (and makes it active),
`POST /api/baseline/:id/activate` switches the active baseline (`/none` to turn
comparison off), and `DELETE /api/baseline/:id` removes one.

### Authentication & per-user permissions

When served by `server.mjs`, the app **requires sign-in** and enforces
**role-based access control**. (Served by a plain static host with no API, it
runs in single-user local mode with no login.)

**Demo accounts** (also shown on the login screen):

| Username | Password | Role | Can |
|----------|----------|------|-----|
| `admin` | `admin123` | admin | everything incl. reset, baselines + user management |
| `awhitfield` | `build123` | pm · **Riverside only** | edit tasks in their assigned project(s) |
| `psandoval` | `north123` | pm · **Northgate + Civic** | edit tasks in their assigned project(s) |
| `viewer` | `view123` | viewer | read-only |

How it works:

- **Passwords** are hashed with `scrypt` + a per-user random salt and compared in
  constant time (`crypto.timingSafeEqual`). Plaintext is never stored. Users live
  in `data/auth.json`, separate from the schedule.
- **Sessions**: login issues a crypto-random token stored server-side and set as
  an **`HttpOnly; SameSite=Strict`** cookie. Sessions expire after 12h; logout
  destroys them; changing a user's role revokes their existing sessions.
- **RBAC** is enforced **server-side** on every `/api` route: reads need a
  session, writes need `pm`+, and `reset`/user-management need `admin`
  (`401` unauthenticated, `403` forbidden). The UI mirrors this (hides New Task,
  baseline, reset, drag, etc. for read-only roles), but the server is the
  boundary — a viewer's edits are rejected even if the client is bypassed.
- **Attribution** is taken from the authenticated session, so it **can't be
  spoofed** by a header. Tasks show who last edited them; the conflict toast
  names them.
- **Login throttling**: 5 failed attempts per username triggers a 60-second
  lockout (`429`).
- **Admins** manage users (create / set role / delete, with last-admin
  protection) from the **Users** panel in the header.

> **Production note:** the session cookie omits the `Secure` flag because the
> demo runs over plain HTTP on localhost — behind HTTPS you'd add `Secure`.
> Sessions are in-memory (a restart logs everyone out); a real deployment would
> back them with a store like Redis.

### Project-scoped permissions

A PM can be **scoped to specific projects**. A pm with an empty project list is
unrestricted (all projects); a non-empty list limits their writes to those
projects only. Everyone can still *read* the whole portfolio.

- The server checks the task's `projectId` against the caller's scope on every
  task write (`403` outside scope), and **baselines require unrestricted access**
  (they're schedule-wide).
- The UI mirrors it per task: a scoped PM can drag / edit / create only in their
  projects; the editor's project picker is limited accordingly; out-of-scope
  tasks open read-only.
- Admins assign scope from the **Users** panel — click the project chips on a PM
  row (no chips selected = all projects). Changing scope revokes the user's
  sessions so it takes effect on next login.

### Activity log (audit)

Every successful change is recorded to an append-only **audit log**
(`data/audit.json`, capped to the latest 500) attributed to the session user:
task create/update/delete, baseline save/clear, schedule reset, and user
management. Open it from the **Activity** button in the header (pm+); it shows
who did what, to which task/project, and when. `GET /api/audit` returns the most
recent 200 entries (write role required).

Each task also has its own **history timeline**: open a task and click *Show
change history* (`GET /api/tasks/:id/history`, any authenticated user) to see
every recorded change to just that task, newest first.

The Activity panel is **filterable** (by action, user, project, free text) and
**exports to CSV** (the filtered rows). `GET /api/audit?all=1` returns the full
log (capped at 500) for export.

### Schedule of Values & progress billing

The **Billing** view turns the cost-loaded schedule into AIA-style **payment
applications**. Each task's scheduled value (its cost) and % complete produce a
**G703 continuation sheet** (scheduled value, from-previous, this-period,
completed-to-date, %, balance, retainage) and a **G702 summary** (completed &
stored, retainage, less previous certificates, **current payment due**). Generate
an application from current progress (retainage configurable), browse the
application history, and export the G703 to CSV. Generating/deleting is
project-scoped and audited; `POST/DELETE /api/billing`.

**Change orders** are managed from the Billing view: raise a CO (signed amount —
negative for credits — plus a schedule-impact in days), move it through
draft → pending → approved/rejected/void, and **approved COs roll into the G702**
as *net change by change order* → *contract sum to date*, adjusting the balance
to finish. `POST/PATCH/DELETE /api/changeorders`, project-scoped + audited.

### Daily field reports

The **Field** view is the site's daily log: weather + temperature, manpower,
work performed, deliveries, and delays — newest first, one card per day, create/
edit per project. `POST/PATCH/DELETE /api/reports`, project-scoped + audited.

### Punch list & closeout

The **Punch** view tracks deficiency items (open → ready-for-review →
accepted/rejected) with priority, location, trade, and assignee, plus a
**closeout-readiness** roll-up (% accepted, open/ready/rejected counts, blocking
items). High-priority open items feed the alert center.
`POST/PATCH/DELETE /api/punch`, project-scoped + audited.

### Attachments

Punch items and daily reports carry **attachments by reference** — name + URL +
caption (e.g. a link to a site photo or drawing), added in their editors.

> Honest scope: this stores attachment *links*, not uploaded binaries. Real photo
> upload needs a blob/object store (S3 or similar) the offline demo doesn't have;
> the model + UI are built so wiring an uploader later is a drop-in.

### Submittals & RFIs

The **Documents** view tracks **submittals** (draft → submitted → under-review →
approved/rejected) and **RFIs** (open → answered → closed) per project, each with
ball-in-court/assignee, a due date, free-text body + response, and an optional
link to the task it concerns. Create/edit/delete is project-scoped and audited
(`POST/PATCH/DELETE /api/docs`); **overdue open items surface in the alert
center** (overdue RFIs are flagged critical).

### Alerts (notification center)

The header **🔔 bell** shows a live count of schedule alerts derived from the
current plan, active baseline, and documents: **overdue** tasks/milestones,
**blocked** work, **milestones slipping** versus baseline, and **overdue
submittals/RFIs** — sorted by severity, each clicking through to the task or
document. Detection is pure and tested (`alerts.js`).

> Out of scope for this offline demo: pushing these alerts out over
> **email/webhook**. That's a thin server addition — a job that diffs the alert
> set and POSTs new ones to a configured endpoint — not something wired up here.

### Resource leveling

The **Resources** view lays each crew out on the timeline with their tasks
**lane-packed** — if a crew is assigned to overlapping tasks, the extra lanes
make the double-booking obvious and the conflicting bars are ringed in red. The
KPI bar shows a live **Crew Conflicts** count, and the task editor warns inline
when the crew + dates you pick collide with that crew's existing bookings
(across all projects). Detection is pure and tested (`leveling.js`); the seed
ships an intentionally unleveled schedule so conflicts show immediately.

**One-click auto-leveling**: the **⚖ Auto-level** button (Resources view,
unrestricted writers) runs a serial schedule-generation scheme — it walks tasks
in dependency order and gives each crew one job at a time, pushing tasks *later*
as needed (never earlier, dependencies preserved). It shows a **preview** of
every proposed shift (old → new dates, +days) before you apply; applying writes
the changes through the normal PATCH path (so concurrency, scope and the audit
log all still apply). Options refine the strategy live:

- **Protect critical path** — critical tasks keep crew priority so non-critical
  work absorbs the delay and the end date is protected.
- **Freeze started work** — done / in-progress tasks are pinned and others
  schedule around them.
- **Horizon** (7/14/30/60d / ∞) — caps how far crew-leveling pushes a task; the
  preview shows any conflicts that remain within the cap. (Dependencies always
  win over the horizon, so a chain can still compound past it.)

### Earned-Value Management (CPI/SPI)

Each task is **cost-loaded** (a `cost` = budget-at-completion and an `actualCost`
= money spent, both editable in the task dialog). The **Cost / EVM** view computes
standard EVM at today's data date:

```
PV  planned value   EV  earned value     AC  actual cost
CPI = EV/AC         SPI = EV/PV          CV = EV−AC   SV = EV−PV
EAC = BAC/CPI       ETC = EAC−AC         VAC = BAC−EAC
```

…and renders a cost-performance S-curve (planned-value curve + EV/AC markers at
today + EAC forecast) and a per-project earned-value table with a health verdict.

## What's in the box

- **3 sample projects** — a commercial complex, a logistics warehouse, and a
  civic renovation — seeded with realistic construction sequences (excavation →
  foundation → structure → framing → envelope → MEP → finishes → closeout).
- **8 trade crews** with leads, assignable per work package.
- **KPI deck**: overall progress, work-package counts, completed/blocked/overdue,
  critical-path size, and aggregate contract value.
- **Filters** by project and trade, applied across all three views.
- **Full task editor**: name, project, trade, crew, dates, status, progress,
  dependencies (multi-select), and milestone toggle. Create / edit / delete.
- **Drag-to-reschedule on the Gantt** — grab a bar to shift it in time, or drag
  either **edge** to change just the start or finish (snaps to whole days, with a
  live date readout). Milestones drag too. Releasing commits to the store, which
  recomputes the critical path and redraws dependency links.
- **Persistence** — server-backed via the REST API when available, with automatic
  LocalStorage fallback. "↺ Reset Demo" restores the seed.

## Architecture

```
index.html              # shell, loads fonts + the ES-module entry
server.mjs              # zero-dep static host + REST API + auth gate + persistence
auth.js                 # server-only: scrypt hashing, sessions, RBAC, project scope, throttling
src/
  css/styles.css        # dark "control-room" theme
  js/
    seed.js             # shared domain core: model, seed, date math, task rules,
                        #   normalizeState migration (imported by browser AND server)
    cpm.js              # pure critical-path method (shared by data + leveling)
    evm.js              # pure earned-value math (PV/EV/AC, CPI/SPI, EAC, S-curve)
    variance.js         # pure baseline variance + baseline-to-baseline compare
    leveling.js         # pure resource leveling: conflicts, lane packing, auto-level (+options)
    billing.js          # pure schedule-of-values / G702-G703 payment-application math
    changeorders.js     # pure change-order model + net-approved (feeds billing)
    fieldreports.js     # pure daily-field-report model
    punch.js            # pure punch-list/closeout model + attachment sanitizer
    docs.js             # pure submittal/RFI model: kinds, statuses, numbering, overdue
    alerts.js           # pure derived alerts (overdue / blocked / slip / overdue docs)
    data.js             # browser store: identity, mutations + attribution,
                        #   optimistic locking, live polling, baseline, CPM
    utils.js            # tiny DOM/format helpers (no framework, deliberately)
    app.js              # controller: router, filters, KPIs, task editor, toasts
    views/
      gantt.js          # time-scaled bars, SVG dep arrows, today line, drag-resize
      board.js          # drag-and-drop Kanban
      calendar.js       # month grid with spans + milestones
      resources.js      # crew timeline with lane-packing + conflict highlighting
      cost.js           # earned-value dashboard + S-curve + per-project table
      billing.js        # G702 summary + G703 sheet + change-order log + CSV
      documents.js      # submittal & RFI columns with status badges + due dates
      field.js          # daily field report cards
      punch.js          # punch list + closeout-readiness deck
  mobile/
    core.js             # pure, tested field core: task bucketing, progress
                        #   stepper, status coherence, offline-outbox reducers
mobile/                 # Corefield — installable PWA field app (served at /mobile/)
  index.html            # mobile shell (manifest + theme-color + module entry)
  app.js                # bottom-tab UI: Work / Punch / Reports / Me + sheets
  store.js              # mobile store: same REST API + offline outbox + polling
  styles.css            # phone-first dark theme (shared palette)
  sw.js                 # service worker — offline app shell + schedule cache
  manifest.webmanifest  # PWA manifest (standalone, icons)
  icon.svg              # app/home-screen icon
```

**Why vanilla JS / no framework?** One shared `store` (in `data.js`) holds all
state and notifies subscribers on change; each view is a pure
`render(mount, ctx)` function. That keeps the three views perfectly in sync with
zero framework weight and zero install friction — it runs anywhere a browser does.

The **Critical Path** is computed with a real CPM pass (topological sort →
forward pass for earliest start/finish → backward pass for latest → tasks with
zero total float are flagged), not hard-coded.

## Roadmap (next sprints)

- Email/webhook delivery for the alert center
- Real file/photo upload (blob store) behind the existing attachment model
- Push notifications to Corefield (today's work, new punch assigned to your crew)
- Database-backed persistence (replace the JSON files)

**Done recently:** ✅ **Team messaging** — per-project channels with a web
communication monitor (search + CSV export) and a Corefield Chat tab (bubbles,
ticks, offline send), server-persistent + audited · ✅ **Corefield mobile field
app** — installable PWA (Work / Punch / Reports), offline outbox with
replay-on-reconnect, on the shared API + domain core · ✅ drag-to-reschedule on
the Gantt (move + edge-resize) ·
✅ server-side persistence via REST API behind the same store interface ·
✅ multi-user concurrency (ETag/If-Match optimistic locking + live polling) ·
✅ earned-value (CPI/SPI) cost reporting with S-curve ·
✅ baseline vs. actual variance tracking ·
✅ authentication (scrypt + sessions) & role-based permissions ·
✅ project-scoped permissions + in-app audit log ·
✅ resource leveling + per-task history timeline ·
✅ one-click auto-leveling with options (critical-path protection, freeze, horizon) ·
✅ baseline history (multiple baselines, compare across revisions) ·
✅ filterable + CSV-exportable audit log + in-app alert center ·
✅ schedule of values / progress billing (G702/G703) + submittal & RFI tracking ·
✅ change-order management (approved COs flow into billing) + daily field reports ·
✅ punch list / closeout tracking + attachments (by reference).
