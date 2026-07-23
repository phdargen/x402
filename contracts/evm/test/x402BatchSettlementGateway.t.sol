// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {VmSafe} from "forge-std/Vm.sol";

import {CompressedSparseMerkleProof} from "../src/libraries/CompressedSparseMerkleProof.sol";
import {x402BatchSettlement} from "../src/x402BatchSettlement.sol";
import {x402BatchSettlementGateway} from "../src/x402BatchSettlementGateway.sol";
import {MockDepositCollector} from "./mocks/MockBatchDepositCollectors.sol";
import {MockERC20} from "./mocks/MockERC20.sol";

contract CompressedSparseMerkleProofHarness {
    function emptyRoot() external pure returns (bytes32) {
        return CompressedSparseMerkleProof.emptyRoot();
    }

    function verify(
        bytes32 root,
        address key,
        uint128 value,
        uint256 nonzeroSiblingBitmap,
        bytes32[] calldata nonzeroSiblings
    ) external pure returns (bool) {
        return CompressedSparseMerkleProof.verify(root, key, value, nonzeroSiblingBitmap, nonzeroSiblings);
    }

    function verifyAndUpdate(
        bytes32 root,
        address key,
        uint128 previousValue,
        uint128 newValue,
        uint256 nonzeroSiblingBitmap,
        bytes32[] calldata nonzeroSiblings
    ) external pure returns (bool, bytes32) {
        return CompressedSparseMerkleProof.verifyAndUpdate(
            root, key, previousValue, newValue, nonzeroSiblingBitmap, nonzeroSiblings
        );
    }
}

/// @dev Independent sparse-tree implementation used to build proofs without production proof helpers.
contract TestSparseMerkleTree {
    uint256 private constant TREE_DEPTH = 160;

    mapping(uint256 level => mapping(uint160 index => bytes32 hash)) private _nodes;
    mapping(address key => uint128 value) public cumulative;
    bytes32[161] private _emptyHashes;

    constructor() {
        _emptyHashes[0] = _hashLeaf(0);
        for (uint256 level = 0; level < TREE_DEPTH; ++level) {
            _emptyHashes[level + 1] = _hashNode(_emptyHashes[level], _emptyHashes[level]);
        }
    }

    function emptyRoot() external view returns (bytes32) {
        return _emptyHashes[TREE_DEPTH];
    }

    function emptyHash(
        uint256 level
    ) external view returns (bytes32) {
        return _emptyHashes[level];
    }

    function root() external view returns (bytes32) {
        return _node(TREE_DEPTH, 0);
    }

    function proof(
        address key
    ) external view returns (uint128 previousCumulative, uint256 nonzeroSiblingBitmap, bytes32[] memory siblings) {
        previousCumulative = cumulative[key];
        uint160 index = uint160(key);
        uint256 siblingCount;

        for (uint256 level = 0; level < TREE_DEPTH; ++level) {
            bytes32 sibling = _node(level, index ^ uint160(1));
            if (sibling != _emptyHashes[level]) ++siblingCount;
            index >>= 1;
        }

        siblings = new bytes32[](siblingCount);
        index = uint160(key);
        uint256 siblingIndex;
        for (uint256 level = 0; level < TREE_DEPTH; ++level) {
            bytes32 sibling = _node(level, index ^ uint160(1));
            if (sibling != _emptyHashes[level]) {
                nonzeroSiblingBitmap |= uint256(1) << level;
                siblings[siblingIndex++] = sibling;
            }
            index >>= 1;
        }
    }

    function setCumulative(
        address key,
        uint128 value
    ) external {
        cumulative[key] = value;

        uint160 index = uint160(key);
        bytes32 current = _hashLeaf(value);
        _storeNode(0, index, current);

        for (uint256 level = 0; level < TREE_DEPTH; ++level) {
            bytes32 sibling = _node(level, index ^ uint160(1));
            current = index & 1 == 0 ? _hashNode(current, sibling) : _hashNode(sibling, current);
            index >>= 1;
            _storeNode(level + 1, index, current);
        }
    }

    function _node(
        uint256 level,
        uint160 index
    ) internal view returns (bytes32) {
        bytes32 value = _nodes[level][index];
        return value == bytes32(0) ? _emptyHashes[level] : value;
    }

    function _storeNode(
        uint256 level,
        uint160 index,
        bytes32 value
    ) internal {
        if (value == _emptyHashes[level]) {
            delete _nodes[level][index];
        } else {
            _nodes[level][index] = value;
        }
    }

    function _hashLeaf(
        uint128 value
    ) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(hex"00", value));
    }

    function _hashNode(
        bytes32 left,
        bytes32 right
    ) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(hex"01", left, right));
    }
}

