"""Flask e2e test server using x402 v2 SDK."""

import os
import signal
import sys
import logging
from flask import Flask, jsonify

from x402 import x402ResourceServerSync
from x402.http import FacilitatorConfig, HTTPFacilitatorClientSync
from x402.http.middleware.flask import PaymentMiddleware, set_settlement_overrides
from e2e_server_shared import load_server_config, configure_resource_server, build_payment_routes

logging.getLogger("werkzeug").setLevel(logging.ERROR)
logging.getLogger("flask").setLevel(logging.ERROR)

cfg = load_server_config()
app = Flask(__name__)

if cfg.facilitator_url:
    print(f"Using remote facilitator at: {cfg.facilitator_url}")
    facilitator = HTTPFacilitatorClientSync(FacilitatorConfig(url=cfg.facilitator_url))
else:
    print("Using default facilitator")
    facilitator = HTTPFacilitatorClientSync()

server = x402ResourceServerSync(facilitator)
configure_resource_server(server, cfg)
routes = build_payment_routes(cfg)

# Apply payment middleware
PaymentMiddleware(app, routes, server)

# Global flag to track if server should accept new requests
shutdown_requested = False


@app.route("/exact/evm/eip3009")
def protected_endpoint():
    """Protected endpoint that requires payment."""
    if shutdown_requested:
        return jsonify({"error": "Server shutting down"}), 503

    return jsonify(
        {
            "message": "Access granted to protected resource",
            "timestamp": "2024-01-01T00:00:00Z",
            "data": {"resource": "premium_content", "access_level": "paid"},
        }
    )


@app.route("/exact/svm")
def protected_svm_endpoint():
    """Protected endpoint that requires SVM (Solana) payment."""
    if shutdown_requested:
        return jsonify({"error": "Server shutting down"}), 503

    return jsonify(
        {
            "message": "Access granted to SVM protected resource",
            "timestamp": "2024-01-01T00:00:00Z",
        }
    )


@app.route("/exact/tvm")
def protected_tvm_endpoint():
    """Protected endpoint that requires TVM payment."""
    if shutdown_requested:
        return jsonify({"error": "Server shutting down"}), 503

    return jsonify(
        {
            "message": "Access granted to TVM protected resource",
            "timestamp": "2024-01-01T00:00:00Z",
        }
    )


@app.route("/exact/evm/permit2-eip2612GasSponsoring")
def protected_permit2_endpoint():
    """Protected endpoint that requires Permit2 payment."""
    if shutdown_requested:
        return jsonify({"error": "Server shutting down"}), 503
    return jsonify(
        {
            "message": "Permit2 endpoint accessed successfully",
            "timestamp": "2024-01-01T00:00:00Z",
            "method": "permit2",
        }
    )


@app.route("/exact/evm/permit2-erc20ApprovalGasSponsoring")
def protected_permit2_erc20_endpoint():
    """Protected endpoint that requires Permit2 payment with ERC-20 approval sponsoring."""
    if shutdown_requested:
        return jsonify({"error": "Server shutting down"}), 503
    return jsonify(
        {
            "message": "Permit2+ERC20Approval endpoint accessed successfully",
            "timestamp": "2024-01-01T00:00:00Z",
            "method": "permit2+erc20approval",
        }
    )


@app.route("/upto/evm/permit2")
def protected_upto_permit2_endpoint():
    """Protected endpoint that requires upto Permit2 payment."""
    if shutdown_requested:
        return jsonify({"error": "Server shutting down"}), 503
    resp = jsonify(
        {
            "message": "Upto endpoint accessed successfully",
            "timestamp": "2024-01-01T00:00:00Z",
            "method": "upto-permit2",
        }
    )
    set_settlement_overrides(resp, {"amount": "1000"})
    return resp


@app.route("/upto/evm/permit2-eip2612GasSponsoring")
def protected_upto_permit2_eip2612_endpoint():
    """Protected endpoint that requires upto Permit2 payment with EIP-2612 gas sponsoring."""
    if shutdown_requested:
        return jsonify({"error": "Server shutting down"}), 503
    resp = jsonify(
        {
            "message": "Upto Permit2 EIP-2612 endpoint accessed successfully",
            "timestamp": "2024-01-01T00:00:00Z",
            "method": "upto-permit2-eip2612",
        }
    )
    set_settlement_overrides(resp, {"amount": "1000"})
    return resp


