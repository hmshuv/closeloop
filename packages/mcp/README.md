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
- `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL`, `LLM_REASONING_EFFORT`: optional; any OpenAI-compatible endpoint.
- `CLOSELOOP_RAZORPAY_KEY_ID`, `CLOSELOOP_RAZORPAY_KEY_SECRET`: optional; lets `import_razorpay_recon({from, to})` fetch Razorpay's settlement recon report. GET requests only.

Without the optional variables the server makes no outbound network calls.

Razorpay's settlement recon report (the documented `recon/combined` format, as a JSON or CSV export, or fetched read-only) makes batched bank credits match from the gateway's item-level rows instead of amounts alone. `npx -y closeloop-mcp demo-report recon.json` writes a synthetic one for the demo data. It works side by side with [Razorpay's official MCP server](https://github.com/razorpay/razorpay-mcp-server).

Requires Node 22.13+ (uses the built-in `node:sqlite`; no native modules, nothing compiled on install). Full documentation, evaluation and design notes are in the project repository.
