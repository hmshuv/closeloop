# Project: CloseLoop — MCP-native reconciliation agent for Indian finance teams

## Context
I'm building a portfolio project to show a fintech startup that builds AI agents for finance operations. It must look and behave like production-grade engineering, not a hackathon demo. Write all code from scratch. Do not copy code from any existing repo. Design inspiration: "keep financial truth deterministic; use AI only where data is messy, and only from read-only evidence."

The headline features are the hard problems most reconciliation demos skip:
1. **Batch decomposition**: one bank credit = many settlements netted together. Find which ones.
2. **Fuzzy matching** of corrupted or reformatted UTRs and bank narrations, with confidence scores.
3. **Configurable settlement windows** per payment method.
4. **Multi-source reconciliation** across payment gateway, bank statement, and accounting ledger.
5. **An MCP server** so anyone can run month-end recon by chatting with Claude Desktop.

## Tech stack (ask me before adding anything else)
- TypeScript, Node 20+, pnpm, strict mode
- SQLite via better-sqlite3
- zod for every schema and LLM output
- vitest for tests
- @modelcontextprotocol/sdk (stdio transport)
- An LLM provider behind an interface (`LLMProvider`), with an Anthropic implementation first. Read the key from `.env`. If there's no key or a call fails, use a deterministic fallback. The app must fully work with no API key.
- Phase 6 only: a minimal Next.js + Tailwind dashboard

All money is **integer paise**. Never use floats for money.

## Domain model (Razorpay-style, Indian context)
- **Payment**: id, order_id, amount, method (upi | card | netbanking | wallet), status, captured_at
- **Fee**: gateway fee plus 18% GST on the fee. settlement_amount = amount − fee − gst
- **Refund**: payment_id, amount, created_at. Partial refunds are allowed
- **Settlement**: id, utr, amount, settled_at, plus a list of settlement items (payment or refund ids with net amounts). One settlement covers many payments
- **Bank statement line**: date, narration (messy free text, e.g. `NEFT CR-RZPY SETTL-UTR AXISN2410...`), credit, debit, balance. **A single bank credit may cover multiple settlements** (consolidated payout)
- **Ledger entry** (Tally/Zoho Books-style export): date, voucher_type (Receipt | Journal | Payment), party, amount, reference, narration

## Phase 1: Synthetic data generator
- Seeded and reproducible. Default 5,000 payments over ~45 days, about 300 settlements, matching bank lines and ledger entries.
- Add realistic **noise**, each with a configurable rate and a ground-truth label:
  - UTRs truncated, case-changed, with spaces or hyphens added, or with 1–2 character typos inside narrations
  - Consolidated bank credits (2–60 settlements in one credit)
  - Late settlements beyond the method's window
  - Missing settlement, missing bank line, missing ledger entry
  - Amount mismatch (small paise rounding vs. large)
  - GST computed on the wrong base
  - Duplicate ledger entry
  - Refund amount mismatch
  - Ledger entry with a wrong or absent reference
- Store ground truth in a **separate table** that the matcher must never read.
- Split the data 80/20 into dev and held-out sets. The held-out set must include **at least two noise variants the matcher's rules were not written around** (for example, a narration format never seen in dev). This keeps the evaluation honest.
- CLI: `pnpm gen --seed 42 --payments 5000`

## Phase 2: Deterministic matching engine (source of truth)
Run these stages in order. Each emits typed results with machine-readable reason codes.
1. **Payment ↔ settlement item**: exact id link; verify fee + GST arithmetic.
2. **Settlement ↔ bank line**:
   - a. Exact UTR match (normalized: uppercase, strip spaces and hyphens).
   - b. **Batch decomposition**: for unmatched bank credits, find the subset of unmatched settlements whose amounts sum exactly to the credit.
     - Candidates must be in a date window before the credit date.
     - Use bounded subset-sum (DP or meet-in-the-middle) with pruning and a time budget per credit.
     - If there's exactly one solution, match it with reason `BATCH_DECOMPOSED`.
     - If there are multiple solutions, raise `AMBIGUOUS_BATCH` for human review and attach the candidate sets.
     - If none, leave it unmatched.
   - c. **Fuzzy UTR / narration match**: extract UTR-like tokens from the narration and score them with Jaro-Winkler or Levenshtein, combined with amount and date proximity.
     - Confidence ≥ 0.97 and exact amount: `MATCHED_FUZZY` (reported separately from exact matches).
     - 0.80–0.97: `SUGGESTED_MATCH`, which needs human approval.
     - Below 0.80: unmatched.
3. **Payment ↔ ledger receipt**: by reference, then by amount + date + party.
4. **Timing**: windows come from config (`config/windows.json`), defaulting to UPI T+1, card T+2, netbanking T+2, wallet T+1, and they are business-day aware. Exceeding the window gives `TIMING_WINDOW_EXCEEDED`, never a silent pass.

**Exception taxonomy** (string enum): AMOUNT_MISMATCH, FEE_GST_MISMATCH, REFUND_AMOUNT_MISMATCH, MISSING_SETTLEMENT, MISSING_BANK_CREDIT, MISSING_LEDGER_ENTRY, DUPLICATE_LEDGER_ENTRY, TIMING_WINDOW_EXCEEDED, AMBIGUOUS_BATCH, SUGGESTED_MATCH, UNIDENTIFIED_BANK_CREDIT.

