# CloseLoop

MCP-native reconciliation agent for Indian finance teams. **Work in progress.** [PLAN.md](PLAN.md) has the design and phase checklist, and [DEMO.md](DEMO.md) has the demo cases.

Requires Node 20.12+ and pnpm.

```bash
pnpm install
pnpm typecheck && pnpm lint && pnpm test
pnpm gen --seed 42 --payments 5000      # seeded demo data → ~/.closeloop/closeloop.db (+ truth.db)
pnpm recon --from 2026-10-01 --to 2026-10-31
```

## LLM setup (optional)

CloseLoop works fully with no API key; every AI step has a deterministic fallback. With a key, the AI layer can:
- parse messy bank narrations (it can only add *candidate tokens* that literally appear in the narration; the deterministic scorer still decides every match),
- explain exceptions from a read-only evidence bundle (answers citing evidence not in the bundle are rejected),
- draft correcting journal entries (`pending_approval` only; the entry must balance to the engine's amount).

Any OpenAI-compatible chat-completions endpoint works. Copy `.env.example` to `.env` (git-ignored) and set all three:

| Provider | `LLM_BASE_URL` | `LLM_MODEL` (example; check the provider's current model list) |
|---|---|---|
| Groq | `https://api.groq.com/openai/v1` | `openai/gpt-oss-120b` |
| Google AI Studio | `https://generativelanguage.googleapis.com/v1beta/openai` | `gemini-2.0-flash` |
| OpenRouter | `https://openrouter.ai/api/v1` | any model id, e.g. `meta-llama/llama-3.3-70b-instruct:free` |

```bash
LLM_BASE_URL=https://api.groq.com/openai/v1
LLM_API_KEY=your-key
LLM_MODEL=openai/gpt-oss-120b
LLM_REASONING_EFFORT=low   # reasoning models only; keeps answers within the token budget
```

LLM budgets live in `config/ai.json`. Free tiers are small (Groq's free tier allows about 8k tokens a minute), so narration parsing runs sequentially and is capped per run.

Behaviour on failure:
- An HTTP 429 gets one retry, honouring `Retry-After` and capped at 5 s.
- A second 429, a timeout (15 s), a malformed response or a schema failure falls back to the deterministic path. The reason is recorded on the output and in the audit trail.
- JSON mode (`response_format`) is requested. If a provider rejects it, CloseLoop retries without it and extracts the JSON from the text.

Bank narrations and ledger text are untrusted input: anyone who sends money controls the narration. They reach the model only inside `<untrusted_data>` delimiters, with instructions to treat them as data. The real guards are schema validation, evidence-id checks, and the rule that AI output can never create a match or touch financial tables.

## MCP server

`closeloop-mcp` is a stdio MCP server. On first run with an empty database it seeds the reproducible demo dataset (seed 42, 5,000 payments) into `~/.closeloop/closeloop.db`; override the location with `CLOSELOOP_DB`. It reads LLM settings from `~/.closeloop/.env`, then from `.env` in its working directory.

| Tool | What it does | Annotations |
|---|---|---|
| `run_reconciliation({from?, to?})` | Matched counts by kind, exceptions by type, exposure per class (never summed), bank-vs-books tie-out | writes a run |
| `list_exceptions({type?, exposure_class?, min_amount_paise?, status?, limit?, cursor?})` | Largest first, 20 per page with a cursor, totals for the whole filtered set | read-only |
| `get_evidence({exception_id})` | Records, rule trace, candidate sets with totals, audit history | read-only |
| `explain_exception({exception_id})` | Root cause and recommended action from read-only evidence (LLM or deterministic) | writes audit |
| `decompose_bank_credit({bank_line_id})` | The settlement set behind one bank credit, or the ranked candidate sets | read-only |
| `draft_journal_entry({exception_id})` | Balanced correcting entry, `pending_approval`, never posted | writes draft |
| `approve_suggestion({id, candidate_index?, set_index?, confirm_token?, reviewer?})` | Two-step human approval: preview + token (5 min), then token + reviewer | destructive |
| `escalate({id, note?, confirm_token?, reviewer?})` | Two-step human escalation with a note | destructive |
| `get_audit_trail({entity_id?, limit?, cursor?})` | Append-only audit events, paginated | read-only |

Also exposes the resource `closeloop://summary/latest` and the prompt `month_end_review({month?})`. Every amount comes as raw `amount_paise` plus a pre-formatted `amount_inr` (₹12,33,701.15), and every response starts with a one-line summary, so the model never has to do arithmetic. No tool can delete data or modify payments, settlements, bank lines or ledger entries (the database enforces this too).

### Claude Desktop (macOS)

Edit `~/Library/Application Support/Claude/claude_desktop_config.json`. Claude Desktop doesn't inherit your shell's `PATH`, so use absolute paths (`which node`):

```json
{
  "mcpServers": {
    "closeloop": {
      "command": "/opt/homebrew/bin/node",
      "args": ["/absolute/path/to/closeloop/packages/mcp/bin/closeloop-mcp.js"]
    }
  }
}
```

Once the package is published to npm, this becomes `"command": "npx", "args": ["-y", "closeloop-mcp"]`. From the repo root, `npx closeloop-mcp` already works.

### MCP Inspector

```bash
npx @modelcontextprotocol/inspector node packages/mcp/bin/closeloop-mcp.js            # web UI
npx @modelcontextprotocol/inspector --cli node packages/mcp/bin/closeloop-mcp.js --method tools/list
npx @modelcontextprotocol/inspector --cli node packages/mcp/bin/closeloop-mcp.js \
  --method tools/call --tool-name decompose_bank_credit --tool-arg bank_line_id=bnk_000080
```
