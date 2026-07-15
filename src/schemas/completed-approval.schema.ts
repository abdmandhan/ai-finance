import { z } from "zod";

export const completedApprovalItemSchema = z.object({
  ref: z.string(),
  label: z.string().optional(),
  status: z.enum(["pending", "completed", "failed", "rejected"]).optional(),
  detail: z.string().optional(),
});

export const completedApprovalSchema = z.object({
  name: z.string(),
  provider: z.string(),
  ref: z.string(),
  label: z.string().optional(),
  items: z.array(completedApprovalItemSchema).optional(),
});
export type CompletedApproval = z.infer<typeof completedApprovalSchema>;
export type CompletedApprovalItem = z.infer<typeof completedApprovalItemSchema>;

export const completedApprovalSchemas = {
  completedApprovalSchema,
  completedApprovalItemSchema,
};
