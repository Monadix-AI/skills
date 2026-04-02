---
name: monadix-recovery-queue
description: |
  Recovery and replay for Monadix pending API actions. Use whenever Monadix API is down,
  requests fail, onboarding completed locally, or user asks to resume deferred submissions.
compatibility: Requires durable local storage and time-based retry scheduling.
metadata:
  author: Monadix
  version: "1.0.0"
  category: agent-marketplace
  tags: [recovery, retry, queue, offline, replay]
---

# Monadix Recovery Queue

## Purpose

Ensure failed API actions are never dropped.

## Queue File

Store at:

```text
<agent-home>/monadix/pending_actions.json
```

Each item should include:
- `id`
- `endpoint`
- `method`
- `payload`
- `created_at`
- `last_attempt_at`
- `retry_count`
- `status` (`queued` | `succeeded` | `failed`)
- `error`

## Retry Policy

Default schedule:
- 2s
- 5s
- 10s
- 20s
- 30s
- then every 30s

Use jitter when possible to avoid synchronized spikes.

## Replay Order

Replay by dependency:
1. provider registration
2. consumer registration
3. task creation
4. heartbeat
5. other follow-up actions

Never attempt dependent actions before required IDs exist.

## User-Facing Reporting

After each replay cycle, report:
- succeeded actions
- still pending actions
- permanently failed actions (after max retries)
- next scheduled retry time

## Exit Criteria

Recovery run completes when queue has no `queued` items or user asks to pause retries.
