import type { CloudFrontRequest, CloudFrontHeaders } from "aws-lambda";
import { HTTPAdapter } from "@x402/core/server";

/**
 * Extract header value from CloudFront headers format
 *
 * @param headers - CloudFront headers object
 * @param name - Header name (case-insensitive)
 * @returns Header value or undefined
 */
function getCloudFrontHeader(
  headers: CloudFrontHeaders,
  name: string,
): string | undefined {
  const lowerName = name.toLowerCase();
  const headerEntry = headers[lowerName];
  if (headerEntry && headerEntry.length > 0) {
    return headerEntry[0].value;
  }
  return undefined;
}

/**
 * CloudFront request adapter for x402 payment processing.
 * Implements HTTPAdapter interface for CloudFront Lambda@Edge request events.
 */
export class CloudFrontRequestAdapter implements HTTPAdapter {
  /**
   * Creates a new CloudFrontRequestAdapter instance.
   *
   * @param request - The CloudFront request object from the event
   * @param distributionDomain - The CloudFront distribution domain name
   */
  constructor(
    private request: CloudFrontRequest,
    private distributionDomain: string,
  ) {}

  /**
   * Gets a header value from the request.
   *
   * @param name - The header name (case-insensitive)
   * @returns The header value or undefined
   */
  getHeader(name: string): string | undefined {
    return getCloudFrontHeader(this.request.headers, name);
  }

  /**
   * Gets the HTTP method of the request.
   *
   * @returns The HTTP method
   */
  getMethod(): string {
    return this.request.method;
  }

  /**
   * Gets the path of the request.
   *
   * @returns The request path
   */
  getPath(): string {
    return this.request.uri;
  }

  /**
   * Gets the full URL of the request.
   *
   * @returns The full request URL
   */
  getUrl(): string {
    const protocol = "https";
    const queryString = this.request.querystring ? `?${this.request.querystring}` : "";
    return `${protocol}://${this.distributionDomain}${this.request.uri}${queryString}`;
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
    if (!this.request.querystring) {
      return params;
    }

    const searchParams = new URLSearchParams(this.request.querystring);
    for (const [key, value] of searchParams.entries()) {
      const existing = params[key];
      if (existing) {
        if (Array.isArray(existing)) {
          existing.push(value);
        } else {
          params[key] = [existing, value];
        }
      } else {
        params[key] = value;
      }
    }
    return params;
  }

  /**
   * Gets a specific query parameter by name.
   *
   * @param name - The query parameter name
   * @returns The query parameter value(s) or undefined
   */
  getQueryParam(name: string): string | string[] | undefined {
    const params = this.getQueryParams();
    return params[name];
  }

  /**
   * Gets the request body. CloudFront requests may include body in origin-request events.
   *
   * @returns The request body or undefined
   */
  getBody(): unknown {
    if (!this.request.body) {
      return undefined;
    }
    const bodyData = this.request.body.data;
    if (this.request.body.encoding === "base64") {
      return Buffer.from(bodyData, "base64").toString("utf-8");
    }
    return bodyData;
  }
}
