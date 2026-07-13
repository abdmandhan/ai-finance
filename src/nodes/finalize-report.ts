import type { ReportStateType } from "@/graphs/report.state";
import { REPORT_NODES, type ReportDeps } from "./shared";

/** Terminal node — guarantees a `result` so the runtime can always reply. */
export function makeFinalizeReportNode(deps: ReportDeps) {
  return {
    name: REPORT_NODES.finalize,
    node: async (state: ReportStateType) => {
      const result = state.result ?? {
        status: "failed" as const,
        summary: "Workflow ended without a result.",
      };
      deps.logger.info({ result }, "report graph finished");
      return { result };
    },
  };
}
