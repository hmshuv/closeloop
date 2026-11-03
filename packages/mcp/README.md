# closeloop-mcp

MCP server for month-end reconciliation of Razorpay-style gateway settlements against the bank statement and the accounting ledger, built for Indian finance teams. Matching is deterministic (exact UTR, fuzzy UTR, batch decomposition); an optional LLM can only parse narrations, explain exceptions and draft journal entries from read-only evidence.

```bash
npx -y closeloop-mcp          # stdio MCP server; seeds a demo dataset on first run
npx -y closeloop-mcp check    # run one reconciliation and print the summary
```

Claude Desktop (`~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{ "mcpServers": { "closeloop": { "command": "npx", "args": ["-y", "closeloop-mcp"] } } }
```

Environment:
- `CLOSELOOP_DB`: state DB (default `~/.closeloop/closeloop.db`).
- `CLOSELOOP_SOURCE_DB`: your financial data, attached read-only.
- `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL`, `LLM_REASONING_EFFORT`: optional; any OpenAI-compatible endpoint. Without them the server makes no outbound network calls.

Requires Node 22.13+ (uses the built-in `node:sqlite`; no native modules, nothing compiled on install). Full documentation, evaluation and design notes are in the project repository.
