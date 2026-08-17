#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ -f "$SCRIPT_DIR/.env" ]; then
 while IFS= read -r line || [ -n "$line" ]; do
   case "$line" in
     ''|'#'*) continue ;;
     *=*)
       key="${line%%=*}"
       value="${line#*=}"
       key="${key#"${key%%[![:space:]]*}"}"
       key="${key%"${key##*[![:space:]]}"}"
       if [ -z "${!key+x}" ]; then
         export "$key=$value"
       fi
       ;;
   esac
 done < "$SCRIPT_DIR/.env"
fi


BASE_URL="${RESOURCE_SERVER_URL:-http://localhost:4021}"
ENDPOINT_PATH="${ENDPOINT_PATH:-/weather}"
URL="${BASE_URL}${ENDPOINT_PATH}"

echo "URL: $URL"

headers=$(curl -s -D - -o /dev/null "$URL")
payment_required=$(echo "$headers" | grep -i '^payment-required:' | cut -d' ' -f2- | tr -d '\r' || true)


if [ -z "$payment_required" ]; then
 http_status=$(echo "$headers" | head -1 | tr -d '\r')
 echo "No payment-required header in response from: $URL" >&2
 echo "HTTP status: ${http_status:-unknown}" >&2
 exit 1
fi


echo "$payment_required" | base64 -d | jq .
