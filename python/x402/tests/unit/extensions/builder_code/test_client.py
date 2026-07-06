"""Tests for the builder-code client extension."""

import pytest

from x402.extensions.builder_code import (
    BUILDER_CODE,
    BuilderCodeClientExtension,
    declare_builder_code_extension,
)
from x402.schemas import PaymentPayload, PaymentRequired, PaymentRequirements

APP = "bc_my_app"
SERVICE = "bc_my_client"


def _base_payload(extensions: dict | None = None) -> PaymentPayload:
    return PaymentPayload(
        payload={},
        accepted=PaymentRequirements(
            scheme="exact",
            network="eip155:8453",
            asset="0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
            amount="1000",
            pay_to="0x0000000000000000000000000000000000000001",
            max_timeout_seconds=300,
        ),
        extensions=extensions,
    )


def _payment_required(app_code: str | None = None) -> PaymentRequired:
    extensions = {BUILDER_CODE: declare_builder_code_extension(app_code)} if app_code else None
    return PaymentRequired(accepts=[], extensions=extensions)


class TestConstructorValidation:
    def test_rejects_invalid_single_code(self) -> None:
        with pytest.raises(ValueError, match="Invalid builder code"):
            BuilderCodeClientExtension("Bad-Code")

    def test_rejects_when_any_array_entry_invalid(self) -> None:
        with pytest.raises(ValueError, match="Invalid builder code"):
            BuilderCodeClientExtension([SERVICE, "Bad-Code"])


class TestEnrichPaymentPayload:
    def test_attaches_single_service_code(self) -> None:
        client = BuilderCodeClientExtension(SERVICE)
        enriched = client.enrich_payment_payload(_base_payload(), _payment_required(APP))
        assert enriched.extensions[BUILDER_CODE] == {"info": {"s": [SERVICE]}}

    def test_attaches_multiple_service_codes(self) -> None:
        client = BuilderCodeClientExtension([SERVICE, "bc_other"])
        enriched = client.enrich_payment_payload(_base_payload(), _payment_required(APP))
        assert enriched.extensions[BUILDER_CODE] == {"info": {"s": [SERVICE, "bc_other"]}}

    def test_preserves_unrelated_extensions(self) -> None:
        client = BuilderCodeClientExtension(SERVICE)
        payload = _base_payload({"other": {"kept": True}})
        enriched = client.enrich_payment_payload(payload, _payment_required(APP))
        assert enriched.extensions["other"] == {"kept": True}
        assert enriched.extensions[BUILDER_CODE] == {"info": {"s": [SERVICE]}}
