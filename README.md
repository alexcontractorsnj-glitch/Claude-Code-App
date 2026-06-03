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
server.mjs              # zero-dependency static host + REST API + file persistence
src/
  css/styles.css        # dark "control-room" theme
  js/
    seed.js             # shared domain core: model, seed, date math, task rules,
                        #   normalizeState migration (imported by browser AND server)
    evm.js              # pure earned-value math (PV/EV/AC, CPI/SPI, EAC, S-curve)
    data.js             # browser store: selectors, mutations, optimistic locking,
                        #   live polling, conflict handling, CPM critical-path
    utils.js            # tiny DOM/format helpers (no framework, deliberately)
    app.js              # controller: router, filters, KPIs, task editor, toasts
    views/
      gantt.js          # time-scaled bars, SVG dep arrows, today line, drag-resize
      board.js          # drag-and-drop Kanban
      calendar.js       # month grid with spans + milestones
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

- Resource leveling / crew over-allocation warnings
- Baseline vs. actual variance tracking (save a baseline, chart drift)
- Auth + per-user attribution on edits (who changed what, when)

**Done recently:** ✅ drag-to-reschedule on the Gantt (move + edge-resize) ·
✅ server-side persistence via REST API behind the same store interface ·
✅ multi-user concurrency (ETag/If-Match optimistic locking + live polling) ·
✅ earned-value (CPI/SPI) cost reporting with S-curve.
