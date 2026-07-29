// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title ISP1Verifier
/// @notice Minimal SP1 verifier interface (matches succinctlabs/sp1-contracts).
interface ISP1Verifier {
    /// @notice Verifies an SP1 proof for `programVKey` with the given public values.
    /// @dev Reverts if the proof is invalid.
    function verifyProof(bytes32 programVKey, bytes calldata publicValues, bytes calldata proofBytes)
        external
        view;
}
