# Sign-In-With-X Server Example

FastAPI server demonstrating auth-only SIWX routes and paid routes with SIWX retry.

## Setup

```bash
cp .env-local .env
# Set FACILITATOR_URL and EVM_ADDRESS and/or SVM_ADDRESS
uv sync
uv run python main.py
```

Server listens on port **4021**.

## Routes

- `GET /weather` — paid + SIWX
- `GET /joke` — paid + SIWX
- `GET /profile` — auth-only (`accepts: []`)

Run the matching client example to exercise the flow.
