// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {IAuthCaptureEscrow} from "../../src/interfaces/IAuthCaptureEscrow.sol";
import {MockERC3009Token} from "./MockERC3009Token.sol";

/// @dev Mirrors the `TokenCollector` surface of the deployed commerce-payments escrow.
interface IMockTokenCollector {
    enum CollectorType {
        Payment,
        Refund
    }

    function collectorType() external view returns (CollectorType);

    function collectTokens(
        IAuthCaptureEscrow.PaymentInfo calldata paymentInfo,
        address tokenStore,
        uint256 amount,
        bytes calldata collectorData
    ) external;
}

/// @dev Per-operator vault holding escrowed funds, mirroring the real `TokenStore` clone.
contract MockTokenStore {
    address public immutable ESCROW;

    error OnlyEscrow();

    constructor() {
        ESCROW = msg.sender;
    }

    function sendTokens(
        address token,
        address to,
        uint256 amount
    ) external {
        if (msg.sender != ESCROW) revert OnlyEscrow();
        SafeERC20.safeTransfer(IERC20(token), to, amount);
    }
}

/// @dev Mirrors the real escrow's `getHash` derivation, `onlySender(operator)` gating, lifecycle accounting,
///      `feeBps` arithmetic, and post-collection token store balance assertion. Expiry validation is omitted; the
///      fork test covers it against the deployed contract.
contract MockAuthCaptureEscrow is IAuthCaptureEscrow {
    uint16 internal constant _MAX_FEE_BPS = 10_000;

    bytes32 public constant PAYMENT_INFO_TYPEHASH = keccak256(
        "PaymentInfo(address operator,address payer,address receiver,address token,uint120 maxAmount,uint48 preApprovalExpiry,uint48 authorizationExpiry,uint48 refundExpiry,uint16 minFeeBps,uint16 maxFeeBps,address feeReceiver,uint256 salt)"
    );

    mapping(bytes32 paymentInfoHash => PaymentState) internal _paymentState;
    mapping(address operator => address store) internal _tokenStores;

    event PaymentCharged(
        bytes32 indexed paymentInfoHash,
        PaymentInfo paymentInfo,
        uint256 amount,
        address tokenCollector,
        uint16 feeBps,
        address feeReceiver
    );
    event PaymentAuthorized(
        bytes32 indexed paymentInfoHash, PaymentInfo paymentInfo, uint256 amount, address tokenCollector
    );
    event PaymentCaptured(bytes32 indexed paymentInfoHash, uint256 amount, uint16 feeBps, address feeReceiver);
    event PaymentVoided(bytes32 indexed paymentInfoHash, uint256 amount);
    event PaymentRefunded(bytes32 indexed paymentInfoHash, uint256 amount, address tokenCollector);

    error InvalidSender(address sender, address expected);
    error ZeroAmount();
    error PaymentAlreadyCollected(bytes32 paymentInfoHash);
    error InsufficientAuthorization(bytes32 paymentInfoHash, uint256 authorizedAmount, uint256 requestedAmount);
    error ZeroAuthorization(bytes32 paymentInfoHash);
    error RefundExceedsCapture(uint256 refundAmount, uint256 captured);
    error FeeBpsOutOfRange(uint16 feeBps, uint16 minFeeBps, uint16 maxFeeBps);
    error InvalidCollectorForOperation();
    error TokenCollectionFailed();

    modifier onlySender(
        address sender
    ) {
        if (msg.sender != sender) revert InvalidSender(msg.sender, sender);
        _;
    }

    modifier validAmount(
        uint256 amount
    ) {
        if (amount == 0) revert ZeroAmount();
        _;
    }

    function authorize(
        PaymentInfo calldata paymentInfo,
        uint256 amount,
        address tokenCollector,
        bytes calldata collectorData
    ) external onlySender(paymentInfo.operator) validAmount(amount) {
        bytes32 paymentInfoHash = getHash(paymentInfo);
        if (_paymentState[paymentInfoHash].hasCollectedPayment) revert PaymentAlreadyCollected(paymentInfoHash);

        _paymentState[paymentInfoHash] =
            PaymentState({hasCollectedPayment: true, capturableAmount: uint120(amount), refundableAmount: 0});
        emit PaymentAuthorized(paymentInfoHash, paymentInfo, amount, tokenCollector);

        _collectTokens(paymentInfo, amount, tokenCollector, collectorData, IMockTokenCollector.CollectorType.Payment);
    }

    function charge(
        PaymentInfo calldata paymentInfo,
        uint256 amount,
        address tokenCollector,
        bytes calldata collectorData,
        uint16 feeBps,
        address feeReceiver
    ) external onlySender(paymentInfo.operator) validAmount(amount) {
        _validateFee(paymentInfo, feeBps);

        bytes32 paymentInfoHash = getHash(paymentInfo);
        if (_paymentState[paymentInfoHash].hasCollectedPayment) revert PaymentAlreadyCollected(paymentInfoHash);

        _paymentState[paymentInfoHash] =
            PaymentState({hasCollectedPayment: true, capturableAmount: 0, refundableAmount: uint120(amount)});
        emit PaymentCharged(paymentInfoHash, paymentInfo, amount, tokenCollector, feeBps, feeReceiver);

        _collectTokens(paymentInfo, amount, tokenCollector, collectorData, IMockTokenCollector.CollectorType.Payment);
        _distributeTokens(paymentInfo.token, paymentInfo.receiver, amount, feeBps, feeReceiver);
    }

    function capture(
        PaymentInfo calldata paymentInfo,
        uint256 amount,
        uint16 feeBps,
        address feeReceiver
    ) external onlySender(paymentInfo.operator) validAmount(amount) {
        _validateFee(paymentInfo, feeBps);

        bytes32 paymentInfoHash = getHash(paymentInfo);
        PaymentState memory state = _paymentState[paymentInfoHash];
        if (state.capturableAmount < amount) {
            revert InsufficientAuthorization(paymentInfoHash, state.capturableAmount, amount);
        }

        state.capturableAmount -= uint120(amount);
        state.refundableAmount += uint120(amount);
        _paymentState[paymentInfoHash] = state;
        emit PaymentCaptured(paymentInfoHash, amount, feeBps, feeReceiver);

        _distributeTokens(paymentInfo.token, paymentInfo.receiver, amount, feeBps, feeReceiver);
    }

    function void(
        PaymentInfo calldata paymentInfo
    ) external onlySender(paymentInfo.operator) {
        bytes32 paymentInfoHash = getHash(paymentInfo);
        uint256 authorizedAmount = _paymentState[paymentInfoHash].capturableAmount;
        if (authorizedAmount == 0) revert ZeroAuthorization(paymentInfoHash);

        _paymentState[paymentInfoHash].capturableAmount = 0;
        emit PaymentVoided(paymentInfoHash, authorizedAmount);

        _sendTokens(paymentInfo.operator, paymentInfo.token, paymentInfo.payer, authorizedAmount);
    }

    function refund(
        PaymentInfo calldata paymentInfo,
        uint256 amount,
        address tokenCollector,
        bytes calldata collectorData
    ) external onlySender(paymentInfo.operator) validAmount(amount) {
        bytes32 paymentInfoHash = getHash(paymentInfo);
        uint120 captured = _paymentState[paymentInfoHash].refundableAmount;
        if (captured < amount) revert RefundExceedsCapture(amount, captured);

        _paymentState[paymentInfoHash].refundableAmount = captured - uint120(amount);
        emit PaymentRefunded(paymentInfoHash, amount, tokenCollector);

        _collectTokens(paymentInfo, amount, tokenCollector, collectorData, IMockTokenCollector.CollectorType.Refund);
        _sendTokens(paymentInfo.operator, paymentInfo.token, paymentInfo.payer, amount);
    }

    function getHash(
        PaymentInfo calldata paymentInfo
    ) public view returns (bytes32) {
        bytes32 paymentInfoHash = keccak256(abi.encode(PAYMENT_INFO_TYPEHASH, paymentInfo));
        return keccak256(abi.encode(block.chainid, address(this), paymentInfoHash));
    }

    /// @dev The real escrow predicts a CREATE2 clone address; this mock deploys lazily and returns zero until then.
    function getTokenStore(
        address operator
    ) public view returns (address) {
        return _tokenStores[operator];
    }

    function paymentState(
        bytes32 paymentInfoHash
    ) external view returns (bool hasCollectedPayment, uint120 capturableAmount, uint120 refundableAmount) {
        PaymentState memory state = _paymentState[paymentInfoHash];
        return (state.hasCollectedPayment, state.capturableAmount, state.refundableAmount);
    }

    function _collectTokens(
        PaymentInfo calldata paymentInfo,
        uint256 amount,
        address tokenCollector,
        bytes calldata collectorData,
        IMockTokenCollector.CollectorType collectorType
    ) internal {
        if (IMockTokenCollector(tokenCollector).collectorType() != collectorType) {
            revert InvalidCollectorForOperation();
        }

        address token = paymentInfo.token;
        address tokenStore = _ensureTokenStore(paymentInfo.operator);
        uint256 balanceBefore = IERC20(token).balanceOf(tokenStore);
        IMockTokenCollector(tokenCollector).collectTokens(paymentInfo, tokenStore, amount, collectorData);
        if (IERC20(token).balanceOf(tokenStore) != balanceBefore + amount) revert TokenCollectionFailed();
    }

    function _sendTokens(
        address operator,
        address token,
        address recipient,
        uint256 amount
    ) internal {
        MockTokenStore(_ensureTokenStore(operator)).sendTokens(token, recipient, amount);
    }

    function _distributeTokens(
        address token,
        address receiver,
        uint256 amount,
        uint16 feeBps,
        address feeReceiver
    ) internal {
        uint256 feeAmount = amount * feeBps / _MAX_FEE_BPS;
        if (feeAmount > 0) _sendTokens(msg.sender, token, feeReceiver, feeAmount);
        if (amount > feeAmount) _sendTokens(msg.sender, token, receiver, amount - feeAmount);
    }

    function _ensureTokenStore(
        address operator
    ) internal returns (address) {
        address store = _tokenStores[operator];
        if (store == address(0)) {
            store = address(new MockTokenStore());
            _tokenStores[operator] = store;
        }
        return store;
    }

    function _validateFee(
        PaymentInfo calldata paymentInfo,
        uint16 feeBps
    ) internal pure {
        if (feeBps < paymentInfo.minFeeBps || feeBps > paymentInfo.maxFeeBps) {
            revert FeeBpsOutOfRange(feeBps, paymentInfo.minFeeBps, paymentInfo.maxFeeBps);
        }
    }
}

