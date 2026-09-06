# Pi Observability Extension

A lightweight, local-first pi agent extension that observes agent lifecycle hooks and streams telemetry in real-time to a local observability server.

## Features

- **Monotonic Event Sequencing:** Automatically assigns zero-indexed sequence numbers (`seq`) per session.
- **Fire-and-Forget Queueing:** Runs non-blocking background queue with up to 10k items, dropping older items on overflow.
- **Exponential Backoff:** Gracefully handles server dropouts, backing off flushes exponentially (250ms -> 5s).
- **Auto-Environment Resolution:** Auto-loads `.env` and `.env.local` from the active directory at session start.
- **Payload Safety Truncation:** Gracefully truncates heavy payloads (tool outputs, prompts) to keep communication lightweight.

## Installation & Load

Simply pass the `-e` or `--extension` flag to load the extension:

```bash
pi -e ./extension/pi-observability.ts
```

Alternatively, add the path to your local `~/.pi/agent/settings.json`:

```json
{
  "extensions": [
    "/absolute/path/to/extension/pi-observability.ts"
  ]
}
```

## Configuration

You can configure the telemetry stream using CLI flags or environment variables.

### CLI Flags

| Flag | Type | Description |
|---|---|---|
| `--obs-server-url` | `string` | Observability server URL (default: `http://127.0.0.1:43190`). |
| `--obs-token` | `string` | Bearer token for server authentication (never logged). |
| `--o-pool` | `string` | Logical pool / bucket name (default: `"default"`). |
| `--o-tag` | `string` | Comma-separated or repeatable tags. |
| `--o-name` | `string` | Optional human-friendly name for this agent session. |
| `--obs-disable` | `boolean` | Hard kill switch. When true, no listeners are registered. |

### Environment Variables

If flags are omitted, the extension falls back to these variables:

- `OBS_SERVER_URL`
- `OBS_AUTH_TOKEN`
- `OBS_POOL`
- `OBS_TAG`
- `OBS_NAME`
- `OBS_DISABLE`

## Emitted Telemetry Events

The extension maps agent events directly into the canonical `ObsEvent` envelopes:

- **`session_start`** & **`session_shutdown`**: Tracks session boundaries.
- **`agent_start`** & **`agent_end`**: Fired per user prompt cycle.
- **`turn_start`** & **`turn_end`**: Tracks individual assistant model calls and usage/cost.
- **`user_message`**: Captures user prompts.
- **`assistant_message`**: Captures model completions (text, tools called, token usage).
- **`thinking`**: Emitted as a chronological sibling when the model streams a `<thinking>` block.
- **`tool_call`** & **`tool_result`**: Non-blocking tool telemetry with truncation checks.
- **`model_change`**: Captured on manual switches or model cycling.
- **`compaction`**: Emitted when session history is compacted (manual or auto).
- **`branch_nav`**: Emitted on session-tree branch navigation (with optional summary preview).

## OBS Console durable delivery (Oz fork)

The extension writes producer-spool v1 records before posting to OBS Console. Install an OBS Console receiver with issue #144 support first. Pending files live under `$XDG_STATE_HOME/nexus/obs-pending/v1` (default `~/.local/state/nexus/obs-pending/v1`), or `OBS_PRODUCER_SPOOL_DIR`; configure the same path for the producer and receiver. The records contain event payloads, never auth tokens, and retain their original IDs/sequences across retries. Keep pending and quarantined files during upgrades.

The receiver independently recovers loopback-3460 pending files, including after Pi exits. The extension's memory queue is bounded without dropping successfully journaled events. POSTs have a 2.5-second deadline, use byte-bounded batches, and request `?receipt=v1`; only explicit durable acknowledgements remove records. Old receivers without those acknowledgements leave data pending, so upgrade receivers before loading this extension. Shutdown makes a bounded attempt and leaves the remaining backlog durable. Disk failures are logged and retained in memory when possible; disk exhaustion still requires operator attention.

Events now carry `harness: OBS_HARNESS || "PI"`. Existing processes need an explicit reload or a new Pi session to load the changed extension. These changes do not alter native token normalization or count `turn_end.usage` a second time.
