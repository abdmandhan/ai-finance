import type { ILogger } from "@/commons";

/**
 * Structured audit logging for each graph run. Every execution must record who
 * ran what and how it ended (see README "Logging"). Never log secrets.
 */
export interface IAuditService {
  runStarted(input: {
    threadId: string;
    workflow: string;
    userId?: string;
  }): void;
  toolCalled(input: {
    threadId: string;
    tool: string;
    ok: boolean;
    elapsedMs: number;
  }): void;
  runFinished(input: {
    threadId: string;
    status: string;
    durationMs: number;
  }): void;
}

export class AuditService implements IAuditService {
  constructor(private readonly logger: ILogger) {}

  runStarted(input: {
    threadId: string;
    workflow: string;
    userId?: string;
  }): void {
    this.logger.info({ audit: "run_started", ...input }, "Graph run started");
  }

  toolCalled(input: {
    threadId: string;
    tool: string;
    ok: boolean;
    elapsedMs: number;
  }): void {
    this.logger.info({ audit: "tool_called", ...input }, "Tool call");
  }

  runFinished(input: {
    threadId: string;
    status: string;
    durationMs: number;
  }): void {
    this.logger.info({ audit: "run_finished", ...input }, "Graph run finished");
  }
}

export function createAuditService(logger: ILogger): IAuditService {
  return new AuditService(logger);
}
