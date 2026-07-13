# Tigeri AI (LangGraph)

> Workflow orchestration engine for Tigeri AI.

This project contains all AI workflows (graphs) used by Tigeri.

Unlike the main backend, this service is responsible for:

- Multi-step reasoning
- Tool orchestration
- Human approval
- Long-running workflows
- Durable execution
- State management
- AI memory (future)
- Business workflow automation

The backend remains the source of truth for business rules and data.

---

# Architecture

```
                    ┌────────────────────┐
                    │   Tigeri Frontend  │
                    └──────────┬─────────┘
                               │
                    REST / WebSocket
                               │
                    ┌──────────▼─────────┐
                    │ Tigeri Backend API │
                    │  (NestJS / Go)     │
                    └──────────┬─────────┘
                               │
                          Kafka Events
                               │
             ┌─────────────────▼─────────────────┐
             │      Tigeri AI (LangGraph)        │
             │                                   │
             │  Main Assistant (conversational)  │
             │    ├─ answers general questions   │
             │    ├─ conversation memory         │
             │    └─ workflow tools:             │
             │         schedule_meeting          │
             │         create_invoice            │
             │  Strict Workflow Graphs           │
             │    ├─ clarification interrupts    │
             │    └─ human approval interrupts   │
             └─────────────────┬─────────────────┘
                               │
               ┌───────────────┼────────────────┐
               │               │                │
            Xero API      Google APIs       Internal APIs
```

## Hybrid assistant

The outer layer is **conversational and agentic**; the inner action layer is
**strict and deterministic**:

- Every `chat.inbound` message goes to the **main assistant** (`assistant.graph.ts`),
  a checkpointed agent loop on thread `assistant:<chatId>`. It answers general
  questions directly and calls a workflow tool only when the user asks for an
  action or company data.
- The **workflow graphs** (`schedule.graph.ts`, `invoice.graph.ts`) stay rigid.
  They run as tools on their own threads (`schedule:<chatId>`, `invoice:<chatId>`)
  via `services/workflow-runner.ts` — never as subgraphs — so their
  clarification/approval `interrupt()`s surface as structured tool results.
- A **paused workflow always wins**: the next inbound message resumes it directly
  (`handlers/assistant.handler.ts` checks `pausedWorkflow` first). Its final
  structured result is then phrased naturally by the assistant ("report mode").
- Structured outcomes drive the Kafka contract (`output.intent`, `approvalData`
  via `handlers/outbound.ts`); natural language exists only at the conversation
  boundary.
- Rollback: `[assistant] enabled = false` in `config.toml` restores the legacy
  classify() router (`handlers/legacy.handler.ts`).

---

# Philosophy

This project **does not contain business logic**.

Business logic belongs inside:

- Tigeri Backend
- Domain Services
- Database

This project is responsible only for:

> Given a goal, determine the safest sequence of actions required to complete it.

Example:

```
User:
Schedule a meeting with Sarah next week.

↓

Extract entities

↓

Search Calendar

↓

Need clarification?

↓

Ask User

↓

Find available slot

↓

Create Calendar Event

↓

Notify User
```

---

# Why LangGraph?

Traditional chatbot:

```
Question

↓

LLM

↓

Answer
```

LangGraph:

```
Question

↓

Planner

↓

Tool

↓

Decision

↓

Another Tool

↓

Approval

↓

Finish
```

Advantages:

- Stateful
- Durable execution
- Pause / Resume
- Human approval
- Retry
- Streaming
- Multi-agent support
- Easy workflow visualization

---

# Project Structure

```
src/

├── graphs/
│
│   assistant.graph.ts / assistant.state.ts   (main conversational agent)
│   schedule.graph.ts / schedule.state.ts
│   invoice.graph.ts / invoice.state.ts
│   *-dev.ts                                  (LangGraph Studio harnesses)
│
├── nodes/
│
│   assistant-call-model.ts
│   assistant-execute-tools.ts                (workflow tool defs + executor)
│   parse-intent.ts, ask-clarification.ts, ... (schedule)
│   parse-invoice.ts, invoice-approval.ts, ... (invoice)
│   shared.ts                                 (deps, node names, InterruptPayload)
│
├── handlers/
│
│   assistant.handler.ts                      (hybrid pipeline, default)
│   legacy.handler.ts                         (classify() router, rollback flag)
│   outbound.ts                               (outcome -> Kafka output mapping)
│
├── tools/
│
│   xero.tool.ts
│   calendar.tool.ts
│   contacts.tool.ts
│   maps.tool.ts
│
├── prompts/
│
│   assistant.prompt.ts                       (Tigeri persona — broad)
│   schedule.prompt.ts, invoice.prompt.ts     (workflow rules — strict)
│
├── memory/
│
│   checkpointer.ts
│
├── schemas/
│
│   chat.schema.ts                            (Kafka contract)
│   assistant.schema.ts, schedule.schema.ts, invoice.schema.ts
│
├── services/
│
│   kafka.service.ts
│   workflow-runner.ts                        (graphs-as-tools runner)
│   llm.service.ts, audit.service.ts, agent-enablement.ts
│
└── index.ts
```

