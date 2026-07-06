"""Unit tests for resource server extension echo validation.

Covers ``x402ResourceServerBase.validate_extensions``: the generic capability that
ensures a client's echoed extension ``info`` preserves every server-advertised
(non-dynamic) field before the payment reaches the facilitator.
"""

from x402 import x402ResourceServer
from x402.schemas import (
    PaymentPayload,
    PaymentPayloadV1,
    PaymentRequired,
    PaymentRequirements,
)
from x402.server_base import ERR_EXTENSION_ECHO_MISMATCH

BUILDER_CODE = "builder-code"
GAS_SPONSORING = "eip2612-gas-sponsoring"


def _requirements() -> PaymentRequirements:
    return PaymentRequirements(
        scheme="exact",
        network="eip155:84532",
        asset="0xabc",
        amount="1000",
        pay_to="0xrecipient",
        max_timeout_seconds=300,
    )


def _payment_required(extensions: dict | None) -> PaymentRequired:
    return PaymentRequired(accepts=[_requirements()], extensions=extensions)


def _payment_payload(extensions: dict | None) -> PaymentPayload:
    return PaymentPayload(
        x402_version=2,
        payload={"authorization": {}, "signature": "0x"},
        accepted=_requirements(),
        extensions=extensions,
    )


class _DummyExtension:
    """Minimal registered extension exposing optional dynamic info fields."""

    def __init__(self, key: str, dynamic_info_fields: list[str] | None = None) -> None:
        self.key = key
        self.dynamic_info_fields = dynamic_info_fields
        self.hooks = None
        self.transport_hooks = None


def test_passes_when_client_omits_extensions() -> None:
    server = x402ResourceServer()
    required = _payment_required({BUILDER_CODE: {"info": {"a": "bc_myapp"}, "schema": 2}})
    payload = _payment_payload(None)

    assert server.validate_extensions(required, payload).valid


def test_passes_when_no_server_extensions() -> None:
    server = x402ResourceServer()
    required = _payment_required(None)
    payload = _payment_payload({BUILDER_CODE: {"info": {"s": ["svc"]}}})

    assert server.validate_extensions(required, payload).valid


def test_passes_when_builder_code_echo_is_additive() -> None:
    server = x402ResourceServer()
    required = _payment_required({BUILDER_CODE: {"info": {"a": "bc_myapp"}, "schema": 2}})
    # Client re-merge restores server `info.a` + `schema` and adds `info.s`.
    payload = _payment_payload(
        {BUILDER_CODE: {"info": {"a": "bc_myapp", "s": ["svc"]}, "schema": 2}}
    )

    assert server.validate_extensions(required, payload).valid


def test_rejects_when_advertised_field_missing() -> None:
    server = x402ResourceServer()
    required = _payment_required({BUILDER_CODE: {"info": {"a": "bc_myapp"}, "schema": 2}})
    payload = _payment_payload({BUILDER_CODE: {"info": {"s": ["svc"]}}})

    result = server.validate_extensions(required, payload)
    assert not result.valid
    assert result.invalid_reason == ERR_EXTENSION_ECHO_MISMATCH
    assert result.extension_key == BUILDER_CODE


def test_rejects_when_advertised_field_changed() -> None:
    server = x402ResourceServer()
    required = _payment_required({BUILDER_CODE: {"info": {"a": "bc_myapp"}, "schema": 2}})
    payload = _payment_payload({BUILDER_CODE: {"info": {"a": "bc_attacker"}, "schema": 2}})

    result = server.validate_extensions(required, payload)
    assert not result.valid
    assert result.invalid_reason == ERR_EXTENSION_ECHO_MISMATCH


def test_passes_when_gas_sponsoring_echo_preserves_server_fields() -> None:
    server = x402ResourceServer()
    required = _payment_required(
        {
            GAS_SPONSORING: {
                "info": {"description": "Gas sponsoring", "version": "1"},
                "schema": {"type": "object"},
            }
        }
    )
    payload = _payment_payload(
        {
            GAS_SPONSORING: {
                "info": {
                    "description": "Gas sponsoring",
                    "version": "1",
                    "from": "0xpayer",
                    "signature": "0xsig",
                },
                "schema": {"type": "object"},
            }
        }
    )

    assert server.validate_extensions(required, payload).valid


def test_passes_when_dynamic_fields_differ() -> None:
    server = x402ResourceServer()
    server.register_extension(
        _DummyExtension("siwx-like", dynamic_info_fields=["nonce", "issuedAt"])
    )
    required = _payment_required(
        {
            "siwx-like": {
                "info": {"domain": "example.com", "nonce": "abc", "issuedAt": "t1"},
            }
        }
    )
    payload = _payment_payload(
        {
            "siwx-like": {
                "info": {"domain": "example.com", "nonce": "xyz", "issuedAt": "t2"},
            }
        }
    )

    assert server.validate_extensions(required, payload).valid


def test_rejects_when_non_dynamic_field_changed_on_dynamic_extension() -> None:
    server = x402ResourceServer()
    server.register_extension(
        _DummyExtension("siwx-like", dynamic_info_fields=["nonce", "issuedAt"])
    )
    required = _payment_required(
        {
            "siwx-like": {
                "info": {"domain": "example.com", "nonce": "abc"},
            }
        }
    )
    payload = _payment_payload(
        {
            "siwx-like": {
                "info": {"domain": "evil.com", "nonce": "xyz"},
            }
        }
    )

    result = server.validate_extensions(required, payload)
    assert not result.valid
    assert result.invalid_reason == ERR_EXTENSION_ECHO_MISMATCH


def test_skips_v1_payloads() -> None:
    server = x402ResourceServer()
    required = _payment_required({BUILDER_CODE: {"info": {"a": "bc_myapp"}}})
    payload = PaymentPayloadV1(
        x402_version=1,
        scheme="exact",
        network="eip155:84532",
        payload={},
    )

    assert server.validate_extensions(required, payload).valid
