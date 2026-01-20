import { describe, it, expect } from "vitest";
import type { CloudFrontRequest, CloudFrontHeaders } from "aws-lambda";
import { CloudFrontRequestAdapter } from "./cloudfront";

/**
 * Factory for creating mock CloudFront requests.
 *
 * @param options - Configuration options for the mock request.
 * @returns A mock CloudFront request object.
 */
function createMockCloudFrontRequest(
  options: {
    uri?: string;
    method?: string;
    headers?: Record<string, string>;
    querystring?: string;
    body?: { data: string; encoding?: "base64" | "text" };
  } = {},
): CloudFrontRequest {
  const headers: CloudFrontHeaders = {};

  if (options.headers) {
    for (const [key, value] of Object.entries(options.headers)) {
      headers[key.toLowerCase()] = [{ key, value }];
    }
  }

  return {
    uri: options.uri || "/api/test",
    method: options.method || "GET",
    headers,
    querystring: options.querystring || "",
    clientIp: "1.2.3.4",
    body: options.body ? { data: options.body.data, encoding: options.body.encoding || "text" } : undefined,
    origin: {
      custom: {
        domainName: "origin.example.com",
        port: 443,
        protocol: "https",
        path: "",
        sslProtocols: ["TLSv1.2"],
        readTimeout: 30,
        keepaliveTimeout: 5,
        customHeaders: {},
      },
    },
  } as CloudFrontRequest;
}

describe("CloudFrontRequestAdapter", () => {
  const distributionDomain = "d1234.cloudfront.net";

  describe("getHeader", () => {
    it("returns header value when present", () => {
      const request = createMockCloudFrontRequest({
        headers: { "X-Custom-Header": "test-value" },
      });
      const adapter = new CloudFrontRequestAdapter(request, distributionDomain);
      expect(adapter.getHeader("X-Custom-Header")).toBe("test-value");
    });

    it("returns header value case-insensitively", () => {
      const request = createMockCloudFrontRequest({
        headers: { "Content-Type": "application/json" },
      });
      const adapter = new CloudFrontRequestAdapter(request, distributionDomain);
      expect(adapter.getHeader("content-type")).toBe("application/json");
      expect(adapter.getHeader("CONTENT-TYPE")).toBe("application/json");
    });

    it("returns undefined for missing headers", () => {
      const request = createMockCloudFrontRequest();
      const adapter = new CloudFrontRequestAdapter(request, distributionDomain);
      expect(adapter.getHeader("X-Missing")).toBeUndefined();
    });
  });

  describe("getMethod", () => {
    it("returns the HTTP method", () => {
      const request = createMockCloudFrontRequest({ method: "POST" });
      const adapter = new CloudFrontRequestAdapter(request, distributionDomain);
      expect(adapter.getMethod()).toBe("POST");
    });

    it("defaults to GET", () => {
      const request = createMockCloudFrontRequest();
      const adapter = new CloudFrontRequestAdapter(request, distributionDomain);
      expect(adapter.getMethod()).toBe("GET");
    });
  });

  describe("getPath", () => {
    it("returns the request URI", () => {
      const request = createMockCloudFrontRequest({ uri: "/api/weather" });
      const adapter = new CloudFrontRequestAdapter(request, distributionDomain);
      expect(adapter.getPath()).toBe("/api/weather");
    });
  });

  describe("getUrl", () => {
    it("returns full URL without query string", () => {
      const request = createMockCloudFrontRequest({ uri: "/api/test" });
      const adapter = new CloudFrontRequestAdapter(request, distributionDomain);
      expect(adapter.getUrl()).toBe("https://d1234.cloudfront.net/api/test");
    });

    it("returns full URL with query string", () => {
      const request = createMockCloudFrontRequest({
        uri: "/api/test",
        querystring: "foo=bar&baz=qux",
      });
      const adapter = new CloudFrontRequestAdapter(request, distributionDomain);
      expect(adapter.getUrl()).toBe("https://d1234.cloudfront.net/api/test?foo=bar&baz=qux");
    });
  });

  describe("getAcceptHeader", () => {
    it("returns Accept header when present", () => {
      const request = createMockCloudFrontRequest({
        headers: { Accept: "text/html" },
      });
      const adapter = new CloudFrontRequestAdapter(request, distributionDomain);
      expect(adapter.getAcceptHeader()).toBe("text/html");
    });

    it("returns empty string when missing", () => {
      const request = createMockCloudFrontRequest();
      const adapter = new CloudFrontRequestAdapter(request, distributionDomain);
      expect(adapter.getAcceptHeader()).toBe("");
    });
  });

  describe("getUserAgent", () => {
    it("returns User-Agent header when present", () => {
      const request = createMockCloudFrontRequest({
        headers: { "User-Agent": "Mozilla/5.0" },
      });
      const adapter = new CloudFrontRequestAdapter(request, distributionDomain);
      expect(adapter.getUserAgent()).toBe("Mozilla/5.0");
    });

    it("returns empty string when missing", () => {
      const request = createMockCloudFrontRequest();
      const adapter = new CloudFrontRequestAdapter(request, distributionDomain);
      expect(adapter.getUserAgent()).toBe("");
    });
  });

  describe("getQueryParams", () => {
    it("returns empty object when no query string", () => {
      const request = createMockCloudFrontRequest({ querystring: "" });
      const adapter = new CloudFrontRequestAdapter(request, distributionDomain);
      expect(adapter.getQueryParams()).toEqual({});
    });

    it("parses single values", () => {
      const request = createMockCloudFrontRequest({ querystring: "city=NYC&units=metric" });
      const adapter = new CloudFrontRequestAdapter(request, distributionDomain);
      expect(adapter.getQueryParams()).toEqual({ city: "NYC", units: "metric" });
    });

    it("handles multiple values for same key", () => {
      const request = createMockCloudFrontRequest({ querystring: "tag=a&tag=b&tag=c" });
      const adapter = new CloudFrontRequestAdapter(request, distributionDomain);
      expect(adapter.getQueryParams()).toEqual({ tag: ["a", "b", "c"] });
    });
  });

  describe("getQueryParam", () => {
    it("returns single value", () => {
      const request = createMockCloudFrontRequest({ querystring: "city=NYC" });
      const adapter = new CloudFrontRequestAdapter(request, distributionDomain);
      expect(adapter.getQueryParam("city")).toBe("NYC");
    });

    it("returns undefined for missing param", () => {
      const request = createMockCloudFrontRequest({ querystring: "" });
      const adapter = new CloudFrontRequestAdapter(request, distributionDomain);
      expect(adapter.getQueryParam("missing")).toBeUndefined();
    });
  });

  describe("getBody", () => {
    it("returns undefined when no body", () => {
      const request = createMockCloudFrontRequest();
      const adapter = new CloudFrontRequestAdapter(request, distributionDomain);
      expect(adapter.getBody()).toBeUndefined();
    });

    it("returns text body as-is", () => {
      const request = createMockCloudFrontRequest({
        body: { data: '{"test": "value"}', encoding: "text" },
      });
      const adapter = new CloudFrontRequestAdapter(request, distributionDomain);
      expect(adapter.getBody()).toBe('{"test": "value"}');
    });

    it("decodes base64 body", () => {
      const original = '{"test": "value"}';
      const base64 = Buffer.from(original).toString("base64");
      const request = createMockCloudFrontRequest({
        body: { data: base64, encoding: "base64" },
      });
      const adapter = new CloudFrontRequestAdapter(request, distributionDomain);
      expect(adapter.getBody()).toBe(original);
    });
  });
});
