"""SVM sync/async compatibility regression tests."""

from __future__ import annotations

import inspect
import threading
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from solders.hash import Hash
from solders.keypair import Keypair
from solders.pubkey import Pubkey

from x402.mechanisms.svm import SOLANA_DEVNET_CAIP2, TOKEN_PROGRAM_ADDRESS, USDC_DEVNET_ADDRESS
from x402.mechanisms.svm.exact import ExactSvmClientScheme, ExactSvmFacilitatorScheme
from x402.mechanisms.svm.exact.v1 import ExactSvmSchemeV1
from x402.mechanisms.svm.signers import KeypairSigner
from x402.pending_settlement_store import InMemoryPendingSettlementStore
from x402.schemas import PaymentPayload, PaymentRequirements, ResourceInfo, VerifyResponse
from x402.schemas.v1 import PaymentRequirementsV1

FIXED_BLOCKHASH = "5Tx8F3jgSHx21CbtjwmdaKPLM5tWmreWAnPrbqHomSJF"


def _mock_rpc_client() -> MagicMock:
    mock_client = MagicMock()
    mock_blockhash_response = MagicMock()
    mock_blockhash_response.value.blockhash = Hash.from_string(FIXED_BLOCKHASH)
    mock_client.get_latest_blockhash = AsyncMock(return_value=mock_blockhash_response)

    mock_account_info = MagicMock()
    mock_account_info.value = MagicMock()
    mock_account_info.value.owner = Pubkey.from_string(TOKEN_PROGRAM_ADDRESS)
    mock_account_info.value.data = bytes(44) + bytes([6]) + bytes(37)
    mock_client.get_account_info = AsyncMock(return_value=mock_account_info)
    mock_client.close = AsyncMock()
    return mock_client


def _v2_requirements() -> PaymentRequirements:
    fee_payer = Keypair.from_seed(bytes([2] * 32))
    pay_to = Keypair.from_seed(bytes([3] * 32))
    return PaymentRequirements(
        scheme="exact",
        network=SOLANA_DEVNET_CAIP2,
        asset=USDC_DEVNET_ADDRESS,
        amount="100000",
        pay_to=str(pay_to.pubkey()),
        max_timeout_seconds=3600,
        extra={"feePayer": str(fee_payer.pubkey()), "recentBlockhash": FIXED_BLOCKHASH},
    )


def _v1_requirements() -> PaymentRequirementsV1:
    fee_payer = Keypair.from_seed(bytes([2] * 32))
    pay_to = Keypair.from_seed(bytes([3] * 32))
    return PaymentRequirementsV1(
        scheme="exact",
        network="solana-devnet",
        resource="https://example.com",
        asset=USDC_DEVNET_ADDRESS,
        max_amount_required="100000",
        pay_to=str(pay_to.pubkey()),
        max_timeout_seconds=3600,
        extra={"feePayer": str(fee_payer.pubkey()), "recentBlockhash": FIXED_BLOCKHASH},
    )


class TestDirectSyncClientCalls:
    def test_v2_create_payment_payload_returns_dict_from_sync_code(self):
        client = ExactSvmClientScheme(KeypairSigner(Keypair.from_seed(bytes([1] * 32))))
        with patch.object(client, "_get_client", return_value=_mock_rpc_client()):
            result = client.create_payment_payload(_v2_requirements())
        assert isinstance(result, dict)
        assert "transaction" in result
        assert not inspect.isawaitable(result)

    def test_v1_create_payment_payload_returns_dict_from_sync_code(self):
        client = ExactSvmSchemeV1(KeypairSigner(Keypair.from_seed(bytes([1] * 32))))
        with patch.object(client, "_get_client", return_value=_mock_rpc_client()):
            result = client.create_payment_payload(_v1_requirements())
        assert isinstance(result, dict)
        assert "transaction" in result
        assert not inspect.isawaitable(result)

    @pytest.mark.asyncio
    async def test_v2_create_payment_payload_async_under_loop(self):
        client = ExactSvmClientScheme(KeypairSigner(Keypair.from_seed(bytes([1] * 32))))
        with patch.object(client, "_get_client", return_value=_mock_rpc_client()):
            result = client.create_payment_payload(_v2_requirements())
        assert inspect.isawaitable(result)
        payload = await result
        assert isinstance(payload, dict)
        assert "transaction" in payload


