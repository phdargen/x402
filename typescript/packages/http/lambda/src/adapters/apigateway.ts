import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { HTTPAdapter } from "@x402/core/server";

/**
 * API Gateway v2 (HTTP API) request adapter for x402 payment processing.
 * Implements HTTPAdapter interface for API Gateway v2 events.
 */
export class ApiGatewayV2Adapter implements HTTPAdapter {
  /**
   * Creates a new ApiGatewayV2Adapter instance.
   *
   * @param event - The API Gateway v2 proxy event
   */
  constructor(private event: APIGatewayProxyEventV2) {}

  /**
   * Gets a header value from the request.
   *
   * @param name - The header name (case-insensitive)
   * @returns The header value or undefined
   */
  getHeader(name: string): string | undefined {
    // API Gateway v2 headers are lowercase
    const lowerName = name.toLowerCase();
    return this.event.headers?.[lowerName];
  }

  /**
   * Gets the HTTP method of the request.
   *
   * @returns The HTTP method
   */
  getMethod(): string {
    return this.event.requestContext.http.method;
  }

  /**
   * Gets the path of the request.
   *
   * @returns The request path
   */
  getPath(): string {
    return this.event.requestContext.http.path;
  }

  /**
   * Gets the full URL of the request.
   *
   * @returns The full request URL
   */
  getUrl(): string {
    const protocol = "https";
    const host = this.event.headers?.host || this.event.requestContext.domainName;
    const path = this.event.rawPath;
    const queryString = this.event.rawQueryString ? `?${this.event.rawQueryString}` : "";
    return `${protocol}://${host}${path}${queryString}`;
  }

  /**
   * Gets the Accept header from the request.
   *
   * @returns The Accept header value or empty string
   */
  getAcceptHeader(): string {
    return this.getHeader("Accept") || "";
  }

  /**
   * Gets the User-Agent header from the request.
   *
   * @returns The User-Agent header value or empty string
   */
  getUserAgent(): string {
    return this.getHeader("User-Agent") || "";
  }

  /**
   * Gets all query parameters from the request URL.
   *
   * @returns Record of query parameter key-value pairs
   */
  getQueryParams(): Record<string, string | string[]> {
    const params: Record<string, string | string[]> = {};

    // API Gateway v2 provides queryStringParameters as single values
    if (this.event.queryStringParameters) {
      for (const [key, value] of Object.entries(this.event.queryStringParameters)) {
        if (value !== undefined) {
          params[key] = value;
        }
      }
    }

    return params;
  }

  /**
   * Gets a specific query parameter by name.
   *
   * @param name - The query parameter name
   * @returns The query parameter value or undefined
   */
  getQueryParam(name: string): string | string[] | undefined {
    return this.event.queryStringParameters?.[name];
  }

  /**
   * Gets the request body, automatically parsing JSON if applicable.
   *
   * @returns The parsed request body or raw string
   */
  getBody(): unknown {
    if (!this.event.body) {
      return undefined;
    }

    let bodyString = this.event.body;
    if (this.event.isBase64Encoded) {
      bodyString = Buffer.from(bodyString, "base64").toString("utf-8");
    }

    // Try to parse as JSON
    const contentType = this.getHeader("Content-Type") || "";
    if (contentType.includes("application/json")) {
      try {
        return JSON.parse(bodyString);
      } catch {
        return bodyString;
      }
    }

    return bodyString;
  }
}
