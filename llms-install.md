# memory-eternal — install notes for AI agents

You are installing an MCP server: a local-first long-term memory for coding agents.

## What it does

- Stores knowledge cards in a local SQLite vault (`~/.dsh/memory-vault` by default) plus a Markdown mirror.
- Exposes them over **MCP** (stdio) so Claude Code, Codex, Cursor, Cline or any MCP client can call `memory_recall`.
- Nothing leaves the machine; no account, no API key required to read memory.

## Install (MCP client)

Use this server entry in the client's `mcpServers` config:

```json
{
  "mcpServers": {
    "memory-eternal": {
      "command": "npx",
      "args": ["-y", "-p", "memory-eternal", "dsh-memory", "mcp"]
    }
  }
}
```

Or install globally:

```bash
npm i -g memory-eternal
dsh-memory connect claude   # configures Claude Code / Codex / Cursor automatically
```

## Verify

```bash
npx -y -p memory-eternal dsh-memory stats --json
```

A fresh vault reports `total: 0`; that is a successful start.

## Notes

- Requires Node.js >= 22.
- Optional: DSH users can instead install the plugin (`dsh plugin --profile desktop add memory-eternal`) to get the review UI.
- Write paths go through a review queue by design; `memory_recall` only returns approved cards.
