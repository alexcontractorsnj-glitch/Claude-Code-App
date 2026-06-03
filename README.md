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
| `GET /api/audit` | recent activity log (write role) |
| `GET /api/tasks/:id/history` | full audit trail for one task (read) |

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
```

**Why vanilla JS / no framework?** One shared `store` (in `data.js`) holds all
state and notifies subscribers on change; each view is a pure
`render(mount, ctx)` function. That keeps the three views perfectly in sync with
zero framework weight and zero install friction — it runs anywhere a browser does.

The **Critical Path** is computed with a real CPM pass (topological sort →
forward pass for earliest start/finish → backward pass for latest → tasks with
zero total float are flagged), not hard-coded.

## Roadmap (next sprints)

- Exportable audit log (CSV) + global activity filters
- Notifications (email/webhook) on milestone slips or blocked tasks
- Schedule-of-values / progress billing tied to earned value
- Mobile-friendly field view for crews

**Done recently:** ✅ drag-to-reschedule on the Gantt (move + edge-resize) ·
✅ server-side persistence via REST API behind the same store interface ·
✅ multi-user concurrency (ETag/If-Match optimistic locking + live polling) ·
✅ earned-value (CPI/SPI) cost reporting with S-curve ·
✅ baseline vs. actual variance tracking ·
✅ authentication (scrypt + sessions) & role-based permissions ·
✅ project-scoped permissions + in-app audit log ·
✅ resource leveling + per-task history timeline ·
✅ one-click auto-leveling with options (critical-path protection, freeze, horizon) ·
✅ baseline history (multiple baselines, compare across revisions).
