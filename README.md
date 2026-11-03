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
| Groq | `https://api.groq.com/openai/v1` | `llama-3.3-70b-versatile` |
| Google AI Studio | `https://generativelanguage.googleapis.com/v1beta/openai` | `gemini-2.0-flash` |
| OpenRouter | `https://openrouter.ai/api/v1` | any model id, e.g. `meta-llama/llama-3.3-70b-instruct:free` |

```bash
LLM_BASE_URL=https://api.groq.com/openai/v1
LLM_API_KEY=your-key
LLM_MODEL=llama-3.3-70b-versatile
```

Behaviour on failure:
- An HTTP 429 gets one retry, honouring `Retry-After` and capped at 5 s.
- A second 429, a timeout (15 s), a malformed response or a schema failure falls back to the deterministic path. The reason is recorded on the output and in the audit trail.
- JSON mode (`response_format`) is requested. If a provider rejects it, CloseLoop retries without it and extracts the JSON from the text.

Bank narrations and ledger text are untrusted input: anyone who sends money controls the narration. They reach the model only inside `<untrusted_data>` delimiters, with instructions to treat them as data. The real guards are schema validation, evidence-id checks, and the rule that AI output can never create a match or touch financial tables.
