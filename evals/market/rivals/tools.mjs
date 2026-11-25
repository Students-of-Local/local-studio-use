// Where the rival tools are installed (install.sh). Outside the repo's own installs, and gitignored.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const TOOLS = process.env.MARKET_RIVALS_DIR || join(dirname(fileURLToPath(import.meta.url)), "tools");
