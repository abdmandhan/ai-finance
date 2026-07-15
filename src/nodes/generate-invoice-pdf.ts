import type { InvoiceStateType } from "@/graphs/invoice.state";
import { StorageConfigurationError } from "@/services";
import type { XeroInvoiceDetail } from "@/tools";
import { interrupt } from "@langchain/langgraph";
import {
  emitProgress,
  INVOICE_NODES,
  type InterruptPayload,
  type InvoiceDeps,
  type ResumeInput,
} from "./shared";

function labelOf(invoice: XeroInvoiceDetail): string {
  return (
    invoice.InvoiceNumber ??
    invoice.Reference ??
    invoice.InvoiceID ??
    "selected invoice"
  );
}

function defaultPdfName(invoice: XeroInvoiceDetail): string {
  return `${labelOf(invoice)}.pdf`;
}

function documentKind(invoice: XeroInvoiceDetail): string {
  return invoice.Type === "ACCPAY" ? "bill" : "invoice";
}

function uniqueInvoices(invoices: XeroInvoiceDetail[]): XeroInvoiceDetail[] {
  const byId = new Map<string, XeroInvoiceDetail>();
  for (const invoice of invoices) {
    if (invoice.InvoiceID) byId.set(invoice.InvoiceID, invoice);
  }
  return [...byId.values()];
}

function pickCandidate(
  candidates: XeroInvoiceDetail[],
  reply: string | undefined,
): XeroInvoiceDetail | null {
  const text = (reply ?? "").trim().toLowerCase();
  if (!text) return null;
  const index = Number.parseInt(text, 10);
  if (Number.isInteger(index) && index >= 1 && index <= candidates.length) {
    return candidates[index - 1] ?? null;
  }
  return (
    candidates.find((invoice) =>
      [
        invoice.InvoiceID,
        invoice.InvoiceNumber,
        invoice.Reference,
        invoice.Contact?.Name,
      ]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase() === text),
    ) ?? null
  );
}

async function resolveInvoice(
  deps: InvoiceDeps,
  state: InvoiceStateType,
): Promise<XeroInvoiceDetail | null> {
  const auth = await deps.resolveXeroAuth(state.tenantId);
  const target = (state.targetInvoiceRef ?? state.invoiceId ?? "").trim();
  if (!target) {
    const payload: InterruptPayload = {
      kind: "clarification",
      message: "Which invoice should I export as a PDF?",
    };
    const reply = interrupt<InterruptPayload, ResumeInput>(payload);
    const ref = (reply.reply ?? "").trim();
    if (!ref) return null;
    return resolveInvoice(deps, { ...state, targetInvoiceRef: ref });
  }

  let byId: XeroInvoiceDetail | null = null;
  try {
    byId = await deps.xeroTool.getInvoiceById(auth, target);
  } catch (err) {
    deps.logger.debug({ err, target }, "invoice PDF id lookup failed");
  }
  if (byId) return byId;

  const [byNumber, byReference] = await Promise.all([
    deps.xeroTool.getInvoices(auth, { invoiceNumber: target }),
    deps.xeroTool.getInvoices(auth, { reference: target }),
  ]);
  const candidates = uniqueInvoices([...byNumber, ...byReference]);
  if (candidates.length === 1) return candidates[0];
  if (candidates.length === 0) {
    const payload: InterruptPayload = {
      kind: "clarification",
      message: `I could not find an invoice matching "${target}". Which invoice number or ID should I export?`,
    };
    const reply = interrupt<InterruptPayload, ResumeInput>(payload);
    const ref = (reply.reply ?? "").trim();
    if (!ref || ref.toLowerCase() === target.toLowerCase()) return null;
    return resolveInvoice(deps, { ...state, targetInvoiceRef: ref });
  }

  const payload: InterruptPayload = {
    kind: "clarification",
    message: `I found multiple invoices matching "${target}": ${candidates
      .map(
        (invoice, i) =>
          `${i + 1}. ${labelOf(invoice)} (${invoice.Contact?.Name ?? "unknown contact"}, ${invoice.Status ?? "unknown"})`,
      )
      .join("; ")}. Which one should I export?`,
  };
  const reply = interrupt<InterruptPayload, ResumeInput>(payload);
  return pickCandidate(candidates, reply.reply);
}

function storageFailureSummary(err: unknown): string {
  if (err instanceof StorageConfigurationError) return err.message;
  return "Could not store the generated PDF. Please try again later.";
}

function isGraphInterrupt(err: unknown): boolean {
  return (err as { name?: string } | null)?.name === "GraphInterrupt";
}

export function makeGenerateInvoicePdfNode(deps: InvoiceDeps) {
  return {
    name: INVOICE_NODES.generatePdf,
    node: async (state: InvoiceStateType) => {
      emitProgress(
        deps,
        state.threadId,
        "generate_invoice_pdf",
        "Generating the invoice PDF...",
      );
      try {
        if (!deps.storageService) throw new StorageConfigurationError();
        const invoice = await resolveInvoice(deps, state);
        if (!invoice?.InvoiceID) {
          const summary = "I could not resolve which invoice to export.";
          if (state.pendingPdfRequest) {
            return {
              pendingPdfRequest: false,
              pdfError: summary,
              _nextNode: INVOICE_NODES.approval,
            };
          }
          return {
            result: { status: "failed" as const, summary },
            _nextNode: INVOICE_NODES.finalize,
          };
        }

        const auth = await deps.resolveXeroAuth(state.tenantId);
        const bytes = await deps.xeroTool.getInvoicePdf(auth, invoice.InvoiceID);
        const document = await deps.storageService.uploadDocument({
          tenantId: state.tenantId,
          chatId: state.threadId,
          fileName: state.fileName ?? defaultPdfName(invoice),
          mimeType: "application/pdf",
          bytes,
        });
        const summary = `I generated the PDF for ${documentKind(invoice)} ${labelOf(invoice)}.`;
        if (state.pendingPdfRequest) {
          return {
            invoiceId: invoice.InvoiceID,
            pendingPdfRequest: false,
            pdfDocument: document,
            pdfError: null,
            _nextNode: INVOICE_NODES.approval,
          };
        }
        return {
          invoiceId: invoice.InvoiceID,
          result: {
            status: "answered" as const,
            invoiceId: invoice.InvoiceID,
            summary,
            documents: [document],
          },
          _nextNode: INVOICE_NODES.finalize,
        };
      } catch (err) {
        if (isGraphInterrupt(err)) throw err;
        deps.logger.error({ err }, "generate-invoice-pdf failed");
        const summary =
          err instanceof StorageConfigurationError
            ? storageFailureSummary(err)
            : "Could not generate the Xero invoice PDF. Please try again later.";
        if (state.pendingPdfRequest) {
          return {
            pendingPdfRequest: false,
            pdfError: summary,
            _nextNode: INVOICE_NODES.approval,
          };
        }
        return {
          result: { status: "failed" as const, summary },
          _nextNode: INVOICE_NODES.finalize,
        };
      }
    },
  };
}
