import { pino, type Logger } from "pino";
import type { Config } from "./config";

export type ILogger = Logger;

function createLogger(config: Config["log"]): ILogger {
  return pino({
    level: config.level,
    transport:
      config.format === "pretty"
        ? { target: "pino-pretty", options: { colorize: true } }
        : undefined,
  });
}

export const loggerUtils = {
  createLogger,
};
