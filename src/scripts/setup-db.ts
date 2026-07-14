/**
 * One-off: create the Postgres checkpointer + preferences tables. Run with `pnpm setup:db`.
 */
import { configUtils, loggerUtils } from "@/commons";
import { checkpointerUtils } from "@/memory";
import { setupProcessLogDb } from "@/services/process-log.service";
import { createPreferencesTool } from "@/tools";

const config = configUtils.initConfig();
const logger = loggerUtils.createLogger(config.log);

const checkpointer = await checkpointerUtils.createCheckpointer(config, logger);
await checkpointerUtils.setupCheckpointer(checkpointer);

await createPreferencesTool(config.database.url, logger).setup();
await setupProcessLogDb(config.database.url, logger);

logger.info("Checkpointer + preferences + process log/pricing tables ready");
process.exit(0);
