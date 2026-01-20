import { describe, it, expect } from "vitest";
import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { ApiGatewayV2Adapter } from "./apigateway";

/**
 * Factory for creating mock API Gateway v2 events.
 *
 * @param options - Configuration options for the mock event.
 * @returns A mock API Gateway v2 proxy event.
 */
function createMockApiGatewayEvent(
  options: {
    path?: string;
    method?: string;
    headers?: Record<string, string>;
    queryStringParameters?: Record<string, string>;
    rawQueryString?: string;
    body?: string;
    isBase64Encoded?: boolean;
    host?: string;
  } = {},
): APIGatewayProxyEventV2 {
  const path = options.path || "/api/test";
  const method = options.method || "GET";
  const host = options.host || "api.example.com";

  // Normalize headers to lowercase (as API Gateway v2 does)
  const headers: Record<string, string> = {};
  if (options.headers) {
    for (const [key, value] of Object.entries(options.headers)) {
      headers[key.toLowerCase()] = value;
    }
  }
  headers.host = host;

  return {
    version: "2.0",
    routeKey: `${method} ${path}`,
    rawPath: path,
    rawQueryString: options.rawQueryString || "",
    headers,
    queryStringParameters: options.queryStringParameters,
    requestContext: {
      accountId: "123456789012",
      apiId: "api-id",
      domainName: host,
      domainPrefix: "api",
      http: {
        method,
        path,
        protocol: "HTTP/1.1",
        sourceIp: "1.2.3.4",
        userAgent: "test-agent",
      },
      requestId: "request-id",
      routeKey: `${method} ${path}`,
      stage: "$default",
      time: "01/Jan/2024:00:00:00 +0000",
      timeEpoch: 1704067200000,
    },
    body: options.body,
    isBase64Encoded: options.isBase64Encoded || false,
  } as APIGatewayProxyEventV2;
}

