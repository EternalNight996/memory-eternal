---
name: memory-open
description: Open the local Memory Atlas Web UI (memory-eternal) from Codex or Claude Code. Use when the user asks to open the memory library, review queue or knowledge graph.
allowed-tools: Bash(dsh-memory open)
---

# Open Memory Atlas

Run this once, from the workspace root:

```bash
dsh-memory open
```

It ensures the local memory Web UI is running on `http://127.0.0.1:7999/` and opens the default browser.

Rules:

- Do not approve or reject cards from here. Review is done by the person in the Web UI.
- Do not write or mutate memory cards.
- If `dsh-memory` is not on PATH, read the repository `README.md` for the CLI install path, or ask the user to run the command manually.
- After opening, tell the user the review queue is available in the Web UI; keep the reply short.
