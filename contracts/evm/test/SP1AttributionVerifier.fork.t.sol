// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {stdJson} from "forge-std/StdJson.sol";

import {SP1AttributionVerifier} from "../src/periphery/SP1AttributionVerifier.sol";

/// @notice Replays a committed Groth16 fixture against the deployed SP1VerifierGateway.
/// @dev Run with: forge test --match-contract SP1AttributionVerifierForkTest --fork-url $RPC_URL
///      Fixture regenerated via: `cd zk && cargo run --release --bin fixture -- --groth16`
contract SP1AttributionVerifierForkTest is Test {
    using stdJson for string;

    address constant SP1_VERIFIER_GATEWAY = 0x397A5f7f3dBd538f23DE225B51f532c34448dA9B;

    SP1AttributionVerifier internal adapter;
    bytes32 internal vkey;
    bytes32 internal batchCommitment;
    bytes internal publicValues;
    bytes internal proof;

    function setUp() public {
        if (block.chainid == 31_337) return;
        require(SP1_VERIFIER_GATEWAY.code.length > 0, "SP1VerifierGateway not deployed");

        try vm.readFile("./test/fixtures/zk-attribution-groth16.json") returns (string memory fixture) {
            vkey = fixture.readBytes32(".vkey");
            batchCommitment = fixture.readBytes32(".batchCommitment");
            publicValues = fixture.readBytes(".publicValues");
            proof = fixture.readBytes(".proof");
            adapter = new SP1AttributionVerifier(SP1_VERIFIER_GATEWAY, vkey);
        } catch {
            // Fixture not regenerated yet — see zk/README.md.
        }
    }

    modifier onlyFork() {
        if (block.chainid == 31_337) return;
        if (address(adapter) == address(0)) return;
        _;
    }

    function test_fork_verifyAttribution_validProof() public onlyFork {
        assertEq(keccak256(publicValues), keccak256(abi.encode(batchCommitment)));
        assertTrue(adapter.verifyAttribution(proof, batchCommitment));
    }

    function test_fork_verifyAttribution_tamperedCommitmentReturnsFalse() public onlyFork {
        bytes32 tampered = bytes32(uint256(batchCommitment) ^ 1);
        assertFalse(adapter.verifyAttribution(proof, tampered));
    }
}
