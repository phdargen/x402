// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";

import {IAuthCaptureEscrow, ICaptureAuthorizer, ICaptureLifecycle} from "../x402CaptureAuthorizer.sol";

/// @title MinCaptureDelayAuthorizer
/// @notice Example `receiverAuthorizer` policy contract for {x402CaptureAuthorizer}: it enforces a mandatory
///         cooling-off window so a payment cannot be captured until `MIN_CAPTURE_DELAY` seconds after it was
///         authorized. This is the signature-pattern equivalent of an escrow-period condition: the time is
///         recorded by a state-writing lifecycle hook and read back by a read-only authorization predicate.
///
/// @dev **How it plugs in.** A merchant deploys this contract and sets it as the payment's `receiverAuthorizer`
///      (folded into `PaymentInfo.salt` per {x402CaptureAuthorizer}). Because it advertises {ICaptureAuthorizer}
///      via ERC-165, the wrapper routes through *policy mode*:
///        - On `authorize`, the wrapper calls {onAuthorize} (a normal, state-mutating `CALL`) and this contract
///          records the on-chain authorization timestamp. `AuthCaptureEscrow` does not store one, so the hook
///          is the trustworthy time anchor.
///        - On `capture`, the wrapper `STATICCALL`s {authorizeCapture}; this contract returns `true` only once
///          the delay has elapsed *and* the merchant key (`OWNER`) has signed the exact capture parameters.
///
///      Because {onAuthorize} is the only state write and it is gated to the wrapper, the recorded timestamp
///      cannot be back-dated by a third party. The authorization predicates are `view`, so this contract can
///      never move funds, mutate escrow state, or reenter — it only answers allow/deny.
///
///      **Replay note (view-path limitation).** The authorization predicates are read-only, so they cannot burn
///      a nonce. Replay of the *same* owner-signed capture is therefore bounded only by the escrow's remaining
///      capturable balance: for a single full capture this is naturally safe, but a merchant issuing *partial*
///      capture signatures should treat each one as reusable up to that remaining balance. The escrow caps total
///      captures at the authorized amount regardless.
///
/// @author x402 Protocol
contract MinCaptureDelayAuthorizer is EIP712, IERC165, ICaptureAuthorizer, ICaptureLifecycle {
    // =========================================================================
    // Constants — EIP-712 Type Hashes
    // =========================================================================

    /// @dev The merchant key signs over these to authorize an operation; bound to this contract's EIP-712 domain.
    bytes32 public constant CAPTURE_TYPEHASH =
        keccak256("Capture(bytes32 paymentInfoHash,uint256 amount,uint16 feeBps,address feeReceiver)");

    bytes32 public constant VOID_TYPEHASH = keccak256("Void(bytes32 paymentInfoHash)");

    bytes32 public constant REFUND_TYPEHASH = keccak256("Refund(bytes32 paymentInfoHash,uint256 amount)");

    // =========================================================================
    // Immutables
    // =========================================================================

    /// @notice The canonical commerce-payments escrow (used to derive the payment hash key).
    IAuthCaptureEscrow public immutable ESCROW;

    /// @notice The {x402CaptureAuthorizer} permitted to drive the {onAuthorize} lifecycle hook.
    address public immutable WRAPPER;

    /// @notice The merchant key that must sign capture/void/refund authorizations.
    address public immutable OWNER;

    /// @notice Seconds that must elapse after authorization before capture is permitted.
    uint256 public immutable MIN_CAPTURE_DELAY;

    // =========================================================================
    // Storage
    // =========================================================================

    /// @notice Unix timestamp at which each payment was authorized (0 if never authorized through the wrapper).
    mapping(bytes32 paymentInfoHash => uint256) public authorizedAt;

    // =========================================================================
    // Events
    // =========================================================================

    /// @notice Emitted when the authorization timestamp is recorded for a payment.
    event AuthorizationRecorded(bytes32 indexed paymentInfoHash, uint256 timestamp);

    // =========================================================================
    // Errors
    // =========================================================================

    error NotWrapper();

    // =========================================================================
    // Constructor
    // =========================================================================

    /// @param escrow The canonical `AuthCaptureEscrow` address.
    /// @param wrapper The {x402CaptureAuthorizer} that relays this payment's lifecycle.
    /// @param owner The merchant key authorizing capture/void/refund.
    /// @param minCaptureDelay The mandatory delay (seconds) between authorization and capture.
    constructor(
        address escrow,
        address wrapper,
        address owner,
        uint256 minCaptureDelay
    ) EIP712("MinCaptureDelayAuthorizer", "1") {
        ESCROW = IAuthCaptureEscrow(escrow);
        WRAPPER = wrapper;
        OWNER = owner;
        MIN_CAPTURE_DELAY = minCaptureDelay;
    }

    // =========================================================================
    // Lifecycle Hook (state-writing; wrapper-only)
    // =========================================================================

    /// @inheritdoc ICaptureLifecycle
    /// @dev Records the first authorization time for the payment. Gated to `WRAPPER` so the timestamp reflects a
    ///      real escrow authorization at the real block time and cannot be back-dated by anyone else.
    function onAuthorize(
        IAuthCaptureEscrow.PaymentInfo calldata paymentInfo
    ) external override {
        if (msg.sender != WRAPPER) revert NotWrapper();
        bytes32 paymentInfoHash = ESCROW.getHash(paymentInfo);
        if (authorizedAt[paymentInfoHash] == 0) {
            authorizedAt[paymentInfoHash] = block.timestamp;
            emit AuthorizationRecorded(paymentInfoHash, block.timestamp);
        }
    }

    // =========================================================================
    // Authorization Predicates (read-only; STATICCALL'd by the wrapper)
    // =========================================================================

    /// @inheritdoc ICaptureAuthorizer
    /// @dev Allowed only once the cooling-off window has elapsed and the merchant key signed this exact capture.
    function authorizeCapture(
        IAuthCaptureEscrow.PaymentInfo calldata paymentInfo,
        uint256 amount,
        uint16 feeBps,
        address feeReceiver,
        bytes calldata authData
    ) external view override returns (bool) {
        bytes32 paymentInfoHash = ESCROW.getHash(paymentInfo);

        uint256 authTime = authorizedAt[paymentInfoHash];
        if (authTime == 0 || block.timestamp < authTime + MIN_CAPTURE_DELAY) return false;

        return _verifyOwner(
            keccak256(abi.encode(CAPTURE_TYPEHASH, paymentInfoHash, amount, feeBps, feeReceiver)), authData
        );
    }

    /// @inheritdoc ICaptureAuthorizer
    /// @dev Not supported: single-shot `charge` settles immediately and would bypass the mandatory capture delay.
    function authorizeCharge(
        IAuthCaptureEscrow.PaymentInfo calldata,
        uint256,
        uint16,
        address,
        bytes calldata
    ) external pure override returns (bool) {
        return false;
    }

    /// @inheritdoc ICaptureAuthorizer
    /// @dev Voiding returns escrow to the payer, so it is permitted whenever the merchant key authorizes it
    ///      (no delay); the payer also retains the escrow's independent `reclaim` after `authorizationExpiry`.
    function authorizeVoid(
        IAuthCaptureEscrow.PaymentInfo calldata paymentInfo,
        bytes calldata authData
    ) external view override returns (bool) {
        return _verifyOwner(keccak256(abi.encode(VOID_TYPEHASH, ESCROW.getHash(paymentInfo))), authData);
    }

    /// @inheritdoc ICaptureAuthorizer
    /// @dev Refunding captured funds to the payer is permitted whenever the merchant key authorizes it.
    function authorizeRefund(
        IAuthCaptureEscrow.PaymentInfo calldata paymentInfo,
        uint256 amount,
        bytes calldata authData
    ) external view override returns (bool) {
        return _verifyOwner(keccak256(abi.encode(REFUND_TYPEHASH, ESCROW.getHash(paymentInfo), amount)), authData);
    }

    // =========================================================================
    // ERC-165
    // =========================================================================

    /// @inheritdoc IERC165
    /// @dev Advertising {ICaptureAuthorizer} is what makes the wrapper route through policy mode; advertising
    ///      {ICaptureLifecycle} is what makes it call {onAuthorize}.
    function supportsInterface(
        bytes4 interfaceId
    ) external pure override returns (bool) {
        return interfaceId == type(ICaptureAuthorizer).interfaceId
            || interfaceId == type(ICaptureLifecycle).interfaceId || interfaceId == type(IERC165).interfaceId;
    }

    // =========================================================================
    // Internal Helpers
    // =========================================================================

    /// @dev True if `authData` is a valid `OWNER` signature over the EIP-712 digest of `structHash`. Uses
    ///      {SignatureChecker} so `OWNER` may be an EOA or an EIP-1271 smart-contract wallet.
    function _verifyOwner(bytes32 structHash, bytes calldata authData) internal view returns (bool) {
        return SignatureChecker.isValidSignatureNow(OWNER, _hashTypedDataV4(structHash), authData);
    }
}
