# In-app messaging for BuildFlow / Corefield — research & implementation plan

> Goal: add WhatsApp-style team communication to the construction app — crews on
> site, PMs in the office, subs in between. This document researches how the
> major messaging systems work, then proposes an implementation that fits this
> codebase (zero-dependency vanilla JS + a zero-dep Node server, REST + cookie
> sessions + RBAC + project scope, JSON persistence, optimistic store with
> ETag polling, an offline outbox, and a PWA).

## 1. How the reference apps actually work

| System | Transport | Storage / history | Encryption | Notable model |
|---|---|---|---|---|
| **WhatsApp** | One long-lived TLS socket per device; server stores undelivered msgs then **drops them after delivery**. Voice/video = WebRTC + TURN. | Minimal server history (device-local). Multi-device (≤4 companions) each with its own identity key. | **E2EE** via the **Signal Protocol** (X3DH key agreement + Double Ratchet; per-message keys, forward secrecy). Groups = server-side multicast loop. | "Queued → sent ✓ → delivered ✓✓ → read ✓✓(blue)" ticks; offline-first; phone is source of truth. |
| **Slack** | **WebSocket** to a regional edge **Gateway Server**; **Channel Servers** hold channel history in memory (consistent hashing, ~16M channels/host). ~500ms global delivery. | **Every message persistent**, indexed, searchable — the opposite of WhatsApp. | TLS in transit + at rest (no consumer E2EE; enables search/compliance/eDiscovery). | Channels-first, threads, presence, push-first delivery. |
| **Signal** | Like WhatsApp but privacy-max; sealed sender. | Device-local. | Same Signal Protocol; the gold standard. | Not a fit for a system that needs server-side history/audit. |
| **Telegram** | MTProto over TCP. | **Cloud history** by default (server-side), synced across devices. | Cloud chats = server-side (not E2EE); "secret chats" = E2EE device-to-device. | Cloud-first sync — closer to what an ERP wants. |
| **Teams / Discord** | WebSocket + REST. | Persistent, searchable, server-side. | TLS in transit/at rest. | Channels + DMs + threads + reactions + presence + push. |
| **Construction apps** (Procore, Fieldwire, Raken) | REST + push; mobile-first. | Persistent, **tied to project records** — comments live on a **task / RFI / drawing / daily log**, not a free-floating chat. | TLS. | Strength = traceability (every message attached to a work item). Weakness (per the reviews): for *quick* field↔office chatter they "feel heavy." |

**The takeaway for us:** we want a **Slack/Telegram-style server-persistent model**
(history, search, audit, multi-device, RBAC) with **WhatsApp-style field UX**
(offline-first, delivery ticks, mobile-first), plus the **construction
super-power** Procore/Fieldwire have: messages can be **attached to a task /
RFI / punch item**. We explicitly do **not** want consumer **E2EE** — it would
break server-side history, search, the audit log, and project-scoped access
control that this ERP is built around (Slack/Teams/Procore all make the same
call). TLS-in-transit + at-rest storage is the right posture here.

## 2. Where this app already gives us a head start

This isn't greenfield — most of the hard parts already exist and we reuse them:

