// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ISP1Verifier} from "../../src/interfaces/ISP1Verifier.sol";

/// @notice Configurable mock of the SP1 verifier gateway for unit tests.
contract MockSP1Verifier is ISP1Verifier {
    bytes32 public expectedVKey;
    bytes public expectedPublicValues;
    bool public shouldSucceed = true;

    function setExpected(bytes32 vkey, bytes calldata publicValues) external {
        expectedVKey = vkey;
        expectedPublicValues = publicValues;
    }

    function setShouldSucceed(bool ok) external {
        shouldSucceed = ok;
    }

    function verifyProof(bytes32 programVKey, bytes calldata publicValues, bytes calldata proofBytes)
        external
        view
        override
    {
        if (!shouldSucceed) revert("MockSP1Verifier: reject");
        if (expectedVKey != bytes32(0) && programVKey != expectedVKey) revert("MockSP1Verifier: bad vkey");
        if (expectedPublicValues.length != 0) {
            if (keccak256(publicValues) != keccak256(expectedPublicValues)) {
                revert("MockSP1Verifier: bad public values");
            }
        }
        proofBytes;
    }
}
