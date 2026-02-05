"""Tests for SVM mechanism exports and utility functions."""

import base64

import pytest

from x402.mechanisms.svm import (
    SCHEME_EXACT,
    SOLANA_DEVNET_CAIP2,
    SOLANA_MAINNET_CAIP2,
    SOLANA_TESTNET_CAIP2,
    SVM_ADDRESS_REGEX,
    USDC_DEVNET_ADDRESS,
    USDC_MAINNET_ADDRESS,
    ClientSvmSigner,
    ExactSvmPayload,
    FacilitatorSvmSigner,
    KeypairSigner,
    SolanaTransaction,
    convert_to_token_amount,
    decode_transaction_from_payload,
    get_usdc_address,
    is_versioned_transaction,
    normalize_network,
    validate_svm_address,
)
from x402.mechanisms.svm.exact import (
    ExactSvmClientScheme,
    ExactSvmFacilitatorScheme,
    ExactSvmScheme,
    ExactSvmServerScheme,
)


class TestExports:
    """Test that main classes and constants are exported."""

    def test_should_export_main_classes(self):
        """Should export main scheme classes."""
        assert ExactSvmScheme is not None
        assert ExactSvmClientScheme is not None
        assert ExactSvmServerScheme is not None
        assert ExactSvmFacilitatorScheme is not None

    def test_should_export_signer_protocols(self):
        """Should export signer protocol classes."""
        assert ClientSvmSigner is not None
        assert FacilitatorSvmSigner is not None

    def test_should_export_signer_implementations(self):
        """Should export signer implementation classes."""
        assert KeypairSigner is not None

    def test_should_export_payload_types(self):
        """Should export payload types."""
        assert ExactSvmPayload is not None


class TestValidateSvmAddress:
    """Test validateSvmAddress function."""

    def test_should_validate_correct_solana_addresses(self):
        """Should validate correct Solana addresses."""
        assert validate_svm_address(USDC_MAINNET_ADDRESS) is True
        assert validate_svm_address(USDC_DEVNET_ADDRESS) is True
        assert validate_svm_address("11111111111111111111111111111111") is True

    def test_should_reject_invalid_addresses(self):
        """Should reject invalid addresses."""
        assert validate_svm_address("") is False
        assert validate_svm_address("invalid") is False
        assert validate_svm_address("0x1234567890abcdef") is False
        assert validate_svm_address("too-short") is False

    def test_should_reject_addresses_with_invalid_characters(self):
        """Should reject addresses with invalid base58 characters (0, O, I, l)."""
        # 'O' not allowed in base58
        assert validate_svm_address("0000000000000000000000000000000O") is False
        # 'I' not allowed in base58
        assert validate_svm_address("0000000000000000000000000000000I") is False
        # 'l' (lowercase L) not allowed in base58
        assert validate_svm_address("0000000000000000000000000000000l") is False


class TestNormalizeNetwork:
    """Test normalizeNetwork function."""

    def test_should_return_caip2_format_as_is(self):
        """Should return CAIP-2 format as-is."""
        assert normalize_network(SOLANA_MAINNET_CAIP2) == SOLANA_MAINNET_CAIP2
        assert normalize_network(SOLANA_DEVNET_CAIP2) == SOLANA_DEVNET_CAIP2
        assert normalize_network(SOLANA_TESTNET_CAIP2) == SOLANA_TESTNET_CAIP2

    def test_should_convert_v1_network_names_to_caip2(self):
        """Should convert V1 network names to CAIP-2."""
        assert normalize_network("solana") == SOLANA_MAINNET_CAIP2
        assert normalize_network("solana-devnet") == SOLANA_DEVNET_CAIP2
        assert normalize_network("solana-testnet") == SOLANA_TESTNET_CAIP2

    def test_should_raise_for_unsupported_networks(self):
        """Should raise ValueError for unsupported networks."""
        with pytest.raises(ValueError, match="Unsupported SVM network"):
            normalize_network("solana:unknown")
        with pytest.raises(ValueError, match="Unsupported SVM network"):
            normalize_network("ethereum:1")
        with pytest.raises(ValueError, match="Unsupported SVM network"):
            normalize_network("unknown-network")


class TestGetUsdcAddress:
    """Test getUsdcAddress function."""

    def test_should_return_mainnet_usdc_address(self):
        """Should return mainnet USDC address."""
        assert get_usdc_address(SOLANA_MAINNET_CAIP2) == USDC_MAINNET_ADDRESS

    def test_should_return_devnet_usdc_address(self):
        """Should return devnet USDC address."""
        assert get_usdc_address(SOLANA_DEVNET_CAIP2) == USDC_DEVNET_ADDRESS

    def test_should_return_testnet_usdc_address(self):
        """Should return testnet USDC address (same as devnet)."""
        assert get_usdc_address(SOLANA_TESTNET_CAIP2) == USDC_DEVNET_ADDRESS

    def test_should_raise_for_unsupported_networks(self):
        """Should raise ValueError for unsupported networks."""
        with pytest.raises(ValueError, match="Unsupported SVM network"):
            get_usdc_address("solana:unknown")


