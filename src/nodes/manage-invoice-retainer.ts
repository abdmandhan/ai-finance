import type { InvoiceStateType } from "@/graphs/invoice.state";
import { emitProgress, INVOICE_NODES, type InvoiceDeps } from "./shared";

export function makeManageInvoiceRetainerNode(deps: InvoiceDeps) {
  return {
    name: INVOICE_NODES.manageRetainer,
    node: async (state: InvoiceStateType) => {
      if (!deps.invoiceRetainersTool) {
        return {
          result: {
            status: "failed" as const,
            summary: "Retainer memory is not configured for this environment.",
          },
          _nextNode: INVOICE_NODES.finalize,
        };
      }

      emitProgress(
        deps,
        state.threadId,
        "manage_retainer",
        "Updating invoice retainer memory...",
      );

      try {
        if (state.action === "list_retainers") {
          const retainers = await deps.invoiceRetainersTool.list({
            tenantId: state.tenantId,
            contactId: state.contactId,
            contactName: state.contactName,
          });
          const summary = retainers.length
            ? retainers
                .map(
                  (r) =>
                    `${r.name}: ${r.currencyCode} ${r.amount} for ${r.contactName} (${r.status})`,
                )
                .join("\n")
            : "No invoice retainers are saved.";
          return {
            result: { status: "answered" as const, summary },
            _nextNode: INVOICE_NODES.finalize,
          };
        }

        if (!state.contactName) {
          return {
            result: {
              status: "failed" as const,
              summary: "A customer is required for retainer memory.",
            },
            _nextNode: INVOICE_NODES.finalize,
          };
        }

        if (state.action === "delete_retainer") {
          const deleted = await deps.invoiceRetainersTool.delete({
            tenantId: state.tenantId,
            contactId: state.contactId,
            contactName: state.contactName,
            name: state.retainerName ?? state.retainer?.name,
          });
          return {
            result: {
              status: deleted
                ? ("retainer_deleted" as const)
                : ("failed" as const),
              summary: deleted
                ? `Deleted retainer for ${state.contactName}.`
                : `No matching retainer for ${state.contactName} was found.`,
            },
            _nextNode: INVOICE_NODES.finalize,
          };
        }

        const retainer = state.retainer;
        if (!retainer?.amount || !retainer.currencyCode) {
          return {
            result: {
              status: "failed" as const,
              summary: "Retainer amount and currency are required.",
            },
            _nextNode: INVOICE_NODES.finalize,
          };
        }
        const saved = await deps.invoiceRetainersTool.upsert({
          tenantId: state.tenantId,
          contactId: state.contactId,
          contactName: state.contactName,
          name: retainer.name ?? state.retainerName,
          amount: retainer.amount,
          currencyCode: retainer.currencyCode,
          description: retainer.description,
          frequency: retainer.frequency,
          billingDay: retainer.billingDay,
          duePolicy: retainer.duePolicy,
          accountCode: retainer.accountCode,
          taxType: retainer.taxType,
          referenceTemplate: retainer.referenceTemplate,
          startDate: retainer.startDate,
          endDate: retainer.endDate,
          status: retainer.status,
          notes: retainer.notes,
        });
        return {
          result: {
            status: "retainer_saved" as const,
            summary: `Saved ${saved.name} retainer for ${saved.contactName}: ${saved.currencyCode} ${saved.amount}.`,
          },
          _nextNode: INVOICE_NODES.finalize,
        };
      } catch (err) {
        deps.logger.error({ err }, "manage-invoice-retainer failed");
        return {
          result: {
            status: "failed" as const,
            summary: "Could not update invoice retainer memory.",
          },
          _nextNode: INVOICE_NODES.finalize,
        };
      }
    },
  };
}
