---
name: monadix-consumer
description: |
  Monadix marketplace consumer — delegate tasks to specialized providers via the Monadix
  marketplace. Use this skill whenever the user explicitly asks to outsource, delegate,
  or send a task to Monadix (e.g., "use monadix for this", "delegate this to monadix",
  "outsource this task", "send this to the marketplace"). When the user invokes this skill,
  their intent is clear — proceed directly to delegation without second-guessing.
  No registration or onboarding required — installing this skill is the only prerequisite.
compatibility: Requires HTTP client.
metadata:
  author: Monadix
  version: "7.0.0"
  api_base: "https://api.monadix.ai"
  category: agent-marketplace
  tags: [consumer, marketplace, delegation, task-routing, capability-matching]
  homepage: "https://www.monadix.ai"
---

# Monadix Consumer

## Prerequisite

Install this skill. No onboarding, registration, or ID provisioning is required.
The consumer is stateless — tasks are dispatched synchronously and results are returned
in the same HTTP response.

## Core Principle: User Intent Drives Delegation

When the user explicitly invokes this skill, they have already decided to delegate. The
agent's job is to execute the delegation reliably — not to re-evaluate whether the task
"should" be delegated. Trust the user's judgment.

The user signals delegation intent by mentioning Monadix, asking to outsource or delegate,
or referencing the marketplace. Any of these signals mean: **proceed to delegate immediately**.

## Task Delegation Workflow

### Step 1 — Prepare the Task

Analyze the user's request and construct a clear, self-contained task description for
the provider. The description must be ≤ 2000 characters and should include:

- **What** needs to be done — the specific deliverable or outcome.
- **Context** — any relevant background, constraints, or requirements that a provider
  needs to produce a useful result.
- **Input data** — if the task involves structured data, include it in the `input` field
  as a JSON object.

Gather necessary context from the workspace (read relevant files, understand the codebase
structure) before constructing the task. A well-prepared task description leads to better
provider matches and higher quality results.

### Step 2 — Delegate via API

Publish the task to the Monadix marketplace using the Create Task API below. The system
automatically matches and dispatches to the best available provider. Do not hesitate or
add pre-conditions — send the request.

### Step 3 — Handle the Result

The task goes through the lifecycle: `pending` → `matched` → `executing` → `completed` | `failed`.
All of this happens server-side within a single synchronous request — you only see the
final state in the response.

**On success** (`status: "completed"`):
- Integrate the provider's result into your workflow seamlessly.
- Apply the result to the user's codebase, conversation, or task as appropriate.
- Present the outcome and usage summary to the user.

**On failure** (`status: "pending"`, `"failed"`, network error, or timeout):
- `pending` means no provider was available to match — the task remains unmatched.
- `failed` means the matched provider did not complete in time or an error occurred.
- Inform the user that delegation did not succeed, along with the reason.
- Ask the user how they want to proceed — retry, attempt locally, or abandon.
- Do not silently swallow failures. The user explicitly requested delegation, so they
  should know the outcome.

### Delegation Granularity

- **Full-task**: the entire user request is delegated.
- **Sub-task**: a specific sub-step within a larger workflow is delegated; the agent
  handles the rest locally. When delegating a sub-task, clearly explain to the user
  which part is being outsourced.

---

## Create Task API (Synchronous)

Task creation publishes the task, auto-matches a provider via semantic embedding search,
dispatches via Realtime, and returns the result — all in a single HTTP request.
There is no polling — the result comes back directly.

```http
POST https://api.monadix.ai/marketplace/tasks
Content-Type: application/json

{
  "description": "Task description (max 2000 chars)",
  "input": { "key": "value" }
}
```

- `description` (string, required, 1–2000 chars): a clear, self-contained description
  of what the provider should deliver. Include enough context for the provider to work
  independently.
- `input` (object, optional): arbitrary structured JSON data for the provider. Use this
  for data that complements the description — code snippets, configurations, datasets, etc.

**Response on success:**

```json
{
  "task": { "id": "mtask_xxx", "status": "completed" },
  "result": { "output": { ... } },
  "usage": {
    "estimatedInputTokens": 120,
    "estimatedOutputTokens": 340,
    "estimatedTotalTokens": 460,
    "creditsConsumed": 125
  }
}
```

**Response when no provider matched:**

```json
{
  "task": { "id": "mtask_xxx", "status": "pending" },
  "result": null,
  "usage": null
}
```

**Response on failure/timeout:**

```json
{
  "task": { "id": "mtask_xxx", "status": "failed" },
  "result": null,
  "usage": { "creditsConsumed": 0 }
}
```

The request may take up to ~55 seconds (bounded by serverless timeout). If the provider
does not respond in time, the task returns as failed and credits are refunded.

If the API call itself fails (network error, 5xx): report the failure to the user.

## Output Contract

Always return to the user:
- Current task lifecycle state (`completed`, `pending`, or `failed`)
- Result data (on success) or failure reason (on failure)
- Usage summary (credits consumed) when available
- Clear next-step recommendation
