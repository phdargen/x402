"""FastAPI e2e test server using x402 v2 SDK.

Paid routes are mounted from e2e/config/mechanisms.json — see
`e2e_server_shared.catalog`. Adding a mechanism does not require editing this file.
"""

import os
import signal
import sys
import asyncio
from typing import Any, Callable, Dict

from fastapi import FastAPI, HTTPException
from fastapi import Response as FastAPIResponse

from x402 import x402ResourceServer
from x402.http import FacilitatorConfig, HTTPFacilitatorClient
from x402.http.middleware.fastapi import payment_middleware, set_settlement_overrides
from e2e_server_shared import (
    CLOSE_PATH,
    HEALTH_PATH,
    CatalogRoute,
    build_payment_routes,
    catalog_routes,
    close_body,
    configure_resource_server,
    health_body,
    load_server_config,
    print_startup_banner,
    route_body,
)

cfg = load_server_config()
app = FastAPI()

if cfg.facilitator_url:
    print(f"Using remote facilitator at: {cfg.facilitator_url}")
    facilitator = HTTPFacilitatorClient(FacilitatorConfig(url=cfg.facilitator_url))
else:
    print("Using default facilitator")
    facilitator = HTTPFacilitatorClient()

server = x402ResourceServer(facilitator)
configure_resource_server(server, cfg)
routes = build_payment_routes(cfg)


# Apply payment middleware
@app.middleware("http")
async def x402_payment_middleware(request, call_next):
    return await payment_middleware(routes, server)(request, call_next)


# Global flag to track if server should accept new requests
shutdown_requested = False


def make_paid_handler(route: CatalogRoute) -> Callable:
    """Build the GET handler for one catalog route."""

    async def handler(response: FastAPIResponse) -> Dict[str, Any]:
        if shutdown_requested:
            raise HTTPException(status_code=503, detail="Server shutting down")
        if route.settlement_override:
            set_settlement_overrides(response, route.settlement_override)
        return route_body()

    return handler


for paid_route in catalog_routes():
    app.add_api_route(paid_route.path, make_paid_handler(paid_route), methods=["GET"])


@app.get(HEALTH_PATH)
async def health_check() -> Dict[str, Any]:
    """Health check endpoint."""
    return health_body("fastapi")


@app.post(CLOSE_PATH)
async def close_server() -> Dict[str, Any]:
    """Graceful shutdown endpoint."""
    global shutdown_requested
    shutdown_requested = True

    # Schedule server shutdown after response
    async def delayed_shutdown():
        await asyncio.sleep(0.1)
        os.kill(os.getpid(), signal.SIGTERM)

    asyncio.create_task(delayed_shutdown())

    return close_body()


def signal_handler(signum, frame):
    """Handle shutdown signals gracefully."""
    print("Received shutdown signal, exiting...")
    sys.exit(0)


if __name__ == "__main__":
    # Set up signal handlers for graceful shutdown
    signal.signal(signal.SIGTERM, signal_handler)
    signal.signal(signal.SIGINT, signal_handler)

    import uvicorn

    print_startup_banner("Starting FastAPI server", cfg.port, cfg.facilitator_url)

    uvicorn.run(app, host="0.0.0.0", port=cfg.port, log_level="warning")
