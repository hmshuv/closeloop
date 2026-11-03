# CloseLoop — Implementation Plan

## Context
You want a portfolio-grade, MCP-native reconciliation agent for Indian finance teams, built from scratch in TypeScript. The full spec is `/Applications/RazorRecon-main/PLAN.md`. The current folder holds the original Python RazorRecon, which serves only as design inspiration: **I will not read or copy its code.** CloseLoop goes in a new sibling repo, `/Applications/closeloop`. Work proceeds **one phase at a time**. After each phase I run typecheck, lint and tests, show a short summary, commit, and **stop and wait for your go-ahead** before starting the next phase.

Decisions you confirmed:
- New folder `/Applications/closeloop`, with a fresh `git init`. The spec is copied there as `SPEC.md`, and `PLAN.md` there becomes the design doc (this plan).
- Extra dependencies approved: eslint, typescript-eslint, tsx, @types/better-sqlite3, @types/node. **No Anthropic SDK.**
- **LLM**: keep the `LLMProvider` interface and ship one implementation, `OpenAICompatibleProvider`, which calls `POST {LLM_BASE_URL}/chat/completions` with the built-in `fetch`.
  - Configured in `.env` with `LLM_BASE_URL`, `LLM_API_KEY` and `LLM_MODEL`. If any is missing, the deterministic fallback runs.
  - **Timeouts**: each call uses an `AbortController` timeout (default 15 s).
  - **Rate limits**: an HTTP 429 gets **one retry**. The delay honors `Retry-After`, capped at 5 s, with a default of 1 s. A second 429 or any other failure goes to the deterministic fallback, and the reason (`rate_limited`, `timeout`, `http_<code>`, `malformed_json`, `schema_invalid`, `fabricated_evidence`) is recorded in the audit trail.
  - An Anthropic provider can be added later behind the same interface.
  - `.env` is loaded with Node's built-in `process.loadEnvFile()`. `.env` goes in `.gitignore`, and `.env.example` is committed.
  - The README documents setup for Groq (`https://api.groq.com/openai/v1`), Google AI Studio (`https://generativelanguage.googleapis.com/v1beta/openai`) and OpenRouter (`https://openrouter.ai/api/v1`), each with an example model.
- Settlement ↔ bank stage order is **exact → fuzzy → batch** (a → c → b), with a conflict rule:
  - Only `MATCHED_FUZZY` settlements leave the batch candidate pool. `SUGGESTED_MATCH` settlements stay in it.
  - If a **unique** batch solution includes a settlement that has a pending `SUGGESTED_MATCH`, neither is auto-matched. A `MATCH_CONFLICT` exception is raised for human review, linking the bank credit, the batch set and the conflicting suggestion(s).
  - `MATCH_CONFLICT` is added to the taxonomy with STRUCTURAL exposure, and it gets a dedicated test.

## Design decisions (also proposals to flag)
1. **Money**: a branded `Paise` type, which is a JS `number` that must satisfy `Number.isSafeInteger` (asserted in zod via `.int().safe()`). The only divisions are fee and GST calculations, done in integer arithmetic with explicit round-half-up (`Math.floor((a*rateBps + 5000)/10000)`). No floats ever hold money.
2. **Ground-truth isolation is stronger than the spec asks.** Ground truth lives in a **separate SQLite file** (`truth.db`), not just a separate table. The matcher only ever receives a handle to `closeloop.db`. Tests check this two ways: the matcher handle has no `truth_labels` table, and a static check confirms that nothing under `core/src/matcher/**` imports `generator/` or `truth/`.
3. **Financial tables are insert-only at the database level.** SQLite `BEFORE UPDATE/DELETE` triggers on payments, refunds, settlements, settlement_items, bank_lines and ledger_entries call `RAISE(ABORT)`. The same triggers on `audit_log` make the audit trail append-only. Reseeding recreates the DB file.
4. **Batch budget exhaustion**: auto-matching requires proven uniqueness.
   - If the budget runs out after finding 1 solution → `AMBIGUOUS_BATCH` with `uniqueness_proven:false`.
   - If it runs out with 0 solutions → `UNIDENTIFIED_BANK_CREDIT`, and the trace records `budget_exhausted`.
5. **In-window items are not exceptions.** A captured payment whose settlement window has not elapsed by the run's `as_of` date is reported as `pending_in_window` and counted, not raised as `MISSING_SETTLEMENT`.
6. **Amount mismatches carry a subtype.** `AMOUNT_MISMATCH` has `subtype: ROUNDING | MATERIAL`. The default threshold is ≤100 paise and lives in config. Matching itself stays exact.
7. **Three-way ledger model (your change)**:
   - The generator books **one Receipt per bank credit** (party "Razorpay Software Pvt Ltd", reference = bank UTR, with noise for wrong or absent references and duplicates). It also books **one Journal per settlement** for fees + GST.
   - Stage 3 becomes **bank_lines ↔ ledger receipts**: match by normalized reference first, then by amount + date (±2 business days) + party.
   - Journals are checked against each settlement's summed fee and GST.
   - A payment is "in the books" through the chain payment → settlement → bank credit → receipt.
   - **Period-end tie-out**: Σ bank credits vs Σ ledger receipts for the period. The engine itemises differences already explained by exceptions; any **unexplained residual ≠ 0** raises `BANK_LEDGER_MISMATCH`. A per-line amount mismatch on a reference-matched receipt also raises `BANK_LEDGER_MISMATCH`. This type is new, with AMOUNT_AT_RISK exposure.
