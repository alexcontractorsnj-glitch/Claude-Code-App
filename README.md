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

## Run it

No build step, no dependencies — pure ES modules.

```bash
# Option A: the bundled zero-dependency Node server
npm start            # → http://localhost:8000

# Option B: any static server
python3 -m http.server 8000
```

Then open **http://localhost:8000**. (Open via a server, not `file://`, so ES
module imports resolve.)

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
- **Local persistence** — everything is saved to your browser's LocalStorage, so
  it behaves like a real app between reloads. "↺ Reset Demo" restores the seed.

## Architecture

```
index.html              # shell, loads fonts + the ES-module entry
server.js               # ~40-line static server (no npm install needed)
src/
  css/styles.css        # dark "control-room" theme
  js/
    data.js             # single source of truth: model, store, CPM critical-path
    utils.js            # tiny DOM/format helpers (no framework, deliberately)
    app.js              # controller: router, filters, KPIs, task editor modal
    views/
      gantt.js          # time-scaled bars + SVG dependency arrows + today line
      board.js          # drag-and-drop Kanban
      calendar.js       # month grid with spans + milestones
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
- Baseline vs. actual variance tracking
- Drag-to-reschedule directly on the Gantt bars
- Server-side persistence + multi-user (REST API behind the same store interface)
- Cost loading per task → earned-value (CPI/SPI) reporting
