/**
 * One-off: create the Postgres checkpointer + preferences tables. Run with `pnpm setup:db`.
 */
import { configUtils, loggerUtils } from "@/commons";
import { checkpointerUtils } from "@/memory";
import { createPreferencesTool } from "@/tools";

const config = configUtils.initConfig();
const logger = loggerUtils.createLogger(config.log);

const checkpointer = checkpointerUtils.createCheckpointer(
  config.database.url,
  logger,
);
await checkpointerUtils.setupCheckpointer(checkpointer);

await createPreferencesTool(config.database.url, logger).setup();

logger.info("Checkpointer + preferences tables ready");
process.exit(0);
