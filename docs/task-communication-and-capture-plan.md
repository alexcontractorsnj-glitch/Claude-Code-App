# Task-level communication & field capture — research + plan

> Goal: put communication (comments, voice notes, video calls) **and** field
> capture (photos, issue flags, constraints) **on the task itself**, the right
> way — without fragmenting the conversation away from the work item.

## 1. What the research says (verified)

A deep, multi-source pass (Fieldwire, Procore, Linear, Asana, ClickUp,
Microsoft Planner/Teams; 24 of 25 extracted claims survived 3-vote adversarial
verification) converged hard:

1. **The dominant model is a per-task discussion thread that lives ON the work
   item** — not a separate chat channel, and not messages merely "linked." Fieldwire
   posts messages "directly on the task to assignees/followers"; Linear and Asana
   put comments on the issue/task itself. *(Fieldwire, Linear, Asana — 3-0.)*
2. **Project chat and task comments are two distinct tiers.** Asana explicitly
   separates project **Messages** from per-**task comments**. Our app already mirrors
   this: per-project channels **+** the `message.linkedTo={kind,id}` hook.
3. **Best anti-fragmentation pattern = one conversation, two synced views.**
   ClickUp "Synced Threads" render the *same* thread in both Chat and the task
   (one source of truth), and auto-link any @mentioned task both directions —
   *not* a duplicated cross-post. Teams promotes a chat message into a task with a
   **bidirectional deep link** back to the message. *(ClickUp, Teams — 3-0.)*
4. **Notifications are scoped to the work item's participants** — assignee,
   creator, commenters, @mentioned (Fieldwire *watchers*, Linear *subscribers*,
   Asana *collaborators*, Procore role recipients) — **never broadcast to the whole
   project channel.** *(4 vendors — 3-0.)*
5. **@mention is the universal control surface:** it targets the notification
   *and* expands the item's audience (in Fieldwire it even sets the assignee).
6. **Attachments/photos are anchored to the work item but also aggregated at
   project level** — Fieldwire task photos also appear in a project Photos tab
   ("dual surfacing"). *(3-0.)*
7. **Anti-pattern to avoid (Microsoft Planner):** storing task comments *only* in
   the channel/group store causes notification gaps (assignee not auto-notified).
   **Lesson:** even with a filtered-view model, implement **first-class per-task
   subscription/@mention notifications** — don't inherit channel-only rules.
8. A **resolve** state on a task thread (Linear) gives the conversation an
   end-state, reducing pressure to re-litigate in the channel.

## 2. Recommended model for *our* app

**Each task gets a thread that is a filtered/synced view of its project channel —
NOT a separate channel.** The `linkedTo={kind:'task',id}` hook (already on every
message) is the join key. One message store, two views — exactly the ClickUp
Synced-Threads precedent, and it means **zero new message plumbing**.

- **Task Activity** = the messages where `linkedTo.kind==='task' && id===taskId`,
  merged with that task's capture items (below), newest-anchored.
- **Project channel** shows general chatter (no `linkedTo`) by default, with an
  **"include task threads"** toggle to see the synced superset — channel stays
  clean, nothing is hidden.
- **Bidirectional auto-link:** `@task` / a task chip in a channel message surfaces
  that message in the task's Activity; posting on a task can optionally "also post
  to channel" when broadly relevant.
- **Voice notes & "📞 Call about this task"** live inline on the task detail; each
  is just a normal message/voice/call **tagged `linkedTo` the task** → appears in
  Activity (and the synced channel view). Reuses the recorder + 1:1 WebRTC we built.
- **Watchers + scoped notifications:** add `task.watchers` (auto: assignee/crew
  lead, creator, anyone who comments or is @mentioned). The alert center (and
  future Web Push) notifies **watchers**, not the channel. The **AI dispatcher**
  posts task alerts as `linkedTo` messages → they land in Activity and ping
  watchers — no channel spam.
- **Resolve** toggle per task thread.

## 3. Field capture — the "dynamic" mechanism

Everything on the task is a **typed entry in one Activity feed**, so adding a kind
later is a config row, not a new screen:

| Entry | Model | Notes |
|---|---|---|
| 💬 Comment | `message` (linkedTo) | text + `@mentions` |
| 🎤 Voice note | `message.voice` (linkedTo) | existing recorder + `/api/voice` |
| 📷 **Photo** | `message.photo` → new capped media store | camera capture, client-compressed (~1280px JPEG), kept out of `/api/state`; **dual-surfaced** in a project Photos gallery |
| ⚠️ **Issue / flag** | thin `issues` entity (linkedTo task) | **lightweight + promotable** → one tap creates a **punch item or RFI**, with a back-link (your choice, confirmed) |
| ⛔ **Constraint** | `constraints` entity (linkedTo task) | **full Last-Planner** (your choice, confirmed) |
| 📞 Call | `message` of kind call (linkedTo) | "call about this task", pre-targeted |

