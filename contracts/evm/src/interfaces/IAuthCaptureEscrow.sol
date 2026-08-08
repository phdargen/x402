// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title IAuthCaptureEscrow
/// @notice Minimal interface for the `AuthCaptureEscrow` singleton.
///
/// @dev `feeBps` is a rate, not an absolute amount: the escrow charges `amount * feeBps / 10_000` and requires
///      `minFeeBps <= feeBps <= maxFeeBps`.
///
/// @author Coinbase
interface IAuthCaptureEscrow {
    /// @notice All information required to authorize and capture a unique payment.
    struct PaymentInfo {
        address operator;
        address payer;
        address receiver;
        address token;
        uint120 maxAmount;
        uint48 preApprovalExpiry;
        uint48 authorizationExpiry;
        uint48 refundExpiry;
        uint16 minFeeBps;
        uint16 maxFeeBps;
        address feeReceiver;
        uint256 salt;
    }

    /// @notice Lifecycle state tracked per payment.
    struct PaymentState {
        bool hasCollectedPayment;
        uint120 capturableAmount;
        uint120 refundableAmount;
    }

    /// @notice Transfers funds from payer to escrow. Callable only by `paymentInfo.operator`.
    function authorize(
        PaymentInfo calldata paymentInfo,
        uint256 amount,
        address tokenCollector,
        bytes calldata collectorData
    ) external;

    /// @notice Transfers funds from payer to receiver in one step. Callable only by `paymentInfo.operator`.
    function charge(
        PaymentInfo calldata paymentInfo,
        uint256 amount,
        address tokenCollector,
        bytes calldata collectorData,
        uint16 feeBps,
        address feeReceiver
    ) external;

    /// @notice Transfers previously-escrowed funds to the receiver. Callable only by `paymentInfo.operator`.
    function capture(
        PaymentInfo calldata paymentInfo,
        uint256 amount,
        uint16 feeBps,
        address feeReceiver
    ) external;

    /// @notice Permanently voids an authorization, returning escrowed funds to the payer.
    function void(
        PaymentInfo calldata paymentInfo
    ) external;

    /// @notice Returns previously-captured tokens to the payer, funded through `tokenCollector`.
    function refund(
        PaymentInfo calldata paymentInfo,
        uint256 amount,
        address tokenCollector,
        bytes calldata collectorData
    ) external;

    /// @notice Canonical payment identifier, committing to `block.chainid` and the escrow address.
    function getHash(
        PaymentInfo calldata paymentInfo
    ) external view returns (bytes32);

    /// @notice Deterministic token store address holding escrowed funds for an operator.
    function getTokenStore(
        address operator
    ) external view returns (address);

    /// @notice Lifecycle state for a payment, keyed by `getHash(paymentInfo)`.
    function paymentState(
        bytes32 paymentInfoHash
    ) external view returns (bool hasCollectedPayment, uint120 capturableAmount, uint120 refundableAmount);
}
