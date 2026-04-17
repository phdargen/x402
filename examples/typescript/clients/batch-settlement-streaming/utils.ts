import type { IncomingHttpHeaders, IncomingMessage } from "node:http";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

export type ClientCliOptions = {
  prompt?: string;
  verbose: boolean;
};

export interface SSEEvent {
  event: string;
  data: string;
}

/**
 * Returns whether an environment variable is set to a truthy string.
 *
 * @param value - Raw env value or undefined.
 * @returns True when value is 1, true, yes, or on (case-insensitive).
 */
export function isTruthyEnvFlag(value: string | undefined): boolean {
  if (!value) return false;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

/**
 * Parses CLI argv for `--prompt` / `-p` and `--verbose` / `-v`.
 *
 * @param argv - Arguments after the script name (e.g. `process.argv.slice(2)`).
 * @returns Parsed prompt override and verbose flag.
 */
export function parseClientCliOptions(argv: string[]): ClientCliOptions {
  let prompt: string | undefined;
  let verbose = false;

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];

    if (arg === "-v" || arg === "--verbose") {
      verbose = true;
      continue;
    }

    if (arg === "--prompt" || arg === "-p") {
      const nextArg = argv[index + 1];
      if (nextArg === "=") {
        prompt = argv[index + 2];
        index += 2;
        continue;
      }

      prompt = nextArg;
      index++;
      continue;
    }

    if (arg.startsWith("--prompt=")) {
      prompt = arg.slice("--prompt=".length);
    }
  }

  return { prompt, verbose };
}

/**
 * Parses Server-Sent Events from a byte stream into event/data pairs.
 *
 * @param source - Async iterable of UTF-8 chunks from the HTTP response body.
 * @returns Async generator yielding one `{ event, data }` per SSE block.
 */
export async function* parseSSE(source: AsyncIterable<Uint8Array>): AsyncGenerator<SSEEvent> {
  const decoder = new TextDecoder();
  let buffer = "";

  for await (const chunk of source) {
    buffer += decoder.decode(chunk, { stream: true });

    const parts = buffer.split("\n\n");
    buffer = parts.pop() ?? "";

    for (const part of parts) {
      if (!part.trim()) continue;

      let event = "message";
      let data = "";
      for (const line of part.split("\n")) {
        if (line.startsWith("event: ")) event = line.slice(7).trim();
        else if (line.startsWith("data: ")) data = line.slice(6);
      }

      yield { event, data };
    }
  }

  buffer += decoder.decode();
  if (!buffer.trim()) return;

  let event = "message";
  let data = "";
  for (const line of buffer.split("\n")) {
    if (line.startsWith("event: ")) event = line.slice(7).trim();
    else if (line.startsWith("data: ")) data = line.slice(6);
  }

  yield { event, data };
}

/**
 * Reads a header value from Fetch `Headers` or Node `IncomingHttpHeaders`.
 *
 * @param headers - Header map from the response.
 * @param name - Header name (case-insensitive for Node maps).
 * @returns The value, joined array for duplicates, or null/undefined when absent.
 */
export function getHeaderValue(
  headers: Headers | IncomingHttpHeaders,
  name: string,
): string | null | undefined {
  if (headers instanceof Headers) {
    return headers.get(name);
  }

  const value = headers[name.toLowerCase()];
  if (Array.isArray(value)) {
    return value.join(", ");
  }

  return value;
}

/**
 * Formats a value as indented JSON with each line prefixed by two spaces.
 *
 * @param value - JSON-serializable value.
 * @returns Pretty-printed JSON string.
 */
export function formatIndentedJson(value: unknown): string {
  return JSON.stringify(value, null, 2)
    .split("\n")
    .map(line => `  ${line}`)
    .join("\n");
}

/**
 * Issues an HTTP GET with the given headers and returns the response stream.
 *
 * @param urlString - Full URL to request.
 * @param headers - Outgoing request headers.
 * @returns The Node `IncomingMessage` once response headers arrive.
 */
export function streamRequest(
  urlString: string,
  headers: Record<string, string>,
): Promise<IncomingMessage> {
  const url = new URL(urlString);
  const requestImpl = url.protocol === "https:" ? httpsRequest : httpRequest;

  return new Promise((resolve, reject) => {
    const req = requestImpl(
      url,
      {
        method: "GET",
        headers,
      },
      resolve,
    );

    req.on("error", reject);
    req.end();
  });
}

/**
 * Reads the full body of a Node HTTP response as UTF-8 text.
 *
 * @param response - Incoming message with a readable body.
 * @returns Concatenated response body as a string.
 */
export async function readNodeResponseText(response: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];

  for await (const chunk of response) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return Buffer.concat(chunks).toString("utf8");
}
