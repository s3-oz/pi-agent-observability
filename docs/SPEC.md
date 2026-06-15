# Pi Observability — v1 Spec

> "If you can't measure, you can't improve."
> The clarity of your measurement determines the clarity of the actions you can take to improve a system.

## Goal (v1)

Two cooperating processes that give a developer a live, filterable feed of
**everything** a Pi coding-agent session does — user prompts, thinking,
assistant text, tool calls, tool results, errors, costs, model changes,
session boundaries — across one or more concurrent agents.

```
   ┌──────────────────────┐                       ┌──────────────────────┐
   │  Pi agent (you)      │   HTTP POST /events   │   Bun server          │
   │  + pi-observability  │  ───────────────────► │  (ingest + storage +  │
   │  extension           │                       │   SSE + HTML UI)      │
   │                      │  ◄────── SSE ─────────┤                       │
   │                      │  (optional, not v1)   │                       │
   └──────────────────────┘                       └──────────────────────┘
        emits events                                stores → SQLite
        in pi hooks                                serves UI on :43190
```

Two applications, one round trip per event. No queues. No external infra.

## Tech stack

- **Extension**: TypeScript, runs inside pi via jiti. Uses only `node:*` + `@earendil-works/pi-coding-agent`.
- **Server**: Bun (single-binary). `bun:sqlite` for storage. Hand-rolled HTTP + SSE. Static HTML/JS UI served from the same process.
- **Wire format**: JSON over HTTP. Optionally NDJSON later.

## Repo layout

```
pi-agent-observability/
├── docs/SPEC.md                     ← this file
├── shared/types.ts                  ← canonical event shapes (single source of truth)
├── extension/
│   ├── pi-observability.ts          ← the pi extension
│   ├── package.json
│   └── README.md
├── apps/
│   └── observability/               ← obs server + static UI
│       ├── server.ts                ← Bun HTTP + SSE + SQLite
│       ├── db.ts                    ← SQLite schema + queries
│       ├── public/
│       │   ├── index.html           ← UI
│       │   └── app.js               ← UI logic (vanilla, no build)
│       ├── package.json
│       └── README.md
└── scripts/
    ├── smoke-server.sh              ← curl-driven smoke tests
    └── replay-session.ts            ← replays a recorded session.jsonl → POST /events
```

## Shared event shape (canonical)

All events POSTed to `/events` follow this envelope:

```ts
interface ObsEvent {
  // ── envelope ────────────────────────────────────────────────────
  event_id:    string;        // uuid v4, client-generated
  ts:          string;        // ISO-8601 with ms, client clock
  type:        ObsEventType;  // see enum below
  // ── identity (who emitted it) ───────────────────────────────────
  session_id:  string;        // pi session uuid
  session_file?: string;      // absolute path to session.jsonl (if any)
  session_name?: string;      // Pi session display name (from --name or /name)
  worktree?:   string;        // current git worktree/branch label, if available
  cwd:         string;
  agent_name?: string;        // optional human name (from --o-name)
  pool?:       string;        // --o-pool, defaults to "default"
  tags:        string[];      // --o-tag, may be repeated; always an array
  // ── model ───────────────────────────────────────────────────────
  provider?:   string;
  model?:      string;
  // ── payload (type-discriminated) ────────────────────────────────
  payload:     unknown;
  // ── ordering ────────────────────────────────────────────────────
  seq:         number;        // monotonic per session, starts at 0
}

type ObsEventType =
  | "session_start"            // payload: { reason, version, parentSession? }
  | "session_shutdown"         // payload: { reason }
  | "agent_start"              // payload: { prompt, images_count }
  | "agent_end"                // payload: { message_count }
  | "turn_start"               // payload: { turnIndex }
  | "turn_end"                 // payload: { turnIndex, usage?, cost? }
  | "user_message"             // payload: { content, images_count }
  | "assistant_message"        // payload: { text, thinking, tool_calls, usage, cost, stopReason }
  | "tool_call"                // payload: { tool_name, tool_call_id, args }
  | "tool_result"              // payload: { tool_name, tool_call_id, content_text, is_error, details_summary }
  | "model_change"             // payload: { provider, model, previous?: {provider, model} }
  | "thinking"                 // payload: { text }  — extracted from assistant message thinking blocks
  | "error"                    // payload: { message, where }
  | "custom"                   // payload: { customType, data }   — pass-through for extensions
  ;
```

Numbers (`usage`, `cost`) are flattened where possible to keep the UI dumb.

## HTTP API (server side)

