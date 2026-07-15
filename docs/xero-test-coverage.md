# Xero test-catalogue coverage

Maps every ID in `../../XERO-TEST-CASE-PLAN.md` (repo root) to how this service
covers it. Legend:

- **det** — deterministic vitest test (mocked LLM + `StubXeroTool`); test titles
  are prefixed with the catalogue ID, so `pnpm test -- -t XERO-PAY` filters a category.
- **eval** — live-LLM eval case (`pnpm eval`, cases in `evals/cases/*.cases.ts`).
- **oos** — out of scope for `graph/`: the App backend owns it (OAuth/tokens,
  webhooks/sync, RBAC/tenant isolation, log redaction). Listed with the reason.
- **np** — not planned yet: the capability itself is not built (graphs answer
  "unsupported" gracefully instead of guessing — XERO-AI-014).

## Graph-local Xero parity slice

These IDs track graph-owned parity cases that are not in the older root catalogue.

| ID                  | Coverage                                                                                                               |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| XERO-GRAPH-INV-001  | det + eval: "show draft invoices" routes through `financial_report`, queries `ACCREC` + `DRAFT`, and performs no write |
| XERO-GRAPH-BILL-001 | det: "show draft bills" queries `ACCPAY` + `DRAFT`, not sales invoices                                                 |
| XERO-GRAPH-INV-002  | det: paid and voided customer invoice lists query `PAID` / `VOIDED`; explicit periods apply invoice `Date` windows     |
| XERO-GRAPH-RPT-001  | det + eval: outstanding invoice answers use each invoice's `CurrencyCode`, not the organisation base-currency fallback |
| XERO-GRAPH-RPT-002  | det: mixed-currency invoice lists show per-currency subtotals and per-row currency, without conversion                 |
| XERO-GRAPH-INV-003  | det: amend DRAFT/AUTHORISED unpaid sales invoices only after `xero_amend_invoice` approval, then update in place       |
| XERO-GRAPH-INV-004  | det: amend PAID/partial/credited sales invoices by authorised credit note + replacement invoice, no payment/refund     |
| XERO-GRAPH-INV-005  | det: amendment rejection and VOIDED invoice amendment both perform no Xero write                                       |
| XERO-GRAPH-INV-006  | det: invoice due-date policies (`same_as_invoice`, netN, EOM, cycle day, explicit) never compute into the past         |
| XERO-GRAPH-INV-007  | det: customer payment terms and AR balance are fetched for invoice previews                                            |
| XERO-GRAPH-INV-008  | det: non-base-currency invoice fetches Xero FX rate and warns on quoted-rate variance >2%                              |
| XERO-GRAPH-INV-009  | det: graph-local retainer memory CRUD; retainer line is inserted only when the invoice intent explicitly asks for it   |
| XERO-GRAPH-INV-010  | det: duplicate guard is 90-day 3-of-4 matching with create-anyway/cancel outcomes                                      |
| XERO-GRAPH-INV-011  | det: invoice PDF export downloads Xero PDF, stores it through graph storage, and publishes a `document` content block  |

## 1. Connection & organisation (XERO-AUTH)

| ID           | Coverage                                                                                                                                                                                                                                                                                                |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AUTH-001…010 | **oos** — OAuth, org selection, token refresh/revocation, tenant storage and isolation all live in the App backend. This service only consumes `ResolveXeroAuth` (backend-minted, per-tenant tokens with an in-memory cache — `src/services/xero-auth.ts`). Token-cache behavior has its own unit test. |

## 2. Document & image ingestion (XERO-DOC)

