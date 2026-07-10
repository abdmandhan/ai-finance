/**
 * One-off: create the Postgres checkpointer tables. Run with `pnpm setup:db`.
 */
import { configUtils, loggerUtils } from "@/commons";
import { checkpointerUtils } from "@/memory";

const config = configUtils.initConfig();
const logger = loggerUtils.createLogger(config.log);

const checkpointer = checkpointerUtils.createCheckpointer(
  config.database.url,
  logger,
);
await checkpointerUtils.setupCheckpointer(checkpointer);

logger.info("Checkpointer tables ready");
process.exit(0);
