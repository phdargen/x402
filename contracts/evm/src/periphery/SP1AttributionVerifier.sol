// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IAttributionVerifier} from "../interfaces/IAttributionVerifier.sol";
import {ISP1Verifier} from "../interfaces/ISP1Verifier.sol";

/// @title SP1AttributionVerifier
/// @notice Adapts an SP1 Groth16 verifier to {IAttributionVerifier} for the hybrid ZK gateway.
///
/// @dev Both `SP1_VERIFIER` and `PROGRAM_VKEY` are immutable. A mutable program vkey would let
///      whoever holds the upgrade key swap the circuit and reintroduce the attribution trust
///      this design removes. Circuit upgrades therefore require a new verifier deployment and
///      a new gateway (with channel rotation).
///
///      The canonical Groth16 `SP1VerifierGateway` on most EVM chains is
///      `0x397A5f7f3dBd538f23DE225B51f532c34448dA9B`.
contract SP1AttributionVerifier is IAttributionVerifier {
    ISP1Verifier public immutable SP1_VERIFIER;
    bytes32 public immutable PROGRAM_VKEY;

    error InvalidConstruction();

    constructor(address sp1Verifier, bytes32 programVKey) {
        if (sp1Verifier == address(0) || programVKey == bytes32(0)) revert InvalidConstruction();
        SP1_VERIFIER = ISP1Verifier(sp1Verifier);
        PROGRAM_VKEY = programVKey;
    }

    /// @inheritdoc IAttributionVerifier
    function verifyAttribution(bytes calldata proof, bytes32 batchCommitment) external view returns (bool) {
        // Public values are abi.encode(bytes32) == the raw 32-byte commitment.
        try SP1_VERIFIER.verifyProof(PROGRAM_VKEY, abi.encode(batchCommitment), proof) {
            return true;
        } catch {
            return false;
        }
    }
}
