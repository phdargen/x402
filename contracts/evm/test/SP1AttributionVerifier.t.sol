// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";

import {SP1AttributionVerifier} from "../src/periphery/SP1AttributionVerifier.sol";
import {MockSP1Verifier} from "./mocks/MockSP1Verifier.sol";

contract SP1AttributionVerifierUnitTest is Test {
    MockSP1Verifier internal sp1;
    SP1AttributionVerifier internal adapter;

    bytes32 internal constant VKEY = keccak256("program-vkey");
    bytes32 internal constant COMMITMENT = keccak256("batch-commitment");

    function setUp() public {
        sp1 = new MockSP1Verifier();
        adapter = new SP1AttributionVerifier(address(sp1), VKEY);
    }

    function test_constructor_revertsZeroVerifier() public {
        vm.expectRevert(SP1AttributionVerifier.InvalidConstruction.selector);
        new SP1AttributionVerifier(address(0), VKEY);
    }

    function test_constructor_revertsZeroVKey() public {
        vm.expectRevert(SP1AttributionVerifier.InvalidConstruction.selector);
        new SP1AttributionVerifier(address(sp1), bytes32(0));
    }

    function test_verifyAttribution_forwardsVkeyAndPublicValues() public {
        sp1.setExpected(VKEY, abi.encode(COMMITMENT));
        assertTrue(adapter.verifyAttribution(hex"deadbeef", COMMITMENT));
    }

    function test_verifyAttribution_returnsFalseWhenUnderlyingRejects() public {
        sp1.setExpected(VKEY, abi.encode(COMMITMENT));
        sp1.setShouldSucceed(false);
        assertFalse(adapter.verifyAttribution(hex"00", COMMITMENT));
    }

    function test_verifyAttribution_returnsFalseOnPublicValuesMismatch() public {
        sp1.setExpected(VKEY, abi.encode(COMMITMENT));
        assertFalse(adapter.verifyAttribution(hex"00", keccak256("other")));
    }
}