class LegacySyncFacilitatorSigner:
    """Legacy sync RPC signer (pre solana>=0.40 style)."""

    def __init__(self, addresses: list[str] | None = None):
        self._addresses = addresses or ["FeePayer1111111111111111111111111111"]

    def get_addresses(self) -> list[str]:
        return self._addresses

    def sign_transaction(self, tx_base64: str, fee_payer: str, network: str) -> str:
        return tx_base64

    def simulate_transaction(self, tx_base64: str, network: str) -> None:
        return None

    def send_transaction(self, tx_base64: str, network: str) -> str:
        return "legacySignature"

    def confirm_transaction(self, signature: str, network: str) -> None:
        return None


class TestDirectSyncFacilitatorCalls:
    def test_v2_verify_returns_response_from_sync_code(self):
        facilitator = ExactSvmFacilitatorScheme(LegacySyncFacilitatorSigner())
        payload = PaymentPayload(
            x402_version=2,
            resource=ResourceInfo(
                url="http://example.com",
                description="Test",
                mime_type="application/json",
            ),
            accepted=_v2_requirements(),
            payload={"transaction": "base64transaction=="},
        )
        with patch(
            "x402.mechanisms.svm.exact.facilitator.decode_transaction_from_payload",
            side_effect=Exception("decode fail"),
        ):
            result = facilitator.verify(payload, _v2_requirements())
        assert not inspect.isawaitable(result)
        assert result.is_valid is False


class TestLegacySyncSignerCompatibility:
    @pytest.mark.asyncio
    async def test_v2_verify_with_sync_signer_methods(self):
        facilitator = ExactSvmFacilitatorScheme(LegacySyncFacilitatorSigner())
        payload = PaymentPayload(
            x402_version=2,
            resource=ResourceInfo(
                url="http://example.com",
                description="Test",
                mime_type="application/json",
            ),
            accepted=_v2_requirements(),
            payload={"transaction": "base64transaction=="},
        )
        with patch(
            "x402.mechanisms.svm.exact.facilitator.decode_transaction_from_payload",
            side_effect=Exception("decode fail"),
        ):
            result = await facilitator.verify(payload, _v2_requirements())
        assert result.is_valid is False


class _ThreadRecordingStore(InMemoryPendingSettlementStore):
    def __init__(self) -> None:
        super().__init__()
        self.threads: dict[str, threading.Thread | None] = {}

    def get(self, key: str) -> str | None:
        self.threads["get"] = threading.current_thread()
        return super().get(key)

    def set(self, key: str, tx_hash: str) -> None:
        self.threads["set"] = threading.current_thread()
        super().set(key, tx_hash)

    def delete(self, key: str) -> None:
        self.threads["delete"] = threading.current_thread()
        super().delete(key)


class TestPendingStoreOffloadedFromEventLoop:
    @pytest.mark.asyncio
    async def test_pending_store_io_runs_off_event_loop_thread(self):
        from x402.mechanisms.svm.exact.facilitator import ExactSvmScheme

        class ConfirmFailSigner(LegacySyncFacilitatorSigner):
            def confirm_transaction(self, signature: str, network: str) -> None:
                raise TimeoutError("confirm timeout")

        store = _ThreadRecordingStore()
        facilitator = ExactSvmScheme(ConfirmFailSigner(), pending_store=store)
        main_thread = threading.current_thread()

        payload = PaymentPayload(
            x402_version=2,
            resource=ResourceInfo(
                url="http://example.com",
                description="Test",
                mime_type="application/json",
            ),
            accepted=_v2_requirements(),
            payload={"transaction": "base64transaction=="},
        )

        with patch.object(
            facilitator, "_verify_async", return_value=VerifyResponse(is_valid=True, payer="p")
        ):
            with patch(
                "x402.mechanisms.svm.exact.facilitator.decode_transaction_from_payload",
                return_value=MagicMock(),
            ):
                with patch(
                    "x402.mechanisms.svm.exact.facilitator.transaction_message_hash",
                    return_value="tx-key",
                ):
                    result = await facilitator._settle_async(payload, _v2_requirements())

        assert result.error_reason == "settlement_pending"
        assert store.threads.get("set") is not None
        assert store.threads["set"] is not main_thread
