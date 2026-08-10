// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {VmSafe} from "forge-std/Vm.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {IAuthCaptureEscrow} from "../src/interfaces/IAuthCaptureEscrow.sol";
import {x402AuthCaptureOperator} from "../src/x402AuthCaptureOperator.sol";

interface IEIP712Domain {
    function DOMAIN_SEPARATOR() external view returns (bytes32);
}

/// @title X402CaptureAuthorizerForkTest
/// @notice Full lifecycle against the live `AuthCaptureEscrow` and token collectors on Base Sepolia, which are the
///         only way to exercise the lazily-deployed token store clone and real ERC-3009 collection.
/// @dev Run with: `forge test --match-contract X402CaptureAuthorizerForkTest --fork-url https://sepolia.base.org`
contract X402CaptureAuthorizerForkTest is Test {
    /// @dev Identical on Base mainnet and Base Sepolia.
    ///      See https://github.com/base/commerce-payments#deployment-addresses.
    address constant ESCROW = 0xBdEA0D1bcC5966192B070Fdf62aB4EF5b4420cff;
    address constant ERC3009_PAYMENT_COLLECTOR = 0x0E3dF9510de65469C4518D7843919c0b8C7A7757;
    address constant USDC = 0x036CbD53842c5426634e7929541eC2318f3dCF7e;

    bytes32 constant RECEIVE_WITH_AUTHORIZATION_TYPEHASH = keccak256(
        "ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );

    x402AuthCaptureOperator public authorizerContract;
    IAuthCaptureEscrow public escrow;

    VmSafe.Wallet public payerWallet;
    VmSafe.Wallet public authorizerWallet;

    address public receiver = makeAddr("fork-receiver");
    address public feeReceiver = makeAddr("fork-feeReceiver");
    address public facilitator = makeAddr("fork-facilitator");

    uint120 constant MAX_AMOUNT = 10e6;
    uint256 constant AUTH_AMOUNT = 6e6;
    uint256 constant CAPTURE_AMOUNT = 4e6;
    uint16 constant FEE_BPS = 250;
    uint256 constant RANDOM_SALT = 0xBEEF;

    function setUp() public {
        if (block.chainid == 31_337) return;
        require(ESCROW.code.length > 0, "AuthCaptureEscrow not deployed on this fork");
        require(ERC3009_PAYMENT_COLLECTOR.code.length > 0, "ERC3009PaymentCollector not deployed on this fork");
        require(USDC.code.length > 0, "USDC not deployed on this fork");

        escrow = IAuthCaptureEscrow(ESCROW);
        authorizerContract = new x402AuthCaptureOperator(ESCROW);

        payerWallet = vm.createWallet("fork-payer");
        authorizerWallet = vm.createWallet("fork-authorizer");

        deal(USDC, payerWallet.addr, 1000e6);
    }

    modifier onlyFork() {
        if (block.chainid == 31_337) return;
        _;
    }

    // =========================================================================
    // Helpers
    // =========================================================================

    function _paymentInfo() internal view returns (IAuthCaptureEscrow.PaymentInfo memory) {
        return _paymentInfoWithSalt(RANDOM_SALT);
    }

    function _paymentInfoWithSalt(
        uint256 randomSalt
    ) internal view returns (IAuthCaptureEscrow.PaymentInfo memory) {
        return IAuthCaptureEscrow.PaymentInfo({
            operator: address(authorizerContract),
            payer: payerWallet.addr,
            receiver: receiver,
            token: USDC,
            maxAmount: MAX_AMOUNT,
            preApprovalExpiry: uint48(block.timestamp + 1 hours),
            authorizationExpiry: uint48(block.timestamp + 2 hours),
            refundExpiry: uint48(block.timestamp + 3 hours),
            minFeeBps: 0,
            maxFeeBps: 1000,
            feeReceiver: feeReceiver,
            salt: authorizerContract.getSalt(authorizerWallet.addr, address(0), randomSalt)
        });
    }

    /// @dev Mirrors `TokenCollector._getHashPayerAgnostic`: the ERC-3009 nonce zeroes the payer field.
    function _payerAgnosticHash(
        IAuthCaptureEscrow.PaymentInfo memory paymentInfo
    ) internal view returns (bytes32) {
        address payer = paymentInfo.payer;
        paymentInfo.payer = address(0);
        bytes32 hashPayerAgnostic = escrow.getHash(paymentInfo);
        paymentInfo.payer = payer;
        return hashPayerAgnostic;
    }

    /// @dev A real `ReceiveWithAuthorization` signature that live USDC verifies, bound to the collector as `to`.
    function _signErc3009(
        IAuthCaptureEscrow.PaymentInfo memory paymentInfo
    ) internal returns (bytes memory) {
        bytes32 structHash = keccak256(
            abi.encode(
                RECEIVE_WITH_AUTHORIZATION_TYPEHASH,
                paymentInfo.payer,
                ERC3009_PAYMENT_COLLECTOR,
                uint256(paymentInfo.maxAmount),
                uint256(0),
                uint256(paymentInfo.preApprovalExpiry),
                _payerAgnosticHash(paymentInfo)
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", IEIP712Domain(USDC).DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(payerWallet, digest);
        return abi.encodePacked(r, s, v);
    }

    function _sign(
        VmSafe.Wallet memory wallet,
        bytes32 digest
    ) internal returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(wallet, digest);
        return abi.encodePacked(r, s, v);
    }

    /// @dev Relays `authorize` as the facilitator would, with a fresh authorizer signature.
    function _authorize(
        IAuthCaptureEscrow.PaymentInfo memory paymentInfo,
        uint256 randomSalt
    ) internal {
        bytes memory collectorData = _signErc3009(paymentInfo);
        bytes memory authorizerSignature = _sign(
            authorizerWallet,
            authorizerContract.getAuthorizeDigest(
                escrow.getHash(paymentInfo), AUTH_AMOUNT, ERC3009_PAYMENT_COLLECTOR, keccak256(collectorData)
            )
        );

        vm.prank(facilitator);
        authorizerContract.authorize(
            paymentInfo,
            AUTH_AMOUNT,
            ERC3009_PAYMENT_COLLECTOR,
            collectorData,
            authorizerWallet.addr, address(0), randomSalt,
            authorizerSignature
        );
    }

    function _expected(
        IAuthCaptureEscrow.PaymentInfo memory paymentInfo
    ) internal view returns (x402AuthCaptureOperator.ExpectedBalances memory) {
        (, uint120 capturable, uint120 refundable) = escrow.paymentState(escrow.getHash(paymentInfo));
        return x402AuthCaptureOperator.ExpectedBalances({
            capturableAmount: capturable, refundableAmount: refundable
        });
    }

    function _capture(
        IAuthCaptureEscrow.PaymentInfo memory paymentInfo,
        uint256 amount,
        uint256 randomSalt
    ) internal {
        x402AuthCaptureOperator.ExpectedBalances memory expected = _expected(paymentInfo);
        bytes memory authorizerSignature = _sign(
            authorizerWallet,
            authorizerContract.getCaptureDigest(escrow.getHash(paymentInfo), amount, FEE_BPS, feeReceiver, expected)
        );

        vm.prank(facilitator);
        authorizerContract.capture(
            paymentInfo,
            amount,
            FEE_BPS,
            feeReceiver,
            authorizerWallet.addr,
            address(0),
            randomSalt,
            expected,
            authorizerSignature
        );
    }

    // =========================================================================
    // Lifecycle
    // =========================================================================

    function test_fork_authorizeThenCapture() public onlyFork {
        IAuthCaptureEscrow.PaymentInfo memory paymentInfo = _paymentInfo();
        bytes32 paymentInfoHash = escrow.getHash(paymentInfo);

        uint256 payerBefore = IERC20(USDC).balanceOf(payerWallet.addr);
        _authorize(paymentInfo, RANDOM_SALT);

        // The collector pulls the full maxAmount and returns the excess, so the payer is only out the auth amount.
        assertEq(IERC20(USDC).balanceOf(payerWallet.addr), payerBefore - AUTH_AMOUNT);
        assertEq(IERC20(USDC).balanceOf(escrow.getTokenStore(address(authorizerContract))), AUTH_AMOUNT);

        (bool collected, uint120 capturable, uint120 refundable) = escrow.paymentState(paymentInfoHash);
        assertTrue(collected);
        assertEq(capturable, AUTH_AMOUNT);
        assertEq(refundable, 0);

        _capture(paymentInfo, CAPTURE_AMOUNT, RANDOM_SALT);

        uint256 expectedFee = CAPTURE_AMOUNT * FEE_BPS / 10_000;
        assertEq(IERC20(USDC).balanceOf(feeReceiver), expectedFee);
        assertEq(IERC20(USDC).balanceOf(receiver), CAPTURE_AMOUNT - expectedFee);

        (, capturable, refundable) = escrow.paymentState(paymentInfoHash);
        assertEq(capturable, AUTH_AMOUNT - CAPTURE_AMOUNT);
        assertEq(refundable, CAPTURE_AMOUNT);

        // The operator has no refund entry point, so it never ends up holding tokens or an allowance.
        assertEq(IERC20(USDC).balanceOf(address(authorizerContract)), 0);
    }

    function test_fork_authorizeThenVoid() public onlyFork {
        IAuthCaptureEscrow.PaymentInfo memory paymentInfo = _paymentInfoWithSalt(RANDOM_SALT + 1);
        _authorize(paymentInfo, RANDOM_SALT + 1);

        uint256 payerBefore = IERC20(USDC).balanceOf(payerWallet.addr);
        bytes memory authorizerSignature =
            _sign(authorizerWallet, authorizerContract.getVoidDigest(escrow.getHash(paymentInfo)));

        vm.prank(facilitator);
        authorizerContract.void(paymentInfo, authorizerWallet.addr, address(0), RANDOM_SALT + 1, authorizerSignature);

        assertEq(IERC20(USDC).balanceOf(payerWallet.addr), payerBefore + AUTH_AMOUNT);

        (, uint120 capturable,) = escrow.paymentState(escrow.getHash(paymentInfo));
        assertEq(capturable, 0);
    }

    function test_fork_charge() public onlyFork {
        IAuthCaptureEscrow.PaymentInfo memory paymentInfo = _paymentInfoWithSalt(RANDOM_SALT + 2);
        bytes memory collectorData = _signErc3009(paymentInfo);

        bytes memory authorizerSignature = _sign(
            authorizerWallet,
            authorizerContract.getChargeDigest(
                escrow.getHash(paymentInfo),
                AUTH_AMOUNT,
                ERC3009_PAYMENT_COLLECTOR,
                keccak256(collectorData),
                FEE_BPS,
                feeReceiver
            )
        );

        vm.prank(facilitator);
        authorizerContract.charge(
            paymentInfo,
            AUTH_AMOUNT,
            ERC3009_PAYMENT_COLLECTOR,
            collectorData,
            FEE_BPS,
            feeReceiver,
            authorizerWallet.addr,
            address(0),
            RANDOM_SALT + 2,
            authorizerSignature
        );

        uint256 expectedFee = AUTH_AMOUNT * FEE_BPS / 10_000;
        assertEq(IERC20(USDC).balanceOf(feeReceiver), expectedFee);
        assertEq(IERC20(USDC).balanceOf(receiver), AUTH_AMOUNT - expectedFee);

        (bool collected,, uint120 refundable) = escrow.paymentState(escrow.getHash(paymentInfo));
        assertTrue(collected);
        assertEq(refundable, AUTH_AMOUNT);
    }

    // =========================================================================
    // Access Control
    // =========================================================================

    /// @dev With this contract as operator, the escrow's `onlySender(operator)` gate rejects everyone else.
    function test_fork_facilitatorCannotCallEscrowDirectly() public onlyFork {
        IAuthCaptureEscrow.PaymentInfo memory paymentInfo = _paymentInfoWithSalt(RANDOM_SALT + 3);
        _authorize(paymentInfo, RANDOM_SALT + 3);

        vm.prank(facilitator);
        vm.expectRevert();
        escrow.capture(paymentInfo, CAPTURE_AMOUNT, FEE_BPS, feeReceiver);

        vm.prank(facilitator);
        vm.expectRevert();
        escrow.void(paymentInfo);
    }

    function test_fork_facilitatorCannotCaptureWithoutSignature() public onlyFork {
        IAuthCaptureEscrow.PaymentInfo memory paymentInfo = _paymentInfoWithSalt(RANDOM_SALT + 4);
        _authorize(paymentInfo, RANDOM_SALT + 4);

        VmSafe.Wallet memory rogue = vm.createWallet("fork-rogue");
        x402AuthCaptureOperator.ExpectedBalances memory expected = _expected(paymentInfo);
        bytes memory rogueSignature = _sign(
            rogue,
            authorizerContract.getCaptureDigest(
                escrow.getHash(paymentInfo), CAPTURE_AMOUNT, FEE_BPS, feeReceiver, expected
            )
        );

        vm.prank(facilitator);
        vm.expectRevert(x402AuthCaptureOperator.InvalidSignature.selector);
        authorizerContract.capture(
            paymentInfo,
            CAPTURE_AMOUNT,
            FEE_BPS,
            feeReceiver,
            authorizerWallet.addr,
            address(0),
            RANDOM_SALT + 4,
            expected,
            rogueSignature
        );
    }

    // =========================================================================
    // Deployed ABI
    // =========================================================================

    /// @dev Reports an interface mismatch directly, rather than as an opaque revert inside a lifecycle test.
    function test_fork_deployedEscrowImplementsInterface() public view onlyFork {
        assertTrue(_codeContains(ESCROW, IAuthCaptureEscrow.authorize.selector), "missing authorize");
        assertTrue(_codeContains(ESCROW, IAuthCaptureEscrow.charge.selector), "missing charge");
        assertTrue(_codeContains(ESCROW, IAuthCaptureEscrow.capture.selector), "missing capture");
        assertTrue(_codeContains(ESCROW, IAuthCaptureEscrow.void.selector), "missing void");
        assertTrue(_codeContains(ESCROW, IAuthCaptureEscrow.refund.selector), "missing refund");
    }

    function _codeContains(
        address target,
        bytes4 selector
    ) internal view returns (bool) {
        bytes memory code = target.code;
        if (code.length < 4) return false;

        for (uint256 i = 0; i <= code.length - 4; ++i) {
            if (
                code[i] == selector[0] && code[i + 1] == selector[1] && code[i + 2] == selector[2]
                    && code[i + 3] == selector[3]
            ) {
                return true;
            }
        }
        return false;
    }
}
