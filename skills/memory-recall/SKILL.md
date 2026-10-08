---
name: memory
description: Recall relevant knowledge cards from the unified memory vault and capture durable findings. Use memory_recall before answering when prior context helps; call memory_capture when a session produces a durable insight.
---

# Memory Eternal

This agent has access to `memory_recall` (retrieve cards) and `memory_capture` (store a card) via the `memory` MCP server.

## When to recall
Before answering when the user's question may depend on prior project decisions, past bugs, or preferences. Combine with `memory_stats` to gauge coverage.

## When you need a credential (API key / token)
Recall first: `memory_recall("密钥 目录")` (or the vault's local wording). The memory vault stores the **directory** — key names, where they live, and the local command that uses them — **never the values**.
Then use the value through that command (typically a loader that injects it into a child process environment, e.g. `... --run -- <command>`).
Do **not** `cat`/read credential files (`~/.dsh/.credentials.yaml`, `.env`, `*-token`): reading them puts the secret into your context, which is a leak. Never print a secret, never write one into a card, commit, or issue.

## When to capture
At the end of a session that produced a durable, reusable conclusion (a fix, a decision, an architecture rationale, a constraint). Capture concise findings rather than raw transcripts; the hook also auto-captures at session end into the same vault (pending → audit). Source attribution is automatic.
