import { loadConfigFromEnv } from "./config.js";

export function bootstrap() {
  const config = loadConfigFromEnv(process.env);

  return { config };
}