---

# Graph

Each business workflow should have its own graph.

Examples:

```
graphs/

schedule.graph.ts

invoice.graph.ts

expense.graph.ts

email.graph.ts

document.graph.ts

bank-reconciliation.graph.ts
```

Avoid creating one massive graph that handles everything.

---

# Node

A node performs exactly one responsibility.

Good:

```
Extract Intent

Find Contact

Search Calendar

Validate Invoice

Create Draft Invoice

Send Email
```

Bad:

```
Do Everything Node
```

Nodes should be deterministic whenever possible.

---

# State

Each graph owns its own state.

Example:

```ts
type ScheduleState = {
  userMessage: string;

  intent?: string;

  attendee?: string;

  duration?: number;

  timezone?: string;

  availableSlots?: Slot[];

  selectedSlot?: Slot;

  approved?: boolean;

  result?: string;
};
```

State should remain serializable.

---

# Tools

Tools perform external side effects.

Examples:

- Xero
- Gmail
- Calendar
- Google Drive
- Database
- Internal API

Rules:

- Keep tools idempotent whenever possible.
- Do not put planning logic inside tools.
- Tools should only perform actions.

---

# Planner

The planner decides:

- Which node to execute
- Which tool to call
- Whether clarification is needed
- Whether approval is required

Business validation should **not** rely solely on the LLM.

Always validate after the planner.

---

# Human Approval

High-risk operations require approval.

Examples:

- Send email
- Create invoice
- Delete document
- Approve payment
- Submit tax report

Example:

```
Planner

↓

Need approval?

↓

YES

↓

Pause Graph

↓

User Approves

↓

Resume Graph

↓

Execute
```

---

# Memory

Future versions will support:

- Conversation memory
- Organization memory
- User preferences
- Learned workflows

Memory should never replace the system of record.

---

# Error Handling

Graphs should recover gracefully.

Example:

```
Calendar API Timeout

↓

Retry

↓

Still Fail

↓

Notify User

↓

Persist Failure

↓

End
```

Avoid infinite loops.

---

# Logging

Every graph execution should log:

- Graph ID
- User ID
- Organization ID
- Start Time
- End Time
- Duration
- Tool Calls
- Errors

Never log secrets.

---

# Development Principles

## Keep nodes small

One responsibility per node.

## Prefer deterministic logic

LLMs decide.

Code validates.

## Graphs should be composable

Large workflows should be composed from reusable nodes.

## Side effects belong in tools

Never inside planners.

## Business rules belong in Backend

Never duplicate accounting logic inside LangGraph.

---

# Example Workflow

Invoice Creation

```
Receive Request

↓

Extract Intent

↓

Find Customer

↓

Find Items

↓

Validate Tax

↓

Need Approval?

↓

Create Draft Invoice

↓

Send Confirmation

↓

Finish
```

---

# Testing & Evals

Two layers, both keyed to the catalogue IDs in `../XERO-TEST-CASE-PLAN.md`
(coverage matrix: `docs/xero-test-coverage.md`):

- **Deterministic** — `pnpm test` (mocked LLM + `StubXeroTool`, runs in CI).
  Filter a catalogue category: `pnpm test -- -t XERO-PAY`.
- **Live-LLM evals** — `pnpm eval` (real model from `config.toml [llm]`,
  StubXeroTool for all Xero I/O; never in default CI). Cases live in
  `evals/cases/*.cases.ts`; multimodal receipt cases skip until image fixtures
  are dropped into `evals/fixtures/receipts/`.

---

# Future Roadmap

- [ ] Durable checkpoint storage
- [ ] Human approval UI
- [ ] Multi-agent workflows
- [ ] Reflection
- [ ] Organization memory
- [ ] Long-term memory
- [x] AI evaluation pipeline (`pnpm eval` — see Testing & Evals)
- [ ] Cost tracking
- [ ] Token usage dashboard
- [ ] Prompt versioning
- [ ] Graph visualization
- [ ] Distributed workers

---

# Design Principles

- Stateless API
- Stateful Graph
- Deterministic Business Rules
- Explicit Human Approval
- Event-driven Architecture
- Auditability First
- AI Assists, Backend Decides

````

## One suggestion based on everything we've discussed

Since you're building **Tigeri** as an accounting AI platform (not just a chatbot), I'd add one more top-level concept to the README:

```text
src/

graphs/
nodes/
tools/
prompts/
schemas/
memory/
agents/
evaluators/
workflows/
events/
````

Where:

- **graphs/** → LangGraph definitions.
- **nodes/** → Individual execution steps.
- **tools/** → Xero, Gmail, Calendar, Drive integrations.
- **agents/** → Specialized agents (Accounting Agent, Scheduling Agent, Email Agent, etc.).
- **evaluators/** → LLM or rule-based validation of graph outputs.
- **workflows/** → High-level business workflow definitions (e.g., Month-end Closing, Bank Reconciliation, Invoice Processing).
- **events/** → Kafka consumers/producers and event contracts.

This separation will scale much better as Tigeri grows from a handful of workflows into dozens of accounting and productivity automations.