8. **LLM JSON**: the request sends `response_format: {type:"json_object"}`. If the provider rejects that (HTTP 400 naming response_format), the call is retried without it, and that is remembered per provider instance. Before zod validation, the first balanced `{…}` block is always extracted from the text, which also strips code fences.
9. **MCP stdout hygiene**: stdout carries the MCP protocol only. A single `log()` helper writes to stderr, and no `console.log` appears anywhere in packages/mcp or in the core code paths it calls (enforced by an eslint `no-console` override that allows only `console.error`). A test spawns the server, runs a session, and asserts that every stdout line parses as JSON-RPC.
10. **Bank holidays**: `config/windows.json` holds the per-method windows (UPI T+1, card T+2, netbanking T+2, wallet T+1) and a calendar. Sundays, the 2nd and 4th Saturdays (RBI rule) and a listed 2026 holiday array are non-business days.
11. **Dates**: demo data covers **2026-09-17 → 2026-10-31**, so "What's unreconciled in October?" works. Timestamps are IST ISO strings (`+05:30`), and dates are `YYYY-MM-DD`.
12. **LLM cost control**: narration parsing runs only on bank lines still unmatched after exact UTR matching. Results are cached in `ai_outputs` by narration hash.
13. **`npx closeloop-mcp`**: works from the repo root through the workspace-linked bin. In Phase 5 the package is **made publish-ready** so it also works outside the repo:
    - The publishable package is `closeloop-mcp`. It bundles core through a tsc build with core as a regular dependency, also published as `@closeloop/core`, or it inlines core. I'll choose whichever keeps `npm pack` clean and explain the choice then.
    - Package metadata: `files`, `bin`, `engines`, `prepublishOnly: build`, a shebang, and `config/` defaults shipped in the package.
    - Verified with `npm pack` → install the tarball into a temp dir → run it.
    - You do the actual publish.
    - The default DB is `~/.closeloop/closeloop.db`; override it with `CLOSELOOP_DB`.

## Batch decomposition algorithm
Input: one unmatched bank credit with amount `T`. The candidate pool `C` is unmatched settlements, minus those already taken by `MATCHED_FUZZY` (settlements with a pending `SUGGESTED_MATCH` stay in), with `settled_at ∈ [credit_date − W_batch, credit_date]` (`W_batch` comes from config, default 7 business days) and `amount ≤ T`.

The steps run in this order:
1. **Prefilter**: if `sum(C) < T`, there is no solution. If `sum(C) == T`, the whole pool is one solution, but keep searching because a smaller subset could also sum to `T`.
2. **n ≤ 36: meet-in-the-middle**, which gives an exact solution count.
   - Split `C` into halves A and B.
   - Enumerate each half's 2^(n/2) subset sums into sorted arrays, then count pairs summing to `T` with two pointers. Keep up to K=5 concrete sets for display.
   - Cost depends **only on n**, not on `T`: time O(2^(n/2) · n), memory O(2^(n/2)). At n=36 that is at most 262,144 sums per half.
