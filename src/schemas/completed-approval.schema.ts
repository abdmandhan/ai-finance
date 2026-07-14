import { z } from "zod";

export const completedApprovalSchema = z.object({
  name: z.string(),
  provider: z.string(),
  ref: z.string(),
  label: z.string().optional(),
});
export type CompletedApproval = z.infer<typeof completedApprovalSchema>;

export const completedApprovalSchemas = {
  completedApprovalSchema,
};
