// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {VmSafe} from "forge-std/Vm.sol";

import {IAuthCaptureEscrow} from "../src/interfaces/IAuthCaptureEscrow.sol";
import {x402AuthCaptureOperator} from "../src/x402AuthCaptureOperator.sol";
import {MockAuthCaptureEscrow, MockERC1271Signer, MockPaymentCollector} from "./mocks/MockAuthCaptureEscrow.sol";
import {MockERC3009Token} from "./mocks/MockERC3009Token.sol";

contract X402CaptureAuthorizerTest is Test {
    x402AuthCaptureOperator public authorizerContract;
    MockAuthCaptureEscrow public escrow;
    MockPaymentCollector public paymentCollector;
    MockERC3009Token public token;

    VmSafe.Wallet public payerWallet;
    VmSafe.Wallet public receiverWallet;
    VmSafe.Wallet public authorizerWallet;
    VmSafe.Wallet public attackerWallet;

    address public feeReceiver = address(0xFEE);

    uint120 constant MAX_AMOUNT = 1000e6;
    uint256 constant AUTH_AMOUNT = 600e6;
    uint256 constant CAPTURE_AMOUNT = 400e6;
    uint16 constant FEE_BPS = 250;
    uint256 constant RANDOM_SALT = 0xC0FFEE;

    event PaymentAuthorized(
        bytes32 indexed paymentInfoHash,
        IAuthCaptureEscrow.PaymentInfo paymentInfo,
        uint256 amount,
        address tokenCollector
    );
    event PaymentCaptured(bytes32 indexed paymentInfoHash, uint256 amount, uint16 feeBps, address feeReceiver);
    event PaymentVoided(bytes32 indexed paymentInfoHash, uint256 amount);

    function setUp() public {
        vm.warp(1_000_000);

        payerWallet = vm.createWallet("payer");
        receiverWallet = vm.createWallet("receiver");
        authorizerWallet = vm.createWallet("authorizer");
        attackerWallet = vm.createWallet("attacker");

        escrow = new MockAuthCaptureEscrow();
        authorizerContract = new x402AuthCaptureOperator(address(escrow));
        paymentCollector = new MockPaymentCollector();

        token = new MockERC3009Token("USDC", "USDC", 6);
        token.mint(payerWallet.addr, 100_000e6);
    }

    // =========================================================================
    // Helpers
    // =========================================================================

    function _paymentInfo() internal view returns (IAuthCaptureEscrow.PaymentInfo memory) {
        return _paymentInfoFor(authorizerWallet.addr, RANDOM_SALT);
    }

    function _paymentInfoFor(
        address authorizer,
        uint256 randomSalt
    ) internal view returns (IAuthCaptureEscrow.PaymentInfo memory) {
        return IAuthCaptureEscrow.PaymentInfo({
            operator: address(authorizerContract),
            payer: payerWallet.addr,
            receiver: receiverWallet.addr,
            token: address(token),
            maxAmount: MAX_AMOUNT,
            preApprovalExpiry: uint48(block.timestamp + 1 hours),
            authorizationExpiry: uint48(block.timestamp + 2 hours),
            refundExpiry: uint48(block.timestamp + 30 days),
            minFeeBps: 0,
            maxFeeBps: 1000,
            feeReceiver: feeReceiver,
            salt: uint256(keccak256(abi.encode(authorizer, address(0), randomSalt)))
        });
    }

    function _hash(
        IAuthCaptureEscrow.PaymentInfo memory paymentInfo
    ) internal view returns (bytes32) {
        return escrow.getHash(paymentInfo);
    }

    function _sign(
        VmSafe.Wallet memory wallet,
        bytes32 digest
    ) internal returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(wallet, digest);
        return abi.encodePacked(r, s, v);
    }

    /// @dev Runs the full `authorize` entry point with a signature from `signer`.
    function _authorize(
        IAuthCaptureEscrow.PaymentInfo memory paymentInfo,
        uint256 amount,
        address authorizer,
        uint256 randomSalt,
        VmSafe.Wallet memory signer
    ) internal {
        bytes memory signature = _sign(
            signer,
            authorizerContract.getAuthorizeDigest(_hash(paymentInfo), amount, address(paymentCollector), keccak256(""))
        );
        authorizerContract.authorize(
            paymentInfo, amount, address(paymentCollector), "", authorizer, address(0), randomSalt, signature
        );
    }

    function _authorizeHappy(
        IAuthCaptureEscrow.PaymentInfo memory paymentInfo
    ) internal {
        _authorize(paymentInfo, AUTH_AMOUNT, authorizerWallet.addr, RANDOM_SALT, authorizerWallet);
    }

    function _expected(
        IAuthCaptureEscrow.PaymentInfo memory paymentInfo
    ) internal view returns (x402AuthCaptureOperator.ExpectedBalances memory) {
        (, uint120 capturable, uint120 refundable) = _state(paymentInfo);
        return x402AuthCaptureOperator.ExpectedBalances({
            capturableAmount: capturable, refundableAmount: refundable
        });
    }

    function _capture(
        IAuthCaptureEscrow.PaymentInfo memory paymentInfo,
        uint256 amount,
        VmSafe.Wallet memory signer
    ) internal {
        _capture(paymentInfo, amount, RANDOM_SALT, signer);
    }

    function _capture(
        IAuthCaptureEscrow.PaymentInfo memory paymentInfo,
        uint256 amount,
        uint256 randomSalt,
        VmSafe.Wallet memory signer
    ) internal {
        x402AuthCaptureOperator.ExpectedBalances memory expected = _expected(paymentInfo);
        bytes memory signature = _sign(
            signer, authorizerContract.getCaptureDigest(_hash(paymentInfo), amount, FEE_BPS, feeReceiver, expected)
        );
        authorizerContract.capture(
            paymentInfo, amount, FEE_BPS, feeReceiver, authorizerWallet.addr, address(0), randomSalt, expected, signature
        );
    }

    function _state(
        IAuthCaptureEscrow.PaymentInfo memory paymentInfo
    ) internal view returns (bool collected, uint120 capturable, uint120 refundable) {
        return escrow.paymentState(_hash(paymentInfo));
    }

    // =========================================================================
    // Happy Paths
    // =========================================================================

    function test_authorize_escrowsFunds() public {
        IAuthCaptureEscrow.PaymentInfo memory paymentInfo = _paymentInfo();
        bytes32 paymentInfoHash = _hash(paymentInfo);
        uint256 payerBefore = token.balanceOf(payerWallet.addr);

        vm.expectEmit(true, false, false, true, address(escrow));
        emit PaymentAuthorized(paymentInfoHash, paymentInfo, AUTH_AMOUNT, address(paymentCollector));
        _authorizeHappy(paymentInfo);

        (bool collected, uint120 capturable, uint120 refundable) = _state(paymentInfo);
        assertTrue(collected);
        assertEq(capturable, AUTH_AMOUNT);
        assertEq(refundable, 0);

        // The collector pulls the full maxAmount and returns the excess, so the payer is only out the auth amount.
        assertEq(token.balanceOf(payerWallet.addr), payerBefore - AUTH_AMOUNT);
        assertEq(token.balanceOf(escrow.getTokenStore(address(authorizerContract))), AUTH_AMOUNT);
    }

    function test_charge_distributesImmediately() public {
        IAuthCaptureEscrow.PaymentInfo memory paymentInfo = _paymentInfo();
        bytes memory signature = _sign(
            authorizerWallet,
            authorizerContract.getChargeDigest(
                _hash(paymentInfo), AUTH_AMOUNT, address(paymentCollector), keccak256(""), FEE_BPS, feeReceiver
            )
        );

        authorizerContract.charge(
            paymentInfo,
            AUTH_AMOUNT,
            address(paymentCollector),
            "",
            FEE_BPS,
            feeReceiver,
            authorizerWallet.addr,
            address(0),
            RANDOM_SALT,
            signature
        );

        uint256 expectedFee = AUTH_AMOUNT * FEE_BPS / 10_000;
        assertEq(token.balanceOf(feeReceiver), expectedFee);
        assertEq(token.balanceOf(receiverWallet.addr), AUTH_AMOUNT - expectedFee);

        (bool collected,, uint120 refundable) = _state(paymentInfo);
        assertTrue(collected);
        assertEq(refundable, AUTH_AMOUNT);
    }

    function test_capture_releasesToReceiver() public {
        IAuthCaptureEscrow.PaymentInfo memory paymentInfo = _paymentInfo();
        _authorizeHappy(paymentInfo);

        bytes32 paymentInfoHash = _hash(paymentInfo);
        uint256 receiverBefore = token.balanceOf(receiverWallet.addr);

        vm.expectEmit(true, false, false, true, address(escrow));
        emit PaymentCaptured(paymentInfoHash, CAPTURE_AMOUNT, FEE_BPS, feeReceiver);
        _capture(paymentInfo, CAPTURE_AMOUNT, authorizerWallet);

        uint256 expectedFee = CAPTURE_AMOUNT * FEE_BPS / 10_000;
        assertEq(token.balanceOf(feeReceiver), expectedFee);
        assertEq(token.balanceOf(receiverWallet.addr), receiverBefore + CAPTURE_AMOUNT - expectedFee);

        (, uint120 capturable, uint120 refundable) = _state(paymentInfo);
        assertEq(capturable, AUTH_AMOUNT - CAPTURE_AMOUNT);
        assertEq(refundable, CAPTURE_AMOUNT);
    }

    function test_capture_partialTwice() public {
        IAuthCaptureEscrow.PaymentInfo memory paymentInfo = _paymentInfo();
        _authorizeHappy(paymentInfo);

        _capture(paymentInfo, 100e6, authorizerWallet);
        _capture(paymentInfo, 200e6, authorizerWallet);

        (, uint120 capturable, uint120 refundable) = _state(paymentInfo);
        assertEq(capturable, AUTH_AMOUNT - 300e6);
        assertEq(refundable, 300e6);
    }

    function test_void_returnsEscrowToPayer() public {
        IAuthCaptureEscrow.PaymentInfo memory paymentInfo = _paymentInfo();
        _authorizeHappy(paymentInfo);

        bytes32 paymentInfoHash = _hash(paymentInfo);
        uint256 payerBefore = token.balanceOf(payerWallet.addr);
        bytes memory signature = _sign(authorizerWallet, authorizerContract.getVoidDigest(paymentInfoHash));

        vm.expectEmit(true, false, false, true, address(escrow));
        emit PaymentVoided(paymentInfoHash, AUTH_AMOUNT);
        authorizerContract.void(paymentInfo, authorizerWallet.addr, address(0), RANDOM_SALT, signature);

        assertEq(token.balanceOf(payerWallet.addr), payerBefore + AUTH_AMOUNT);
        (, uint120 capturable,) = _state(paymentInfo);
        assertEq(capturable, 0);
    }

    /// @dev No refund entry point exists, so the operator must never end up holding tokens or an allowance.
    function test_operatorHoldsNoFunds() public {
        IAuthCaptureEscrow.PaymentInfo memory paymentInfo = _paymentInfo();
        _authorizeHappy(paymentInfo);
        _capture(paymentInfo, CAPTURE_AMOUNT, authorizerWallet);

        assertEq(token.balanceOf(address(authorizerContract)), 0);
        assertEq(token.allowance(address(authorizerContract), address(paymentCollector)), 0);
    }

    // =========================================================================
    // Operator & Salt Binding
    // =========================================================================

    function test_wrongOperator_reverts() public {
        IAuthCaptureEscrow.PaymentInfo memory paymentInfo = _paymentInfo();
        paymentInfo.operator = attackerWallet.addr;

        bytes memory signature = _sign(authorizerWallet, authorizerContract.getVoidDigest(_hash(paymentInfo)));

        vm.expectRevert(x402AuthCaptureOperator.WrongOperator.selector);
        authorizerContract.void(paymentInfo, authorizerWallet.addr, address(0), RANDOM_SALT, signature);
    }

    function test_saltAuthorizerMismatch_wrongAuthorizer_reverts() public {
        // Salt commits to `authorizerWallet`, but the call claims the attacker as authorizer.
        IAuthCaptureEscrow.PaymentInfo memory paymentInfo = _paymentInfo();
        bytes memory signature = _sign(attackerWallet, authorizerContract.getVoidDigest(_hash(paymentInfo)));

        vm.expectRevert(x402AuthCaptureOperator.SaltMismatch.selector);
        authorizerContract.void(paymentInfo, attackerWallet.addr, address(0), RANDOM_SALT, signature);
    }

    function test_saltAuthorizerMismatch_wrongRandomSalt_reverts() public {
        IAuthCaptureEscrow.PaymentInfo memory paymentInfo = _paymentInfo();
        bytes memory signature = _sign(authorizerWallet, authorizerContract.getVoidDigest(_hash(paymentInfo)));

        vm.expectRevert(x402AuthCaptureOperator.SaltMismatch.selector);
        authorizerContract.void(paymentInfo, authorizerWallet.addr, address(0), RANDOM_SALT + 1, signature);
    }

    function test_zeroAuthorizer_reverts() public {
        IAuthCaptureEscrow.PaymentInfo memory paymentInfo = _paymentInfoFor(address(0), RANDOM_SALT);
        bytes memory signature = _sign(authorizerWallet, authorizerContract.getVoidDigest(_hash(paymentInfo)));

        vm.expectRevert(x402AuthCaptureOperator.ZeroAuthorizer.selector);
        authorizerContract.void(paymentInfo, address(0), address(0), RANDOM_SALT, signature);
    }

    function test_getSalt_matchesPaymentInfoSalt() public view {
        assertEq(authorizerContract.getSalt(authorizerWallet.addr, address(0), RANDOM_SALT), _paymentInfo().salt);
    }

    // =========================================================================
    // Signature Validation
    // =========================================================================

    function test_wrongSigner_reverts() public {
        IAuthCaptureEscrow.PaymentInfo memory paymentInfo = _paymentInfo();
        bytes memory signature = _sign(attackerWallet, authorizerContract.getVoidDigest(_hash(paymentInfo)));

        vm.expectRevert(x402AuthCaptureOperator.InvalidSignature.selector);
        authorizerContract.void(paymentInfo, authorizerWallet.addr, address(0), RANDOM_SALT, signature);
    }

    function test_tamperedAmount_reverts() public {
        IAuthCaptureEscrow.PaymentInfo memory paymentInfo = _paymentInfo();
        bytes memory signature = _sign(
            authorizerWallet,
            authorizerContract.getAuthorizeDigest(
                _hash(paymentInfo), AUTH_AMOUNT, address(paymentCollector), keccak256("")
            )
        );

        vm.expectRevert(x402AuthCaptureOperator.InvalidSignature.selector);
        authorizerContract.authorize(
            paymentInfo, AUTH_AMOUNT + 1, address(paymentCollector), "", authorizerWallet.addr,
            address(0),
            RANDOM_SALT,
            signature
        );
    }

    function test_tamperedCollectorData_reverts() public {
        IAuthCaptureEscrow.PaymentInfo memory paymentInfo = _paymentInfo();
        bytes memory signature = _sign(
            authorizerWallet,
            authorizerContract.getAuthorizeDigest(
                _hash(paymentInfo), AUTH_AMOUNT, address(paymentCollector), keccak256("")
            )
        );

        vm.expectRevert(x402AuthCaptureOperator.InvalidSignature.selector);
        authorizerContract.authorize(
            paymentInfo,
            AUTH_AMOUNT,
            address(paymentCollector),
            hex"deadbeef",
            authorizerWallet.addr,
            address(0),
            RANDOM_SALT,
            signature
        );
    }

    function test_tamperedFeeBps_reverts() public {
        IAuthCaptureEscrow.PaymentInfo memory paymentInfo = _paymentInfo();
        _authorizeHappy(paymentInfo);

        (, uint120 capturable, uint120 refundable) = _state(paymentInfo);
        bytes memory signature = _sign(
            authorizerWallet,
            authorizerContract.getCaptureDigest(
                _hash(paymentInfo),
                CAPTURE_AMOUNT,
                FEE_BPS,
                feeReceiver,
                x402AuthCaptureOperator.ExpectedBalances({capturableAmount: capturable, refundableAmount: refundable})
            )
        );

        vm.expectRevert(x402AuthCaptureOperator.InvalidSignature.selector);
        authorizerContract.capture(
            paymentInfo,
            CAPTURE_AMOUNT,
            FEE_BPS + 1,
            feeReceiver,
            authorizerWallet.addr,
            address(0),
            RANDOM_SALT,
            x402AuthCaptureOperator.ExpectedBalances({capturableAmount: capturable, refundableAmount: refundable}),
            signature
        );
    }

    /// @dev A digest signed for one payment must not authorize a different one.
    function test_signatureFromOtherPayment_reverts() public {
        IAuthCaptureEscrow.PaymentInfo memory paymentInfo = _paymentInfo();
        IAuthCaptureEscrow.PaymentInfo memory otherPayment = _paymentInfo();
        otherPayment.maxAmount = MAX_AMOUNT - 1;

        bytes memory signature = _sign(authorizerWallet, authorizerContract.getVoidDigest(_hash(otherPayment)));

        vm.expectRevert(x402AuthCaptureOperator.InvalidSignature.selector);
        authorizerContract.void(paymentInfo, authorizerWallet.addr, address(0), RANDOM_SALT, signature);
    }

    function test_erc1271Authorizer_succeeds() public {
        MockERC1271Signer smartWallet = new MockERC1271Signer(authorizerWallet.addr);
        IAuthCaptureEscrow.PaymentInfo memory paymentInfo = _paymentInfoFor(address(smartWallet), RANDOM_SALT);

        _authorize(paymentInfo, AUTH_AMOUNT, address(smartWallet), RANDOM_SALT, authorizerWallet);

        (bool collected, uint120 capturable,) = _state(paymentInfo);
        assertTrue(collected);
        assertEq(capturable, AUTH_AMOUNT);
    }

    function test_erc1271Authorizer_wrongOwner_reverts() public {
        MockERC1271Signer smartWallet = new MockERC1271Signer(authorizerWallet.addr);
        IAuthCaptureEscrow.PaymentInfo memory paymentInfo = _paymentInfoFor(address(smartWallet), RANDOM_SALT);

        bytes memory signature = _sign(attackerWallet, authorizerContract.getVoidDigest(_hash(paymentInfo)));

        vm.expectRevert(x402AuthCaptureOperator.InvalidSignature.selector);
        authorizerContract.void(paymentInfo, address(smartWallet), address(0), RANDOM_SALT, signature);
    }

    // =========================================================================
    // Expected Balance Replay Protection
    // =========================================================================

    function test_capture_staleExpectedBalances_reverts() public {
        IAuthCaptureEscrow.PaymentInfo memory paymentInfo = _paymentInfo();
        _authorizeHappy(paymentInfo);

        uint256 expectedCapturable = AUTH_AMOUNT;
        uint256 expectedRefundable = 0;
        bytes memory signature = _sign(
            authorizerWallet,
            authorizerContract.getCaptureDigest(
                _hash(paymentInfo), 100e6, FEE_BPS, feeReceiver, x402AuthCaptureOperator.ExpectedBalances({capturableAmount: expectedCapturable, refundableAmount: expectedRefundable})
            )
        );

        _capture(paymentInfo, 100e6, authorizerWallet);

        vm.expectRevert(
            abi.encodeWithSelector(
                x402AuthCaptureOperator.UnexpectedPaymentState.selector, AUTH_AMOUNT - 100e6, 100e6
            )
        );
        authorizerContract.capture(
            paymentInfo,
            100e6,
            FEE_BPS,
            feeReceiver,
            authorizerWallet.addr,
            address(0),
            RANDOM_SALT,
            x402AuthCaptureOperator.ExpectedBalances({capturableAmount: expectedCapturable, refundableAmount: expectedRefundable}),
            signature
        );
    }

    function test_expectedBalancesIndependentAcrossPayments() public {
        IAuthCaptureEscrow.PaymentInfo memory first = _paymentInfo();
        IAuthCaptureEscrow.PaymentInfo memory second = _paymentInfoFor(authorizerWallet.addr, RANDOM_SALT + 1);

        _authorizeHappy(first);
        _authorize(second, AUTH_AMOUNT, authorizerWallet.addr, RANDOM_SALT + 1, authorizerWallet);

        _capture(first, 100e6, authorizerWallet);
        _capture(second, 100e6, RANDOM_SALT + 1, authorizerWallet);

        (,, uint120 firstRefundable) = _state(first);
        (,, uint120 secondRefundable) = _state(second);
        assertEq(firstRefundable, 100e6);
        assertEq(secondRefundable, 100e6);
    }

    // =========================================================================
    // Escrow Passthrough
    // =========================================================================

    function test_escrowRevertBubblesUp() public {
        IAuthCaptureEscrow.PaymentInfo memory paymentInfo = _paymentInfo();
        _authorizeHappy(paymentInfo);

        bytes32 paymentInfoHash = _hash(paymentInfo);
        uint256 amount = AUTH_AMOUNT + 1;
        (, uint120 capturable, uint120 refundable) = _state(paymentInfo);
        bytes memory signature = _sign(
            authorizerWallet,
            authorizerContract.getCaptureDigest(
                paymentInfoHash, amount, FEE_BPS, feeReceiver, x402AuthCaptureOperator.ExpectedBalances({capturableAmount: capturable, refundableAmount: refundable})
            )
        );

        vm.expectRevert(
            abi.encodeWithSelector(
                MockAuthCaptureEscrow.InsufficientAuthorization.selector, paymentInfoHash, AUTH_AMOUNT, amount
            )
        );
        authorizerContract.capture(
            paymentInfo,
            amount,
            FEE_BPS,
            feeReceiver,
            authorizerWallet.addr,
            address(0),
            RANDOM_SALT,
            x402AuthCaptureOperator.ExpectedBalances({capturableAmount: capturable, refundableAmount: refundable}),
            signature
        );
    }

    function test_authorizeTwice_reverts() public {
        IAuthCaptureEscrow.PaymentInfo memory paymentInfo = _paymentInfo();
        _authorizeHappy(paymentInfo);

        bytes32 paymentInfoHash = _hash(paymentInfo);
        bytes memory signature = _sign(
            authorizerWallet,
            authorizerContract.getAuthorizeDigest(
                paymentInfoHash, AUTH_AMOUNT, address(paymentCollector), keccak256("")
            )
        );

        vm.expectRevert(abi.encodeWithSelector(MockAuthCaptureEscrow.PaymentAlreadyCollected.selector, paymentInfoHash));
        authorizerContract.authorize(
            paymentInfo, AUTH_AMOUNT, address(paymentCollector), "", authorizerWallet.addr,
            address(0),
            RANDOM_SALT,
            signature
        );
    }

    // =========================================================================
    // Multicall
    // =========================================================================

    function test_multicall_batchesCaptures() public {
        IAuthCaptureEscrow.PaymentInfo memory paymentInfo = _paymentInfo();
        _authorizeHappy(paymentInfo);

        bytes[] memory calls = new bytes[](2);
        calls[0] = abi.encodeCall(
            x402AuthCaptureOperator.capture,
            (
                paymentInfo,
                100e6,
                FEE_BPS,
                feeReceiver,
                authorizerWallet.addr,
                address(0),
                RANDOM_SALT,
                x402AuthCaptureOperator.ExpectedBalances({capturableAmount: AUTH_AMOUNT, refundableAmount: 0}),
                _sign(
                    authorizerWallet,
                    authorizerContract.getCaptureDigest(
                        _hash(paymentInfo), 100e6, FEE_BPS, feeReceiver, x402AuthCaptureOperator.ExpectedBalances({capturableAmount: AUTH_AMOUNT, refundableAmount: 0})
                )
                )
            )
        );
        calls[1] = abi.encodeCall(
            x402AuthCaptureOperator.capture,
            (
                paymentInfo,
                200e6,
                FEE_BPS,
                feeReceiver,
                authorizerWallet.addr,
                address(0),
                RANDOM_SALT,
                x402AuthCaptureOperator.ExpectedBalances({
                    capturableAmount: AUTH_AMOUNT - 100e6, refundableAmount: 100e6
                }),
                _sign(
                    authorizerWallet,
                    authorizerContract.getCaptureDigest(
                        _hash(paymentInfo), 200e6, FEE_BPS, feeReceiver, x402AuthCaptureOperator.ExpectedBalances({capturableAmount: AUTH_AMOUNT - 100e6, refundableAmount: 100e6})
                )
                )
            )
        );

        authorizerContract.multicall(calls);

        (,, uint120 refundable) = _state(paymentInfo);
        assertEq(refundable, 300e6);
    }

    // =========================================================================
    // Digests
    // =========================================================================

    function test_digests_matchEip712Encoding() public view {
        bytes32 paymentInfoHash = keccak256("payment");
        bytes32 domainSeparator = _domainSeparator();

        assertEq(
            authorizerContract.getVoidDigest(paymentInfoHash),
            keccak256(
                abi.encodePacked(
                    "\x19\x01",
                    domainSeparator,
                    keccak256(abi.encode(authorizerContract.VOID_TYPEHASH(), paymentInfoHash))
                )
            )
        );
        assertEq(
            authorizerContract.getCaptureDigest(
                paymentInfoHash,
                1e6,
                FEE_BPS,
                feeReceiver,
                x402AuthCaptureOperator.ExpectedBalances({capturableAmount: 3, refundableAmount: 4})
            ),
            keccak256(
                abi.encodePacked(
                    "\x19\x01",
                    domainSeparator,
                    keccak256(
                        abi.encode(
                            authorizerContract.CAPTURE_TYPEHASH(),
                            paymentInfoHash,
                            1e6,
                            FEE_BPS,
                            feeReceiver,
                            uint256(3),
                            uint256(4)
                        )
                    )
                )
            )
        );
    }

    function test_typehashStrings() public view {
        assertEq(
            authorizerContract.AUTHORIZE_TYPEHASH(),
            keccak256(
                "Authorize(bytes32 paymentInfoHash,uint256 amount,address tokenCollector,bytes32 collectorDataHash)"
            )
        );
        assertEq(
            authorizerContract.CHARGE_TYPEHASH(),
            keccak256(
                "Charge(bytes32 paymentInfoHash,uint256 amount,address tokenCollector,bytes32 collectorDataHash,uint16 feeBps,address feeReceiver)"
            )
        );
        assertEq(
            authorizerContract.CAPTURE_TYPEHASH(),
            keccak256(
                "Capture(bytes32 paymentInfoHash,uint256 amount,uint16 feeBps,address feeReceiver,uint256 expectedCapturableAmount,uint256 expectedRefundableAmount)"
            )
        );
        assertEq(authorizerContract.VOID_TYPEHASH(), keccak256("Void(bytes32 paymentInfoHash)"));
    }

    function test_escrowImmutable() public view {
        assertEq(address(authorizerContract.ESCROW()), address(escrow));
    }

    function _domainSeparator() internal view returns (bytes32) {
        (, string memory name, string memory version, uint256 chainId, address verifyingContract,,) =
            authorizerContract.eip712Domain();
        return keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256(bytes(name)),
                keccak256(bytes(version)),
                chainId,
                verifyingContract
            )
        );
    }

    // =========================================================================
    // Fuzz
    // =========================================================================

    function testFuzz_saltBinding(
        address authorizer,
        uint256 randomSalt,
        uint256 wrongSalt
    ) public {
        vm.assume(authorizer != address(0));
        vm.assume(randomSalt != wrongSalt);

        IAuthCaptureEscrow.PaymentInfo memory paymentInfo = _paymentInfoFor(authorizer, randomSalt);
        assertEq(paymentInfo.salt, authorizerContract.getSalt(authorizer, address(0), randomSalt));

        vm.expectRevert(x402AuthCaptureOperator.SaltMismatch.selector);
        authorizerContract.void(paymentInfo, authorizer, address(0), wrongSalt, "");
    }

    function testFuzz_staleExpectedBalancesRevert(
        uint256 captureAmount
    ) public {
        captureAmount = bound(captureAmount, 1e6, AUTH_AMOUNT - 1e6);
        IAuthCaptureEscrow.PaymentInfo memory paymentInfo = _paymentInfo();
        _authorizeHappy(paymentInfo);

        bytes memory signature = _sign(
            authorizerWallet,
            authorizerContract.getCaptureDigest(
                _hash(paymentInfo), captureAmount, FEE_BPS, feeReceiver, x402AuthCaptureOperator.ExpectedBalances({capturableAmount: AUTH_AMOUNT, refundableAmount: 0})
            )
        );
        _capture(paymentInfo, captureAmount, authorizerWallet);

        vm.expectRevert(
            abi.encodeWithSelector(
                x402AuthCaptureOperator.UnexpectedPaymentState.selector, AUTH_AMOUNT - captureAmount, captureAmount
            )
        );
        authorizerContract.capture(
            paymentInfo,
            captureAmount,
            FEE_BPS,
            feeReceiver,
            authorizerWallet.addr,
            address(0),
            RANDOM_SALT,
            x402AuthCaptureOperator.ExpectedBalances({capturableAmount: AUTH_AMOUNT, refundableAmount: 0}),
            signature
        );
    }
}