### Constraints — modeled the Last-Planner way (verified)
A **constraint** is a prerequisite that must be cleared before a task can start.
The lean **constraint log** assigns *responsibility for removal* and a *promised
need-by date*; the make-ready process clears constraints ahead of execution, and
**"Tasks Made Ready" (TMR)** is the key metric. So:

```
constraint { id, taskId, projectId,
  type: 'material'|'info'|'labor'|'equipment'|'design'|'permit'|'prereq',
  description, responsibleParty, needBy(date), status: 'open'|'cleared',
  clearedBy, clearedAt, createdBy, createdAt }
```
- A task is **"made ready"** only when it has **no open constraints**.
- **The AI dispatcher watches open constraints exactly like deliveries** — flags
  any open constraint whose `needBy` is overdue or whose task starts soon, posting
  a `linkedTo` alert into the task thread. New KPI: **% Made Ready**.

### Issues — lightweight, promotable (verified pattern)
Quick field capture (title + severity + optional photo), one tap to **Promote →
Punch item / RFI** (matches the field→office "informal capture, formal record"
split Procore/Fieldwire use). The created punch/doc stores a back-link to the
issue and task.

## 4. UX

- **Desktop task editor** gains tabs: **Details · Activity · Constraints**.
  Activity = the merged feed + composer (text/voice/photo) + "Call about task" +
  Resolve. Constraints = the log with add/clear. A project **Photos** gallery and
  a **Constraints/Made-Ready** roll-up join the view switcher.
- **Corefield task sheet** gains a capture row: **💬 · 🎤 · 📷 · ⚠️ Flag · ⛔
  Constraint · 📞** and the task Activity feed — so a crew documents the work,
  flags a problem, or raises a blocker in two taps, offline-queued like everything
  else.
- **Dispatcher** posts task-scoped alerts (overdue, blocked, **open constraint at
  risk**) straight into the relevant task thread.

## 5. Phased build

- **Phase A — Activity backbone:** task Activity = filtered `linkedTo` view; post
  comment/voice from the task on both apps; task chip + bidirectional surfacing;
  watchers + scoped alert-center notifications; resolve state. *(Reuses ~everything;
  no new storage.)*
- **Phase B — Photos + Issues:** camera capture → capped media store (`message.photo`)
  + project Photos gallery; lightweight **issue** flag with **Promote → punch/RFI**.
- **Phase C — Constraints:** Last-Planner constraint log entity + UI + dispatcher
  monitoring + **% Made Ready** KPI.
- **Phase D — Calls + AI on the task:** "Call about this task" (pre-targeted,
  tagged `linkedTo`); when Claude is keyed, AI posts a call/voice summary back as a
  `linkedTo` message.

**Recommended start: Phase A** — it's the backbone every other piece hangs off,
and it's almost entirely reuse of the messaging + `linkedTo` foundation.

## 6. Honest limitations
- **Photos need storage.** The capped-base64 store (like voice) works with zero
  infra but isn't full-res archival; a real blob store (S3) is the drop-in for
  production. Server `/api/state` stays lean (media served by id).
- **Push notifications** to watchers are in-app/alert-center now; off-device Web
  Push is a later add (iOS 16.4+ for installed PWAs).
- The synced-view + linkedTo recommendation is a *synthesis* of the precedents
  (ClickUp/Teams/Fieldwire), not a single sourced spec — but it's the best-supported
  pattern and fits our data model exactly.

### Sources
Task communication & threading: [Fieldwire — Tasks](https://help.fieldwire.com/hc/en-us/articles/360003458332-Introduction-to-Tasks) · [Linear — Comments](https://linear.app/docs/comment-on-issues) · [Linear — Notifications](https://linear.app/docs/notifications) · [Asana — Communicating](https://help.asana.com/s/article/communicating-in-asana?language=en_US) · [ClickUp Chat (Synced Threads/SyncUps)](https://clickup.com/blog/clickup-chat/) · [Teams → Planner task from a message](https://techcommunity.microsoft.com/blog/plannerblog/create-trackable-tasks-from-your-ad-hoc-teams-messages/2443289) · [Procore — RFI notifications](https://support.procore.com/faq/when-does-the-rfis-tool-send-email-notifications) · [Microsoft Planner — comment storage (anti-pattern)](https://support.microsoft.com/en-us/office/comment-on-tasks-in-microsoft-planner-fd4aedde-7785-4cd0-96ee-122fbc9140e1)
Capture (constraints/observations): [Lean Construction Institute — Last Planner System](https://leanconstruction.org/lean-topics/last-planner-system/) · [What is the Last Planner System](https://leanconstructionblog.com/What-is-the-Last-Planner-System.html) · [Fieldwire vs Procore (field capture)](https://www.fieldwire.com/blog/fieldwire-vs-procore-comparison/)