3. **n > 36: DFS branch-and-bound.**
   - **Complement trick (DFS only)**: if `sum(C) − T < T`, search for the *excluded* subset summing to `sum(C) − T`. This is the same problem, but pruning bites earlier because the target is smaller. A large consolidated payout that uses most of the pool then becomes a search for the few excluded items.
   - Candidates are sorted descending, with suffix sums precomputed.
   - Prune a branch when `remaining > suffixSum[i]` (the remaining items can't reach the target) or when a candidate is larger than what remains.
   - Stop as soon as a 2nd solution is found, because that proves ambiguity.
   - Hard limits: a time budget (default 250 ms per credit, from config) and a node budget, both checked every 4,096 nodes.
   - Worst case is O(2^n). The budget caps it, which is why decision 4 exists.
4. **Outcome**:
   - Exactly 1 solution, proven unique, with no settlement in a pending `SUGGESTED_MATCH` → match with reason `BATCH_DECOMPOSED`.
   - Exactly 1 solution, proven unique, but it includes a suggested-match settlement → `MATCH_CONFLICT`. Neither the batch nor the suggestion is auto-matched.
   - ≥2 solutions → `AMBIGUOUS_BATCH`, with candidate sets attached.
   - 0 solutions → `UNIDENTIFIED_BANK_CREDIT`.

Credits are processed largest first. Settlements consumed by a unique batch leave the pool before the next credit is processed.

## Fuzzy matching
1. **Extract tokens.** Find UTR-like tokens in the narration with a regex, alphanumeric and 10–22 characters long. Also try joins of 2–3 adjacent short tokens, which handles UTRs with spaces inserted. Add the LLM-parsed `utr` if one exists.
2. **Normalize** each token: uppercase, strip spaces and hyphens.
3. **Score** each token against each unmatched settlement UTR with **normalized Levenshtein**, `1 − dist / max(len)`. Jaro-Winkler is not used because same-bank UTRs share long prefixes, and its prefix bonus would inflate their similarity. A truncated UTR is handled by scoring the token against the same-length prefix/suffix of the settlement UTR, with a length penalty.
4. **Combine**: `score = 0.75·utrSim + 0.15·amountScore + 0.10·dateScore`.
   - `amountScore` is 1 for an exact amount match and decays with relative delta.
   - `dateScore` is 1 inside the window and decays per business day outside it.
5. **Decide**:
   - Score ≥ 0.97 **and** exact amount **and** best − second-best ≥ `margin` (default 0.05, in config) → `MATCHED_FUZZY`.
   - If the margin check fails, or 0.80 ≤ score < 0.97 → `SUGGESTED_MATCH`, with the top candidates attached.
   - Below 0.80 → unmatched.

The weights, thresholds and margin live in config. The trace stores every component of the score plus the runner-up. A test uses two settlements whose UTRs share a long prefix and checks that the margin rule downgrades the match to SUGGESTED_MATCH.

## Exposure classes
| Class | Exception types |
|---|---|
| AMOUNT_AT_RISK | AMOUNT_MISMATCH, FEE_GST_MISMATCH, REFUND_AMOUNT_MISMATCH, MISSING_BANK_CREDIT, UNIDENTIFIED_BANK_CREDIT, BANK_LEDGER_MISMATCH, (unknown → default) |
| AWAITING_SETTLEMENT | MISSING_SETTLEMENT, TIMING_WINDOW_EXCEEDED |
| STRUCTURAL | MISSING_LEDGER_ENTRY, DUPLICATE_LEDGER_ENTRY, AMBIGUOUS_BATCH, SUGGESTED_MATCH, MATCH_CONFLICT |

## Schema (closeloop.db)
- Financial tables, insert-only through triggers:
  - `payments(id, order_id, amount_paise, method, status, captured_at)`
  - `refunds(id, payment_id, amount_paise, created_at)`
  - `settlements(id, utr, amount_paise, settled_at)`
  - `settlement_items(id, settlement_id, entity_type, entity_id, gross_paise, fee_paise, gst_paise, net_paise)`
  - `bank_lines(id, txn_date, narration, credit_paise, debit_paise, balance_paise)`
  - `ledger_entries(id, entry_date, voucher_type, party, amount_paise, reference, narration)`
- Recon tables:
  - `recon_runs(id uuid, from_date, to_date, as_of, started_at, finished_at, config_hash, summary_json)`. The summary includes the tie-out.
  - `matches(id, run_id, kind EXACT|FUZZY|BATCH|LEDGER_REF|LEDGER_ATTR|JOURNAL|HUMAN_APPROVED, left_type, left_id, right_type, right_id, confidence, reason_code, trace_json)`
  - `exceptions(id, run_id, type, exposure_class, amount_paise, subtype, primary_type, primary_id, related_json, trace_json, status open|approved|escalated)`
  - `batch_candidate_sets(exception_id, set_index, settlement_ids_json)`
- AI and audit tables:
  - `ai_outputs(id, kind, key, source, fallback_reason, payload_json, created_at)`
  - `journal_drafts(id, exception_id, status 'pending_approval', lines_json, source, created_at)`
  - `audit_log(id uuid, ts, actor system|llm|human, action, entity_type, entity_id, payload_json)`, append-only
- **truth.db** (separate file): `truth_labels(entity_type, entity_id, noise_kind, expected_exception, expected_match_kind, split, details_json)`

## Data split (honest evaluation)
- The split is chronological. Payments captured on days 1–36 go to **dev** and days 37–45 to **held-out**, which is about 80/20. Settlements, bank lines and ledger entries follow their payments, and consolidated credits only form within one split.
- Held-out adds **two noise variants the rules were never written around**:
  1. A new narration format with the UTR split across tokens and prefixed differently, e.g. `BY TRANSFER/RZP PAYOUTS/REF AXIS N2410 29.../IMPS`.
  2. OCR-style character confusions in UTRs (O↔0, I↔1, S↔5, B↔8).
- Eval loads each split into its own `:memory:` DB pair and reconciles them separately.
- **Minimum support**: the generator guarantees at least `min_per_type` labelled cases (default 15, in config) of **every** exception type in held-out. It boosts noise injection within held-out until each type is covered, and eval fails loudly if a type is still short. Every metric is printed with its `n`.
- **Consolidated credits**: sizes are drawn mostly from 2–15 settlements, with a small tail up to 40. All settlements in a consolidated credit are settled within `W_batch` business days before the credit date.

## Repo layout
```
/Applications/closeloop
  package.json (workspace root; scripts: gen, eval, build, typecheck, lint, test)
  pnpm-workspace.yaml, tsconfig.base.json (strict), eslint.config.js, vitest.config.ts
  SPEC.md, PLAN.md, CLAUDE.md, README.md, EVAL.md (generated), .env.example
  config/windows.json, config/fees.json, config/matching.json
  packages/core/src/
    money.ts, calendar.ts, config.ts, db/{schema.ts,open.ts}, types.ts (zod)
    generator/{rng.ts,generate.ts,noise.ts,split.ts,load.ts}, truth/{store.ts}
    matcher/{stage1-items.ts,stage2-exact.ts,stage2-fuzzy.ts,stage2-batch.ts,stage3-ledger.ts,stage4-timing.ts,tieout.ts,run.ts,exposure.ts}
    matcher/subsetsum.ts, matcher/similarity.ts
    ai/{provider.ts,openai-compatible.ts,narration.ts,explain.ts,journal.ts,fallback.ts}
    audit/audit.ts, eval/{score.ts,report.ts}
  packages/mcp/src/{server.ts,tools.ts,bin.ts}  (bin: closeloop-mcp)
  apps/dashboard/ (Phase 6 only)
  scripts/{gen.ts,eval.ts}
  .github/workflows/ci.yml
```

## Phase checklist. I stop after each phase for your review.
- **Phase 0, scaffold**: create the folder, `git init`, set up the workspace, strict tsconfig, eslint, vitest, CLAUDE.md, SPEC.md and PLAN.md (this design), add one smoke test. *Verify*: `pnpm typecheck && pnpm lint && pnpm test` pass. Commit, then **stop**.
- **Phase 1, generator**: seeded RNG (mulberry32), domain generation, every noise kind with configurable rates and truth labels, the 80/20 split with the 2 held-out-only variants, and `pnpm gen --seed 42 --payments 5000`. *Tests*: paise and GST arithmetic, reproducibility (same seed gives an identical hash), balance continuity on bank lines, label coverage. *Show*: row counts and noise counts. Commit, then **stop**.
- **Phase 2, matcher**: stages 1→4, with stage 2 run as exact → fuzzy → batch and stage 3 matching bank ↔ ledger receipts plus the journal checks. Also the period-end tie-out, the exception taxonomy, exposure classes, and run persistence. *Extra tests*: the fuzzy margin with prefix-sharing UTRs, BANK_LEDGER_MISMATCH both per line and from an unexplained tie-out residual. *Tests*: each exception type, batch unique / ambiguous / none, a time budget on a pathological input (for example 60 equal-ish amounts) finishing within the budget plus slack, fuzzy thresholds, business-day windows, **MATCH_CONFLICT when a unique batch includes a suggested-match settlement**, and that the matcher cannot read ground truth. *Show*: summary on seed 42. Commit, then **stop**.
- **Phase 3, AI layer**: the `LLMProvider` interface and the fetch-based `OpenAICompatibleProvider` (timeout, a single retry on 429, `response_format` plus JSON-block extraction). zod-validated narration, explanation and journal outputs. Rejection of fabricated evidence ids. Deterministic fallbacks that record `fallback_reason`, and the audit trail. *Tests*: using a mock provider and a mocked `fetch`, each case must fall back correctly: malformed JSON, schema failure, fabricated ids, timeout, 429 followed by success (no fallback), and 429 followed by 429. Audit ids stay unique under a burst of 10k writes. If you have a free Groq, AI Studio or OpenRouter key in `.env` by then, I'll also run one live smoke test. Commit, then **stop**.
- **Phase 4, MCP server**: the 9 tools plus the `closeloop://summary/latest` resource, zod input schemas, auto-seeding on an empty DB, the bin entry, and a README Claude Desktop snippet. *Tests*: an in-process MCP client calls every tool, outputs validate against their schemas, and mutation attempts are rejected. A spawned stdio server must emit only JSON-RPC on stdout, with all logs on stderr. *Verify*: drive the server over stdio once by hand. Commit, then **stop**.
- **Phase 5, eval + CI**: `pnpm eval` prints dev and held-out metrics (match rate by kind, precision and recall per type, FP/FN, batch success and ambiguity, fuzzy recovery, throughput, exposure by class) and writes `EVAL.md` from that run, with categorized held-out misses. Add the GitHub Actions workflow (typecheck, lint, test) and the full README (Mermaid diagram, "Try it in 60 seconds", principles, limitations, credits), with no hand-written numbers. Also the npm publish prep: `npm pack`, a tarball install in a temp dir, and `npx closeloop-mcp` starting from there. You publish it yourself. Commit, then **stop**.
- **Phase 6, dashboard** (only once Phases 1–5 are green): Next.js and Tailwind. Summary cards and exposure by class, an exception queue with filters, a detail view (evidence, explanation, audit history), and a batch decomposition visual. It reads `@closeloop/core` directly in server components. *Verify*: run the dev server and check each page. Commit, then **stop**.

## Verification, every phase
`pnpm typecheck && pnpm lint && pnpm test` must all be green before committing. Phase-specific checks are listed above. Commits stay local; I won't push to a remote unless you ask.

## Decisions log (made during implementation)
- **Phase 0**: TypeScript is pinned to `~6.0.3` (typescript-eslint 8 supports < 6.1). `@types/node` is pinned to v20 so the code stays within the Node 20 API. pnpm 11 uses `allowBuilds` (better-sqlite3, esbuild).
- **Phase 1, money type**: `Paise` is a plain `number` alias validated by `PaiseSchema` / `assertPaise`, not a branded type. Branding forced re-wrapping after every sum without adding safety beyond the zod/STRICT-table checks.
- **Phase 1, eval sizing (your decision)**: `pnpm gen` keeps the spec default of 5,000 payments (~300 settlements) for the demo. Eval uses a larger dataset, and CI runs `pnpm eval --payments 5000` as a smoke check. **Noise rates are realistic and never inflated to hit the per-type minimum**; the dataset grows instead. The generator only *reports* held-out coverage, and eval enforces it.
- **Phase 1, scaling**: `generateDataset({ days })` can lengthen the period, so a larger dataset can keep the demo's daily volume.
- **Phase 1, coverage measured** (seed 42, realistic rates): the scarcest held-out targets have 2 at 25k payments, 9 at 100k and 14 at 150k. Reaching 15 per type needs roughly 150k+ payments. The size the full eval uses is still open (see the Phase 1 summary).
- **Phase 1, consolidation share**: 20% of settlements arrive inside consolidated credits (sizes mostly 2–15, a 10% tail up to 40, always within `W_batch`).
- **Phase 1, ambiguity traps**: built from twin settlements with identical subscription-price baskets, so their nets are equal. One twin arrives inside a consolidated credit and the other never arrives. Because the right answer is undecidable, the expected output is `AMBIGUOUS_BATCH`, and the twin itself carries no expected exception.
- **Phase 1, ground-truth isolation**: truth readers are exported only through the `@closeloop/core/truth` subpath, never from the package root. The recon DB's metadata omits the held-out boundary.
- **Phase 1, held-out-only variants**: `HELDOUT_NARRATION_FORMAT` (an IMPS-INF payout narration with a dot-separated UTR after `REF`) and `HELDOUT_OCR_CONFUSION` (0↔O, 1↔I, 5↔S, 8↔B).
- **Phase 1→2, eval design (your decision)**: the full eval uses **8 independent 25k-payment datasets** with seeds fixed up front in `config/generator.json` (`eval_seeds`). Each dataset is reconciled on its own. The report gives pooled held-out metrics plus min/median/max across seeds for each metric. Seeds are consumed in their fixed order, and the stopping rule depends **only on truth label counts** (per-type held-out n ≥ min), never on matcher results. EVAL.md lists the seeds, sizes and per-type n, plus the total runtime. CI runs `pnpm eval --payments 5000` as a smoke check.
- **Phase 2, fuzzy thresholds (your decision)**: thresholds use **edit distance on the normalized UTR**, not a ratio. Exact amount and a settlement-date window are hard requirements for auto-matching.
  - Distance ≤ 1 and a ≥ 0.05 similarity margin over the runner-up → `MATCHED_FUZZY`.
  - Distance 2, or a truncated UTR → `SUGGESTED_MATCH`.
  - The displayed confidence (1 − d/len) is shown but never used as a threshold.
  - **Exact or distance-1 UTR with a different amount**: link the bank line to the settlement and raise `AMOUNT_MISMATCH` (ROUNDING/MATERIAL) instead of leaving it unidentified.
  - Generator consequence: conflict decoys are now exactly distance 2 from the settlement UTR, so a correct matcher suggests (not auto-matches) them.
- **Phase 2, batch model (your decision): both approaches combined.** The default window is **W = 2 business days**, and it is configurable. Measured on seed 42: at 25k payments/45 days, W = 7 gave candidate pools of up to 128 settlements, and most credits came back ambiguous. Once a pool holds about 25 or more ₹-lakh-scale amounts, other subsets genuinely hit the same paise total.
  - **2b-i, contiguous runs**: a run of settlements consecutive in `created_at` order whose sum equals the credit, found by an O(n) sliding window. Exactly one run → `BATCH_CONTIGUOUS`, unique **only under the payout-model assumption**. The trace carries the assumption text, plus the arbitrary-subset search's verdict when that search was cheap enough to run.
  - **2b-ii, arbitrary subsets (proof-only)**: meet-in-the-middle / branch-and-bound. Unique → `BATCH_DECOMPOSED`. Multiple, or budget exhausted → `AMBIGUOUS_BATCH` with the top K candidate sets, ranked by fewest contiguous blocks and then by closest settlement dates.
  - **Possible members are reserved**: every pool settlement of an unresolved credit goes into that AMBIGUOUS_BATCH, not MISSING_BANK_CREDIT. A settlement is only "missing" when no open credit could contain it.
  - **Settlement `created_at`** (an IST timestamp) is added to the schema, so same-day settlements have a real order.
  - **Generator**: about 75% of consolidations are contiguous (weekends/holidays/held-funds releases) and about 25% arbitrary. Labels record the *actual* contiguity, and held-out always gets at least one non-contiguous payout.
  - EVAL.md (Phase 5) will report batch results per match kind and per daily volume, explain why amount-only decomposition turns ambiguous at scale, and note that production systems use gateway payout reports.
- **Phase 2, other engine decisions**:
  - **Fuzzy runs before batch.** Credits holding a pending suggestion are excluded from batch search, because they are waiting for a human.
  - **Single-settlement solutions are allowed.** A credit that exactly equals one unmatched settlement inside the window, with no UTR evidence, is a valid size-1 decomposition. It is reported with `set_size: 1` in the trace.
  - **Receipt matching** runs by reference (normalized alphanumerics found in the narration, within a date tolerance of 2 business days) and then by amount + date + party alias. A second receipt against the same credit is a `DUPLICATE_LEDGER_ENTRY`. A receipt with no credit is `BANK_LEDGER_MISMATCH` (`RECEIPT_WITHOUT_BANK_CREDIT`). A credit without a receipt is `MISSING_LEDGER_ENTRY` once the one-business-day booking grace has passed.
  - **Journal checks**: one Journal per settlement, by settlement-id reference, with amount = Σ(fee + GST). A missing journal is `MISSING_LEDGER_ENTRY` (`JOURNAL`), and a wrong amount is `AMOUNT_MISMATCH`.
  - **Tie-out**: Σ credits − Σ receipts in the period = the reconciling items (unreceipted credits, duplicates, unmatched receipts, amount differences, cross-period timing). A non-zero residual raises `BANK_LEDGER_MISMATCH` (`UNEXPLAINED_TIE_OUT_RESIDUAL`) on the period. On generated data the residual is 0, so it works as an integrity guard.
  - **Run scope**: `run_reconciliation({from, to})` matches every record dated ≤ `to` (so earlier settlements give context) and reports exceptions and matches whose anchor date falls in [from, to].
  - **In-window items are not exceptions**: captured payments whose window hasn't elapsed by `to`, and credits still inside the receipt grace, are counted under `pending`.
- **Phase 2 follow-ups (your decisions)**:
  - **Single-settlement batches**: auto-match only if the narration names the gateway (`batch.single_settlement_gateway_patterns`, default RAZORPAY/RZPY/RZP) **and** the settlement is unique in the pool, meaning no other pool settlement has the same amount and the subset search proved uniqueness. Otherwise → `SUGGESTED_MATCH` (`gateway_not_identified` / `not_unique_in_pool`).
  - **Deferred missing credits**: possible members of an open AMBIGUOUS_BATCH / MATCH_CONFLICT are persisted in `settlement_reviews` with status `unresolved_in_batch`, linked to that exception, and counted in `summary.pending.unresolved_in_batch`. `approveBatchCandidate()` (core, `review/batch.ts`, for Phase 4's approve tool) records HUMAN_APPROVED links, closes the exception, then re-evaluates each leftover:
    - still a possible member of another open batch → stays deferred there
    - past its bank-credit date → raises `MISSING_BANK_CREDIT`
    - otherwise → released
  - Eval (Phase 5) will report missing-credit outcomes as **detected / deferred-to-human / missed**.
  - **DEMO.md** is generated by `pnpm demo:cases` from an actual October run on the default demo dataset (seed 42, 5k payments). Nothing in it is hand-picked.
- **Phase 3, AI layer**:
  - **Provider**: `LLMProvider` interface, plus a fetch-based `OpenAICompatibleProvider` configured from `.env`.
    - Each attempt has a 15 s AbortController timeout.
    - An HTTP 429 gets one retry (honouring `Retry-After`, capped at 5 s), and the second 429 → `rate_limited`.
    - `response_format: json_object` is requested. If the provider rejects it, the call is retried without it and that is remembered. The first balanced `{…}` is always extracted before zod.
  - **Every output** carries `source` and `fallback_reason`. Reasons: no_provider / timeout / rate_limited / network / http_N / malformed_json / schema_invalid / fabricated_evidence / unbalanced_entry.
  - **Narration parsing** is used only for credits with no exact UTR. It may add only **grounded** tokens (present in the narration once reduced to alphanumerics), and the matcher re-checks grounding itself. The deterministic scorer decides. Results are cached by narration hash in `ai_outputs`. Usage is aggregated into the run's audit event, not one event per narration.
  - **Explanations** are built from a read-only evidence bundle (`review/evidence.ts`, which the Phase 4 `get_evidence` tool reuses).
    - Rejected if any cited id is not in the bundle.
    - `requires_human_review` has a policy floor the model can raise but never lower: review is required for everything except TIMING_WINDOW_EXCEEDED and ROUNDING amount mismatches.
    - The deterministic template explanation is built from the rule trace.
  - **Journal drafts**: the deterministic template is the source of amounts. A model proposal is accepted only if it uses chart-of-accounts accounts, balances, and totals exactly the template amount. Drafts are stored with `status = 'pending_approval'` (DB CHECK) and never posted. Exceptions that need a matching decision get no draft.
  - **Prompt injection**: narrations, references and ledger text are wrapped in `<untrusted_data>` delimiters (inner delimiter strings neutralised), with a system preamble. The tests cover a hostile model plus an injected narration and ledger entry: match and exception sets are identical to a no-AI baseline, financial-table hashes are unchanged, and the explanation is still schema-valid (fallback: `fabricated_evidence`).
  - **Audit**: `audit_log` is append-only (triggers) with uuid ids and actor system/llm/human. It records every run (with AI usage), investigation, journal draft and batch approval. Escalation lands in Phase 4.
  - **No live LLM smoke test yet**: no `.env` key is configured. Every provider path is covered by tests with a mocked `fetch`.
- **Phase 3→4, live LLM (Groq, `openai/gpt-oss-120b`)**: the smoke test surfaced two real issues.
  - **Empty answers under JSON mode.** The reasoning model spent its whole token budget on reasoning, and Groq rejected the empty output as `json_validate_failed`. Fix: optional `LLM_REASONING_EFFORT` (sent as `reasoning_effort`), larger token budgets, and `json_validate_failed` → `malformed_json`.
  - **Rate limiting.** The free tier is about 8k tokens/minute, and 4 parallel narration calls exhausted it, starving the explanations. Fix: `config/ai.json` with sequential narration parsing and a per-run call budget (default 8).
  - The explainer had been adding raw paise itself, so prompts now carry `*_inr` strings and say "never compute". Re-tested live: narration hints grounded 10/12, and explanations are LLM-sourced, cite only bundle ids and quote ₹ strings.
- **Phase 4, MCP server (your additions)**:
  - **Responses**: every tool response carries `amount_paise` + `amount_inr` and pre-computed totals, starts with a one-line summary, and has a zod `outputSchema` (validated by the SDK server side). Lists are paginated, 20 per page by default, with an opaque cursor bound to the query.
  - **Two-step human actions**: `approve_suggestion` and `escalate` first return a preview and a single-use confirm token (5-minute TTL), then need the token plus a non-blank `reviewer`. A missing reviewer or a token presented for a different exception is rejected **without** using the token up; reused and expired tokens are rejected.
  - **Annotations**: `readOnlyHint` on read tools, `destructiveHint` on approve/escalate.
  - **`month_end_review` prompt**: summary → top AMOUNT_AT_RISK exceptions → batch cases, chosen by the same `showcaseCases()` that writes DEMO.md.
  - **Entry point**: `npx closeloop-mcp` from the repo root currently runs the TS sources through tsx. Phase 5 replaces this with a built, publishable package.
  - **stdout hygiene**: verified by a spawn test (every stdout line parses as JSON-RPC 2.0, logs on stderr), by a manual stdio session, and with MCP Inspector `--cli` (tools/list, prompts/list, tools/call).
- **Phase 5 (your additions)**:
  - **npm name**: `npm view closeloop-mcp` → 404, so the unscoped name is free and no scoped name is needed.
  - **Package build**: the MCP package is bundled with **esbuild** (a new explicit build-only devDependency; it was already in the tree via tsx) into `dist/closeloop-mcp.js`, with core inlined. The dependencies @modelcontextprotocol/sdk and zod stay normal dependencies (better-sqlite3 too, until 0.1.1 replaced it with `node:sqlite`). Default `config/*.json` ships in the package. The `files` allowlist plus `scripts/pack-smoke.mjs` fail the build if anything outside `dist/`, `config/`, README, LICENSE or package.json would ship (`.env`, `*.db`, `~/.closeloop`, sources).
  - **Clean-install test**: `npm pack` → install the tarball into an empty temp folder (no repo) → start via `npx` → call `decompose_bank_credit`. Verified locally on macOS with Node 22 and Node 20. CI job `clean-install` runs ubuntu + macOS × Node 20 + 22 from the packed artifact.
  - **Read-only data mounts**: `CLOSELOOP_SOURCE_DB` attaches the customer's financial DB read-only. The state DB holds only engine output; unqualified table names resolve to the attached source. URI filenames are disabled in this better-sqlite3 build, so this uses a plain-path ATTACH, which SQLite opens read-only on a read-only file or mount. The source must be in rollback-journal mode.
  - **Subcommands**: `check` (one run, summary to stderr) and `seed PATH` (demo source DB in rollback-journal mode).
  - **Docker**: multi-stage image installs the same npm tarball; non-root uid 10001. `compose.yaml` seeds `./data/source.db`, then runs the server with the data mounted `:ro`, a read-only root filesystem, a tmpfs `/tmp` and `network_mode: none`. An opt-in `llm` profile reads `.env`. Verified: MCP session through `docker compose run -T`, EROFS on `/data` and on the root fs, outbound fetch blocked.
  - **Eval**: 8 fixed seeds × 25k payments. Stopping rule on truth-label counts only; dev and held-out reported separately with min/median/max across seeds. Also covers batch results by contiguity and by daily volume (5k / 12.5k / 25k sweep), fuzzy recovery by mechanism (`auto_fuzzy` vs `auto_other` amount-only vs `suggested_correct`), missing credits as detected / deferred / missed, and categorised held-out misses. `EVAL.md` and the README Results block are generated, stamped with the commit (`-dirty` if the tree had changes) and the total runtime. CI runs `pnpm eval --payments 5000`.
  - **README**: generated Results block, a "Why this exists" placeholder for you, the Mermaid architecture, "Try it in 60 seconds", design principles, "Deploying inside a customer environment", "Lessons from deployment" (reasoning-model token budget, free-tier rate limits, LLM arithmetic on paise, model churn), known limitations and credits.
  - **Phase 6 (dashboard)**: on hold at your request.
- **Phase 6, read-only dashboard (your design)**:
  - **`pnpm snapshot`** seeds the demo data and runs the October reconciliation, then records the **real MCP tool outputs** (run, list, evidence, decompose, draft) through in-process clients into `apps/dashboard/data/snapshot.json`. That file is committed (synthetic data).
    - LLM explanations, from `.env`, are generated only for the DEMO.md cases (match conflict, its decoy suggestion, the open ambiguous batch) plus the top 20 exceptions by amount. They are paced for free-tier token limits, with one retry after 60 s on rate limits. Every other exception gets the deterministic template, labelled "LLM not used".
    - Eval headline numbers come from `EVAL.json`, written by the same `pnpm eval` run as EVAL.md.
  - **Display redaction**: the synthetic data imitates a real gateway's narrations and ledger party. Because the public site must not show another company's name, the snapshot replaces gateway names with a neutral "Gateway" at write time, and fails if any remain. The engine, eval and MCP outputs are unchanged.
  - **Explanation grounding (found by the live run)**: the LLM had muddled the match-conflict explanation. The prompt now carries the engine's deterministic finding as trusted `engine_finding` that the model must stay consistent with, and requires a plain-English root cause. Facts stay deterministic; the model adds clarity.
  - **Dashboard build**: Next.js 16.4.2 + Tailwind 4.3.3, both chosen to be at least two weeks old (pnpm 11's release-age guard flagged the day-old 16.4.4 / 4.3.4). Static export (`output: "export"`, `trailingSlash`): 71 pages including every exception and batch credit. No database, API routes or runtime LLM calls. The data loads at build time with `fs`. Class-based dark mode follows the OS until toggled. Checked at phone width by rendering in 390 px iframes.
  - **Exposure classes are never summed**, including in the queue: a ₹ total appears only when a single class is selected.
  - **Vercel**: `apps/dashboard/vercel.json`. Framework "Other", filtered install, `pnpm build`, output `out/`. Steps are in `apps/dashboard/README.md`. CI also builds the dashboard.
- **0.1.1: built-in `node:sqlite` instead of better-sqlite3**:
  - **Why**: `npx -y closeloop-mcp` 0.1.0 failed on clean installs whose native binding was never built ("Could not locate the bindings file"), e.g. with `--ignore-scripts` or a Node version without a prebuilt binary. The package now has no native dependency and no install step.
  - **Adapter**: `packages/core/src/db/sqlite.ts` wraps `DatabaseSync` with the surface the engine already used (`prepare/run/get/all`, `exec`, `pragma`, `close`), so no call site changed. `transaction(fn)` is BEGIN/COMMIT/ROLLBACK, with SAVEPOINTs when nested, a ROLLBACK if COMMIT itself fails, and a refusal of async functions. Binding keeps better-sqlite3's rules: a missing named parameter throws (node:sqlite would bind NULL), and extra object keys are ignored (node:sqlite would throw).
  - **Unchanged**: the insert-only triggers, the separate `truth.db` file, and the plain-path read-only `CLOSELOOP_SOURCE_DB` attach, all covered by tests.
  - **Node**: `engines` is `>=22.13`, the first 22.x release with `node:sqlite` unflagged. `@types/node` moved to v22. CI clean-install runs ubuntu + macOS × Node 22 + 24, installing the tarball with `--ignore-scripts`.
  - **ExperimentalWarning**: Node prints it through `process.emitWarning`, which goes to stderr. The stdio test drops `NODE_NO_WARNINGS` so the warning really fires, and asserts that stdout carries only JSON-RPC and never the warning.
