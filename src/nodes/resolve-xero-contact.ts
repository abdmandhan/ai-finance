import type { InvoiceStateType } from "@/graphs/invoice.state";
import { emitProgress, INVOICE_NODES, type InvoiceDeps } from "./shared";

/**
 * Resolve the customer/supplier to a Xero ContactID — find first, create if missing
 * (mirrors `xero_find_contact` → `xero_create_or_update_contact`).
 */
export function makeResolveXeroContactNode(deps: InvoiceDeps) {
  return {
    name: INVOICE_NODES.resolveContact,
    node: async (state: InvoiceStateType) => {
      const name = state.contactName ?? "";
      emitProgress(
        deps,
        state.threadId,
        "resolve_contact",
        `Finding ${name} in Xero...`,
      );

      try {
        const auth = await deps.resolveXeroAuth(state.tenantId);
        const matches = await deps.xeroTool.findContact(auth, name);
        // Prefer an exact (case-insensitive) name match, else the first hit.
        const exact = matches.find(
          (c) => c.Name.toLowerCase() === name.toLowerCase(),
        );
        const contact = exact ?? matches[0];

        if (contact) {
          let fullContact = contact;
          try {
            fullContact =
              (await deps.xeroTool.getContact(auth, contact.ContactID)) ??
              contact;
          } catch (err) {
            deps.logger.warn(
              { err, contactId: contact.ContactID },
              "contact detail lookup failed",
            );
          }
          return {
            contactId: fullContact.ContactID,
            customer: fullContact,
            customerArBalance:
              fullContact.ARBalance ??
              fullContact.Balances?.AccountsReceivable?.Outstanding,
            _nextNode: INVOICE_NODES.checkDuplicate,
          };
        }

        const contactId = await deps.xeroTool.upsertContact(auth, { name });
        deps.logger.info({ name, contactId }, "created Xero contact");
        return { contactId, _nextNode: INVOICE_NODES.checkDuplicate };
      } catch (err) {
        deps.logger.error({ err }, "resolve-xero-contact failed");
        return {
          result: {
            status: "failed" as const,
            summary: "Could not reach Xero to resolve the contact.",
          },
          _nextNode: INVOICE_NODES.finalize,
        };
      }
    },
  };
}