@app.route("/batch-settlement/evm/eip3009")
def protected_batch_settlement_eip3009_endpoint():
    """Batch-settlement EIP-3009 deposit endpoint."""
    if shutdown_requested:
        return jsonify({"error": "Server shutting down"}), 503
    return jsonify(
        {
            "message": "Batch-settlement endpoint accessed successfully",
            "timestamp": "2024-01-01T00:00:00Z",
        }
    )


@app.route("/batch-settlement/evm/permit2")
def protected_batch_settlement_permit2_endpoint():
    """Batch-settlement Permit2 deposit endpoint."""
    if shutdown_requested:
        return jsonify({"error": "Server shutting down"}), 503
    return jsonify(
        {
            "message": "Batch-settlement Permit2 endpoint accessed successfully",
            "timestamp": "2024-01-01T00:00:00Z",
            "method": "batch-settlement-permit2",
        }
    )


@app.route("/batch-settlement/evm/permit2-eip2612GasSponsoring")
def protected_batch_settlement_permit2_eip2612_endpoint():
    """Batch-settlement Permit2 with EIP-2612 gas sponsoring."""
    if shutdown_requested:
        return jsonify({"error": "Server shutting down"}), 503
    return jsonify(
        {
            "message": "Batch-settlement Permit2 EIP-2612 endpoint accessed successfully",
            "timestamp": "2024-01-01T00:00:00Z",
            "method": "batch-settlement-permit2-eip2612",
        }
    )


@app.route("/batch-settlement/evm/permit2-erc20ApprovalGasSponsoring")
def protected_batch_settlement_permit2_erc20_endpoint():
    """Batch-settlement Permit2 with ERC-20 approval gas sponsoring."""
    if shutdown_requested:
        return jsonify({"error": "Server shutting down"}), 503
    return jsonify(
        {
            "message": "Batch-settlement Permit2 ERC-20 approval endpoint accessed successfully",
            "timestamp": "2024-01-01T00:00:00Z",
            "method": "batch-settlement-permit2-erc20-approval",
        }
    )


@app.route("/upto/evm/permit2-erc20ApprovalGasSponsoring")
def protected_upto_permit2_erc20_endpoint():
    """Protected endpoint that requires upto Permit2 payment with ERC-20 approval gas sponsoring."""
    if shutdown_requested:
        return jsonify({"error": "Server shutting down"}), 503
    resp = jsonify(
        {
            "message": "Upto Permit2 ERC-20 approval endpoint accessed successfully",
            "timestamp": "2024-01-01T00:00:00Z",
            "method": "upto-permit2-erc20-approval",
        }
    )
    set_settlement_overrides(resp, {"amount": "1000"})
    return resp


@app.route("/health")
def health_check():
    """Health check endpoint."""
    return jsonify(
        {"status": "healthy", "timestamp": "2024-01-01T00:00:00Z", "server": "flask"}
    )


@app.route("/close", methods=["POST"])
def close_server():
    """Graceful shutdown endpoint."""
    global shutdown_requested
    shutdown_requested = True

    # Schedule server shutdown after response
    def shutdown():
        os.kill(os.getpid(), signal.SIGTERM)

    import threading

    timer = threading.Timer(0.1, shutdown)
    timer.start()

    return jsonify(
        {
            "message": "Server shutting down gracefully",
            "timestamp": "2024-01-01T00:00:00Z",
        }
    )


def signal_handler(signum, frame):
    """Handle shutdown signals gracefully."""
    print("Received shutdown signal, exiting...")
    sys.exit(0)


if __name__ == "__main__":
    # Set up signal handlers for graceful shutdown
    signal.signal(signal.SIGTERM, signal_handler)
    signal.signal(signal.SIGINT, signal_handler)

    print(f"Starting Flask server on port {cfg.port}")
    print(f"EVM address: {cfg.evm_address}")
    print(f"SVM address: {cfg.svm_address}")
    print(f"EVM Network: {cfg.evm_network}")
    print(f"SVM Network: {cfg.svm_network}")
    print(f"Using facilitator: {cfg.facilitator_url}")
    print("Server listening on port", cfg.port)

    app.run(
        host="0.0.0.0",
        port=cfg.port,
        debug=False,  # Disable debug mode to reduce logs
        use_reloader=False,  # Disable reloader to reduce logs
    )
