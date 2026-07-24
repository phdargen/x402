"""FastAPI e2e test server using x402 v2 SDK."""

import os
import signal
import sys
import asyncio
from typing import Any, Dict

from fastapi import FastAPI, HTTPException
from fastapi import Response as FastAPIResponse

from x402 import x402ResourceServer
from x402.http import FacilitatorConfig, HTTPFacilitatorClient
from x402.http.middleware.fastapi import payment_middleware, set_settlement_overrides
from e2e_server_shared import load_server_config, configure_resource_server, build_payment_routes

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


@app.get("/exact/evm/eip3009")
async def protected_endpoint() -> Dict[str, Any]:
    """Protected endpoint that requires payment."""
    if shutdown_requested:
        raise HTTPException(status_code=503, detail="Server shutting down")

    return {
        "message": "Access granted to protected resource",
        "timestamp": "2024-01-01T00:00:00Z",
    }


@app.get("/exact/svm")
async def protected_svm_endpoint() -> Dict[str, Any]:
    """Protected endpoint that requires SVM (Solana) payment."""
    if shutdown_requested:
        raise HTTPException(status_code=503, detail="Server shutting down")

    return {
        "message": "Access granted to SVM protected resource",
        "timestamp": "2024-01-01T00:00:00Z",
    }


@app.get("/exact/tvm")
async def protected_tvm_endpoint() -> Dict[str, Any]:
    """Protected endpoint that requires TVM payment."""
    if shutdown_requested:
        raise HTTPException(status_code=503, detail="Server shutting down")

    return {
        "message": "Access granted to TVM protected resource",
        "timestamp": "2024-01-01T00:00:00Z",
    }


@app.get("/exact/evm/permit2-eip2612GasSponsoring")
async def protected_permit2_endpoint() -> Dict[str, Any]:
    """Protected endpoint that requires Permit2 payment."""
    if shutdown_requested:
        raise HTTPException(status_code=503, detail="Server shutting down")

    return {
        "message": "Permit2 endpoint accessed successfully",
        "timestamp": "2024-01-01T00:00:00Z",
        "method": "permit2",
    }


@app.get("/exact/evm/permit2-erc20ApprovalGasSponsoring")
async def protected_permit2_erc20_endpoint() -> Dict[str, Any]:
    """Protected endpoint that requires Permit2 payment with ERC-20 approval sponsoring."""
    if shutdown_requested:
        raise HTTPException(status_code=503, detail="Server shutting down")

    return {
        "message": "Permit2+ERC20Approval endpoint accessed successfully",
        "timestamp": "2024-01-01T00:00:00Z",
        "method": "permit2+erc20approval",
    }


@app.get("/upto/evm/permit2")
async def protected_upto_permit2_endpoint(response: FastAPIResponse):
    """Protected endpoint that requires upto Permit2 payment."""
    if shutdown_requested:
        raise HTTPException(status_code=503, detail="Server shutting down")
    set_settlement_overrides(response, {"amount": "1000"})
    return {
        "message": "Upto endpoint accessed successfully",
        "timestamp": "2024-01-01T00:00:00Z",
        "method": "upto-permit2",
    }


@app.get("/upto/evm/permit2-eip2612GasSponsoring")
async def protected_upto_permit2_eip2612_endpoint(response: FastAPIResponse):
    """Protected endpoint that requires upto Permit2 payment with EIP-2612 gas sponsoring."""
    if shutdown_requested:
        raise HTTPException(status_code=503, detail="Server shutting down")
    set_settlement_overrides(response, {"amount": "1000"})
    return {
        "message": "Upto Permit2 EIP-2612 endpoint accessed successfully",
        "timestamp": "2024-01-01T00:00:00Z",
        "method": "upto-permit2-eip2612",
    }