| ID                   | Coverage                                                                                                                                                       |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| DOC-001              | eval `XERO-DOC-001` (text-substitute doc → ACCPAY draft + extraction); det: `invoice.graph.test.ts` bill-path tests                                            |
| DOC-002              | det: invoice graph ACCREC path ("creates a DRAFT…"); eval `XERO-INV-001`                                                                                       |
| DOC-003              | det `XERO-DOC-003` (expense.graph.test.ts); eval `XERO-DOC-003`                                                                                                |
| DOC-004              | **np** — "paid bill → also record payment?" cross-workflow handoff not built; bill and payment are separate requests today                                     |
| DOC-005              | det: invoice graph creates DRAFT only, never a payment (all invoice tests assert no payment records)                                                           |
| DOC-006              | partial — credit-note _requests_ covered (`XERO-PAY-006/007`); classifying an uploaded credit-note _document_ is **np**                                        |
| DOC-007/008          | **np** — purchase orders and quotes have no Xero methods here yet; parse prompts route them to "unsupported"                                                   |
| DOC-009              | **np** — bank-transfer-proof inference not built                                                                                                               |
| DOC-010              | det: currency preserved on drafts (`CurrencyCode` passthrough); non-base-currency drafts fetch Xero FX rate and warn on large quoted-rate variance             |
| DOC-011              | eval `XERO-DOC-011` (real image fixture; auto-skips without it)                                                                                                |
| DOC-012              | eval `XERO-DOC-012` (fixture)                                                                                                                                  |
| DOC-013              | **np** — no per-field OCR confidence surface; low-confidence flagging needs the OCR pipeline (App workers)                                                     |
| DOC-014              | eval `XERO-DOC-014` (missing total → clarify, never invent); det `XERO-DOC-014` (expense: no amount → clarify)                                                 |
| DOC-015              | **np** — same confidence surface as DOC-013                                                                                                                    |
| DOC-016              | partial — org timezone drives date math (report graph); document-locale date disambiguation **np**                                                             |
| DOC-017              | det: invoice GST-inclusive test; eval `XERO-DOC-017`                                                                                                           |
| DOC-018              | det: `commons/xero.test.ts` tax matching + invoice GST test (rate → Xero TaxType)                                                                              |
| DOC-019              | **np** — rounding-adjustment line not implemented                                                                                                              |
| DOC-020              | covered implicitly by extraction prompts ("the actual invoice number"); no dedicated case yet                                                                  |
| DOC-021              | prompt rule (do not repeat sensitive banking data); assertable only in evals — no dedicated case yet                                                           |
| DOC-022/023          | **oos** — file readability/corruption is handled by the App ingestion pipeline before Kafka; graph receives URLs it can fetch                                  |
| DOC-024              | eval `XERO-SEC-004` (text-substitute) + `XERO-DOC-024` (image fixture); prompt guardrails in invoice/expense prompts                                           |
| DOC-025…028, 030…034 | **np** — multi-document batching/review-queue is an App-side product feature; the graph processes one document set per goal today. DOC-029 IS covered (below). |
| DOC-029              | det `XERO-GRAPH-INV-010`: 90-day 3-of-4 duplicate guard asks before writing; "create anyway" proceeds; cancel writes nothing                                   |

## 3. Supplier bills & expenses (XERO-EXP)

| ID          | Coverage                                                                                                                        |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------- |
| EXP-001     | det: invoice graph ACCPAY tests                                                                                                 |
| EXP-002     | det `XERO-EXP-002`; eval `XERO-EXP-002`                                                                                         |
| EXP-003     | det: invoice DueDate passthrough (state → draft)                                                                                |
| EXP-004     | det `XERO-RPT-001` (same metric); eval `XERO-EXP-004`                                                                           |
| EXP-005     | partial — `expenses_by_category` metric exists; account-filtered single-category totals **np**                                  |
| EXP-006     | det `XERO-EXP-006` (compare periods, delta + %)                                                                                 |
| EXP-007     | det `XERO-EXP-007` (by supplier, no payment double-count)                                                                       |
| EXP-008     | det: `expenses_by_category`/`top_expenses` path (`XERO-RPT-009` test)                                                           |
| EXP-009     | det: `top_expenses` ranked rows                                                                                                 |
| EXP-010     | det `XERO-EXP-010` (bills due next week, org timezone) + `periods.test.ts`                                                      |
| EXP-011     | det `XERO-EXP-011` (overdue excludes PAID/VOIDED)                                                                               |
| EXP-012     | partial — "pay all overdue" resolves candidates and asks/pauses (multi-doc batch execution **np**; single-doc path fully gated) |
| EXP-013     | det `XERO-INV-013` (BCA hint) ; eval `XERO-EXP-013` (yesterday + BCA)                                                           |
| EXP-014     | det `XERO-EXP-014` (paid bill → explains correction path); eval `XERO-EXP-014`                                                  |
| EXP-015     | **np** — bill line-item account edits not built                                                                                 |
| EXP-016     | **np** — percentage split entry not built (multi-line extraction handles explicit lines)                                        |
| EXP-017/018 | **np** — billable-expense linking / tracking categories not built                                                               |