contract X402BatchSettlementGatewayTest is Test {
    x402BatchSettlement public settlement;
    x402BatchSettlementGateway public gateway;
    CompressedSparseMerkleProofHarness public proofHarness;
    TestSparseMerkleTree public tree;
    MockDepositCollector public collector;
    MockERC20 public token;

    VmSafe.Wallet public payerWallet;
    VmSafe.Wallet public payerAuthWallet;
    VmSafe.Wallet public receiver1Wallet;
    VmSafe.Wallet public receiver1AuthWallet;
    VmSafe.Wallet public receiver2Wallet;
    VmSafe.Wallet public receiver2AuthWallet;
    VmSafe.Wallet public receiver3Wallet;
    VmSafe.Wallet public receiver3AuthWallet;
    VmSafe.Wallet public otherWallet;

    uint40 private constant WITHDRAW_DELAY = 1 hours;
    uint128 private constant DEPOSIT_AMOUNT = 1000e6;
    uint128 private constant CLAIM_AMOUNT = 100e6;

    event Distributed(
        bytes32 indexed channelId,
        address indexed receiver,
        address indexed token,
        uint128 amount,
        uint128 newDistributedCumulative
    );

    event Withdrawn(address indexed receiver, address indexed token, address indexed sender, uint128 amount);

    function setUp() public {
        payerWallet = vm.createWallet("gateway payer");
        payerAuthWallet = vm.createWallet("gateway payer authorizer");
        receiver1Wallet = vm.createWallet("gateway receiver 1");
        receiver1AuthWallet = vm.createWallet("gateway receiver authorizer 1");
        receiver2Wallet = vm.createWallet("gateway receiver 2");
        receiver2AuthWallet = vm.createWallet("gateway receiver authorizer 2");
        receiver3Wallet = vm.createWallet("gateway receiver 3");
        receiver3AuthWallet = vm.createWallet("gateway receiver authorizer 3");
        otherWallet = vm.createWallet("gateway other");

        settlement = new x402BatchSettlement();
        gateway = new x402BatchSettlementGateway(address(settlement));
        proofHarness = new CompressedSparseMerkleProofHarness();
        tree = new TestSparseMerkleTree();
        collector = new MockDepositCollector();
        token = new MockERC20("USDC", "USDC", 6);

        token.mint(payerWallet.addr, 10_000e6);
        vm.prank(payerWallet.addr);
        token.approve(address(collector), type(uint256).max);
    }

    // =========================================================================
    // Helpers
    // =========================================================================

    function _makeChannel(
        bytes32 salt
    ) internal view returns (x402BatchSettlement.ChannelConfig memory) {
        return x402BatchSettlement.ChannelConfig({
            payer: payerWallet.addr,
            payerAuthorizer: payerAuthWallet.addr,
            receiver: address(gateway),
            receiverAuthorizer: address(gateway),
            token: address(token),
            withdrawDelay: WITHDRAW_DELAY,
            salt: salt
        });
    }

    function _fundChannel(
        bytes32 salt
    ) internal returns (x402BatchSettlement.ChannelConfig memory config, bytes32 channelId) {
        config = _makeChannel(salt);
        channelId = settlement.getChannelId(config);
        settlement.deposit(config, DEPOSIT_AMOUNT, address(collector), "");
    }

    function _signDigest(
        VmSafe.Wallet memory wallet,
        bytes32 digest
    ) internal returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(wallet, digest);
        return abi.encodePacked(r, s, v);
    }

    function _makeGatewayClaim(
        bytes32 channelId,
        address receiver,
        VmSafe.Wallet memory receiverAuthorizer,
        uint128 totalClaimed,
        uint128 maxClaimableAmount
    ) internal returns (x402BatchSettlementGateway.GatewayVoucherClaim memory gvc) {
        x402BatchSettlementGateway.GatewayConfig memory config = x402BatchSettlementGateway.GatewayConfig({
            channelId: channelId, receiver: receiver, receiverAuthorizer: receiverAuthorizer.addr
        });
        bytes32 voucherDigest = gateway.getGatewayVoucherDigest(gateway.getGatewayId(config), maxClaimableAmount);
        x402BatchSettlementGateway.GatewayClaimAuthorization memory authorization =
            x402BatchSettlementGateway.GatewayClaimAuthorization({
                gatewayVoucherDigest: voucherDigest, totalClaimed: totalClaimed
            });
        (uint128 previousCumulative, uint256 bitmap, bytes32[] memory siblings) = tree.proof(receiver);

        gvc = x402BatchSettlementGateway.GatewayVoucherClaim({
            voucher: x402BatchSettlementGateway.GatewayVoucher({
                config: config, maxClaimableAmount: maxClaimableAmount
            }),
            gatewaySignature: _signDigest(payerAuthWallet, voucherDigest),
            claim: authorization,
            receiverAuthorizerSignature: _signDigest(
                receiverAuthorizer, gateway.getGatewayClaimAuthorizationDigest(authorization)
            ),
            previousCumulative: previousCumulative,
            nonzeroSiblingBitmap: bitmap,
            nonzeroSiblings: siblings
        });
    }

    function _makeDistribution(
        x402BatchSettlement.ChannelConfig memory config,
        x402BatchSettlementGateway.GatewayVoucherClaim[] memory claims
    ) internal returns (x402BatchSettlementGateway.ChannelDistribution memory) {
        bytes32 channelId = settlement.getChannelId(config);
        return x402BatchSettlementGateway.ChannelDistribution({
            voucher: x402BatchSettlement.Voucher({channel: config, maxClaimableAmount: DEPOSIT_AMOUNT}),
            signature: _signDigest(payerAuthWallet, settlement.getVoucherDigest(channelId, DEPOSIT_AMOUNT)),
            claims: claims
        });
    }

    function _callDistribution(
        x402BatchSettlementGateway.ChannelDistribution memory distribution
    ) internal {
        x402BatchSettlementGateway.ChannelDistribution[] memory distributions =
            new x402BatchSettlementGateway.ChannelDistribution[](1);
        distributions[0] = distribution;
        gateway.claimAndDistribute(distributions);
    }

    function _submitClaims(
        x402BatchSettlement.ChannelConfig memory config,
        x402BatchSettlementGateway.GatewayVoucherClaim[] memory claims
    ) internal {
        _callDistribution(_makeDistribution(config, claims));
    }

    function _assertCumulative(
        bytes32 channelId,
        address receiver,
        uint128 expected
    ) internal view {
        (uint128 cumulative, uint256 bitmap, bytes32[] memory siblings) = tree.proof(receiver);
        assertEq(cumulative, expected);
        assertTrue(gateway.verifyReceiverCumulative(channelId, receiver, cumulative, bitmap, siblings));
    }

    function _submitThree(
        x402BatchSettlement.ChannelConfig memory config,
        bytes32 channelId,
        uint128[3] memory totals
    ) internal {
        x402BatchSettlementGateway.GatewayVoucherClaim[] memory claims =
            new x402BatchSettlementGateway.GatewayVoucherClaim[](3);

        claims[0] = _makeGatewayClaim(channelId, receiver1Wallet.addr, receiver1AuthWallet, totals[0], DEPOSIT_AMOUNT);
        tree.setCumulative(receiver1Wallet.addr, totals[0]);

        claims[1] = _makeGatewayClaim(channelId, receiver2Wallet.addr, receiver2AuthWallet, totals[1], DEPOSIT_AMOUNT);
        tree.setCumulative(receiver2Wallet.addr, totals[1]);

        claims[2] = _makeGatewayClaim(channelId, receiver3Wallet.addr, receiver3AuthWallet, totals[2], DEPOSIT_AMOUNT);
        tree.setCumulative(receiver3Wallet.addr, totals[2]);

        _submitClaims(config, claims);
    }

    // =========================================================================
    // Compressed Sparse Merkle Proof Tests
    // =========================================================================

    function test_proof_canonicalEmptyRoot() public view {
        bytes32 emptyRoot = tree.emptyRoot();
        bytes32[] memory siblings = new bytes32[](0);

        assertEq(proofHarness.emptyRoot(), emptyRoot);
        assertEq(gateway.EMPTY_CUMULATIVE_ROOT(), emptyRoot);
        assertEq(gateway.getCumulativeRoot(bytes32(uint256(123))), emptyRoot);
        assertTrue(proofHarness.verify(emptyRoot, receiver1Wallet.addr, 0, 0, siblings));
        assertTrue(gateway.verifyReceiverCumulative(bytes32(uint256(123)), receiver1Wallet.addr, 0, 0, siblings));
    }

    function test_proof_matchesFixedLsbFirstVectors() public view {
        bytes32 emptyRoot = tree.emptyRoot();
        bytes32[] memory siblings = new bytes32[](0);

        assertEq(emptyRoot, hex"cd4f8a0334f5dd04bb031a8adfafefbfeccc7b0172c39f9815a3f8e0c3d439c6");

        (bool lowBitValid, bytes32 lowBitRoot) =
            proofHarness.verifyAndUpdate(emptyRoot, address(1), 0, CLAIM_AMOUNT, 0, siblings);
        assertTrue(lowBitValid);
        assertEq(lowBitRoot, hex"61d2846d5515f19e48cc2efdedcb6b4287d9bd3f011d4dc2d93a8dc9e3517c0a");

        address highBitKey = address(0x8000000000000000000000000000000000000000);
        (bool highBitValid, bytes32 highBitRoot) =
            proofHarness.verifyAndUpdate(emptyRoot, highBitKey, 0, CLAIM_AMOUNT, 0, siblings);
        assertTrue(highBitValid);
        assertEq(highBitRoot, hex"8f6ff8cf82d2dc19cd79692cd766ef4f3415d157f2bff15b9241faebeda91c75");
    }

    function test_proof_firstLeafAndExistingLeafUpdates() public {
        bytes32 emptyRoot = tree.emptyRoot();
        (, uint256 bitmap, bytes32[] memory siblings) = tree.proof(receiver1Wallet.addr);

        (bool firstValid, bytes32 firstRoot) =
            proofHarness.verifyAndUpdate(emptyRoot, receiver1Wallet.addr, 0, CLAIM_AMOUNT, bitmap, siblings);
        assertTrue(firstValid);
        tree.setCumulative(receiver1Wallet.addr, CLAIM_AMOUNT);
        assertEq(firstRoot, tree.root());

        (uint128 previous, uint256 updateBitmap, bytes32[] memory updateSiblings) = tree.proof(receiver1Wallet.addr);
        (bool updateValid, bytes32 updatedRoot) = proofHarness.verifyAndUpdate(
            firstRoot, receiver1Wallet.addr, previous, CLAIM_AMOUNT * 2, updateBitmap, updateSiblings
        );
        assertTrue(updateValid);
        tree.setCumulative(receiver1Wallet.addr, CLAIM_AMOUNT * 2);
        assertEq(updatedRoot, tree.root());
    }

    function test_proof_rejectsMalformedCompression() public {
        bytes32 emptyRoot = tree.emptyRoot();
        bytes32[] memory noSiblings = new bytes32[](0);
        bytes32[] memory oneSibling = new bytes32[](1);

        assertFalse(proofHarness.verify(emptyRoot, receiver1Wallet.addr, 0, uint256(1) << 160, noSiblings));

        oneSibling[0] = bytes32(uint256(123));
        assertFalse(proofHarness.verify(emptyRoot, receiver1Wallet.addr, 0, 0, oneSibling));

        oneSibling[0] = tree.emptyHash(0);
        assertFalse(proofHarness.verify(emptyRoot, receiver1Wallet.addr, 0, 1, oneSibling));

        tree.setCumulative(receiver1Wallet.addr, CLAIM_AMOUNT);
        (uint128 previous, uint256 bitmap, bytes32[] memory siblings) = tree.proof(receiver2Wallet.addr);
        assertGt(siblings.length, 0);
        assertTrue(proofHarness.verify(tree.root(), receiver2Wallet.addr, previous, bitmap, siblings));

        bytes32[] memory missingSibling = new bytes32[](siblings.length - 1);
        for (uint256 i = 0; i < missingSibling.length; ++i) {
            missingSibling[i] = siblings[i];
        }
        assertFalse(proofHarness.verify(tree.root(), receiver2Wallet.addr, previous, bitmap, missingSibling));
    }

    // =========================================================================
    // Gateway Claim Tests
    // =========================================================================

    function test_gateway_firstClaimUpdatesAccountingAndWithdraws() public {
        (x402BatchSettlement.ChannelConfig memory config, bytes32 channelId) = _fundChannel(bytes32(uint256(1)));
        x402BatchSettlementGateway.GatewayVoucherClaim[] memory claims =
            new x402BatchSettlementGateway.GatewayVoucherClaim[](1);
        claims[0] =
            _makeGatewayClaim(channelId, receiver1Wallet.addr, receiver1AuthWallet, CLAIM_AMOUNT, DEPOSIT_AMOUNT);
        tree.setCumulative(receiver1Wallet.addr, CLAIM_AMOUNT);

        vm.expectEmit(true, true, true, true);
        emit Distributed(channelId, receiver1Wallet.addr, address(token), CLAIM_AMOUNT, CLAIM_AMOUNT);
        _submitClaims(config, claims);

        assertEq(gateway.getCumulativeRoot(channelId), tree.root());
        assertEq(gateway.distributedByChannel(channelId), CLAIM_AMOUNT);
        assertEq(gateway.withdrawable(receiver1Wallet.addr, address(token)), CLAIM_AMOUNT);
        assertEq(gateway.totalOutstanding(address(token)), CLAIM_AMOUNT);
        assertEq(token.balanceOf(address(gateway)), CLAIM_AMOUNT);
        (, uint128 baseTotalClaimed) = settlement.channels(channelId);
        assertEq(baseTotalClaimed, CLAIM_AMOUNT);
        (uint128 receiverTotalClaimed, uint128 receiverTotalSettled) =
            settlement.receivers(address(gateway), address(token));
        assertEq(receiverTotalClaimed, CLAIM_AMOUNT);
        assertEq(receiverTotalSettled, CLAIM_AMOUNT);
        _assertCumulative(channelId, receiver1Wallet.addr, CLAIM_AMOUNT);

        vm.expectEmit(true, true, true, true);
        emit Withdrawn(receiver1Wallet.addr, address(token), otherWallet.addr, CLAIM_AMOUNT);
        vm.prank(otherWallet.addr);
        gateway.withdraw(receiver1Wallet.addr, address(token));

        assertEq(token.balanceOf(receiver1Wallet.addr), CLAIM_AMOUNT);
        assertEq(gateway.withdrawable(receiver1Wallet.addr, address(token)), 0);
        assertEq(gateway.totalOutstanding(address(token)), 0);
        assertEq(token.balanceOf(address(gateway)), 0);
    }

    function test_gateway_sequentialIntermediateRootProofs() public {
        (x402BatchSettlement.ChannelConfig memory config, bytes32 channelId) = _fundChannel(bytes32(uint256(2)));
        x402BatchSettlementGateway.GatewayVoucherClaim[] memory claims =
            new x402BatchSettlementGateway.GatewayVoucherClaim[](2);

        claims[0] =
            _makeGatewayClaim(channelId, receiver1Wallet.addr, receiver1AuthWallet, CLAIM_AMOUNT, DEPOSIT_AMOUNT);
        tree.setCumulative(receiver1Wallet.addr, CLAIM_AMOUNT);
        claims[1] =
            _makeGatewayClaim(channelId, receiver2Wallet.addr, receiver2AuthWallet, CLAIM_AMOUNT * 2, DEPOSIT_AMOUNT);
        tree.setCumulative(receiver2Wallet.addr, CLAIM_AMOUNT * 2);

        _submitClaims(config, claims);

        assertEq(gateway.getCumulativeRoot(channelId), tree.root());
        assertEq(gateway.distributedByChannel(channelId), CLAIM_AMOUNT * 3);
        assertEq(gateway.withdrawable(receiver1Wallet.addr, address(token)), CLAIM_AMOUNT);
        assertEq(gateway.withdrawable(receiver2Wallet.addr, address(token)), CLAIM_AMOUNT * 2);
        assertEq(gateway.totalOutstanding(address(token)), CLAIM_AMOUNT * 3);
        _assertCumulative(channelId, receiver1Wallet.addr, CLAIM_AMOUNT);
        _assertCumulative(channelId, receiver2Wallet.addr, CLAIM_AMOUNT * 2);
    }

    function test_gateway_batchesMultipleChannelsForSameToken() public {
        (x402BatchSettlement.ChannelConfig memory config1, bytes32 channelId1) = _fundChannel(bytes32(uint256(11)));
        (x402BatchSettlement.ChannelConfig memory config2, bytes32 channelId2) = _fundChannel(bytes32(uint256(12)));

        x402BatchSettlementGateway.GatewayVoucherClaim[] memory claims1 =
            new x402BatchSettlementGateway.GatewayVoucherClaim[](1);
        claims1[0] =
            _makeGatewayClaim(channelId1, receiver1Wallet.addr, receiver1AuthWallet, CLAIM_AMOUNT, DEPOSIT_AMOUNT);
        x402BatchSettlementGateway.GatewayVoucherClaim[] memory claims2 =
            new x402BatchSettlementGateway.GatewayVoucherClaim[](1);
        claims2[0] =
            _makeGatewayClaim(channelId2, receiver2Wallet.addr, receiver2AuthWallet, CLAIM_AMOUNT * 2, DEPOSIT_AMOUNT);

        x402BatchSettlementGateway.ChannelDistribution[] memory distributions =
            new x402BatchSettlementGateway.ChannelDistribution[](2);
        distributions[0] = _makeDistribution(config1, claims1);
        distributions[1] = _makeDistribution(config2, claims2);
        gateway.claimAndDistribute(distributions);

        bytes32[] memory siblings = new bytes32[](0);
        (, bytes32 expectedRoot1) =
            proofHarness.verifyAndUpdate(tree.emptyRoot(), receiver1Wallet.addr, 0, CLAIM_AMOUNT, 0, siblings);
        (, bytes32 expectedRoot2) =
            proofHarness.verifyAndUpdate(tree.emptyRoot(), receiver2Wallet.addr, 0, CLAIM_AMOUNT * 2, 0, siblings);

        assertEq(gateway.getCumulativeRoot(channelId1), expectedRoot1);
        assertEq(gateway.getCumulativeRoot(channelId2), expectedRoot2);
        assertEq(gateway.distributedByChannel(channelId1), CLAIM_AMOUNT);
        assertEq(gateway.distributedByChannel(channelId2), CLAIM_AMOUNT * 2);
        assertEq(gateway.totalOutstanding(address(token)), CLAIM_AMOUNT * 3);
        assertEq(token.balanceOf(address(gateway)), CLAIM_AMOUNT * 3);
        (uint128 baseTotalClaimed, uint128 baseTotalSettled) = settlement.receivers(address(gateway), address(token));
        assertEq(baseTotalClaimed, CLAIM_AMOUNT * 3);
        assertEq(baseTotalSettled, CLAIM_AMOUNT * 3);
        assertTrue(gateway.verifyReceiverCumulative(channelId1, receiver1Wallet.addr, CLAIM_AMOUNT, 0, siblings));
        assertTrue(gateway.verifyReceiverCumulative(channelId2, receiver2Wallet.addr, CLAIM_AMOUNT * 2, 0, siblings));
    }

    function test_gateway_existingLeafUsesLatestCumulativeDelta() public {
        (x402BatchSettlement.ChannelConfig memory config, bytes32 channelId) = _fundChannel(bytes32(uint256(3)));
        x402BatchSettlementGateway.GatewayVoucherClaim[] memory claims =
            new x402BatchSettlementGateway.GatewayVoucherClaim[](1);

        claims[0] =
            _makeGatewayClaim(channelId, receiver1Wallet.addr, receiver1AuthWallet, CLAIM_AMOUNT, DEPOSIT_AMOUNT);
        tree.setCumulative(receiver1Wallet.addr, CLAIM_AMOUNT);
        _submitClaims(config, claims);

        claims[0] =
            _makeGatewayClaim(channelId, receiver1Wallet.addr, receiver1AuthWallet, CLAIM_AMOUNT * 3, DEPOSIT_AMOUNT);
        tree.setCumulative(receiver1Wallet.addr, CLAIM_AMOUNT * 3);
        _submitClaims(config, claims);

        assertEq(gateway.distributedByChannel(channelId), CLAIM_AMOUNT * 3);
        assertEq(gateway.withdrawable(receiver1Wallet.addr, address(token)), CLAIM_AMOUNT * 3);
        assertEq(gateway.totalOutstanding(address(token)), CLAIM_AMOUNT * 3);
        assertEq(gateway.getCumulativeRoot(channelId), tree.root());
        _assertCumulative(channelId, receiver1Wallet.addr, CLAIM_AMOUNT * 3);
    }

    function test_gateway_refreshedProofNoop() public {
        (x402BatchSettlement.ChannelConfig memory config, bytes32 channelId) = _fundChannel(bytes32(uint256(4)));
        x402BatchSettlementGateway.GatewayVoucherClaim[] memory firstClaim =
            new x402BatchSettlementGateway.GatewayVoucherClaim[](1);
        firstClaim[0] =
            _makeGatewayClaim(channelId, receiver1Wallet.addr, receiver1AuthWallet, CLAIM_AMOUNT, DEPOSIT_AMOUNT);
        tree.setCumulative(receiver1Wallet.addr, CLAIM_AMOUNT);
        _submitClaims(config, firstClaim);

        x402BatchSettlementGateway.GatewayVoucherClaim[] memory onlyNoop =
            new x402BatchSettlementGateway.GatewayVoucherClaim[](1);
        onlyNoop[0] =
            _makeGatewayClaim(channelId, receiver1Wallet.addr, receiver1AuthWallet, CLAIM_AMOUNT, DEPOSIT_AMOUNT);
        x402BatchSettlementGateway.ChannelDistribution memory noopDistribution = _makeDistribution(config, onlyNoop);
        vm.expectRevert(x402BatchSettlementGateway.NoClaimableDelta.selector);
        _callDistribution(noopDistribution);

        x402BatchSettlementGateway.GatewayVoucherClaim[] memory mixedClaims =
            new x402BatchSettlementGateway.GatewayVoucherClaim[](2);
        mixedClaims[0] =
            _makeGatewayClaim(channelId, receiver1Wallet.addr, receiver1AuthWallet, CLAIM_AMOUNT - 1, DEPOSIT_AMOUNT);
        mixedClaims[1] =
            _makeGatewayClaim(channelId, receiver2Wallet.addr, receiver2AuthWallet, CLAIM_AMOUNT / 2, DEPOSIT_AMOUNT);
        tree.setCumulative(receiver2Wallet.addr, CLAIM_AMOUNT / 2);
        _submitClaims(config, mixedClaims);

        assertEq(gateway.distributedByChannel(channelId), CLAIM_AMOUNT + CLAIM_AMOUNT / 2);
        assertEq(gateway.withdrawable(receiver1Wallet.addr, address(token)), CLAIM_AMOUNT);
        assertEq(gateway.withdrawable(receiver2Wallet.addr, address(token)), CLAIM_AMOUNT / 2);
        assertEq(gateway.getCumulativeRoot(channelId), tree.root());
        _assertCumulative(channelId, receiver1Wallet.addr, CLAIM_AMOUNT);
    }

    function test_gateway_revertsInvalidAndStaleProofs() public {
        (x402BatchSettlement.ChannelConfig memory config, bytes32 channelId) = _fundChannel(bytes32(uint256(5)));

        x402BatchSettlementGateway.GatewayVoucherClaim memory invalidClaim =
            _makeGatewayClaim(channelId, receiver1Wallet.addr, receiver1AuthWallet, CLAIM_AMOUNT, DEPOSIT_AMOUNT);
        invalidClaim.nonzeroSiblingBitmap = 1;
        invalidClaim.nonzeroSiblings = new bytes32[](1);
        invalidClaim.nonzeroSiblings[0] = bytes32(uint256(123));
        x402BatchSettlementGateway.GatewayVoucherClaim[] memory invalidClaims =
            new x402BatchSettlementGateway.GatewayVoucherClaim[](1);
        invalidClaims[0] = invalidClaim;

        x402BatchSettlementGateway.ChannelDistribution memory invalidDistribution =
            _makeDistribution(config, invalidClaims);
        vm.expectRevert(x402BatchSettlementGateway.InvalidCumulativeProof.selector);
        _callDistribution(invalidDistribution);

        x402BatchSettlementGateway.GatewayVoucherClaim memory staleClaim =
            _makeGatewayClaim(channelId, receiver2Wallet.addr, receiver2AuthWallet, CLAIM_AMOUNT, DEPOSIT_AMOUNT);
        x402BatchSettlementGateway.GatewayVoucherClaim[] memory currentClaims =
            new x402BatchSettlementGateway.GatewayVoucherClaim[](1);
        currentClaims[0] =
            _makeGatewayClaim(channelId, receiver1Wallet.addr, receiver1AuthWallet, CLAIM_AMOUNT, DEPOSIT_AMOUNT);
        tree.setCumulative(receiver1Wallet.addr, CLAIM_AMOUNT);
        _submitClaims(config, currentClaims);

        x402BatchSettlementGateway.GatewayVoucherClaim[] memory staleClaims =
            new x402BatchSettlementGateway.GatewayVoucherClaim[](1);
        staleClaims[0] = staleClaim;
        x402BatchSettlementGateway.ChannelDistribution memory staleDistribution = _makeDistribution(config, staleClaims);
        vm.expectRevert(x402BatchSettlementGateway.InvalidCumulativeProof.selector);
        _callDistribution(staleDistribution);
    }

    function test_gateway_revertsDuplicateReceiver() public {
        (x402BatchSettlement.ChannelConfig memory config, bytes32 channelId) = _fundChannel(bytes32(uint256(6)));
        x402BatchSettlementGateway.GatewayVoucherClaim memory claim =
            _makeGatewayClaim(channelId, receiver1Wallet.addr, receiver1AuthWallet, CLAIM_AMOUNT, DEPOSIT_AMOUNT);
        x402BatchSettlementGateway.GatewayVoucherClaim[] memory claims =
            new x402BatchSettlementGateway.GatewayVoucherClaim[](2);
        claims[0] = claim;
        claims[1] = claim;

        x402BatchSettlementGateway.ChannelDistribution memory distribution = _makeDistribution(config, claims);
        vm.expectRevert(x402BatchSettlementGateway.DuplicateReceiver.selector);
        _callDistribution(distribution);
    }

    function test_gateway_revertsAuthorizationFailures() public {
        (x402BatchSettlement.ChannelConfig memory config, bytes32 channelId) = _fundChannel(bytes32(uint256(7)));

        x402BatchSettlementGateway.GatewayVoucherClaim memory wrongPayerClaim =
            _makeGatewayClaim(channelId, receiver1Wallet.addr, receiver1AuthWallet, CLAIM_AMOUNT, DEPOSIT_AMOUNT);
        bytes32 voucherDigest = gateway.getGatewayVoucherDigest(
            gateway.getGatewayId(wrongPayerClaim.voucher.config), wrongPayerClaim.voucher.maxClaimableAmount
        );
        wrongPayerClaim.gatewaySignature = _signDigest(otherWallet, voucherDigest);
        x402BatchSettlementGateway.GatewayVoucherClaim[] memory claims =
            new x402BatchSettlementGateway.GatewayVoucherClaim[](1);
        claims[0] = wrongPayerClaim;
        x402BatchSettlementGateway.ChannelDistribution memory distribution = _makeDistribution(config, claims);
        vm.expectRevert(x402BatchSettlementGateway.InvalidSignature.selector);
        _callDistribution(distribution);

        x402BatchSettlementGateway.GatewayVoucherClaim memory wrongReceiverClaim =
            _makeGatewayClaim(channelId, receiver1Wallet.addr, receiver1AuthWallet, CLAIM_AMOUNT, DEPOSIT_AMOUNT);
        wrongReceiverClaim.receiverAuthorizerSignature =
            _signDigest(otherWallet, gateway.getGatewayClaimAuthorizationDigest(wrongReceiverClaim.claim));
        claims[0] = wrongReceiverClaim;
        distribution = _makeDistribution(config, claims);
        vm.expectRevert(x402BatchSettlementGateway.InvalidReceiverAuthorizerSignature.selector);
        _callDistribution(distribution);

        x402BatchSettlementGateway.GatewayVoucherClaim memory mismatchedClaim =
            _makeGatewayClaim(channelId, receiver1Wallet.addr, receiver1AuthWallet, CLAIM_AMOUNT, DEPOSIT_AMOUNT);
        mismatchedClaim.claim.gatewayVoucherDigest = bytes32(uint256(1));
        claims[0] = mismatchedClaim;
        distribution = _makeDistribution(config, claims);
        vm.expectRevert(x402BatchSettlementGateway.ClaimVoucherMismatch.selector);
        _callDistribution(distribution);

        x402BatchSettlementGateway.GatewayVoucherClaim memory excessiveClaim =
            _makeGatewayClaim(channelId, receiver1Wallet.addr, receiver1AuthWallet, CLAIM_AMOUNT, CLAIM_AMOUNT - 1);
        claims[0] = excessiveClaim;
        distribution = _makeDistribution(config, claims);
        vm.expectRevert(x402BatchSettlementGateway.ClaimExceedsCeiling.selector);
        _callDistribution(distribution);
    }

    function test_gateway_revertsInvalidBaseSignature() public {
        (x402BatchSettlement.ChannelConfig memory config, bytes32 channelId) = _fundChannel(bytes32(uint256(8)));
        x402BatchSettlementGateway.GatewayVoucherClaim[] memory claims =
            new x402BatchSettlementGateway.GatewayVoucherClaim[](1);
        claims[0] =
            _makeGatewayClaim(channelId, receiver1Wallet.addr, receiver1AuthWallet, CLAIM_AMOUNT, DEPOSIT_AMOUNT);
        x402BatchSettlementGateway.ChannelDistribution memory distribution = _makeDistribution(config, claims);
        distribution.signature = _signDigest(otherWallet, settlement.getVoucherDigest(channelId, DEPOSIT_AMOUNT));

        vm.expectRevert(x402BatchSettlement.InvalidSignature.selector);
        _callDistribution(distribution);
    }

    function test_gateway_revertsBaseAccountingMismatch() public {
        (x402BatchSettlement.ChannelConfig memory config, bytes32 channelId) = _fundChannel(bytes32(uint256(9)));

        x402BatchSettlement.VoucherClaim[] memory directClaims = new x402BatchSettlement.VoucherClaim[](1);
        directClaims[0] = x402BatchSettlement.VoucherClaim({
            voucher: x402BatchSettlement.Voucher({channel: config, maxClaimableAmount: DEPOSIT_AMOUNT}),
            signature: _signDigest(payerAuthWallet, settlement.getVoucherDigest(channelId, DEPOSIT_AMOUNT)),
            totalClaimed: 1
        });
        vm.prank(address(gateway));
        settlement.claim(directClaims);

        x402BatchSettlementGateway.GatewayVoucherClaim[] memory gatewayClaims =
            new x402BatchSettlementGateway.GatewayVoucherClaim[](1);
        gatewayClaims[0] =
            _makeGatewayClaim(channelId, receiver1Wallet.addr, receiver1AuthWallet, CLAIM_AMOUNT, DEPOSIT_AMOUNT);
        x402BatchSettlementGateway.ChannelDistribution memory distribution = _makeDistribution(config, gatewayClaims);
        vm.expectRevert(x402BatchSettlementGateway.AccountingMismatch.selector);
        _callDistribution(distribution);
    }

    function testFuzz_gateway_monotonicCumulativesStayConsistent(
        uint64 first1,
        uint64 first2,
        uint64 first3,
        uint64 delta1,
        uint64 delta2,
        uint64 delta3
    ) public {
        (x402BatchSettlement.ChannelConfig memory config, bytes32 channelId) = _fundChannel(bytes32(uint256(10)));

        uint128[3] memory firstTotals;
        firstTotals[0] = uint128(bound(first1, 1, CLAIM_AMOUNT));
        firstTotals[1] = uint128(bound(first2, 1, CLAIM_AMOUNT));
        firstTotals[2] = uint128(bound(first3, 1, CLAIM_AMOUNT));
        _submitThree(config, channelId, firstTotals);

        uint128[3] memory finalTotals;
        finalTotals[0] = firstTotals[0] + uint128(bound(delta1, 1, CLAIM_AMOUNT));
        finalTotals[1] = firstTotals[1] + uint128(bound(delta2, 1, CLAIM_AMOUNT));
        finalTotals[2] = firstTotals[2] + uint128(bound(delta3, 1, CLAIM_AMOUNT));
        _submitThree(config, channelId, finalTotals);

        uint128 aggregate = finalTotals[0] + finalTotals[1] + finalTotals[2];
        assertEq(gateway.getCumulativeRoot(channelId), tree.root());
        assertEq(gateway.distributedByChannel(channelId), aggregate);
        assertEq(gateway.withdrawable(receiver1Wallet.addr, address(token)), finalTotals[0]);
        assertEq(gateway.withdrawable(receiver2Wallet.addr, address(token)), finalTotals[1]);
        assertEq(gateway.withdrawable(receiver3Wallet.addr, address(token)), finalTotals[2]);
        assertEq(gateway.totalOutstanding(address(token)), aggregate);
        assertEq(token.balanceOf(address(gateway)), aggregate);
        (, uint128 baseTotalClaimed) = settlement.channels(channelId);
        assertEq(baseTotalClaimed, aggregate);
        _assertCumulative(channelId, receiver1Wallet.addr, finalTotals[0]);
        _assertCumulative(channelId, receiver2Wallet.addr, finalTotals[1]);
        _assertCumulative(channelId, receiver3Wallet.addr, finalTotals[2]);
    }
}