- **Identity, auth, RBAC, project scope** — `auth.js` + the server gate. Channel
  visibility and posting rights fall straight out of the existing per-project
  permissions (a scoped PM only sees their projects' channels).
- **Optimistic store + offline outbox** — `mobile/store.js` already queues
  writes offline and replays them in order on reconnect. **Sending a message is
  just another outbox op** → we get WhatsApp's "queued → sent" ticks almost for
  free, on both desktop and Corefield.
- **Live sync via ETag polling** — the store already polls for changes. We can
  ship a working v1 on polling alone, then add a push stream for instant
  delivery.
- **Attachments by reference** — punch items and daily reports already store
  `{name, url, caption}` attachments; messages reuse the same sanitizer.
- **Alert center** (`alerts.js`) — `@mentions` and unread DMs feed it directly.
- **PWA + service worker** — already installable; the SW is where Web Push lands.
- **Demo mode** — Corefield's local mode means messaging also needs a seeded,
  offline-only fallback on the GitHub Pages build (no server) — easy to provide.

## 3. Transport decision (the one real architecture choice)

Consumer apps use **WebSockets**. For *this* codebase the better first step is
**Server-Sent Events (SSE) + plain POST**, because:

- **Zero new dependencies.** SSE is just an HTTP response that stays open
  (`Content-Type: text/event-stream`) — trivial on the existing `node:http`
  server. A zero-dep WebSocket means hand-implementing RFC 6455 framing.
- **Auto-reconnect built in.** The browser's `EventSource` reconnects on its own
  and resumes via `Last-Event-ID`; with raw WebSockets we'd write backoff/replay
  ourselves.
- **Direction matches the need.** Chat is "mostly receive"; sending is low-rate
  and a normal authenticated `POST /api/messages` fits the existing write path
  (and the offline outbox) perfectly. SSE pushes new messages / typing /
  presence down.
- **Graceful fallback.** If SSE is unavailable, the existing **polling** path
  still delivers messages within the poll interval — nothing breaks.

> We can upgrade the SSE stream to a from-scratch WebSocket later if we ever need
> high-rate bidirectional features (live cursors, voice). Chat does not need it.
> (Industry guidance in 2025 is exactly this: start with polling/SSE, reserve
> WebSockets for truly interactive bidirectional workloads.)

## 4. Data model

```
channel  { id, type: 'project'|'dm'|'group', projectId?, name, memberIds[],
           createdBy, createdAt, archived }
message  { id, channelId, authorId, authorName, body,
           attachments: [{name,url,caption,addedBy,addedAt}],
           linkedTo?: { kind:'task'|'rfi'|'punch', id },   // construction super-power
           replyTo?: messageId, createdAt, editedAt?, deleted?, rev }
read     { userId, channelId, lastReadAt }                 // → unread + ✓✓ read ticks
```

- **One channel auto-provisioned per project** (e.g. "Riverside — General"), so
  there's always somewhere to talk. Plus DMs and ad-hoc groups.
- **Storage:** `data/messages.json`, **capped per channel** (ring buffer, e.g.
  last 500) exactly like the audit log's cap — keeps the zero-DB model honest.
  History beyond the cap is a later "move to SQLite/Postgres" task (already on
  the roadmap).
- **Delivery state** is *derived*, not stored per message: `delivered` =
  recipients connected since `createdAt`; `read` = recipient `lastReadAt ≥
  createdAt`. This gives WhatsApp ticks without N×M storage.

## 5. Server API (extends the existing REST surface)

| Method & path | Action |
|---|---|
| `GET /api/channels` | channels visible to the caller (project-scoped) |
| `POST /api/channels` | create a DM/group (project channels auto-exist) |
| `GET /api/channels/:id/messages?before=&limit=` | paged history (read access) |
| `POST /api/messages` | send `{channelId, body, attachments?, replyTo?, linkedTo?, clientId}` → message (write + channel membership enforced) |
| `PATCH /api/messages/:id` | edit (author only) · `DELETE` soft-delete |
| `POST /api/channels/:id/read` | set `lastReadAt` → clears unread, drives read ticks |
| `POST /api/channels/:id/typing` | ephemeral typing ping (fan out on SSE) |
| `GET /api/stream` | **SSE**: `message`, `typing`, `presence`, `read` events for the caller's channels |
| `POST /api/push/subscribe` | (Phase 3) store a Web Push subscription |

Every route reuses the existing session gate + `canEditProject`-style scope
checks. `clientId` (client-generated) makes sends **idempotent** so an
offline-then-replayed message can't double-post — the same dedupe trick the
outbox already implies.

## 6. Client (shared core + two UIs)

- **Pure core** (`src/mobile/core.js` sibling, unit-tested): unread counts,
  message grouping by day/author, tick state (`queued|sent|delivered|read`),
  `@mention` parsing, outbox ops for `message.send`.
- **Corefield (mobile):** a new **💬 Chat** tab — channel list with unread
  badges → conversation view (bubbles, day separators, ticks, attachment chips,
  reply, "link to task"), composer with offline queueing. Mirrors the existing
  tab/sheet system and styles.
- **Desktop BuildFlow:** a **Messages** panel / side drawer; plus an inline
  "discuss" thread on a task/RFI/punch item (the Procore-style attach-to-record
  flow) that opens the linked channel message.
- **Both** subscribe to `GET /api/stream`; both fall back to the existing poll.

## 7. Notifications

- **In-app:** unread badges on the Chat tab + alert-center entries for
  `@mentions` and DMs (reuse `alerts.js`).
- **Push (Phase 3):** **Web Push + VAPID + service worker**. Works on Android and,
  since **iOS 16.4**, on **installed** PWAs (must call `Notification.request­Permission()`
  from a user gesture; VAPID subject must be a `mailto:`/HTTPS URL or Apple
  returns 403; iOS delivery ~70–85% vs ~90–95% Android). **Caveat:** the Web
  Push *payload* encryption (RFC 8291: ECDH + HKDF + AES-GCM) is the one piece
  that's fiddly to do zero-dependency. Node's `crypto` has all the primitives
  (~150 lines), **or** we relax the zero-dep rule for the tiny, audited
  `web-push` library on the server only. Recommended call: implement it with
  Node `crypto` to preserve the zero-dependency story; fall back to the library
  if we want it faster.

## 8. Encryption posture (explicit decision)

**No consumer E2EE.** TLS in transit + server-side at-rest storage, access
gated by the existing RBAC + project scope. Rationale: E2EE (Signal Protocol)
is incompatible with the things this ERP needs — server-side **search**,
**audit/compliance**, **web multi-device**, and **project-scoped visibility**.
Slack, Teams, Telegram-cloud and Procore all make the same trade. If a specific
high-sensitivity DM ever needs it, E2EE can be added for *that* channel type
later without touching the rest.

## 9. Phased delivery

- **Phase 1 — MVP (project channels):** model + `messages.json`, the REST
  endpoints, SSE stream (polling fallback), Corefield Chat tab + desktop panel,
  offline send via the outbox, unread badges, attachments-by-reference,
  `@mention` → alerts. RBAC/scope enforced. Demo-mode seeded sample channel.
- **Phase 2 — conversations:** DMs + groups, typing indicators, presence
  (online / last seen), read receipts (ticks), edit/delete, reply threads, and
  **link-a-message-to-a-task/RFI/punch** (the construction differentiator).
- **Phase 3 — reach & polish:** Web Push notifications, message search,
  reactions, and a path to DB-backed history (SQLite/Postgres) for unbounded
  retention.
- **Optional:** real photo upload behind a blob store (already a roadmap item;
  messaging attachments would light up the moment it exists), E2EE DMs.

## 10. Effort & risk

- **Phase 1** is the bulk of the value and reuses ~70% existing machinery
  (auth, scope, outbox, polling, attachments, alerts, PWA). Main new code: the
  message store/endpoints, the SSE stream, and the chat UI. Pure logic stays in
  a tested core module, matching this repo's standard.
- **Lowest-risk path:** ship Phase 1 on **polling first** (no SSE) to prove the
  model end-to-end, then turn on the SSE stream for instant delivery — both
  behind the same store interface, so the UI never changes.
- **The only genuinely tricky bit** is Web Push payload encryption (Phase 3);
  everything else is squarely within the patterns already in the repo.

---

### Sources
- WhatsApp / Signal Protocol & multi-device: [Engineering at Meta](https://engineering.fb.com/2021/07/14/security/whatsapp-multi-device/), [InfoQ](https://www.infoq.com/news/2021/07/WhatsApp-signal-protocol/), [WhatsApp E2EE explainer](https://requestly.com/blog/how-whatsapp-ensures-chat-security-with-end-to-end-encryption/)
- Slack real-time architecture: [Slack Engineering](https://slack.engineering/real-time-messaging/), [InfoQ](https://www.infoq.com/news/2023/04/real-time-messaging-slack/), [ByteByteGo](https://blog.bytebytego.com/p/how-slack-supports-billions-of-daily)
- Transport trade-offs: [RxDB](https://rxdb.info/articles/websockets-sse-polling-webrtc-webtransport.html), [Ably](https://ably.com/blog/websockets-vs-long-polling), [AlgoMaster](https://blog.algomaster.io/p/polling-vs-long-polling-vs-sse-vs-websockets-webhooks)
- PWA Web Push / VAPID / iOS: [MDN](https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Tutorials/js13kGames/Re-engageable_Notifications_Push), [MagicBell guide](https://www.magicbell.com/blog/using-push-notifications-in-pwas), [iOS web-push example](https://github.com/andreinwald/webpush-ios-example)
- Construction field comms: [Fieldwire vs Procore](https://www.fieldwire.com/blog/fieldwire-vs-procore-comparison/), [Raken](https://www.rakenapp.com/procore-raken)
