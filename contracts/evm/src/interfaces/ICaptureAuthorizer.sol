// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IAuthCaptureEscrow} from "./IAuthCaptureEscrow.sol";

/// @notice View-only policy predicates invoked by {x402AuthCapturePolicyOperator}.
interface ICaptureAuthorizer {
    function authorizeAuthorization(
        IAuthCaptureEscrow.PaymentInfo calldata paymentInfo,
        uint256 amount,
        address tokenCollector,
        bytes calldata collectorData,
        bytes calldata authData
    ) external view returns (bool);

    function authorizeCharge(
        IAuthCaptureEscrow.PaymentInfo calldata paymentInfo,
        uint256 amount,
        address tokenCollector,
        bytes calldata collectorData,
        uint16 feeBps,
        address feeReceiver,
        bytes calldata authData
    ) external view returns (bool);

    function authorizeCapture(
        IAuthCaptureEscrow.PaymentInfo calldata paymentInfo,
        uint256 amount,
        uint16 feeBps,
        address feeReceiver,
        bytes calldata authData
    ) external view returns (bool);

    function authorizeVoid(
        IAuthCaptureEscrow.PaymentInfo calldata paymentInfo,
        bytes calldata authData
    ) external view returns (bool);
}