**Exposure classes**: each exception type maps to one of `AMOUNT_AT_RISK`, `AWAITING_SETTLEMENT`, or `STRUCTURAL`. Report exposure per class and never as a single summed number. An unknown type defaults to AMOUNT_AT_RISK.

## Phase 3: Constrained AI layer
The AI never decides financial truth and never mutates financial tables. It has exactly three jobs:
1. **Narration parsing**: turn messy bank narration into `{utr?, counterparty?, channel?, reference?}`, validated by zod. It's used only as an extra input to fuzzy matching, and the deterministic scorer still decides.
2. **Exception explanation**: the input is a read-only evidence bundle (the records involved and the rule that fired). The output is a zod-validated `{root_cause, explanation, confidence, evidence_ids[], recommended_action, requires_human_review}`. Reject the output if it cites evidence ids that weren't in the bundle.
3. **Journal entry drafting**: propose a correcting entry (e.g. booking the missing GST on fees) as a DRAFT only, with status `pending_approval`.

If there's no key, a timeout, a malformed response, or a schema failure, use the deterministic fallback, and record why in the audit trail. Every output carries `source: "llm" | "deterministic_fallback"`.

**Audit trail**: an append-only table with uuid ids recording every run, investigation, draft, approval and escalation, with actor (`system` | `llm` | `human`) and timestamp.

## Phase 4: MCP server (most important for the demo)
- stdio server, runnable with one command: `npx closeloop-mcp` (set up the bin entry). Make the first run work instantly: if the database is empty, generate the seeded demo data automatically.
- Tools, all with zod input schemas and clear descriptions written for an LLM to read:
  - `run_reconciliation({ from, to })`: a summary of matched (exact / fuzzy / batch) counts, exceptions by type, and exposure by class
  - `list_exceptions({ type?, min_amount_paise?, status?, limit? })`
  - `get_evidence({ exception_id })`: all records involved plus the rule trace
  - `explain_exception({ exception_id })`
  - `decompose_bank_credit({ bank_line_id })`: shows the settlement set it found, or the ambiguous candidate sets
  - `draft_journal_entry({ exception_id })`: draft only
  - `approve_suggestion({ id, reviewer })` and `escalate({ id, reviewer, note })`: human actions, written to the audit trail
  - `get_audit_trail({ entity_id? })`
- Resource: `closeloop://summary/latest`.
- No tool may delete data or modify payments, settlements, bank lines or ledger entries.
- Include a ready-to-paste Claude Desktop config snippet in the README.

## Phase 5: Evaluation and tests
- `pnpm eval` runs generate → reconcile on an isolated in-memory DB and prints the following on **dev and held-out separately**:
  - match rate by match kind
  - exception precision and recall per type
  - false positives and false negatives
  - batch decomposition success rate and ambiguity rate
  - fuzzy recovery rate
  - throughput
  - exposure by class
- It also writes `EVAL.md` from the actual run. **Never hardcode or invent numbers anywhere, including the README.** If held-out is below 100%, show the misses and categorize why.
- Tests (vitest), at minimum:
  - paise arithmetic and GST
  - each exception type
  - a batch decomposition with a unique solution, an ambiguous one, and none
  - the time budget is respected on a pathological input
  - fuzzy thresholds
  - business-day windows
  - the matcher cannot read ground truth
  - LLM schema rejection and fallback paths (mock the provider)
  - fabricated evidence ids are rejected
  - MCP tools reject mutation and return valid schemas
  - audit ids are unique under burst writes
  - generator reproducibility
- Add a GitHub Actions workflow that runs typecheck, lint and tests.

## Phase 6: Minimal dashboard (only after Phases 1–5 pass)
A Next.js page showing:
- summary cards and exposure by class
- an exception queue with filters
- an exception detail view with evidence, explanation and audit history
- a batch decomposition visual (one bank credit splitting into N settlements)
It reads from the same core package. Keep it clean and simple.

## Repo structure
Use a pnpm workspace: `packages/core` (generator, matcher, AI layer, audit), `packages/mcp`, `apps/dashboard`, `scripts/`, `config/`.

## README requirements
- A one-line pitch, and an architecture diagram (Mermaid)
- A "Try it in 60 seconds" section: `npx closeloop-mcp` plus the Claude Desktop config, then example questions like "What's unreconciled in October and why?" and "Break down the largest unmatched bank credit."
- Design principles (the trust boundary between deterministic matching and AI)
- An evaluation section linking to the generated EVAL.md
- An honest **Known limitations** section (e.g. synthetic data only, single currency, no real bank or Tally connectors yet)
- Credits: "Design principle of deterministic truth with constrained AI inspired by RazorRecon (https://github.com/Ragh234/RazorRecon). CloseLoop is an independent implementation focused on batch decomposition, fuzzy matching and multi-source ledgers."

## How to work
1. First, write `PLAN.md` with your design decisions, the batch decomposition algorithm and its complexity bounds, the schema, and the phase checklist. Wait for my approval.
2. Then implement one phase at a time. After each phase, run typecheck and tests, fix failures, show me a short summary, and commit with a clear message. Don't move on with failing tests.
3. Create `CLAUDE.md` with the project conventions (paise only, no AI mutation, zod everywhere, tests required).
4. Prefer simple, readable code over clever abstractions. Add comments only where the finance logic is non-obvious.
5. If something in this spec is ambiguous or a better approach exists, tell me and propose an alternative rather than guessing silently.