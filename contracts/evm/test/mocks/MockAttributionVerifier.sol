// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IAttributionVerifier} from "../../src/interfaces/IAttributionVerifier.sol";

/// @notice Attribution verifier mock for gateway tests. Optionally pins an expected commitment.
contract MockAttributionVerifier is IAttributionVerifier {
    bytes32 public expectedCommitment;
    bool public checkCommitment;
    bool public shouldSucceed = true;

    function setExpectedCommitment(bytes32 commitment) external {
        expectedCommitment = commitment;
        checkCommitment = true;
    }

    function clearExpectedCommitment() external {
        checkCommitment = false;
        expectedCommitment = bytes32(0);
    }

    function setShouldSucceed(bool ok) external {
        shouldSucceed = ok;
    }

    function verifyAttribution(bytes calldata, bytes32 batchCommitment) external view returns (bool) {
        if (!shouldSucceed) return false;
        if (checkCommitment && batchCommitment != expectedCommitment) return false;
        return true;
    }
}
