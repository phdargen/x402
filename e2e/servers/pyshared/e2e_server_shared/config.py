"""Shared env + routes for Python e2e resource servers (fastapi/flask)."""

from __future__ import annotations

import os
import sys
from dataclasses import dataclass
from typing import Any

from x402.extensions.bazaar import declare_discovery_extension, OutputConfig
from x402.extensions.eip2612_gas_sponsoring import declare_eip2612_gas_sponsoring_extension
from x402.extensions.erc20_approval_gas_sponsoring import (
    declare_erc20_approval_gas_sponsoring_extension,
)
from x402.mechanisms.tvm import TVM_TESTNET


@dataclass(frozen=True)
class ServerConfig:
    evm_address: str | None
    svm_address: str | None
    tvm_address: str | None
    port: int
    facilitator_url: str | None
    evm_permit2_asset: str
    evm_network: str
    svm_network: str
    tvm_network: str


def load_server_config() -> ServerConfig:
    """Load and validate shared server env."""
    evm_address = os.getenv("SERVER_EVM_ADDRESS")
    svm_address = os.getenv("SERVER_SVM_ADDRESS")
    tvm_address = os.getenv("SERVER_TVM_ADDRESS")
    if not any([evm_address, svm_address, tvm_address]):
        print(
            "Error: At least one of SERVER_EVM_ADDRESS, SERVER_SVM_ADDRESS, or SERVER_TVM_ADDRESS is required"
        )
        sys.exit(1)

    return ServerConfig(
        evm_address=evm_address,
        svm_address=svm_address,
        tvm_address=tvm_address,
        port=int(os.getenv("PORT", "4021")),
        facilitator_url=os.getenv("FACILITATOR_URL"),
        evm_permit2_asset=os.getenv(
            "EVM_PERMIT2_ASSET", "0x036CbD53842c5426634e7929541eC2318f3dCF7e"
        ),
        evm_network=os.getenv("EVM_NETWORK", "eip155:84532"),
        svm_network=os.getenv("SVM_NETWORK", "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1"),
        tvm_network=os.getenv("TVM_NETWORK", TVM_TESTNET),
    )


def configure_resource_server(server: Any, cfg: ServerConfig) -> None:
    """Register exact/upto/batch-settlement/tvm schemes + bazaar on a resource server."""
    from x402.mechanisms.evm.exact import register_exact_evm_server
    from x402.mechanisms.evm.upto import UptoEvmServerScheme
    from x402.mechanisms.evm.batch_settlement.authorizer_signer import LocalAuthorizerSigner
    from x402.mechanisms.evm.batch_settlement.server import (
        BatchSettlementEvmScheme as BatchSettlementServerScheme,
        BatchSettlementEvmSchemeServerConfig,
    )
    from x402.mechanisms.svm.exact import register_exact_svm_server
    from x402.mechanisms.tvm.exact import ExactTvmServerScheme
    from x402.extensions.bazaar import bazaar_resource_server_extension

    register_exact_evm_server(server, cfg.evm_network)
    server.register(cfg.evm_network, UptoEvmServerScheme())
    register_exact_svm_server(server, cfg.svm_network)
    server.register(cfg.tvm_network, ExactTvmServerScheme())

    if cfg.evm_address:
        receiver_authorizer_pk = os.environ.get("SERVER_EVM_RECEIVER_AUTHORIZER_PRIVATE_KEY")
        batch_settlement_authorizer_signer = (
            LocalAuthorizerSigner(receiver_authorizer_pk) if receiver_authorizer_pk else None
        )
        server.register(
            cfg.evm_network,
            BatchSettlementServerScheme(
                cfg.evm_address,
                BatchSettlementEvmSchemeServerConfig(
                    receiver_authorizer_signer=batch_settlement_authorizer_signer,
                ),
            ),
        )

    server.register_extension(bazaar_resource_server_extension)


