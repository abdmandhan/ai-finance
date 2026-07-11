export {
  createAssistantHandler,
  type AssistantHandlerDeps,
} from "./assistant.handler";
export { createLegacyHandler, type LegacyHandlerDeps } from "./legacy.handler";
export { outcomeToOutput, defaultAnswerFor } from "./outbound";
export {
  createCorrelationStore,
  inboundText,
  inboundAttachments,
  type Correlation,
  type CorrelationStore,
} from "./shared";
