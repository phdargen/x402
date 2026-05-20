# Sign-In-With-X Client Example

httpx client demonstrating auth-only SIWX and pay-then-SIWX flows.

## Setup

```bash
cp .env-local .env
# Set EVM_PRIVATE_KEY and/or SVM_PRIVATE_KEY, FACILITATOR_URL, RESOURCE_SERVER_URL
uv sync
uv run python main.py
```

Start the server example first on port 4021.