All endpoints require `Authorization: Bearer <OBS_AUTH_TOKEN>` (server-side env).
For v1, the server may also accept `?token=` for the SSE endpoint (browsers can't set Authorization on EventSource).

| Method | Path                                                            | Purpose |
|--------|-----------------------------------------------------------------|---------|
| GET    | `/health`                                                        | `{ ok: true, version, uptime_s, events_total, sessions_total }` |
| POST   | `/events`                                                        | Body: `ObsEvent` or `ObsEvent[]`. Returns `{ ingested: N }`.    |
| GET    | `/sessions?pool=&tag=&since=&limit=`                             | Recent sessions w/ counts, latest ts, cwd, model.               |
| GET    | `/sessions/:session_id/events?limit=&before_seq=&type=`          | Paginated event replay.                                          |
| GET    | `/events/stream?pool=&tag=&session_id=&token=`                   | SSE stream of new events (filtered).                             |
| GET    | `/`                                                              | Static `index.html` (UI).                                        |
| GET    | `/app.js`, `/style.css`, etc.                                    | Static assets from `public/`.                                    |

### Auth

- Server reads `OBS_AUTH_TOKEN` from env (or `--token` flag). If unset, generates a random token at boot and prints it.
- Server prints its full URL + token at boot for easy copy/paste.

## CLI flags (extension)

The extension registers these pi flags via `pi.registerFlag`:

| Flag                 | Type   | Default                            | Notes |
|----------------------|--------|------------------------------------|-------|
| `--obs-server-url`   | string | env `OBS_SERVER_URL` or `http://127.0.0.1:43190` | |
| `--obs-token`        | string | env `OBS_AUTH_TOKEN`               | Never logged. |
| `--o-pool`           | string | env `OBS_POOL` or `"default"`      | Logical bucket. |
| `--o-tag`            | string | (none)                             | Repeatable. Comma-split also accepted. |
| `--o-name`           | string | (none)                             | Optional friendly agent name. |
| `--obs-disable`      | bool   | false                              | Hard kill switch; do not register listeners. |

The extension auto-loads `.env` from `cwd` (and `.env.local`) on `session_start` so the user can drop creds next to their project.

## Storage (SQLite)

```sql
CREATE TABLE IF NOT EXISTS sessions (
  session_id   TEXT PRIMARY KEY,
  pool         TEXT NOT NULL DEFAULT 'default',
  agent_name   TEXT,
  session_name TEXT,
  worktree     TEXT,
  cwd          TEXT,
  session_file TEXT,
  provider     TEXT,
  model        TEXT,
  first_ts     TEXT NOT NULL,
  last_ts      TEXT NOT NULL,
  event_count  INTEGER NOT NULL DEFAULT 0,
  tags_json    TEXT NOT NULL DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS events (
  event_id     TEXT PRIMARY KEY,
  session_id   TEXT NOT NULL,
  seq          INTEGER NOT NULL,
  ts           TEXT NOT NULL,
  type         TEXT NOT NULL,
  pool         TEXT NOT NULL DEFAULT 'default',
  tags_json    TEXT NOT NULL DEFAULT '[]',
  payload_json TEXT NOT NULL,
  provider     TEXT,
  model        TEXT,
  FOREIGN KEY (session_id) REFERENCES sessions(session_id)
);

CREATE INDEX IF NOT EXISTS idx_events_session_seq ON events(session_id, seq);
CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);
CREATE INDEX IF NOT EXISTS idx_events_pool ON events(pool);
CREATE INDEX IF NOT EXISTS idx_events_type ON events(type);
```

## UI (v1)

Single-page HTML at `GET /`. Vanilla JS, no build step. Layout:

```
┌──────────────────────────────────────────────────────────────────┐
│ pi observability                                       ● live    │
├──────────────────────────┬───────────────────────────────────────┤
│ pool: [default ▼]        │  Session: <cwd> · <model> · live       │
│ tag:  [____________ +]   │  ┌─────────────────────────────────┐   │
│                          │  │ 14:00:01  user_message  …       │   │
│ Sessions (12)            │  │ 14:00:02  thinking      …       │   │
│ ● a1b2  team-alpha       │  │ 14:00:03  tool_call bash …      │   │
│   c3d4  team-beta        │  │ 14:00:04  tool_result   exit 0  │   │
│   e5f6  default          │  │ 14:00:05  assistant_message …   │   │
│   …                      │  │                                  │   │
│                          │  └─────────────────────────────────┘   │
└──────────────────────────┴───────────────────────────────────────┘
```

Behaviour:
- Left rail: live list of sessions (latest first), with pool/tag filters.
- Right pane: timeline of selected session. Each event is a collapsed card; click to expand. Tool calls show args, tool results show output (trimmed), assistant_message shows text + cost + tokens.
- Top right: `● live` indicator (green when SSE connected, red when not).
- SSE-driven; falls back to polling if EventSource fails.

## Validation checkpoints (orchestrator gates)

1. **M1 — shape lock**: shared/types.ts agreed by both teammates. (orchestrator)
2. **M2 — server alone**: `bun server.ts` boots, `/health` OK, can POST a hand-crafted event and read it back. (obv-ds)
3. **M3 — extension alone**: extension loaded with `-e`, emits a `session_start` event to a mock server (curl-collected) — verify shape matches types. (obv-flash)
4. **M4 — end-to-end smoke**: server running, real pi session with extension, run a couple of bash/read tool calls, hit UI, see events. (orchestrator)
5. **M5 — cross-review**: each teammate reviews the other's code via coms_net_send. Sign off here. (cross)