@app.get("/upto/evm/permit2-erc20ApprovalGasSponsoring")
async def protected_upto_permit2_erc20_endpoint(response: FastAPIResponse):
    """Protected endpoint that requires upto Permit2 payment with ERC-20 approval gas sponsoring."""
    if shutdown_requested:
        raise HTTPException(status_code=503, detail="Server shutting down")
    set_settlement_overrides(response, {"amount": "1000"})
    return {
        "message": "Upto Permit2 ERC-20 approval endpoint accessed successfully",
        "timestamp": "2024-01-01T00:00:00Z",
        "method": "upto-permit2-erc20-approval",
    }


@app.get("/batch-settlement/evm/eip3009")
async def protected_batch_settlement_eip3009_endpoint() -> Dict[str, Any]:
    """Batch-settlement EIP-3009 deposit endpoint."""
    if shutdown_requested:
        raise HTTPException(status_code=503, detail="Server shutting down")
    return {
        "message": "Batch-settlement endpoint accessed successfully",
        "timestamp": "2024-01-01T00:00:00Z",
    }


@app.get("/batch-settlement/evm/permit2")
async def protected_batch_settlement_permit2_endpoint() -> Dict[str, Any]:
    """Batch-settlement Permit2 deposit endpoint."""
    if shutdown_requested:
        raise HTTPException(status_code=503, detail="Server shutting down")
    return {
        "message": "Batch-settlement Permit2 endpoint accessed successfully",
        "timestamp": "2024-01-01T00:00:00Z",
        "method": "batch-settlement-permit2",
    }


@app.get("/batch-settlement/evm/permit2-eip2612GasSponsoring")
async def protected_batch_settlement_permit2_eip2612_endpoint() -> Dict[str, Any]:
    """Batch-settlement Permit2 with EIP-2612 gas sponsoring."""
    if shutdown_requested:
        raise HTTPException(status_code=503, detail="Server shutting down")
    return {
        "message": "Batch-settlement Permit2 EIP-2612 endpoint accessed successfully",
        "timestamp": "2024-01-01T00:00:00Z",
        "method": "batch-settlement-permit2-eip2612",
    }


@app.get("/batch-settlement/evm/permit2-erc20ApprovalGasSponsoring")
async def protected_batch_settlement_permit2_erc20_endpoint() -> Dict[str, Any]:
    """Batch-settlement Permit2 with ERC-20 approval gas sponsoring."""
    if shutdown_requested:
        raise HTTPException(status_code=503, detail="Server shutting down")
    return {
        "message": "Batch-settlement Permit2 ERC-20 approval endpoint accessed successfully",
        "timestamp": "2024-01-01T00:00:00Z",
        "method": "batch-settlement-permit2-erc20-approval",
    }


@app.get("/health")
async def health_check() -> Dict[str, Any]:
    """Health check endpoint."""
    return {
        "status": "healthy",
        "timestamp": "2024-01-01T00:00:00Z",
        "server": "fastapi",
    }


@app.post("/close")
async def close_server() -> Dict[str, Any]:
    """Graceful shutdown endpoint."""
    global shutdown_requested
    shutdown_requested = True

    # Schedule server shutdown after response
    async def delayed_shutdown():
        await asyncio.sleep(0.1)
        os.kill(os.getpid(), signal.SIGTERM)

    asyncio.create_task(delayed_shutdown())

    return {
        "message": "Server shutting down gracefully",
        "timestamp": "2024-01-01T00:00:00Z",
    }


def signal_handler(signum, frame):
    """Handle shutdown signals gracefully."""
    print("Received shutdown signal, exiting...")
    sys.exit(0)


if __name__ == "__main__":
    # Set up signal handlers for graceful shutdown
    signal.signal(signal.SIGTERM, signal_handler)
    signal.signal(signal.SIGINT, signal_handler)

    import uvicorn

    print(f"Starting FastAPI server on port {cfg.port}")
    print(f"EVM address: {cfg.evm_address}")
    print(f"SVM address: {cfg.svm_address}")
    print(f"EVM Network: {cfg.evm_network}")
    print(f"SVM Network: {cfg.svm_network}")
    print(f"Using facilitator: {cfg.facilitator_url}")
    print("Server listening on port", cfg.port)

    uvicorn.run(app, host="0.0.0.0", port=cfg.port, log_level="warning")
