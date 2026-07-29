// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {VmSafe} from "forge-std/Vm.sol";

import {x402BatchSettlement} from "../src/x402BatchSettlement.sol";
import {x402BatchSettlementZKHybridGateway} from "../src/x402BatchSettlementGatewayHybridZk.sol";
import {MockAttributionVerifier} from "./mocks/MockAttributionVerifier.sol";
import {MockDepositCollector} from "./mocks/MockBatchDepositCollectors.sol";
import {MockERC20} from "./mocks/MockERC20.sol";

contract X402BatchSettlementGatewayHybridZkTest is Test {
    x402BatchSettlement internal settlement;
    x402BatchSettlementZKHybridGateway internal gateway;
    MockAttributionVerifier internal verifier;
    MockDepositCollector internal collector;
    MockERC20 internal token;

    VmSafe.Wallet internal payerWallet;
    VmSafe.Wallet internal payerAuthWallet;
    VmSafe.Wallet internal operatorWallet;
    address internal receiverA;
    address internal receiverB;

    uint40 constant WITHDRAW_DELAY = 3600;

    function setUp() public {
        vm.warp(1_000_000);

        payerWallet = vm.createWallet("payer");
        payerAuthWallet = vm.createWallet("payerAuth");
        operatorWallet = vm.createWallet("operator");
        receiverA = makeAddr("receiverA");
        receiverB = makeAddr("receiverB");
        // Ensure receiverA < receiverB for credit ordering.
        if (receiverA > receiverB) (receiverA, receiverB) = (receiverB, receiverA);

        settlement = new x402BatchSettlement();
        verifier = new MockAttributionVerifier();
        gateway = new x402BatchSettlementZKHybridGateway(
            address(settlement), address(verifier), operatorWallet.addr
        );
        collector = new MockDepositCollector();
        token = new MockERC20("USDC", "USDC", 6);

        token.mint(payerWallet.addr, 1_000_000e6);
        vm.prank(payerWallet.addr);
        token.approve(address(collector), type(uint256).max);
    }

    // =========================================================================
    // Helpers
    // =========================================================================

    function _config(bytes32 salt) internal view returns (x402BatchSettlement.ChannelConfig memory) {
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

    function _deposit(x402BatchSettlement.ChannelConfig memory config, uint128 amount) internal {
        settlement.deposit(config, amount, address(collector), "");
    }

    function _signVoucher(bytes32 channelId, uint128 maxClaimable) internal returns (bytes memory) {
        bytes32 structHash = keccak256(abi.encode(settlement.VOUCHER_TYPEHASH(), channelId, maxClaimable));
        (, string memory name, string memory version, uint256 chainId, address verifyingContract,,) =
            settlement.eip712Domain();
        bytes32 domain = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256(bytes(name)),
                keccak256(bytes(version)),
                chainId,
                verifyingContract
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domain, structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(payerAuthWallet, digest);
        return abi.encodePacked(r, s, v);
    }

    function _attrLeaf(address payTo, uint128 cumulative) internal pure returns (bytes32) {
        return keccak256(abi.encode(payTo, cumulative));
    }

    function _attrRoot(address[] memory payTos, uint128[] memory cumulatives) internal pure returns (bytes32) {
        require(payTos.length == cumulatives.length, "len");
        if (payTos.length == 0) return bytes32(0);
        bytes32[] memory leaves = new bytes32[](payTos.length);
        for (uint256 i = 0; i < payTos.length; ++i) {
            leaves[i] = _attrLeaf(payTos[i], cumulatives[i]);
        }
        return keccak256(abi.encodePacked(leaves));
    }

    function _expectedCommitment(
        x402BatchSettlementZKHybridGateway.ChannelClaim[] memory claims,
        x402BatchSettlementZKHybridGateway.Credit[] memory credits
    ) internal view returns (bytes32) {
        bytes32[] memory claimLeaves = new bytes32[](claims.length);
        for (uint256 i = 0; i < claims.length; ++i) {
            bytes32 channelId = settlement.getChannelId(claims[i].config);
            (, uint128 priorClaimed) = settlement.channels(channelId);
            bytes32 oldRoot = gateway.attributionRoot(channelId);
            claimLeaves[i] = keccak256(
                abi.encode(
                    channelId,
                    claims[i].config.payer,
                    claims[i].config.payerAuthorizer,
                    claims[i].config.token,
                    priorClaimed,
                    claims[i].totalClaimed,
                    oldRoot,
                    claims[i].newAttributionRoot
                )
            );
        }
        bytes32[] memory creditLeaves = new bytes32[](credits.length);
        for (uint256 j = 0; j < credits.length; ++j) {
            creditLeaves[j] = keccak256(abi.encode(credits[j].receiver, credits[j].token, credits[j].amount));
        }
        return keccak256(
            abi.encode(
                gateway.DOMAIN_SEPARATOR(),
                keccak256(abi.encodePacked(claimLeaves)),
                keccak256(abi.encodePacked(creditLeaves))
            )
        );
    }

    function _singleChannelBatch(uint128 claimAmount, uint128 creditA, uint128 creditB, bytes32 salt)
        internal
        returns (
            x402BatchSettlementZKHybridGateway.ChannelClaim[] memory claims,
            x402BatchSettlementZKHybridGateway.Credit[] memory credits
        )
    {
        x402BatchSettlement.ChannelConfig memory config = _config(salt);
        _deposit(config, claimAmount * 2);
        bytes32 channelId = settlement.getChannelId(config);
        bytes memory voucherSig = _signVoucher(channelId, claimAmount);

        address[] memory payTos = new address[](2);
        uint128[] memory cum = new uint128[](2);
        payTos[0] = receiverA;
        payTos[1] = receiverB;
        // Keep ascending by address.
        if (payTos[0] > payTos[1]) {
            (payTos[0], payTos[1]) = (payTos[1], payTos[0]);
            (creditA, creditB) = (creditB, creditA);
        }
        cum[0] = creditA;
        cum[1] = creditB;
        bytes32 newRoot = _attrRoot(payTos, cum);

        claims = new x402BatchSettlementZKHybridGateway.ChannelClaim[](1);
        claims[0] = x402BatchSettlementZKHybridGateway.ChannelClaim({
            config: config,
            maxClaimableAmount: claimAmount,
            signature: voucherSig,
            totalClaimed: claimAmount,
            newAttributionRoot: newRoot
        });

        credits = new x402BatchSettlementZKHybridGateway.Credit[](2);
        credits[0] = x402BatchSettlementZKHybridGateway.Credit({
            receiver: payTos[0], token: address(token), amount: cum[0]
        });
        credits[1] = x402BatchSettlementZKHybridGateway.Credit({
            receiver: payTos[1], token: address(token), amount: cum[1]
        });
    }

    // =========================================================================
    // Happy path
    // =========================================================================

    function test_settleBatch_happyPath() public {
        (x402BatchSettlementZKHybridGateway.ChannelClaim[] memory claims,
            x402BatchSettlementZKHybridGateway.Credit[] memory credits) =
            _singleChannelBatch(100e6, 60e6, 40e6, bytes32(uint256(1)));

        bytes32 commitment = _expectedCommitment(claims, credits);
        verifier.setExpectedCommitment(commitment);

        vm.expectEmit(true, true, false, true);
        emit x402BatchSettlementZKHybridGateway.BatchProven(commitment, address(this));

        gateway.settleBatch(claims, credits, hex"01");

        assertEq(gateway.withdrawable(credits[0].receiver, address(token)), credits[0].amount);
        assertEq(gateway.withdrawable(credits[1].receiver, address(token)), credits[1].amount);
        assertEq(gateway.totalOutstanding(address(token)), 100e6);
        assertEq(token.balanceOf(address(gateway)), 100e6);
        assertEq(gateway.attributionRoot(settlement.getChannelId(claims[0].config)), claims[0].newAttributionRoot);
    }

    function test_settleBatch_multipleChannels() public {
        // Two channels, same token, credits aggregated per receiver.
        x402BatchSettlement.ChannelConfig memory c1 = _config(bytes32(uint256(1)));
        x402BatchSettlement.ChannelConfig memory c2 = _config(bytes32(uint256(2)));
        _deposit(c1, 200e6);
        _deposit(c2, 200e6);

        bytes32 id1 = settlement.getChannelId(c1);
        bytes32 id2 = settlement.getChannelId(c2);
        // Ensure claims sorted by channel id.
        if (id1 > id2) {
            (c1, c2) = (c2, c1);
            (id1, id2) = (id2, id1);
        }

        address[] memory payTos = new address[](1);
        uint128[] memory cum1 = new uint128[](1);
        uint128[] memory cum2 = new uint128[](1);
        payTos[0] = receiverA;
        cum1[0] = 50e6;
        cum2[0] = 70e6;

        x402BatchSettlementZKHybridGateway.ChannelClaim[] memory claims =
            new x402BatchSettlementZKHybridGateway.ChannelClaim[](2);
        claims[0] = x402BatchSettlementZKHybridGateway.ChannelClaim({
            config: c1,
            maxClaimableAmount: 50e6,
            signature: _signVoucher(id1, 50e6),
            totalClaimed: 50e6,
            newAttributionRoot: _attrRoot(payTos, cum1)
        });
        claims[1] = x402BatchSettlementZKHybridGateway.ChannelClaim({
            config: c2,
            maxClaimableAmount: 70e6,
            signature: _signVoucher(id2, 70e6),
            totalClaimed: 70e6,
            newAttributionRoot: _attrRoot(payTos, cum2)
        });

        x402BatchSettlementZKHybridGateway.Credit[] memory credits =
            new x402BatchSettlementZKHybridGateway.Credit[](1);
        credits[0] = x402BatchSettlementZKHybridGateway.Credit({
            receiver: receiverA, token: address(token), amount: 120e6
        });

        verifier.setExpectedCommitment(_expectedCommitment(claims, credits));
        gateway.settleBatch(claims, credits, hex"01");
        assertEq(gateway.withdrawable(receiverA, address(token)), 120e6);
    }

    // =========================================================================
    // Reverts
    // =========================================================================

    function test_settleBatch_revertsEmptyBatch() public {
        x402BatchSettlementZKHybridGateway.ChannelClaim[] memory claims =
            new x402BatchSettlementZKHybridGateway.ChannelClaim[](0);
        x402BatchSettlementZKHybridGateway.Credit[] memory credits =
            new x402BatchSettlementZKHybridGateway.Credit[](0);
        vm.expectRevert(x402BatchSettlementZKHybridGateway.EmptyBatch.selector);
        gateway.settleBatch(claims, credits, hex"");
    }

    function test_settleBatch_revertsUnsortedOrDuplicateChannel() public {
        x402BatchSettlement.ChannelConfig memory c1 = _config(bytes32(uint256(1)));
        x402BatchSettlement.ChannelConfig memory c2 = _config(bytes32(uint256(2)));
        _deposit(c1, 100e6);
        _deposit(c2, 100e6);
        bytes32 id1 = settlement.getChannelId(c1);
        bytes32 id2 = settlement.getChannelId(c2);
        // Force descending order.
        if (id1 < id2) {
            (c1, c2) = (c2, c1);
            (id1, id2) = (id2, id1);
        }

        address[] memory payTos = new address[](1);
        uint128[] memory cum = new uint128[](1);
        payTos[0] = receiverA;
        cum[0] = 10e6;
        bytes32 root = _attrRoot(payTos, cum);

        x402BatchSettlementZKHybridGateway.ChannelClaim[] memory claims =
            new x402BatchSettlementZKHybridGateway.ChannelClaim[](2);
        claims[0] = x402BatchSettlementZKHybridGateway.ChannelClaim({
            config: c1,
            maxClaimableAmount: 10e6,
            signature: _signVoucher(id1, 10e6),
            totalClaimed: 10e6,
            newAttributionRoot: root
        });
        claims[1] = x402BatchSettlementZKHybridGateway.ChannelClaim({
            config: c2,
            maxClaimableAmount: 10e6,
            signature: _signVoucher(id2, 10e6),
            totalClaimed: 10e6,
            newAttributionRoot: bytes32(uint256(2))
        });

        x402BatchSettlementZKHybridGateway.Credit[] memory credits =
            new x402BatchSettlementZKHybridGateway.Credit[](1);
        credits[0] =
            x402BatchSettlementZKHybridGateway.Credit({receiver: receiverA, token: address(token), amount: 20e6});

        vm.expectRevert(x402BatchSettlementZKHybridGateway.UnsortedOrDuplicateChannel.selector);
        gateway.settleBatch(claims, credits, hex"01");
    }

    function test_settleBatch_revertsNoClaimDelta() public {
        (x402BatchSettlementZKHybridGateway.ChannelClaim[] memory claims,
            x402BatchSettlementZKHybridGateway.Credit[] memory credits) =
            _singleChannelBatch(100e6, 60e6, 40e6, bytes32(uint256(3)));
        claims[0].totalClaimed = 0;
        vm.expectRevert(x402BatchSettlementZKHybridGateway.NoClaimDelta.selector);
        gateway.settleBatch(claims, credits, hex"01");
    }

    function test_settleBatch_revertsUnchangedAttributionRoot() public {
        (x402BatchSettlementZKHybridGateway.ChannelClaim[] memory claims,
            x402BatchSettlementZKHybridGateway.Credit[] memory credits) =
            _singleChannelBatch(100e6, 60e6, 40e6, bytes32(uint256(4)));
        claims[0].newAttributionRoot = bytes32(0); // old root is zero
        vm.expectRevert(x402BatchSettlementZKHybridGateway.UnchangedAttributionRoot.selector);
        gateway.settleBatch(claims, credits, hex"01");
    }

    function test_settleBatch_revertsUnsortedOrDuplicateCredit() public {
        (x402BatchSettlementZKHybridGateway.ChannelClaim[] memory claims,
            x402BatchSettlementZKHybridGateway.Credit[] memory credits) =
            _singleChannelBatch(100e6, 60e6, 40e6, bytes32(uint256(5)));
        // Swap to violate strict ordering.
        (credits[0], credits[1]) = (credits[1], credits[0]);
        vm.expectRevert(x402BatchSettlementZKHybridGateway.UnsortedOrDuplicateCredit.selector);
        gateway.settleBatch(claims, credits, hex"01");
    }

    function test_settleBatch_revertsConservationMismatch() public {
        (x402BatchSettlementZKHybridGateway.ChannelClaim[] memory claims,
            x402BatchSettlementZKHybridGateway.Credit[] memory credits) =
            _singleChannelBatch(100e6, 60e6, 40e6, bytes32(uint256(6)));
        credits[0].amount = 50e6; // 50+40 != 100
        // Mock accepts any commitment so we reach the defense-in-depth check.
        verifier.clearExpectedCommitment();
        vm.expectRevert(x402BatchSettlementZKHybridGateway.ConservationMismatch.selector);
        gateway.settleBatch(claims, credits, hex"01");
    }

    function test_settleBatch_revertsInvalidAttributionProof() public {
        (x402BatchSettlementZKHybridGateway.ChannelClaim[] memory claims,
            x402BatchSettlementZKHybridGateway.Credit[] memory credits) =
            _singleChannelBatch(100e6, 60e6, 40e6, bytes32(uint256(7)));
        verifier.setShouldSucceed(false);
        vm.expectRevert(x402BatchSettlementZKHybridGateway.InvalidAttributionProof.selector);
        gateway.settleBatch(claims, credits, hex"01");
    }

    function test_settleBatch_revertsZeroPayerAuthorizer() public {
        x402BatchSettlement.ChannelConfig memory config = _config(bytes32(uint256(8)));
        config.payerAuthorizer = address(0);
        // Stateful payer path: deposit still works; gateway must reject.
        _deposit(config, 100e6);

        address[] memory payTos = new address[](1);
        uint128[] memory cum = new uint128[](1);
        payTos[0] = receiverA;
        cum[0] = 100e6;

        x402BatchSettlementZKHybridGateway.ChannelClaim[] memory claims =
            new x402BatchSettlementZKHybridGateway.ChannelClaim[](1);
        // Voucher would need payer sig when authorizer is 0; we never get that far.
        claims[0] = x402BatchSettlementZKHybridGateway.ChannelClaim({
            config: config,
            maxClaimableAmount: 100e6,
            signature: hex"",
            totalClaimed: 100e6,
            newAttributionRoot: _attrRoot(payTos, cum)
        });
        x402BatchSettlementZKHybridGateway.Credit[] memory credits =
            new x402BatchSettlementZKHybridGateway.Credit[](1);
        credits[0] =
            x402BatchSettlementZKHybridGateway.Credit({receiver: receiverA, token: address(token), amount: 100e6});

        vm.expectRevert(x402BatchSettlementZKHybridGateway.ZeroPayerAuthorizer.selector);
        gateway.settleBatch(claims, credits, hex"01");
    }

    function test_settleBatch_revertsNotGatewayChannel() public {
        x402BatchSettlement.ChannelConfig memory config = _config(bytes32(uint256(9)));
        config.receiver = makeAddr("other");
        config.receiverAuthorizer = makeAddr("otherAuth");
        // Can't easily deposit to other receiver without approval flow; craft claim directly.
        x402BatchSettlementZKHybridGateway.ChannelClaim[] memory claims =
            new x402BatchSettlementZKHybridGateway.ChannelClaim[](1);
        claims[0] = x402BatchSettlementZKHybridGateway.ChannelClaim({
            config: config,
            maxClaimableAmount: 1,
            signature: hex"",
            totalClaimed: 1,
            newAttributionRoot: bytes32(uint256(1))
        });
        x402BatchSettlementZKHybridGateway.Credit[] memory credits =
            new x402BatchSettlementZKHybridGateway.Credit[](1);
        credits[0] =
            x402BatchSettlementZKHybridGateway.Credit({receiver: receiverA, token: address(token), amount: 1});

        vm.expectRevert(x402BatchSettlementZKHybridGateway.NotGatewayChannel.selector);
        gateway.settleBatch(claims, credits, hex"01");
    }

    function test_settleBatch_revertsGatewayInsolvent() public {
        (x402BatchSettlementZKHybridGateway.ChannelClaim[] memory claims,
            x402BatchSettlementZKHybridGateway.Credit[] memory credits) =
            _singleChannelBatch(100e6, 60e6, 40e6, bytes32(uint256(11)));
        verifier.clearExpectedCommitment();
        gateway.settleBatch(claims, credits, hex"01");

        // Second claim: +10e6 to credits[0].receiver. Drain gateway first so after settle
        // balance is 10 while outstanding is 110.
        x402BatchSettlement.ChannelConfig memory config2 = claims[0].config;
        bytes32 channelId = settlement.getChannelId(config2);
        address[] memory payTos = new address[](2);
        uint128[] memory cum = new uint128[](2);
        payTos[0] = credits[0].receiver;
        payTos[1] = credits[1].receiver;
        cum[0] = credits[0].amount + 10e6;
        cum[1] = credits[1].amount;

        x402BatchSettlementZKHybridGateway.ChannelClaim[] memory claims2 =
            new x402BatchSettlementZKHybridGateway.ChannelClaim[](1);
        claims2[0] = x402BatchSettlementZKHybridGateway.ChannelClaim({
            config: config2,
            maxClaimableAmount: 110e6,
            signature: _signVoucher(channelId, 110e6),
            totalClaimed: 110e6,
            newAttributionRoot: _attrRoot(payTos, cum)
        });
        x402BatchSettlementZKHybridGateway.Credit[] memory credits2 =
            new x402BatchSettlementZKHybridGateway.Credit[](1);
        credits2[0] = x402BatchSettlementZKHybridGateway.Credit({
            receiver: credits[0].receiver, token: address(token), amount: 10e6
        });

        deal(address(token), address(gateway), 0);

        vm.expectRevert(x402BatchSettlementZKHybridGateway.GatewayInsolvent.selector);
        gateway.settleBatch(claims2, credits2, hex"01");
    }

    // =========================================================================
    // Withdraw / refund
    // =========================================================================

    function test_withdraw_happyPath() public {
        (x402BatchSettlementZKHybridGateway.ChannelClaim[] memory claims,
            x402BatchSettlementZKHybridGateway.Credit[] memory credits) =
            _singleChannelBatch(100e6, 60e6, 40e6, bytes32(uint256(12)));
        verifier.clearExpectedCommitment();
        gateway.settleBatch(claims, credits, hex"01");

        uint128 amount = gateway.withdrawable(credits[0].receiver, address(token));
        gateway.withdraw(credits[0].receiver, address(token));
        assertEq(token.balanceOf(credits[0].receiver), amount);
        assertEq(gateway.withdrawable(credits[0].receiver, address(token)), 0);
    }

    function test_withdraw_revertsNothingToWithdraw() public {
        vm.expectRevert(x402BatchSettlementZKHybridGateway.NothingToWithdraw.selector);
        gateway.withdraw(receiverA, address(token));
    }

    function test_refundChannel_operatorOnly() public {
        x402BatchSettlement.ChannelConfig memory config = _config(bytes32(uint256(13)));
        _deposit(config, 100e6);

        vm.expectRevert(x402BatchSettlementZKHybridGateway.NotOperator.selector);
        gateway.refundChannel(config, 50e6);

        vm.prank(operatorWallet.addr);
        gateway.refundChannel(config, 50e6);
        assertEq(token.balanceOf(payerWallet.addr), 1_000_000e6 - 100e6 + 50e6);
    }
}
