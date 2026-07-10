import type { Config } from "@/commons";
import { ChatAnthropic } from "@langchain/anthropic";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { BaseMessage } from "@langchain/core/messages";
import { ChatOpenAI } from "@langchain/openai";
import type { z } from "zod";

/**
 * Thin wrapper around the chat model. Nodes depend on this interface, not on a
 * concrete provider, so the provider can be swapped via config without touching graphs.
 */
export interface ILlmService {
  /** Invoke the model and coerce the reply into `schema` via tool-calling. */
  extract<T extends Record<string, any>>(
    schema: z.ZodType<T>,
    messages: BaseMessage[],
    name: string,
  ): Promise<T>;
}

function buildModel(config: Config["llm"]): BaseChatModel {
  if (config.provider === "openai") {
    // Some GPT-5 reasoning models only accept the default temperature — omit it.
    return new ChatOpenAI({ apiKey: config.api_key, model: config.model });
  }
  return new ChatAnthropic({
    apiKey: config.api_key,
    model: config.model,
    temperature: 0,
  });
}

export class LlmService implements ILlmService {
  private readonly model: BaseChatModel;

  constructor(config: Config["llm"]) {
    this.model = buildModel(config);
  }

  async extract<T extends Record<string, any>>(
    schema: z.ZodType<T>,
    messages: BaseMessage[],
    name: string,
  ): Promise<T> {
    const structured = this.model.withStructuredOutput<T>(schema, { name });
    return structured.invoke(messages);
  }
}

export function createLlmService(config: Config["llm"]): ILlmService {
  return new LlmService(config);
}
