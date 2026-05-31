import { config } from "dotenv";

config();

/**
 * Returns a required environment variable or exits the process.
 *
 * @param name - Environment variable name
 * @returns Trimmed non-empty value
 */
export function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    console.error(`❌ ${name} environment variable is required`);
    process.exit(1);
  }
  return value;
}

/**
 * Returns an optional trimmed environment variable.
 *
 * @param name - Environment variable name
 * @returns Trimmed value or undefined when unset/blank
 */
export function optionalEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value || undefined;
}

/** Base URL for the resource server under test. */
export const resourceServerUrl = process.env.RESOURCE_SERVER_URL || "http://localhost:4021";

/** Endpoint path appended to the resource server URL. */
export const endpointPath = process.env.ENDPOINT_PATH || "/weather";

/**
 * Full resource URL used by client examples.
 *
 * @returns Combined resource server URL and endpoint path
 */
export function resourceUrl(): string {
  return `${resourceServerUrl}${endpointPath}`;
}
