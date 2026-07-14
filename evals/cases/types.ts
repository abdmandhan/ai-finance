import type { ResumeInput } from "@/nodes";
import type { StubXeroSeed } from "@/tools";

/** Which StubXeroTool record array an op assertion refers to. */
export type StubOpKind =
  | "created" // invoices/bills created
  | "authorised"
  | "upserted" // contacts
  | "attached"
  | "createdPayments"
  | "deletedPayments"
  | "createdCreditNotes"
  | "allocations"
  | "bankTransactions"
  | "bankTransfers"
  | "attachedToBankTransactions"
  | "statusUpdates"
  // Read-side records — proof a read-only workflow actually queried Xero.
  | "reportRequests"
  | "invoiceQueries";

export interface OpExpectation {
  count?: number;
  /** Subset match against the FIRST recorded op of this kind. */
  match?: Record<string, unknown>;
}

/**
 * One catalogue-keyed live-LLM eval case. `level: "workflow"` invokes the target
 * graph directly (validates extraction + graph behavior with a real model);
 * `level: "assistant"` goes through the assistant (validates tool choice too).
 */
export interface EvalCase {
  /** Catalogue ID, e.g. "XERO-PAY-001". */
  id: string;
  title: string;
  level: "workflow" | "assistant";
  workflow?: "invoice" | "payment" | "expense" | "report";
  /** Stub data; defaults to `baseSeed()`. */
  seed?: StubXeroSeed;
  /** The user prompt. Embed document text as data below a `--- document ---` marker. */
  prompt: string;
  attachments?: { fixture: string; mimeType: string; fileName: string }[];
  /** Workflow-level only: resumes applied in order after the initial invoke. */
  steps?: { resume: ResumeInput }[];
  expect: {
    /** Kind of the interrupt the run should END on ("none" = ran to completion). */
    interrupt?: "approval" | "clarification" | "none";
    /** Regex/substring the final interrupt message must contain. */
    interruptMessage?: string | RegExp;
    ops?: Partial<Record<StubOpKind, OpExpectation>>;
    /** Op kinds that must have ZERO records. */
    mustNotOps?: StubOpKind[];
    /** Result.status of the finished workflow (workflow level). */
    resultStatus?: string;
    /** Substrings/regexes the final text (result summary or interrupt message) must contain. */
    answerIncludes?: (string | RegExp)[];
    answerExcludes?: (string | RegExp)[];
  };
}