class TestConvertToTokenAmount:
    """Test convertToTokenAmount function."""

    def test_should_convert_decimal_amounts_to_token_units_6_decimals(self):
        """Should convert decimal amounts to token units (6 decimals)."""
        assert convert_to_token_amount("0.10", 6) == "100000"
        assert convert_to_token_amount("1.00", 6) == "1000000"
        assert convert_to_token_amount("0.01", 6) == "10000"
        assert convert_to_token_amount("123.456789", 6) == "123456789"

    def test_should_handle_whole_numbers(self):
        """Should handle whole numbers."""
        assert convert_to_token_amount("1", 6) == "1000000"
        assert convert_to_token_amount("100", 6) == "100000000"

    def test_should_handle_different_decimals(self):
        """Should handle different decimal places."""
        assert convert_to_token_amount("1", 9) == "1000000000"  # SOL
        assert convert_to_token_amount("1", 2) == "100"
        assert convert_to_token_amount("1", 0) == "1"

    def test_should_raise_for_invalid_amounts(self):
        """Should raise ValueError for invalid amounts."""
        with pytest.raises(ValueError, match="Invalid amount"):
            convert_to_token_amount("abc", 6)
        with pytest.raises(ValueError, match="Invalid amount"):
            convert_to_token_amount("", 6)
        # NaN is parsed by Decimal but fails on conversion to int
        with pytest.raises(ValueError):
            convert_to_token_amount("NaN", 6)


class TestConstants:
    """Test that constants are exported with correct values."""

    def test_should_export_correct_usdc_addresses(self):
        """Should export correct USDC addresses."""
        assert USDC_MAINNET_ADDRESS == "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
        assert USDC_DEVNET_ADDRESS == "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"

    def test_should_have_valid_address_regex(self):
        """Should have valid address regex."""
        import re

        pattern = re.compile(SVM_ADDRESS_REGEX)
        assert pattern.match(USDC_MAINNET_ADDRESS) is not None

    def test_should_export_scheme_exact(self):
        """Should export scheme identifier."""
        assert SCHEME_EXACT == "exact"


class TestIsVersionedTransaction:
    """Test is_versioned_transaction function for detecting transaction types."""

    def test_should_detect_legacy_transaction(self):
        """Should detect legacy transactions (message first byte < 0x80)."""
        # Legacy transaction format:
        # - CompactU16(1) = 0x01 (1 signature)
        # - 64 bytes empty signature
        # - Legacy message header: numReqSigs=1, numReadonlySigned=0, numReadonlyUnsigned=0
        # - 1 account key (32 bytes)
        # - Recent blockhash (32 bytes)
        # - 0 instructions
        legacy_tx_bytes = bytes([0x01])  # 1 signature
        legacy_tx_bytes += bytes(64)  # Empty signature slot
        legacy_tx_bytes += bytes([0x01, 0x00, 0x00])  # Legacy header (first byte < 0x80)
        legacy_tx_bytes += bytes([0x01])  # 1 account key
        legacy_tx_bytes += bytes(32)  # Account key
        legacy_tx_bytes += bytes(32)  # Recent blockhash
        legacy_tx_bytes += bytes([0x00])  # 0 instructions

        assert is_versioned_transaction(legacy_tx_bytes) is False

    def test_should_detect_versioned_transaction(self):
        """Should detect versioned (v0) transactions (message first byte >= 0x80)."""
        # Versioned transaction format:
        # - CompactU16(1) = 0x01 (1 signature)
        # - 64 bytes empty signature
        # - Version byte 0x80 (v0)
        # - Message header
        # - 1 account key (32 bytes)
        # - Recent blockhash (32 bytes)
        # - 0 instructions
        # - 0 address table lookups
        versioned_tx_bytes = bytes([0x01])  # 1 signature
        versioned_tx_bytes += bytes(64)  # Empty signature slot
        versioned_tx_bytes += bytes([0x80])  # Version byte for v0 (128 >= 0x80)
        versioned_tx_bytes += bytes([0x01, 0x00, 0x00])  # Header
        versioned_tx_bytes += bytes([0x01])  # 1 account key
        versioned_tx_bytes += bytes(32)  # Account key
        versioned_tx_bytes += bytes(32)  # Recent blockhash
        versioned_tx_bytes += bytes([0x00])  # 0 instructions
        versioned_tx_bytes += bytes([0x00])  # 0 address table lookups

        assert is_versioned_transaction(versioned_tx_bytes) is True

    def test_should_detect_transaction_with_multiple_signatures(self):
        """Should correctly skip multiple signatures when detecting version."""
        # Transaction with 2 signatures
        tx_bytes = bytes([0x02])  # 2 signatures
        tx_bytes += bytes(64)  # First signature
        tx_bytes += bytes(64)  # Second signature
        tx_bytes += bytes([0x80])  # Version byte for v0

        assert is_versioned_transaction(tx_bytes) is True

    def test_legacy_with_high_num_required_signatures(self):
        """Legacy tx with high numRequiredSignatures should still be < 0x80."""
        # A legacy transaction where numRequiredSignatures is 127 (max before 0x80)
        # This is still a valid legacy transaction
        legacy_tx_bytes = bytes([0x01])  # 1 signature
        legacy_tx_bytes += bytes(64)  # Empty signature slot
        legacy_tx_bytes += bytes([0x7F, 0x00, 0x00])  # numReqSigs=127 (0x7F < 0x80)

        assert is_versioned_transaction(legacy_tx_bytes) is False


class TestDecodeTransactionFromPayload:
    """Test decode_transaction_from_payload function for handling both tx types."""

    def test_should_raise_on_invalid_base64(self):
        """Should raise ValueError for invalid base64."""
        payload = ExactSvmPayload(transaction="not-valid-base64!!!")

        with pytest.raises(ValueError, match="invalid_exact_svm_payload_transaction"):
            decode_transaction_from_payload(payload)

    def test_should_raise_on_malformed_transaction(self):
        """Should raise ValueError for malformed transaction bytes."""
        # Valid base64 but not a valid transaction
        payload = ExactSvmPayload(transaction=base64.b64encode(b"not a transaction").decode())

        with pytest.raises(ValueError, match="invalid_exact_svm_payload_transaction"):
            decode_transaction_from_payload(payload)

    def test_should_export_solana_transaction_type(self):
        """Should export SolanaTransaction type alias."""
        # Just verify the type alias is exported and usable
        assert SolanaTransaction is not None
