// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Multicall} from "@openzeppelin/contracts/utils/Multicall.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";

import {IAuthCaptureEscrow} from "./interfaces/IAuthCaptureEscrow.sol";

/// @title x402CaptureAuthorizer
/// @notice `AuthCaptureEscrow` operator that gates every lifecycle call on an EIP-712 signature from an authorizer
///         committed to by `paymentInfo.salt`.
///
/// @dev Deployed as `PaymentInfo.operator`, so the escrow's own `onlySender(operator)` gate routes all calls
///      through here. Each entry point requires that `paymentInfo.salt == getSalt(authorizer, randomSalt)` and
///      that `authorizer` signed a digest binding the operation's parameters.
///
///      No owner and no state beyond `nonceBitmap`. Uses `ReentrancyGuardTransient` (EIP-1153); deploy only where
///      transient storage is supported.
///
/// @author Coinbase
contract x402CaptureAuthorizer is EIP712, Multicall, ReentrancyGuardTransient {
    using SafeERC20 for IERC20;

    // =========================================================================
    // Immutables
    // =========================================================================

    /// @notice The `AuthCaptureEscrow` singleton this contract operates on behalf of.
    IAuthCaptureEscrow public immutable ESCROW;

    // =========================================================================
    // Constants — EIP-712 Type Hashes
    // =========================================================================

    /// @dev `paymentInfoHash` is `ESCROW.getHash(paymentInfo)`, which already commits to `block.chainid`, the
    ///      escrow address, and every `PaymentInfo` field.
    bytes32 public constant AUTHORIZE_TYPEHASH =
        keccak256("Authorize(bytes32 paymentInfoHash,uint256 amount,address tokenCollector,bytes32 collectorDataHash)");

    bytes32 public constant CHARGE_TYPEHASH = keccak256(
        "Charge(bytes32 paymentInfoHash,uint256 amount,address tokenCollector,bytes32 collectorDataHash,uint16 feeBps,address feeReceiver)"
    );

    bytes32 public constant CAPTURE_TYPEHASH =
        keccak256("Capture(bytes32 paymentInfoHash,uint256 amount,uint16 feeBps,address feeReceiver,uint256 nonce)");

    bytes32 public constant VOID_TYPEHASH = keccak256("Void(bytes32 paymentInfoHash)");

    bytes32 public constant REFUND_TYPEHASH = keccak256(
        "Refund(bytes32 paymentInfoHash,uint256 amount,address tokenCollector,address refundPayer,uint256 nonce)"
    );

    // =========================================================================
    // Storage
    // =========================================================================

    /// @notice Unordered nonces scoped per payment, 256 to a slot.
    ///
    /// @dev Only `capture` and `refund` consume a nonce; the rest are already single-shot on the escrow, which
    ///      reverts once `hasCollectedPayment` is set (`authorize`, `charge`) or `capturableAmount` is zero
    ///      (`void`). Nonces start at 0 for every payment.
    mapping(bytes32 paymentInfoHash => mapping(uint256 word => uint256 bitmap)) public nonceBitmap;

    // =========================================================================
    // Errors
    // =========================================================================

    /// @notice `paymentInfo.operator` is not this contract.
    error WrongOperator();

    /// @notice `paymentInfo.salt` does not commit to `(authorizer, randomSalt)`.
    error SaltAuthorizerMismatch();

    /// @notice The authorizer signature does not match the operation digest.
    error InvalidSignature();

    /// @notice This `(paymentInfoHash, nonce)` pair was already consumed.
    error NonceAlreadyUsed();

    /// @notice The authorizer address is zero.
    error ZeroAuthorizer();

    // =========================================================================
    // Constructor
    // =========================================================================

    /// @param escrow The `AuthCaptureEscrow` singleton address.
    constructor(
        address escrow
    ) EIP712("x402 Capture Authorizer", "1") {
        ESCROW = IAuthCaptureEscrow(escrow);
    }

    // =========================================================================
    // Lifecycle Operations
    // =========================================================================

    /// @notice Escrows funds from the payer, gated on an `Authorize` signature.
    ///
    /// @param paymentInfo The payment being authorized; `operator` must be this contract.
    /// @param amount Amount to place on hold.
    /// @param tokenCollector Escrow token collector that performs the pull.
    /// @param collectorData Opaque bytes forwarded to the collector.
    /// @param authorizer Signer of `authorizerSignature`.
    /// @param randomSalt Second preimage of `paymentInfo.salt`.
    /// @param authorizerSignature Signature over `getAuthorizeDigest(...)`.
    ///
    /// @dev `amount` is signed because it is destructive rather than merely wasteful: collectors pull the full
    ///      `paymentInfo.maxAmount` and return the excess, so a call at a token amount consumes the payer's
    ///      single-use collector nonce and leaves the payment stuck at that amount.
    function authorize(
        IAuthCaptureEscrow.PaymentInfo calldata paymentInfo,
        uint256 amount,
        address tokenCollector,
        bytes calldata collectorData,
        address authorizer,
        uint256 randomSalt,
        bytes calldata authorizerSignature
    ) external nonReentrant {
        bytes32 paymentInfoHash = _checkSalt(paymentInfo, authorizer, randomSalt);
        _checkSignature(
            authorizer,
            getAuthorizeDigest(paymentInfoHash, amount, tokenCollector, keccak256(collectorData)),
            authorizerSignature
        );

        ESCROW.authorize(paymentInfo, amount, tokenCollector, collectorData);
    }

    /// @notice Collects and immediately distributes funds in one step, gated on a `Charge` signature.
    ///
    /// @param paymentInfo The payment being charged; `operator` must be this contract.
    /// @param amount Amount to charge.
    /// @param tokenCollector Escrow token collector that performs the pull.
    /// @param collectorData Opaque bytes forwarded to the collector.
    /// @param feeBps Fee rate in basis points; the escrow enforces `[minFeeBps, maxFeeBps]`.
    /// @param feeReceiver Fee recipient; must match `paymentInfo.feeReceiver` unless that is zero.
    /// @param authorizer Signer of `authorizerSignature`.
    /// @param randomSalt Second preimage of `paymentInfo.salt`.
    /// @param authorizerSignature Signature over `getChargeDigest(...)`.
    function charge(
        IAuthCaptureEscrow.PaymentInfo calldata paymentInfo,
        uint256 amount,
        address tokenCollector,
        bytes calldata collectorData,
        uint16 feeBps,
        address feeReceiver,
        address authorizer,
        uint256 randomSalt,
        bytes calldata authorizerSignature
    ) external nonReentrant {
        bytes32 paymentInfoHash = _checkSalt(paymentInfo, authorizer, randomSalt);
        _checkSignature(
            authorizer,
            getChargeDigest(paymentInfoHash, amount, tokenCollector, keccak256(collectorData), feeBps, feeReceiver),
            authorizerSignature
        );

        ESCROW.charge(paymentInfo, amount, tokenCollector, collectorData, feeBps, feeReceiver);
    }

    /// @notice Releases escrowed funds to the receiver, gated on a `Capture` signature.
    ///
    /// @param paymentInfo The payment being captured; `operator` must be this contract.
    /// @param amount Amount to capture; may be called repeatedly up to the authorized total.
    /// @param feeBps Fee rate in basis points.
    /// @param feeReceiver Fee recipient.
    /// @param authorizer Signer of `authorizerSignature`.
    /// @param randomSalt Second preimage of `paymentInfo.salt`.
    /// @param nonce Unordered nonce, unique per payment.
    /// @param authorizerSignature Signature over `getCaptureDigest(...)`.
    ///
    /// @dev Retry a stalled capture at the same nonce and parameters: the signature is byte-identical, so
    ///      resubmission is idempotent. Re-signing at a fresh nonce would allow a double capture.
    function capture(
        IAuthCaptureEscrow.PaymentInfo calldata paymentInfo,
        uint256 amount,
        uint16 feeBps,
        address feeReceiver,
        address authorizer,
        uint256 randomSalt,
        uint256 nonce,
        bytes calldata authorizerSignature
    ) external nonReentrant {
        bytes32 paymentInfoHash = _checkSalt(paymentInfo, authorizer, randomSalt);
        _checkSignature(
            authorizer, getCaptureDigest(paymentInfoHash, amount, feeBps, feeReceiver, nonce), authorizerSignature
        );
        _useNonce(paymentInfoHash, nonce);

        ESCROW.capture(paymentInfo, amount, feeBps, feeReceiver);
    }

    /// @notice Voids an authorization and returns escrowed funds to the payer, gated on a `Void` signature.
    ///
    /// @param paymentInfo The payment being voided; `operator` must be this contract.
    /// @param authorizer Signer of `authorizerSignature`.
    /// @param randomSalt Second preimage of `paymentInfo.salt`.
    /// @param authorizerSignature Signature over `getVoidDigest(...)`.
    function void(
        IAuthCaptureEscrow.PaymentInfo calldata paymentInfo,
        address authorizer,
        uint256 randomSalt,
        bytes calldata authorizerSignature
    ) external nonReentrant {
        bytes32 paymentInfoHash = _checkSalt(paymentInfo, authorizer, randomSalt);
        _checkSignature(authorizer, getVoidDigest(paymentInfoHash), authorizerSignature);

        ESCROW.void(paymentInfo);
    }

    /// @notice Returns captured funds to the payer, gated on a `Refund` signature.
    ///
    /// @param paymentInfo The payment being refunded; `operator` must be this contract.
    /// @param amount Amount to refund; the escrow caps this at the payment's `refundableAmount`.
    /// @param tokenCollector Refund-type escrow token collector, normally `OperatorRefundCollector`.
    /// @param collectorData Opaque bytes forwarded to the collector; unused by `OperatorRefundCollector`.
    /// @param refundPayer Address funding the refund; must have approved this contract for `amount`.
    /// @param authorizer Signer of `authorizerSignature`.
    /// @param randomSalt Second preimage of `paymentInfo.salt`.
    /// @param nonce Unordered nonce, unique per payment.
    /// @param authorizerSignature Signature over `getRefundDigest(...)`.
    ///
    /// @dev `OperatorRefundCollector` pulls from `paymentInfo.operator`, which is this contract, and this contract
    ///      holds no balance of its own. Hence the staging: pull `amount` from `refundPayer`, approve the collector
    ///      for exactly that, let the escrow drive the collection, then zero the approval. A collector that sources
    ///      its liquidity elsewhere leaves the staged funds untouched, so they are returned to `refundPayer`.
    ///
    ///      A standing `refundPayer` allowance is safe to leave in place: the escrow caps `amount` at the payment's
    ///      `refundableAmount`, and reaching that payment at all requires a signature from the authorizer its
    ///      `salt` commits to.
    function refund(
        IAuthCaptureEscrow.PaymentInfo calldata paymentInfo,
        uint256 amount,
        address tokenCollector,
        bytes calldata collectorData,
        address refundPayer,
        address authorizer,
        uint256 randomSalt,
        uint256 nonce,
        bytes calldata authorizerSignature
    ) external nonReentrant {
        bytes32 paymentInfoHash = _checkSalt(paymentInfo, authorizer, randomSalt);
        _checkSignature(
            authorizer,
            getRefundDigest(paymentInfoHash, amount, tokenCollector, refundPayer, nonce),
            authorizerSignature
        );
        _useNonce(paymentInfoHash, nonce);

        IERC20 token = IERC20(paymentInfo.token);
        uint256 balanceBefore = token.balanceOf(address(this));

        token.safeTransferFrom(refundPayer, address(this), amount);
        token.forceApprove(tokenCollector, amount);

        ESCROW.refund(paymentInfo, amount, tokenCollector, collectorData);

        token.forceApprove(tokenCollector, 0);

        uint256 unspent = token.balanceOf(address(this)) - balanceBefore;
        if (unspent > 0) token.safeTransfer(refundPayer, unspent);
    }

    // =========================================================================
    // View Functions
    // =========================================================================

    /// @notice EIP-712 digest an authorizer signs to permit `authorize`.
    function getAuthorizeDigest(
        bytes32 paymentInfoHash,
        uint256 amount,
        address tokenCollector,
        bytes32 collectorDataHash
    ) public view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(abi.encode(AUTHORIZE_TYPEHASH, paymentInfoHash, amount, tokenCollector, collectorDataHash))
        );
    }

    /// @notice EIP-712 digest an authorizer signs to permit `charge`.
    function getChargeDigest(
        bytes32 paymentInfoHash,
        uint256 amount,
        address tokenCollector,
        bytes32 collectorDataHash,
        uint16 feeBps,
        address feeReceiver
    ) public view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    CHARGE_TYPEHASH, paymentInfoHash, amount, tokenCollector, collectorDataHash, feeBps, feeReceiver
                )
            )
        );
    }

    /// @notice EIP-712 digest an authorizer signs to permit `capture`.
    function getCaptureDigest(
        bytes32 paymentInfoHash,
        uint256 amount,
        uint16 feeBps,
        address feeReceiver,
        uint256 nonce
    ) public view returns (bytes32) {
        return
            _hashTypedDataV4(
                keccak256(abi.encode(CAPTURE_TYPEHASH, paymentInfoHash, amount, feeBps, feeReceiver, nonce))
            );
    }

    /// @notice EIP-712 digest an authorizer signs to permit `void`.
    function getVoidDigest(
        bytes32 paymentInfoHash
    ) public view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(VOID_TYPEHASH, paymentInfoHash)));
    }

    /// @notice EIP-712 digest an authorizer signs to permit `refund`.
    function getRefundDigest(
        bytes32 paymentInfoHash,
        uint256 amount,
        address tokenCollector,
        address refundPayer,
        uint256 nonce
    ) public view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(abi.encode(REFUND_TYPEHASH, paymentInfoHash, amount, tokenCollector, refundPayer, nonce))
        );
    }

    /// @notice The salt a payer must embed in `PaymentInfo` to bind a payment to `authorizer`.
    function getSalt(
        address authorizer,
        uint256 randomSalt
    ) public pure returns (uint256) {
        return uint256(keccak256(abi.encode(authorizer, randomSalt)));
    }

    /// @notice Whether `nonce` has already been consumed for `paymentInfoHash`.
    function isNonceUsed(
        bytes32 paymentInfoHash,
        uint256 nonce
    ) public view returns (bool) {
        return nonceBitmap[paymentInfoHash][nonce >> 8] & (1 << (nonce & 0xff)) != 0;
    }

    // =========================================================================
    // Internal Helpers
    // =========================================================================

    /// @dev Checks this contract is the operator and that `paymentInfo.salt` commits to `(authorizer, randomSalt)`,
    ///      then returns the payment identifier.
    function _checkSalt(
        IAuthCaptureEscrow.PaymentInfo calldata paymentInfo,
        address authorizer,
        uint256 randomSalt
    ) internal view returns (bytes32) {
        if (paymentInfo.operator != address(this)) revert WrongOperator();
        if (authorizer == address(0)) revert ZeroAuthorizer();
        if (paymentInfo.salt != getSalt(authorizer, randomSalt)) revert SaltAuthorizerMismatch();
        return ESCROW.getHash(paymentInfo);
    }

    /// @dev Accepts both ECDSA and ERC-1271 signatures.
    function _checkSignature(
        address authorizer,
        bytes32 digest,
        bytes calldata signature
    ) internal view {
        if (!SignatureChecker.isValidSignatureNow(authorizer, digest, signature)) revert InvalidSignature();
    }

    /// @dev Marks `nonce` consumed for `paymentInfoHash`, reverting if it was already set.
    function _useNonce(
        bytes32 paymentInfoHash,
        uint256 nonce
    ) internal {
        uint256 bit = 1 << (nonce & 0xff);
        uint256 word = nonce >> 8;
        uint256 bitmap = nonceBitmap[paymentInfoHash][word];
        if (bitmap & bit != 0) revert NonceAlreadyUsed();
        nonceBitmap[paymentInfoHash][word] = bitmap | bit;
    }
}