def build_payment_routes(cfg: ServerConfig) -> dict[str, Any]:
    """Shared payment route map for fastapi/flask e2e servers."""
    routes = {

    "GET /exact/evm/eip3009": {
        "accepts": {
            "scheme": "exact",
            "payTo": cfg.evm_address,
            "price": "$0.001",
            "network": cfg.evm_network,
        },
        "extensions": {
            **declare_discovery_extension(
                output=OutputConfig(
                    example={
                        "message": "Access granted to protected resource",
                        "timestamp": "2024-01-01T00:00:00Z",
                    },
                    schema={
                        "properties": {
                            "message": {"type": "string"},
                            "timestamp": {"type": "string"},
                        },
                        "required": ["message", "timestamp"],
                    },
                )
            ),
        },
    },
    "GET /exact/svm": {
        "accepts": {
            "scheme": "exact",
            "payTo": cfg.svm_address,
            "price": "$0.001",
            "network": cfg.svm_network,
        },
        "extensions": {
            **declare_discovery_extension(
                output=OutputConfig(
                    example={
                        "message": "Access granted to SVM protected resource",
                        "timestamp": "2024-01-01T00:00:00Z",
                    },
                    schema={
                        "properties": {
                            "message": {"type": "string"},
                            "timestamp": {"type": "string"},
                        },
                        "required": ["message", "timestamp"],
                    },
                )
            ),
        },
    },
    "GET /exact/tvm": {
        "accepts": {
            "scheme": "exact",
            "payTo": cfg.tvm_address,
            "price": "$0.001",
            "network": cfg.tvm_network,
        },
        "extensions": {
            **declare_discovery_extension(
                output=OutputConfig(
                    example={
                        "message": "Access granted to TVM protected resource",
                        "timestamp": "2024-01-01T00:00:00Z",
                    },
                    schema={
                        "properties": {
                            "message": {"type": "string"},
                            "timestamp": {"type": "string"},
                        },
                        "required": ["message", "timestamp"],
                    },
                )
            ),
        },
    },
    "GET /exact/evm/permit2-eip2612GasSponsoring": {
        "accepts": {
            "scheme": "exact",
            "payTo": cfg.evm_address,
            "network": cfg.evm_network,
            "price": {
                "amount": "1000",
                "asset": cfg.evm_permit2_asset,
                "extra": {
                    "assetTransferMethod": "permit2",
                    "name": "USDC",
                    "version": "2",
                },
            },
        },
        "extensions": {
            **declare_discovery_extension(
                output=OutputConfig(
                    example={
                        "message": "Permit2 endpoint accessed successfully",
                        "timestamp": "2024-01-01T00:00:00Z",
                        "method": "permit2",
                    },
                    schema={
                        "properties": {
                            "message": {"type": "string"},
                            "timestamp": {"type": "string"},
                            "method": {"type": "string"},
                        },
                        "required": ["message", "timestamp"],
                    },
                )
            ),
            **declare_eip2612_gas_sponsoring_extension(),
        },
    },
    "GET /exact/evm/permit2-erc20ApprovalGasSponsoring": {
        "accepts": {
            "scheme": "exact",
            "payTo": cfg.evm_address,
            "network": cfg.evm_network,
            "price": {
                "amount": "1000",
                "asset": cfg.evm_permit2_asset,
                "extra": {"assetTransferMethod": "permit2"},
            },
        },
        "extensions": {
            **declare_erc20_approval_gas_sponsoring_extension(),
        },
    },
    "GET /upto/evm/permit2": {
        "accepts": {
            "scheme": "upto",
            "payTo": cfg.evm_address,
            "network": cfg.evm_network,
            "price": {
                "amount": "2000",
                "asset": cfg.evm_permit2_asset,
                "extra": {
                    "assetTransferMethod": "permit2",
                    "name": "USDC",
                    "version": "2",
                },
            },
        },
        "extensions": {
            **declare_discovery_extension(
                output=OutputConfig(
                    example={
                        "message": "Upto endpoint accessed successfully",
                        "timestamp": "2024-01-01T00:00:00Z",
                        "method": "upto-permit2",
                    },
                    schema={
                        "properties": {
                            "message": {"type": "string"},
                            "timestamp": {"type": "string"},
                            "method": {"type": "string"},
                        },
                        "required": ["message", "timestamp"],
                    },
                )
            ),
        },
    },
    "GET /upto/evm/permit2-eip2612GasSponsoring": {
        "accepts": {
            "scheme": "upto",
            "payTo": cfg.evm_address,
            "network": cfg.evm_network,
            "price": {
                "amount": "2000",
                "asset": cfg.evm_permit2_asset,
                "extra": {
                    "assetTransferMethod": "permit2",
                    "name": "USDC",
                    "version": "2",
                },
            },
        },
        "extensions": {
            **declare_eip2612_gas_sponsoring_extension(),
        },
    },
    "GET /upto/evm/permit2-erc20ApprovalGasSponsoring": {
        "accepts": {
            "scheme": "upto",
            "payTo": cfg.evm_address,
            "network": cfg.evm_network,
            "price": {
                "amount": "2000",
                "asset": cfg.evm_permit2_asset,
                "extra": {
                    "assetTransferMethod": "permit2",
                },
            },
        },
        "extensions": {
            **declare_erc20_approval_gas_sponsoring_extension(),
        },
    },
    "GET /batch-settlement/evm/eip3009": {
        "accepts": {
            "scheme": "batch-settlement",
            "payTo": cfg.evm_address,
            "price": "$0.001",
            "network": cfg.evm_network,
        },
    },
    "GET /batch-settlement/evm/permit2": {
        "accepts": {
            "scheme": "batch-settlement",
            "payTo": cfg.evm_address,
            "network": cfg.evm_network,
            "price": {
                "amount": "1000",
                "asset": cfg.evm_permit2_asset,
                "extra": {
                    "assetTransferMethod": "permit2",
                    "name": "USDC" if cfg.evm_network == "eip155:84532" else "USD Coin",
                    "version": "2",
                },
            },
        },
    },
    "GET /batch-settlement/evm/permit2-eip2612GasSponsoring": {
        "accepts": {
            "scheme": "batch-settlement",
            "payTo": cfg.evm_address,
            "network": cfg.evm_network,
            "price": "$0.001",
            "extra": {"assetTransferMethod": "permit2"},
        },
        "extensions": {
            **declare_eip2612_gas_sponsoring_extension(),
        },
    },
    "GET /batch-settlement/evm/permit2-erc20ApprovalGasSponsoring": {
        "accepts": {
            "scheme": "batch-settlement",
            "payTo": cfg.evm_address,
            "network": cfg.evm_network,
            "price": {
                "amount": "1000",
                "asset": cfg.evm_permit2_asset,
                "extra": {
                    "assetTransferMethod": "permit2",
                },
            },
        },
        "extensions": {
            **declare_erc20_approval_gas_sponsoring_extension(),
        },
    },

    }
    return {
        route: requirements
        for route, requirements in routes.items()
        if requirements["accepts"].get("payTo")
    }
