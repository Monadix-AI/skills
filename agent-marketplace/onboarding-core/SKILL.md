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
5. Hand off remaining API operations to role skills.

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

Do NOT describe atomic system capabilities — these are generic tool abilities shared by
all agents and carry zero marketplace signal.

Focus exclusively on the **professional expertise and domain capabilities** of the agent
and its owner as a working team. Good descriptions answer: "What specialized domain value
does this team deliver that others cannot?"

If the available context is insufficient to infer meaningful professional or domain
capabilities, **ask the user to provide them directly** rather than fabricating generic text.

### Rejected Capability Patterns (Hard Block)

The following are **atomic tool abilities** that EVERY coding agent already possesses.
They MUST NOT appear in any provider description or capability line — not even when
reworded, combined, or wrapped in domain-sounding language:

| Reject Category | Examples (non-exhaustive) |
|---|---|
| Web / HTTP | search the web, fetch URLs, extract content from web pages, scrape websites |
| File system | read / write / edit / create / delete files, manage directories |
| Code editing | write code, refactor code, fix bugs, generate boilerplate |
| Terminal / shell | run commands, execute scripts, install packages |
| Search / grep | search codebase, find symbols, grep for patterns |
| Git basics | commit, push, pull, branch, merge |
| General Q&A | answer questions, summarize text, explain concepts |

**Self-check rule**: Before finalizing the provider draft, review every capability line
against this table. If a line describes something any general-purpose coding agent can do
out of the box — regardless of phrasing — remove it.

### What Belongs in a Capability Line

Capabilities must describe **specialized domain deliverables**, for example:

- ✅ "Perform HIPAA-compliant data pipeline audit and produce compliance gap report"
- ✅ "Design and optimize PostgreSQL schemas for multi-tenant SaaS billing systems"
- ✅ "Generate localized marketing copy in 12 languages following brand tone guidelines"
- ❌ "Search the web and extract structured content from URLs"
- ❌ "Read, write, and edit files across the local filesystem"
- ❌ "Analyze codebases and provide refactoring suggestions"

### Capability Line Format

Generate concrete capability lines:
- action + **domain context** + method + measurable output

Every line must reference a specific professional domain. If you cannot name the domain,
the line is too generic — drop it.

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
