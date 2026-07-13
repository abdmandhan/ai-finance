import { resolvePeriod, type PeriodToken } from "@/commons";
import type { ReportStateType } from "@/graphs/report.state";
import { REPORT_NODES, type ReportDeps } from "./shared";

/**
 * Deterministic period resolution in the ORGANISATION's timezone — never the
 * server's. A missing period defaults to the current month, flagged so the
 * answer states the default explicitly (XERO-AI-011).
 */
export function makeResolveReportPeriodNode(deps: ReportDeps) {
  return {
    name: REPORT_NODES.resolvePeriod,
    node: async (state: ReportStateType) => {
      const auth = await deps.resolveXeroAuth(state.tenantId);
      const org = await deps.xeroTool.getOrganisation(auth);
      const timezone = org.Timezone ?? "UTC";
      const now = deps.now?.() ?? new Date();

      let token = (state.periodToken ?? "none") as PeriodToken;
      // "Bills due next week" style questions default forward, not to this month.
      if (token === "none" && state.metric === "bills_due_soon")
        token = "next_week";

      const period = resolvePeriod(token, now, timezone, {
        from: state.customFrom,
        to: state.customTo,
      });

      return {
        period,
        timezone,
        baseCurrency: org.BaseCurrency,
        _nextNode: REPORT_NODES.fetchData,
      };
    },
  };
}
