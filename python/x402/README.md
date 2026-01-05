# x402 Python SDK

Python implementation of the x402 payment protocol.

## Installation

```bash
# Core package only
uv add x402

# With HTTP client support
uv add "x402[httpx]"      # async httpx client
uv add "x402[requests]"   # sync requests client
uv add "x402[clients]"    # all HTTP clients

# With server framework support  
uv add "x402[fastapi]"    # FastAPI middleware
uv add "x402[flask]"      # Flask middleware
uv add "x402[servers]"    # all server frameworks

# Everything
uv add "x402[all]"
```

## Quick Start

### Client-side (making paid requests)

```python
from x402 import x402Client
from x402.http.clients import wrapHttpxWithPayment  # requires: uv add "x402[httpx]"

# Create x402 client with your signer
client = x402Client()
client.register("eip155:8453", ExactEvmScheme(signer=my_signer))

# Wrap httpx with automatic payment handling
async with wrapHttpxWithPayment(client) as http:
    response = await http.get("https://api.example.com/paid-resource")
```

### Server-side (protecting resources)

```python
from fastapi import FastAPI
from x402 import x402ResourceServer
from x402.http.middleware import fastapi_payment_middleware  # requires: uv add "x402[fastapi]"

app = FastAPI()

# Configure server
server = x402ResourceServer(facilitator_client)
server.register("eip155:8453", ExactEvmServerScheme())

# Define protected routes
routes = {
    "GET /api/weather/*": {
        "accepts": {
            "scheme": "exact",
            "payTo": "0x...",
            "price": "$0.01",
            "network": "eip155:84532",
        }
    }
}

# Add payment middleware
@app.middleware("http")
async def x402_middleware(request, call_next):
    return await fastapi_payment_middleware(routes, server)(request, call_next)
```

## Components

- **x402Client** - Client-side payment creation with policies and hooks
- **x402ResourceServer** - Server-side resource protection
- **x402Facilitator** - Payment verification and settlement

## HTTP Integrations

### Clients

| Package | Install | Description |
|---------|---------|-------------|
| httpx | `uv add "x402[httpx]"` | Async HTTP client wrapper |
| requests | `uv add "x402[requests]"` | Sync HTTP client wrapper |

### Server Middleware

| Framework | Install | Description |
|-----------|---------|-------------|
| FastAPI | `uv add "x402[fastapi]"` | ASGI middleware for FastAPI/Starlette |
| Flask | `uv add "x402[flask]"` | WSGI middleware for Flask |

## Documentation

See [x402.org](https://x402.org) for full documentation.

## License

MIT
