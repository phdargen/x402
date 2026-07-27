"""Mechanisms catalog loader for the Python e2e resource servers.

SSOT is e2e/config/mechanisms.json. Route paths, payment requirements, and
declared extensions all come from there, so adding a mechanism does not require
editing fastapi/flask entrypoints.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable

SDK = "python"
PROTECTED_ROUTE_MESSAGE = "Protected endpoint accessed successfully"


def _find_catalog() -> Path:
    """Prefer the harness-injected path, else walk up from this file (then cwd)."""
    injected = os.getenv("E2E_MECHANISMS_CATALOG")
    if injected:
        path = Path(injected)
        if not path.is_file():
            raise FileNotFoundError(
                f"E2E_MECHANISMS_CATALOG does not point at a file: {injected}"
            )
        return path

    for start in (Path(__file__).resolve(), Path.cwd().resolve() / "_"):
        for parent in start.parents:
            candidate = parent / "config" / "mechanisms.json"
            if candidate.is_file():
                return candidate
    raise FileNotFoundError("Could not locate e2e/config/mechanisms.json")


def _load() -> dict[str, Any]:
    with _find_catalog().open(encoding="utf-8") as handle:
        return json.load(handle)


_CATALOG = _load()


@dataclass(frozen=True)
class CatalogRoute:
    """One paid HTTP route as declared in the catalog."""

    path: str
    scheme: str
    network: str
    asset_transfer_method: str | None
    price: dict[str, Any]
    extensions: list[str]
    settlement_override: dict[str, str] | None


@dataclass(frozen=True)
class ResolvedRoute:
    """A catalog route with env-dependent payment requirements resolved."""

    path: str
    network_id: str
    scheme: str
    network: str
    pay_to: str
    price: Any
    extra: dict[str, str] | None
    extensions: list[str] = field(default_factory=list)
    settlement_override: dict[str, str] | None = None


def _network_definition(network_id: str) -> dict[str, Any]:
    definition = _CATALOG["networks"].get(network_id)
    if definition is None:
        raise KeyError(f"Unknown network in catalog: {network_id}")
    return definition


def _route_filter() -> tuple[set[str], set[str]]:
    """Scheme/network exclusions for surfaces narrower than the catalog."""

    def parse(name: str) -> set[str]:
        return {part.strip() for part in os.getenv(name, "").split(",") if part.strip()}

    return parse("E2E_EXCLUDE_SCHEMES"), parse("E2E_EXCLUDE_NETWORKS")


def catalog_routes() -> list[CatalogRoute]:
    """Routes this SDK implements, after applying the harness exclusions."""
    excluded_schemes, excluded_networks = _route_filter()
    routes: list[CatalogRoute] = []

    for path, definition in _CATALOG["routes"].items():
        if SDK not in definition.get("sdks", []):
            continue
        network = definition["network"]
        if definition["scheme"] in excluded_schemes or network in excluded_networks:
            continue
        routes.append(
            CatalogRoute(
                path=path,
                scheme=definition["scheme"],
                network=network,
                asset_transfer_method=definition.get("assetTransferMethod"),
                price=definition.get("price") or _network_definition(network)["defaultPrice"],
                extensions=list(definition.get("extensions", [])),
                settlement_override=definition.get("settlementOverride"),
            )
        )

    return routes


def network_caip2(network_id: str, env: Callable[[str], str | None] = os.getenv) -> str:
    """CAIP-2 id for a network: the harness env override, else the catalog testnet."""
    definition = _network_definition(network_id)
    return (
        env(definition["networkEnv"]["networkKey"]) or definition["networks"]["testnet"]["caip2"]
    )


def _network_mode(network_id: str, caip2: str) -> str:
    modes = _network_definition(network_id)["networks"]
    return "mainnet" if modes["mainnet"]["caip2"] == caip2 else "testnet"


def _resolve_price(
    route: CatalogRoute, caip2: str, env: Callable[[str], str | None]
) -> tuple[Any, dict[str, str] | None]:
    spec = route.price

    if "usd" in spec:
        extra = (
            {"assetTransferMethod": route.asset_transfer_method}
            if spec.get("declareAssetTransferMethod") and route.asset_transfer_method
            else None
        )
        return spec["usd"], extra

    mode_config = _network_definition(route.network)["networks"][_network_mode(route.network, caip2)]

    amount = (env(spec["amountEnv"]) if spec.get("amountEnv") else None) or spec.get("amount")
    if not amount:
        raise ValueError(f"Route {route.path}: price has no amount")

    asset_default = (
        mode_config.get("permit2Asset") if spec.get("assetRef") == "permit2" else spec.get("asset")
    )
    asset = (env(spec["assetEnv"]) if spec.get("assetEnv") else None) or asset_default
    if not asset:
        raise ValueError(f"Route {route.path}: price has no asset")
    asset_overridden = bool(asset_default) and asset != asset_default

    extra: dict[str, str] = {}
    if route.asset_transfer_method:
        extra["assetTransferMethod"] = route.asset_transfer_method
    if spec.get("permit2Domain") and mode_config.get("permit2AssetName"):
        extra["name"] = mode_config["permit2AssetName"]
        extra["version"] = "2"
    for key, env_spec in (spec.get("extraEnv") or {}).items():
        if env_spec.get("whenAssetOverridden") and not asset_overridden:
            continue
        value = env(env_spec["env"])
        if value:
            extra[key] = value

    price: dict[str, Any] = {"amount": amount, "asset": asset}
    if extra:
        price["extra"] = extra
    return price, None


def resolve_routes(env: Callable[[str], str | None] = os.getenv) -> list[ResolvedRoute]:
    """Resolve catalog routes for one server process.

    The payee address and CAIP-2 identifier per network come from the env keys the
    catalog declares. Routes whose network has no configured payee are dropped, so
    the server only advertises what it can settle.
    """
    resolved: list[ResolvedRoute] = []

    for route in catalog_routes():
        definition = _network_definition(route.network)
        pay_to = env(definition["env"]["server"][0])
        if not pay_to:
            continue

        caip2 = network_caip2(route.network, env)
        price, extra = _resolve_price(route, caip2, env)

        resolved.append(
            ResolvedRoute(
                path=route.path,
                network_id=route.network,
                scheme=route.scheme,
                network=caip2,
                pay_to=pay_to,
                price=price,
                extra=extra,
                extensions=route.extensions,
                settlement_override=route.settlement_override,
            )
        )

    return resolved


@dataclass(frozen=True)
class ServedNetwork:
    """One network this server serves, with the payee it settles to."""

    id: str
    network: str
    pay_to: str


def served_networks(env: Callable[[str], str | None] = os.getenv) -> list[ServedNetwork]:
    """Networks the resolved routes cover, in catalog order — for banners/health."""
    served: dict[str, ServedNetwork] = {}
    for route in resolve_routes(env):
        served.setdefault(
            route.network_id,
            ServedNetwork(id=route.network_id, network=route.network, pay_to=route.pay_to),
        )
    return list(served.values())


def route_discovery_output() -> dict[str, Any]:
    """Bazaar discovery metadata matching the fixed paid-route success body."""
    example = {"message": PROTECTED_ROUTE_MESSAGE, "timestamp": "2024-01-01T00:00:00Z"}
    return {
        "example": example,
        "schema": {
            "properties": {key: {"type": "string"} for key in example},
            "required": list(example),
        },
    }