/// @dev Mirrors `ERC3009PaymentCollector`: pulls the full `maxAmount` from the payer, returns the excess, and
///      forwards `amount` to the token store. Signature verification is stubbed out by `MockERC3009Token`.
contract MockPaymentCollector is IMockTokenCollector {
    function collectorType() external pure returns (CollectorType) {
        return CollectorType.Payment;
    }

    function collectTokens(
        IAuthCaptureEscrow.PaymentInfo calldata paymentInfo,
        address tokenStore,
        uint256 amount,
        bytes calldata
    ) external {
        uint256 maxAmount = paymentInfo.maxAmount;
        MockERC3009Token(paymentInfo.token)
            .receiveWithAuthorization(
                paymentInfo.payer, address(this), maxAmount, 0, paymentInfo.preApprovalExpiry, bytes32(0), ""
            );

        if (maxAmount > amount) {
            SafeERC20.safeTransfer(IERC20(paymentInfo.token), paymentInfo.payer, maxAmount - amount);
        }
        SafeERC20.safeTransfer(IERC20(paymentInfo.token), tokenStore, amount);
    }
}

/// @dev Minimal ERC-1271 wallet that accepts ECDSA signatures from a single owner key.
contract MockERC1271Signer {
    bytes4 internal constant _MAGIC_VALUE = 0x1626ba7e;

    address public immutable OWNER;

    constructor(
        address owner
    ) {
        OWNER = owner;
    }

    function isValidSignature(
        bytes32 hash,
        bytes calldata signature
    ) external view returns (bytes4) {
        (address recovered, ECDSA.RecoverError err,) = ECDSA.tryRecover(hash, signature);
        if (err == ECDSA.RecoverError.NoError && recovered == OWNER) return _MAGIC_VALUE;
        return 0xffffffff;
    }
}
