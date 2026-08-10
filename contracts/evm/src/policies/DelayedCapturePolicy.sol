// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ERC165} from "@openzeppelin/contracts/utils/introspection/ERC165.sol";

import {IAuthCaptureEscrow} from "../interfaces/IAuthCaptureEscrow.sol";
import {ICaptureAuthorizer} from "../interfaces/ICaptureAuthorizer.sol";

/// @notice Allows capture only after `paymentInfo.preApprovalExpiry + cooldown`.
contract DelayedCapturePolicy is ICaptureAuthorizer, ERC165 {
    uint48 public immutable COOLDOWN;

    constructor(
        uint48 cooldown
    ) {
        COOLDOWN = cooldown;
    }

    function authorizeAuthorization(
        IAuthCaptureEscrow.PaymentInfo calldata,
        uint256,
        address,
        bytes calldata,
        bytes calldata
    ) external pure returns (bool) {
        return true;
    }

    function authorizeCharge(
        IAuthCaptureEscrow.PaymentInfo calldata,
        uint256,
        address,
        bytes calldata,
        uint16,
        address,
        bytes calldata
    ) external pure returns (bool) {
        return false;
    }

    function authorizeCapture(
        IAuthCaptureEscrow.PaymentInfo calldata paymentInfo,
        uint256,
        uint16,
        address,
        bytes calldata
    ) external view returns (bool) {
        return block.timestamp >= uint256(paymentInfo.preApprovalExpiry) + COOLDOWN;
    }

    function authorizeVoid(
        IAuthCaptureEscrow.PaymentInfo calldata,
        bytes calldata
    ) external pure returns (bool) {
        return true;
    }

    function supportsInterface(
        bytes4 interfaceId
    ) public view override returns (bool) {
        return interfaceId == type(ICaptureAuthorizer).interfaceId || super.supportsInterface(interfaceId);
    }
}
