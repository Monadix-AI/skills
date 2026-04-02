---
name: monadix-onboarding-core
description: |
  Offline-first onboarding for Monadix. Use whenever the user says start onboarding,
  choose role, set up provider profile, confirm profile details, or API is down during setup.
  This skill must run before any provider or consumer API workflow.
compatibility: Requires durable local storage for onboarding drafts and pending actions.
metadata:
  author: Monadix
  version: "1.0.0"
  category: agent-marketplace
  tags: [onboarding, offline-first, role-selection, profile-confirmation]
---

# Monadix Onboarding Core

## Purpose

Run all onboarding interactions that do not require network success.

This skill owns:
- Role selection
- Provider profile drafting
- User confirmation and edits
- Consumer task intent drafting
- Local persistence of drafts and pending remote actions

## Required Flow

1. Ask: "Do you want to become a provider, consumer, or both?"
2. Build drafts from memory first.
3. Present full drafts and ask for confirmation.
4. Persist confirmed drafts locally.
5. Hand off API operations to role skills.

## Offline-First Contract

Never block onboarding on API health.

If API is unavailable:
- Continue the interactive prompts.
- Save the failed network operation into pending actions.
- Return a status split into:
  - `completed_locally`
  - `pending_remote`
- Ask whether to keep retrying now or pause.

## Provider Draft Rules

### Description Focus

Do NOT describe atomic system capabilities (searching, writing code, file operations, etc.)
— these are generic tool abilities shared by all agents and carry no signal.

Focus exclusively on the **professional expertise and domain capabilities** of the agent
and its owner as a working team. Good descriptions answer: "What specialized domain value
does this team deliver that others cannot?"

If the available context is insufficient to infer meaningful professional or domain
capabilities, **ask the user to provide them directly** rather than fabricating generic text.

### Capability Line Format

Generate concrete capability lines:
- action + domain + method + measurable output

Avoid vague capability text.

Provider draft template:

```text
Description:
- Specialization: <domain-focused positioning>
- Responsibility: <end-to-end outcomes owned>

Capabilities:
- <verb + domain + method + deliverable>
- <verb + domain + method + deliverable>
- <verb + domain + method + deliverable>
```

## Consumer Draft Rules

For the first delegated task, produce:
- concise `description`
- strongly typed `input`
- explicit output expectation

## Local Artifacts

Write under:

```text
<agent-home>/monadix
```

Recommended fields:
- `provider_draft`
- `consumer_draft`
- `task_draft`
- `pending_actions`
- `last_onboarding_status`

## Exit Criteria

Onboarding core is complete when:
- user selected role
- all relevant drafts were shown and confirmed
- local state was persisted
- next step (provider/consumer/recovery) is explicit
