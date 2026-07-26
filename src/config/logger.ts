import pino from "pino";
import { getEnv } from "../config/environment.js";

export const logger = pino({
  level: getEnv().LOG_LEVEL,
  transport:
    process.env.NODE_ENV !== "production"
      ? { target: "pino-pretty", options: { colorize: true } }
      : undefined,
});
