"""Shared env + routes for Python e2e resource servers (fastapi/flask).

Route paths and payment requirements come from the mechanisms catalog via
:mod:`catalog`; only scheme registration lives here.
"""

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
from catalog import ResolvedRoute, network_caip2, resolve_routes, route_discovery_output


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
        evm_network=network_caip2("evm"),
        svm_network=network_caip2("svm"),
        tvm_network=network_caip2("tvm"),
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


def _declare_extension(extension_id: str, route: ResolvedRoute) -> dict[str, Any]:
    """Map a catalog extension id to the SDK call that declares it on a route."""
    if extension_id == "bazaar":
        output = route_discovery_output()
        return declare_discovery_extension(
            output=OutputConfig(example=output["example"], schema=output["schema"])
        )
    if extension_id == "eip2612GasSponsoring":
        return declare_eip2612_gas_sponsoring_extension()
    if extension_id == "erc20ApprovalGasSponsoring":
        return declare_erc20_approval_gas_sponsoring_extension()
    raise ValueError(f'Route {route.path} declares unknown extension "{extension_id}"')


def build_payment_routes(cfg: ServerConfig) -> dict[str, Any]:
    """Payment route map for fastapi/flask e2e servers, derived from the catalog."""
    routes: dict[str, Any] = {}

    for route in resolve_routes():
        accepts: dict[str, Any] = {
            "scheme": route.scheme,
            "payTo": route.pay_to,
            "network": route.network,
            "price": route.price,
        }
        if route.extra:
            accepts["extra"] = route.extra

        entry: dict[str, Any] = {"accepts": accepts}
        if route.extensions:
            extensions: dict[str, Any] = {}
            for extension_id in route.extensions:
                extensions.update(_declare_extension(extension_id, route))
            entry["extensions"] = extensions

        routes[f"GET {route.path}"] = entry

    return routes