describe("ApiGatewayV2Adapter", () => {
  describe("getHeader", () => {
    it("returns header value when present", () => {
      const event = createMockApiGatewayEvent({
        headers: { "X-Custom-Header": "test-value" },
      });
      const adapter = new ApiGatewayV2Adapter(event);
      expect(adapter.getHeader("X-Custom-Header")).toBe("test-value");
    });

    it("returns header value case-insensitively", () => {
      const event = createMockApiGatewayEvent({
        headers: { "Content-Type": "application/json" },
      });
      const adapter = new ApiGatewayV2Adapter(event);
      // API Gateway v2 normalizes headers to lowercase
      expect(adapter.getHeader("content-type")).toBe("application/json");
      expect(adapter.getHeader("CONTENT-TYPE")).toBe("application/json");
    });

    it("returns undefined for missing headers", () => {
      const event = createMockApiGatewayEvent();
      const adapter = new ApiGatewayV2Adapter(event);
      expect(adapter.getHeader("X-Missing")).toBeUndefined();
    });
  });

  describe("getMethod", () => {
    it("returns the HTTP method", () => {
      const event = createMockApiGatewayEvent({ method: "POST" });
      const adapter = new ApiGatewayV2Adapter(event);
      expect(adapter.getMethod()).toBe("POST");
    });

    it("defaults to GET", () => {
      const event = createMockApiGatewayEvent();
      const adapter = new ApiGatewayV2Adapter(event);
      expect(adapter.getMethod()).toBe("GET");
    });
  });

  describe("getPath", () => {
    it("returns the request path", () => {
      const event = createMockApiGatewayEvent({ path: "/api/weather" });
      const adapter = new ApiGatewayV2Adapter(event);
      expect(adapter.getPath()).toBe("/api/weather");
    });
  });

  describe("getUrl", () => {
    it("returns full URL without query string", () => {
      const event = createMockApiGatewayEvent({
        path: "/api/test",
        host: "api.example.com",
      });
      const adapter = new ApiGatewayV2Adapter(event);
      expect(adapter.getUrl()).toBe("https://api.example.com/api/test");
    });

    it("returns full URL with query string", () => {
      const event = createMockApiGatewayEvent({
        path: "/api/test",
        host: "api.example.com",
        rawQueryString: "foo=bar&baz=qux",
      });
      const adapter = new ApiGatewayV2Adapter(event);
      expect(adapter.getUrl()).toBe("https://api.example.com/api/test?foo=bar&baz=qux");
    });
  });

  describe("getAcceptHeader", () => {
    it("returns Accept header when present", () => {
      const event = createMockApiGatewayEvent({
        headers: { Accept: "text/html" },
      });
      const adapter = new ApiGatewayV2Adapter(event);
      expect(adapter.getAcceptHeader()).toBe("text/html");
    });

    it("returns empty string when missing", () => {
      const event = createMockApiGatewayEvent();
      const adapter = new ApiGatewayV2Adapter(event);
      expect(adapter.getAcceptHeader()).toBe("");
    });
  });

  describe("getUserAgent", () => {
    it("returns User-Agent header when present", () => {
      const event = createMockApiGatewayEvent({
        headers: { "User-Agent": "Mozilla/5.0" },
      });
      const adapter = new ApiGatewayV2Adapter(event);
      expect(adapter.getUserAgent()).toBe("Mozilla/5.0");
    });

    it("returns empty string when missing", () => {
      const event = createMockApiGatewayEvent();
      const adapter = new ApiGatewayV2Adapter(event);
      expect(adapter.getUserAgent()).toBe("");
    });
  });

  describe("getQueryParams", () => {
    it("returns empty object when no query params", () => {
      const event = createMockApiGatewayEvent();
      const adapter = new ApiGatewayV2Adapter(event);
      expect(adapter.getQueryParams()).toEqual({});
    });

    it("returns query parameters", () => {
      const event = createMockApiGatewayEvent({
        queryStringParameters: { city: "NYC", units: "metric" },
      });
      const adapter = new ApiGatewayV2Adapter(event);
      expect(adapter.getQueryParams()).toEqual({ city: "NYC", units: "metric" });
    });
  });

  describe("getQueryParam", () => {
    it("returns single value", () => {
      const event = createMockApiGatewayEvent({
        queryStringParameters: { city: "NYC" },
      });
      const adapter = new ApiGatewayV2Adapter(event);
      expect(adapter.getQueryParam("city")).toBe("NYC");
    });

    it("returns undefined for missing param", () => {
      const event = createMockApiGatewayEvent();
      const adapter = new ApiGatewayV2Adapter(event);
      expect(adapter.getQueryParam("missing")).toBeUndefined();
    });
  });

  describe("getBody", () => {
    it("returns undefined when no body", () => {
      const event = createMockApiGatewayEvent();
      const adapter = new ApiGatewayV2Adapter(event);
      expect(adapter.getBody()).toBeUndefined();
    });

    it("returns raw body for non-JSON content", () => {
      const event = createMockApiGatewayEvent({
        headers: { "Content-Type": "text/plain" },
        body: "plain text body",
      });
      const adapter = new ApiGatewayV2Adapter(event);
      expect(adapter.getBody()).toBe("plain text body");
    });

    it("parses JSON body", () => {
      const event = createMockApiGatewayEvent({
        headers: { "Content-Type": "application/json" },
        body: '{"test": "value"}',
      });
      const adapter = new ApiGatewayV2Adapter(event);
      expect(adapter.getBody()).toEqual({ test: "value" });
    });

    it("decodes base64 body before parsing", () => {
      const original = '{"test": "value"}';
      const base64 = Buffer.from(original).toString("base64");
      const event = createMockApiGatewayEvent({
        headers: { "Content-Type": "application/json" },
        body: base64,
        isBase64Encoded: true,
      });
      const adapter = new ApiGatewayV2Adapter(event);
      expect(adapter.getBody()).toEqual({ test: "value" });
    });

    it("returns raw string for invalid JSON", () => {
      const event = createMockApiGatewayEvent({
        headers: { "Content-Type": "application/json" },
        body: "not valid json",
      });
      const adapter = new ApiGatewayV2Adapter(event);
      expect(adapter.getBody()).toBe("not valid json");
    });
  });
});
