// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title IAttributionVerifier
/// @notice Verifies a zk proof that attests to a hybrid-gateway `batchCommitment`.
interface IAttributionVerifier {
    /// @notice Returns true if `proof` is a valid attribution proof for `batchCommitment`.
    /// @dev Must not revert on an invalid proof; return false instead so the gateway can
    ///      surface a stable `InvalidAttributionProof` error.
    function verifyAttribution(bytes calldata proof, bytes32 batchCommitment) external view returns (bool);
}
