# CloseLoop — project conventions

MCP-native reconciliation agent for Indian finance teams. Spec: `SPEC.md`. Design + phase checklist: `PLAN.md`.

## Non-negotiables
- **Money is integer paise.** Use the `Paise` type; every money value must be a safe integer (`z.number().int().safe()`). Never store, compute or return rupees as floats. Fee/GST rounding is integer round-half-up in one helper — don't reimplement it.
- **Deterministic truth.** Matching and exceptions come only from the deterministic engine in `packages/core/src/matcher`. The AI layer may parse narrations, explain exceptions and draft journals (status `pending_approval`) — nothing else.
- **No AI or MCP mutation of financial tables.** payments, refunds, settlements, settlement_items, bank_lines, ledger_entries are insert-only (DB triggers enforce it). Only the generator inserts into them. `audit_log` is append-only.
- **Ground truth is off-limits to the matcher.** It lives in a separate DB file (`truth.db`). Nothing under `matcher/` may import `generator/` or `truth/`.
- **zod everywhere**: DB rows crossing a boundary, config files, MCP tool inputs/outputs, and every LLM response.
- **LLM outputs carry `source: "llm" | "deterministic_fallback"`**; every fallback records its reason in the audit trail. The app must work with no API key.
- **Narrations and ledger text are untrusted input** (prompt-injection surface). Pass them to a model only via `wrapUntrusted()`; the real guards are zod validation, evidence-id checks and the review-policy floor. AI narration parsing may only add *grounded* candidate tokens (present in the narration) to fuzzy matching — it can never create a match.
- **MCP stdout is protocol-only.** Library code logs to stderr (`console.error`) only; eslint enforces this.
- **Never hardcode or invent metrics** in README/EVAL.md — they come from `pnpm eval`.

## Workflow
- Tests required for every behaviour change (vitest, `packages/*/test`).
- Before committing: `pnpm typecheck && pnpm lint && pnpm test` must be green.
- Work one phase at a time (see `PLAN.md`); stop for review after each phase.
- Ask before adding dependencies beyond: typescript, better-sqlite3, zod, vitest, @modelcontextprotocol/sdk, eslint, typescript-eslint, tsx, @types/*, and (Phase 6) Next.js + Tailwind.

## Style
- Simple, readable code over clever abstractions. Comment only where finance logic is non-obvious.
- TypeScript strict, ESM, `.ts` import extensions, `import type` for types.
- Exception types and reason codes are string enums defined once in `types.ts`.