## 4. Customer invoices & AR (XERO-INV)

| ID      | Coverage                                                                                                               |
| ------- | ---------------------------------------------------------------------------------------------------------------------- |
| INV-001 | det: invoice ACCREC draft test; eval `XERO-INV-001`                                                                    |
| INV-002 | det: clarification loop tests (parse → ask → re-parse)                                                                 |
| INV-003 | det: approval interrupt before authorise (all invoice tests)                                                           |
| INV-004 | eval `XERO-INV-004` (reject → stays draft); det: reject test                                                           |
| INV-005 | **np** — discount lines not built                                                                                      |
| INV-006 | det `XERO-GRAPH-INV-008`: CurrencyCode passthrough + Xero FX-rate lookup/variance warning; no currency conversion      |
| INV-007 | partial — Xero repeating-invoices endpoint **np**; graph-local retainer memory supports intent-driven monthly invoices |
| INV-008 | det: report graph lists unpaid/overdue/draft/paid/voided sales invoices read-only; eval covers unpaid + draft lists    |
| INV-009 | **np** — sending email reminders not built (and deliberately out of the AI's reach for now)                            |
| INV-010 | det `XERO-INV-010`-equivalent (report tests); eval `XERO-INV-010`                                                      |
| INV-011 | det/eval `XERO-INV-011` (receivables)                                                                                  |
| INV-012 | det `XERO-INV-012` (grouping by contact — overdue by customer)                                                         |
| INV-013 | det `XERO-INV-013` (missing payment details → clarify)                                                                 |
| INV-014 | det `XERO-PAY-004 / XERO-INV-014` (partial payment, remaining balance)                                                 |
| INV-015 | det + eval `XERO-INV-015` (void gated on approval, state validated)                                                    |
| INV-016 | det `XERO-GRAPH-INV-003/004/005`: amend preview + approval; paid/partial/credited use credit note + replacement        |
| INV-017 | det `XERO-ERR-003`-adjacent: `extractXeroError` surfaces Xero validation messages verbatim; execute nodes return them  |
| INV-018 | det `XERO-GRAPH-INV-010` (90-day 3-of-4 duplicate guard doubles as retry-after-timeout guard)                          |
| PDF     | det `XERO-GRAPH-INV-011`: "generate a PDF for this invoice" uses the last invoice in chat or an explicit ref, no write |

## 5. Contacts (XERO-CON)

| ID      | Coverage                                                                                                                        |
| ------- | ------------------------------------------------------------------------------------------------------------------------------- |
| CON-001 | partial — contacts are created inside invoice flow after a lookup; standalone "create a customer" workflow **np**               |
| CON-002 | det: "creates the Xero contact when the customer is unknown"; eval `XERO-CON-002`                                               |
| CON-003 | eval `XERO-CON-003` (ACME → existing Acme Ltd, no upsert); det: exact-match preference in `resolve-xero-contact`                |
| CON-004 | det `XERO-AI-003` (payment graph asks between candidates); invoice graph picks exact match first                                |
| CON-005 | **np** — contact update workflow not built                                                                                      |
| CON-006 | det + eval `XERO-CON-006` (invoice_total_for_contact)                                                                           |
| CON-007 | det: invoice/bill report lists include Xero contact names; unpaid/overdue/draft/paid/voided list coverage lives in report tests |
| CON-008 | det `XERO-EXP-007` (supplier payments not double-counted — bill totals only)                                                    |
| CON-009 | det `XERO-ERR-003` (validation message extraction)                                                                              |
| CON-010 | det: per-document CurrencyCode (invoice graph) — no contact-wide currency assumption exists                                     |
| CON-011 | det `XERO-GRAPH-INV-007`: customer payment terms can default invoice due dates; AR balance appears in approval preview          |

## 6. Payments, credit notes & refunds (XERO-PAY)

| ID          | Coverage                                                                                                |
| ----------- | ------------------------------------------------------------------------------------------------------- |
| PAY-001     | det + eval `XERO-PAY-001`                                                                               |
| PAY-002     | det + eval `XERO-PAY-002` (never over-apply)                                                            |
| PAY-003     | **np** — one payment across several bills not built (single-target per run)                             |
| PAY-004     | det + eval `XERO-PAY-004`                                                                               |
| PAY-005     | det `XERO-PAY-005` (locate → approve → delete; reject → nothing)                                        |
| PAY-006     | det `XERO-PAY-006/007` (credit note created with contact/amount)                                        |
| PAY-007     | det: allocation capped at min(credit, amount due)                                                       |
| PAY-008     | det: refund_credit → explains unsupported + safe alternative (`XERO-AI-014` eval)                       |
| PAY-009/010 | **np** — batch payments not built; requests resolve to per-document flows or an unsupported explanation |

## 7. Bank transactions (XERO-BANK)

| ID           | Coverage                                                                                                                              |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| BANK-001     | det `XERO-BANK-001` (spend money, expense account default)                                                                            |
| BANK-002     | det + eval `XERO-BANK-002` (receive vs invoice payment — asks)                                                                        |
| BANK-003     | det + eval `XERO-BANK-003`                                                                                                            |
| BANK-004     | det + eval `XERO-BANK-004` (identical accounts rejected)                                                                              |
| BANK-005     | partial — `cash` metric returns the BankSummary; Xero-vs-statement balance distinction **np** (statement data not exposed by the API) |
| BANK-006/007 | **np** — reconciliation is not exposed by the Accounting API; requests fall through to "unsupported" with an explanation              |
| BANK-008     | partial — invoice duplicate detection is 90-day 3-of-4 matching; bank-transaction dedup **np**                                        |
| BANK-009     | det `XERO-BANK-009` (receipt attached to the created transaction)                                                                     |
| BANK-010     | partial — `cash`/`overview` metrics; strict cash-in decomposition **np**                                                              |

## 8. Reports (XERO-RPT)

| ID      | Coverage                                                                                                                                                                     |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| RPT-001 | det `XERO-RPT-001` (full current month + stated basis)                                                                                                                       |
| RPT-002 | det + eval `XERO-RPT-002`                                                                                                                                                    |
| RPT-003 | det `XERO-RPT-003` (P&L, range + basis stated)                                                                                                                               |
| RPT-004 | partial — `last_6_months` period + monthly grouping enum exist; per-month series fetch **np**                                                                                |
| RPT-005 | det: revenue via P&L Total Income (tax never counted — report rows only)                                                                                                     |
| RPT-006 | partial — BankSummary-based `cash` view; classified cash-flow statement **np**                                                                                               |
| RPT-007 | det `XERO-RPT-007` (balance sheet as of a date)                                                                                                                              |
| RPT-008 | **np** — tax reports are org-specific report names; not built                                                                                                                |
| RPT-009 | det `XERO-RPT-009` (top categories from P&L rows)                                                                                                                            |
| RPT-010 | partial — needs monthly series (RPT-004)                                                                                                                                     |
| RPT-011 | partial — `compareToPrevious` gives a two-period trend; longer trend **np**                                                                                                  |
| RPT-012 | **np** — COGS section parsing not built                                                                                                                                      |
| RPT-013 | partial — det `XERO-GRAPH-RPT-001/002`: invoice/bill document lists use transaction currency and per-currency subtotals; P&L/report endpoints still use Xero report currency |
| RPT-014 | det: custom from/to period (`XERO-EXP-007` supplier test uses custom period; `periods.test.ts` XERO-RPT-014)                                                                 |
| RPT-015 | det + eval `XERO-RPT-015` (overview)                                                                                                                                         |
| RPT-016 | partial — comparison shows account-level deltas; causal narrative deliberately not claimed                                                                                   |
| RPT-017 | **np** — forecasting deliberately not built                                                                                                                                  |
| RPT-018 | det `XERO-RPT-018` (minAmount filter)                                                                                                                                        |
| RPT-019 | det `XERO-EXP-011`/`XERO-RPT-019` (overdue receivables only)                                                                                                                 |
| RPT-020 | **np** — journal/ledger drill-down not built; the graph explains the limitation                                                                                              |

## 9. Accounts, tax & tracking (XERO-ACC)

| ID          | Coverage                                                                                 |
| ----------- | ---------------------------------------------------------------------------------------- |
| ACC-001     | det: org-default account fill (`commons/xero.test.ts`, invoice draft tests)              |
| ACC-002     | **np** — interactive account selection not built (defaults + config override)            |
| ACC-003     | det: `matchAccountByHint` never matches archived (`xero-query.test.ts`)                  |
| ACC-004/005 | **np** — account creation not built                                                      |
| ACC-006     | det: `matchTaxRate` percent → TaxType (`commons/xero.test.ts`, GST invoice test)         |
| ACC-007     | det: account-default tax used; document rate only overrides a 0% default                 |
| ACC-008     | partial — per-line TaxType preserved when set; per-line extraction of mixed rates **np** |
| ACC-009…011 | **np** — tracking categories not built                                                   |
| ACC-012     | det: reference cache is keyed per tenant (`XeroTool.cached` uses `xeroTenantId`)         |

## 10. AI conversational behaviour (XERO-AI)

| ID         | Coverage                                                                                                                                           |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| AI-001     | det: clarification loop; eval `XERO-AI-001`                                                                                                        |
| AI-002/003 | AI-002 partial: invoice PDF export can use the last invoice in chat; AI-003 det `XERO-AI-003` + `XERO-GRAPH-INV-011` disambiguation               |
| AI-004     | eval `XERO-AI-004`; mechanically enforced: resume targets only the paused workflow (`createPausedWorkflowCheck` + handler `isAffirmative`)         |
| AI-005     | partial — amend requests now have explicit field-level preview + approval; editing a just-created draft in the same approval pause is still staged |
| AI-006     | det `XERO-AI-006` ×3 (payment/expense/invoice reject paths)                                                                                        |
| AI-007     | det `XERO-AI-007` (report graph has NO approval node — structural); eval `XERO-AI-007`                                                             |
| AI-008     | det: void/payment approval names the object; eval `XERO-AI-008`                                                                                    |
| AI-009     | prompt rules ("never invent", nullable fields); enforced by clarify-not-invent tests (DOC-014)                                                     |
| AI-010     | eval `XERO-AI-010` (supplier doc called "invoice" → ACCPAY)                                                                                        |
| AI-011     | det `XERO-AI-011` (defaulted period stated); eval `XERO-AI-011`                                                                                    |
| AI-012/013 | partial — follow-ups arrive merged in the assistant tool `request`; dedicated retained-filter tests **np**                                         |
| AI-014     | det: unsupported paths in all four graphs; eval `XERO-AI-014`                                                                                      |
| AI-015     | **np** — Xero-vs-document conflict surfacing not built                                                                                             |

## 11. Sync & webhooks (XERO-SYNC)

| ID           | Coverage                                                                                                                                    |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| SYNC-001…012 | **oos** — webhooks, incremental sync, and local-state reconciliation are App backend concerns; this service holds no business data to sync. |

## 12. Reliability (XERO-ERR)

| ID          | Coverage                                                                                                                |
| ----------- | ----------------------------------------------------------------------------------------------------------------------- |
| ERR-001     | partial — `withRetry` wraps workflow runs; check-before-retry exists for invoices via the duplicate node (ERR-010)      |
| ERR-002     | **np** — `Retry-After` handling not implemented in `XeroTool.request` yet                                               |
| ERR-003     | det `XERO-ERR-003` (`extractXeroError` unit test; execute nodes surface the message)                                    |
| ERR-004     | det: execute-node catch paths return `failed` with the Xero message — success is never claimed                          |
| ERR-005     | det `XERO-GRAPH-INV-010` (3-of-4 dedup before creating)                                                                 |
| ERR-006     | **np** — batch operations not built                                                                                     |
| ERR-007/008 | **oos** — local-DB/Xero consistency is App backend (this service persists only graph checkpoints)                       |
| ERR-009     | **oos** — token refresh concurrency lives in the backend token minting; graph caches with expiry slack                  |
| ERR-010     | det `XERO-GRAPH-INV-010` (second identical command → duplicate question, not a second bill)                             |
| ERR-011     | det: expense attach failure reported in summary, transaction preserved (`attach-expense-file`)                          |
| ERR-012     | det: all Xero response parsing uses optional fields (`?? []` / optional props) — unknown fields ignored by construction |

## 13. Security (XERO-SEC)

| ID                       | Coverage                                                                                                                                          |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| SEC-001/002/003, 006…011 | **oos** — RBAC, tenant isolation, log redaction, CSV escaping, session validation: App backend.                                                   |
| SEC-004                  | eval `XERO-SEC-004` (text) + `XERO-DOC-024` (image fixture)                                                                                       |
| SEC-005                  | eval `XERO-SEC-005` (assistant refuses to reveal tokens; prompt rule)                                                                             |
| SEC-012                  | partial — attachment filenames are URL-encoded on upload (`encodeURIComponent` in `attach`); full sanitisation policy **oos** (App storage layer) |

## P0 acceptance suite mapping

| #   | P0 item                               | Where                                                                                   |
| --- | ------------------------------------- | --------------------------------------------------------------------------------------- |
| 1–3 | Connect/select org, token refresh     | **oos** (App backend)                                                                   |
| 4   | Bill from one clear image             | eval `XERO-DOC-011` (fixture) / `XERO-DOC-001` (text)                                   |
| 5   | One bill from multipage doc           | invoice graph treats multiple images as one document (det attach test)                  |
| 6   | Multiple independent invoices         | **np** (multi-document batching)                                                        |
| 7   | Duplicate upload detected             | det `XERO-DOC-029`                                                                      |
| 8   | Unreadable image → no invented values | eval `XERO-DOC-014`; det expense no-amount clarify                                      |
| 9   | Draft customer invoice                | det invoice tests; eval `XERO-INV-001/004`                                              |
| 10  | Partial invoice payment               | det `XERO-PAY-004/INV-014`                                                              |
| 11  | Simple spend-money                    | det + eval `XERO-EXP-002`                                                               |
| 12  | "How much did we spend this month?"   | det `XERO-RPT-001`; eval `XERO-EXP-004`                                                 |
| 13  | "What invoices are overdue / draft?"  | det `XERO-EXP-011`, `XERO-GRAPH-INV-001/002`; eval `XERO-INV-010`, `XERO-GRAPH-INV-001` |
| 14  | P&L question                          | det `XERO-RPT-003`; eval `XERO-RPT-015`                                                 |
| 15  | Contact resolved without duplication  | eval `XERO-CON-003`; det exact-match test                                               |
| 16  | Confirmation before writes            | det approval-gate tests in all three write graphs                                       |
| 17  | API-timeout recovery                  | partial (`withRetry` + duplicate check)                                                 |
| 18  | Rate limits                           | **np** (ERR-002)                                                                        |
| 19  | Duplicate webhooks                    | **oos** (App backend)                                                                   |
| 20  | Cross-tenant prevention               | **oos** (backend token minting; graph keys caches per tenant)                           |

## Remaining full-parity milestones

- Purchase orders and quotes: add Xero tool methods, parse/workflow support, and catalogue coverage.
- Batch operations: multi-invoice/bill payment, batch execution, and partial-failure reporting remain unbuilt.
- Contact updates, account creation/selection, tracking categories, tax reports, and ledger drill-down are still staged follow-ups.
- Amendment email/send-to-customer remains deferred; `graph/` does not yet own email or Xero-send workflows.
- WhatsApp binary document delivery is deferred to App delivery; graph publishes the PDF URL in `content[]` and text today.
- Reliability gaps remain for `Retry-After` handling and broader local-state reconciliation, which partly belongs in App/backend sync.
