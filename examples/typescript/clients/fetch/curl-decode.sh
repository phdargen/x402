#!/bin/bash

# Standalone script to curl an x402-protected endpoint and decode the payment header

#BASE_URL="https://x402.akave.com/api/download?key=v1%2Fglobal%2Fdate%3D2025-12-03%2Fweather_data.parquet"
BASE_URL="${RESOURCE_SERVER_URL:-http://localhost:4021}"
ENDPOINT="${ENDPOINT_PATH:-/weather}"
#ENDPOINT="${ENDPOINT_PATH:-/api/generate}"
#ENDPOINT="${ENDPOINT_PATH:-/llm/stream}"
URL="${BASE_URL}${ENDPOINT}"
#URL=https://d3gvmcmb2qtcma.cloudfront.net/api/content
#URL=http://localhost:4021/protected-aptos
#URL=https://api.8k4protocol.com/agents/21480/score?chain=base 
echo "Making request to: $URL"
echo "----------------------------------------"

# Make the request and capture headers + body
response=$(curl -s -i "$URL")

# Split headers and body
headers=$(echo "$response" | sed -n '1,/^\r$/p')
body=$(echo "$response" | sed -n '/^\r$/,$p' | tail -n +2)

echo "Response Headers:"
echo "$headers"
echo ""
echo "----------------------------------------"
echo "Response Body:"
echo "$body" | jq . 2>/dev/null || echo "$body"
echo ""

# Extract and decode PAYMENT-REQUIRED header if present
payment_required=$(echo "$headers" | grep -i "^payment-required:" | cut -d' ' -f2- | tr -d '\r')

if [ -n "$payment_required" ]; then
  echo "----------------------------------------"
  echo "Decoded PAYMENT-REQUIRED Header:"
  echo "$payment_required" | base64 -d 2>/dev/null | jq . 2>/dev/null || echo "$payment_required" | base64 -d 2>/dev/null || echo "(not base64 encoded or invalid)"
fi

# Extract and decode PAYMENT-RESPONSE header if present (after successful payment)
payment_response=$(echo "$headers" | grep -i "^payment-response:" | cut -d' ' -f2- | tr -d '\r')

if [ -n "$payment_response" ]; then
  echo "----------------------------------------"
  echo "Decoded PAYMENT-RESPONSE Header:"
  echo "$payment_response" | base64 -d 2>/dev/null | jq . 2>/dev/null || echo "$payment_response" | base64 -d 2>/dev/null || echo "(not base64 encoded or invalid)"
fi

