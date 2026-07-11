/**
 * One-off: create the Postgres checkpointer tables. Run with `pnpm setup:db`.
 */
import { configUtils, loggerUtils } from "@/commons";
import { checkpointerUtils } from "@/memory";

const config = configUtils.initConfig();
const logger = loggerUtils.createLogger(config.log);

const checkpointer = await checkpointerUtils.createCheckpointer(config, logger);
await checkpointerUtils.setupCheckpointer(checkpointer);

logger.info("Checkpointer tables ready");
process.exit(0);
