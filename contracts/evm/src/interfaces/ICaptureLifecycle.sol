// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IAuthCaptureEscrow} from "./IAuthCaptureEscrow.sol";

/// @notice Optional mutating hook after a successful escrow `authorize`.
interface ICaptureLifecycle {
    function onAuthorize(
        IAuthCaptureEscrow.PaymentInfo calldata paymentInfo
    ) external;
}
