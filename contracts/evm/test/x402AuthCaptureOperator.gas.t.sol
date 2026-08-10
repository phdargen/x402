// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title x402AuthCaptureOperator gas benchmarks
/// @notice Compare auth+capture (commerce escrow) vs a single EIP-3009 exact transfer.
///
/// **Local (mock escrow + mock USDC):**
/// `forge test --match-contract X402CaptureAuthorizerGasTest -vv`
///
/// **Production-adjacent (real USDC + AuthCaptureEscrow on Base Sepolia):**
/// `forge test --match-contract X402CaptureAuthorizerGasTest --match-test test_gas_fork --fork-url https://sepolia.base.org -vv`
///
/// **Interpretation:**
/// - `exact_eip3009_transferWithAuthorization` mirrors `scheme_exact_evm.md` settlement (one facilitator tx).
/// - `capture_authorize_first` includes token-store clone deployment on the first payment for an operator.
/// - `capture_authorize_subsequent` reuses an existing token store (cheaper authorize).
/// - Full auth+capture = authorize + capture (two facilitator txs; partial capture modeled here).

import {Test} from "forge-std/Test.sol";
import {console2} from "forge-std/console2.sol";
import {VmSafe} from "forge-std/Vm.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {IAuthCaptureEscrow} from "../src/interfaces/IAuthCaptureEscrow.sol";
import {x402AuthCaptureOperator} from "../src/x402AuthCaptureOperator.sol";
import {MockAuthCaptureEscrow, MockPaymentCollector} from "./mocks/MockAuthCaptureEscrow.sol";
import {MockERC3009Token} from "./mocks/MockERC3009Token.sol";

interface IEIP712Domain {
    function DOMAIN_SEPARATOR() external view returns (bytes32);
}

interface IUSDC3009 {
    function transferWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes memory signature
    ) external;
}

contract X402CaptureAuthorizerGasTest is Test {
    // --- Fork constants (Base mainnet + Base Sepolia) ---
    address constant FORK_ESCROW = 0xBdEA0D1bcC5966192B070Fdf62aB4EF5b4420cff;
    address constant FORK_ERC3009_COLLECTOR = 0x0E3dF9510de65469C4518D7843919c0b8C7A7757;
    address constant FORK_USDC = 0x036CbD53842c5426634e7929541eC2318f3dCF7e;

    bytes32 constant TRANSFER_WITH_AUTHORIZATION_TYPEHASH = keccak256(
        "TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );
    bytes32 constant RECEIVE_WITH_AUTHORIZATION_TYPEHASH = keccak256(
        "ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );

    uint256 constant TRANSFER_AMOUNT = 4e6;
    uint256 constant AUTH_AMOUNT = 6e6;
    uint120 constant MAX_AMOUNT = 10e6;
    uint16 constant FEE_BPS = 250;
    uint256 constant RANDOM_SALT = 0xBEEF;

    // --- Local harness ---
    x402AuthCaptureOperator public authorizer;
    MockAuthCaptureEscrow public escrow;
    MockPaymentCollector public collector;
    MockERC3009Token public token;

    VmSafe.Wallet public payerWallet;
    VmSafe.Wallet public authorizerWallet;
    address public receiver = makeAddr("gas-receiver");
    address public feeReceiver = makeAddr("gas-feeReceiver");
    address public facilitator = makeAddr("gas-facilitator");

    // --- Fork harness (lazy init) ---
    x402AuthCaptureOperator public forkAuthorizer;
    IAuthCaptureEscrow public forkEscrow;
    VmSafe.Wallet public forkPayerWallet;
    VmSafe.Wallet public forkAuthorizerWallet;

    function setUp() public {
        vm.warp(1_000_000);

        payerWallet = vm.createWallet("gas_payer");
        authorizerWallet = vm.createWallet("gas_authorizer");

        escrow = new MockAuthCaptureEscrow();
        authorizer = new x402AuthCaptureOperator(address(escrow));
        collector = new MockPaymentCollector();
        token = new MockERC3009Token("USDC", "USDC", 6);
        token.mint(payerWallet.addr, 1000e6);
    }

    modifier onlyFork() {
        if (block.chainid == 31_337) return;
        _;
    }

    // =========================================================================
    // Local gas snapshots (mock token — ERC-3009 crypto omitted; use fork for USDC)
    // =========================================================================

    function test_gas_exact_eip3009_transferWithAuthorization_mock() public {
        vm.prank(facilitator);
        token.receiveWithAuthorization(
            payerWallet.addr, receiver, TRANSFER_AMOUNT, 0, block.timestamp + 1 hours, bytes32(uint256(1)), ""
        );
        uint256 g = vm.snapshotGasLastCall("mock_exact_eip3009_transfer");
        console2.log("mock_exact_eip3009_transfer", g);
    }

    function test_gas_capture_authorize_first_mock() public {
        _authorizeMock(_mockPaymentInfo(RANDOM_SALT), RANDOM_SALT);
        uint256 g = vm.snapshotGasLastCall("mock_capture_authorize_first");
        console2.log("mock_capture_authorize_first", g);
    }

    function test_gas_capture_authorize_subsequent_mock() public {
        _authorizeMock(_mockPaymentInfo(RANDOM_SALT), RANDOM_SALT);
        _authorizeMock(_mockPaymentInfo(RANDOM_SALT + 1), RANDOM_SALT + 1);
        uint256 g = vm.snapshotGasLastCall("mock_capture_authorize_subsequent");
        console2.log("mock_capture_authorize_subsequent", g);
    }

    function test_gas_capture_capture_mock() public {
        IAuthCaptureEscrow.PaymentInfo memory paymentInfo = _mockPaymentInfo(RANDOM_SALT);
        _authorizeMock(paymentInfo, RANDOM_SALT);
        _captureMock(paymentInfo, TRANSFER_AMOUNT, RANDOM_SALT);
        uint256 g = vm.snapshotGasLastCall("mock_capture_capture");
        console2.log("mock_capture_capture", g);
    }

    function test_gas_capture_capture_plain_operator_mock() public {
        IAuthCaptureEscrow.PaymentInfo memory paymentInfo = _mockPlainPaymentInfo(RANDOM_SALT);
        _authorizePlainMock(paymentInfo);
        vm.prank(facilitator);
        escrow.capture(paymentInfo, TRANSFER_AMOUNT, FEE_BPS, feeReceiver);
        uint256 g = vm.snapshotGasLastCall("mock_capture_plain_operator");
        console2.log("mock_capture_plain_operator", g);
    }

    function test_gas_capture_capture_with_authorizer_mock() public {
        IAuthCaptureEscrow.PaymentInfo memory paymentInfo = _mockPaymentInfo(RANDOM_SALT);
        _authorizeMock(paymentInfo, RANDOM_SALT);
        _captureMock(paymentInfo, TRANSFER_AMOUNT, RANDOM_SALT);
        uint256 g = vm.snapshotGasLastCall("mock_capture_with_authorizer");
        console2.log("mock_capture_with_authorizer", g);
    }

    function test_gas_authorize_plain_operator_mock() public {
        _authorizePlainMock(_mockPlainPaymentInfo(RANDOM_SALT));
        uint256 g = vm.snapshotGasLastCall("mock_authorize_plain_operator");
        console2.log("mock_authorize_plain_operator", g);
    }

    function test_gas_authorize_with_authorizer_mock() public {
        _authorizeMock(_mockPaymentInfo(RANDOM_SALT), RANDOM_SALT);
        uint256 g = vm.snapshotGasLastCall("mock_authorize_with_authorizer");
        console2.log("mock_authorize_with_authorizer", g);
    }

    function test_gas_capture_auth_plus_capture_mock() public {
        IAuthCaptureEscrow.PaymentInfo memory paymentInfo = _mockPaymentInfo(RANDOM_SALT);
        _authorizeMock(paymentInfo, RANDOM_SALT);
        uint256 authGas = vm.snapshotGasLastCall("mock_capture_authorize_first");
        _captureMock(paymentInfo, TRANSFER_AMOUNT, RANDOM_SALT);
        uint256 captureGas = vm.snapshotGasLastCall("mock_capture_capture");
        console2.log("mock_capture_auth_plus_capture_total", authGas + captureGas);
    }

    // =========================================================================
    // Fork gas snapshots (real USDC + live AuthCaptureEscrow on Base Sepolia)
    // =========================================================================

    function test_gas_fork_exact_eip3009_transferWithAuthorization() public onlyFork {
        _forkInit();
        bytes32 nonce = keccak256("fork-exact-nonce");
        bytes memory sig = _signUsdcTransferWithAuthorization(forkPayerWallet, receiver, TRANSFER_AMOUNT, nonce);

        vm.prank(facilitator);
        IUSDC3009(FORK_USDC).transferWithAuthorization(
            forkPayerWallet.addr, receiver, TRANSFER_AMOUNT, 0, block.timestamp + 1 hours, nonce, sig
        );
        uint256 g = vm.snapshotGasLastCall("fork_exact_eip3009_transferWithAuthorization");
        console2.log("fork_exact_eip3009_transferWithAuthorization", g);
    }

    function test_gas_fork_capture_authorize_first() public onlyFork {
        _forkInit();
        _forkAuthorize(_forkPaymentInfo(RANDOM_SALT), RANDOM_SALT);
        uint256 g = vm.snapshotGasLastCall("fork_capture_authorize_first");
        console2.log("fork_capture_authorize_first", g);
    }

    function test_gas_fork_capture_authorize_subsequent() public onlyFork {
        _forkInit();
        _forkAuthorize(_forkPaymentInfo(RANDOM_SALT), RANDOM_SALT);
        _forkAuthorize(_forkPaymentInfo(RANDOM_SALT + 1), RANDOM_SALT + 1);
        uint256 g = vm.snapshotGasLastCall("fork_capture_authorize_subsequent");
        console2.log("fork_capture_authorize_subsequent", g);
    }

    function test_gas_fork_capture_capture() public onlyFork {
        _forkInit();
        IAuthCaptureEscrow.PaymentInfo memory paymentInfo = _forkPaymentInfo(RANDOM_SALT);
        _forkAuthorize(paymentInfo, RANDOM_SALT);
        _forkCapture(paymentInfo, TRANSFER_AMOUNT, RANDOM_SALT);
        uint256 g = vm.snapshotGasLastCall("fork_capture_capture");
        console2.log("fork_capture_capture", g);
    }

    function test_gas_fork_capture_plain_operator() public onlyFork {
        _forkInit();
        IAuthCaptureEscrow.PaymentInfo memory paymentInfo = _forkPlainPaymentInfo(RANDOM_SALT);
        _forkAuthorizePlain(paymentInfo);
        vm.prank(facilitator);
        forkEscrow.capture(paymentInfo, TRANSFER_AMOUNT, FEE_BPS, feeReceiver);
        uint256 g = vm.snapshotGasLastCall("fork_capture_plain_operator");
        console2.log("fork_capture_plain_operator", g);
    }

    function test_gas_fork_capture_with_authorizer() public onlyFork {
        _forkInit();
        IAuthCaptureEscrow.PaymentInfo memory paymentInfo = _forkPaymentInfo(RANDOM_SALT);
        _forkAuthorize(paymentInfo, RANDOM_SALT);
        _forkCapture(paymentInfo, TRANSFER_AMOUNT, RANDOM_SALT);
        uint256 g = vm.snapshotGasLastCall("fork_capture_with_authorizer");
        console2.log("fork_capture_with_authorizer", g);
    }

    function test_gas_fork_authorize_plain_operator() public onlyFork {
        _forkInit();
        _forkAuthorizePlain(_forkPlainPaymentInfo(RANDOM_SALT));
        uint256 g = vm.snapshotGasLastCall("fork_authorize_plain_operator");
        console2.log("fork_authorize_plain_operator", g);
    }

    function test_gas_fork_authorize_with_authorizer() public onlyFork {
        _forkInit();
        _forkAuthorize(_forkPaymentInfo(RANDOM_SALT), RANDOM_SALT);
        uint256 g = vm.snapshotGasLastCall("fork_authorize_with_authorizer");
        console2.log("fork_authorize_with_authorizer", g);
    }

    function test_gas_fork_capture_auth_plus_capture() public onlyFork {
        _forkInit();
        IAuthCaptureEscrow.PaymentInfo memory paymentInfo = _forkPaymentInfo(RANDOM_SALT);
        _forkAuthorize(paymentInfo, RANDOM_SALT);
        uint256 authGas = vm.snapshotGasLastCall("fork_capture_authorize_first");
        _forkCapture(paymentInfo, TRANSFER_AMOUNT, RANDOM_SALT);
        uint256 captureGas = vm.snapshotGasLastCall("fork_capture_capture");
        console2.log("fork_capture_auth_plus_capture_total", authGas + captureGas);
    }

    // =========================================================================
    // Helpers — local
    // =========================================================================

    function _mockPlainPaymentInfo(
        uint256 salt
    ) internal view returns (IAuthCaptureEscrow.PaymentInfo memory) {
        return IAuthCaptureEscrow.PaymentInfo({
            operator: facilitator,
            payer: payerWallet.addr,
            receiver: receiver,
            token: address(token),
            maxAmount: MAX_AMOUNT,
            preApprovalExpiry: uint48(block.timestamp + 1 hours),
            authorizationExpiry: uint48(block.timestamp + 2 hours),
            refundExpiry: uint48(block.timestamp + 3 hours),
            minFeeBps: 0,
            maxFeeBps: 1000,
            feeReceiver: feeReceiver,
            salt: salt
        });
    }

    function _authorizePlainMock(IAuthCaptureEscrow.PaymentInfo memory paymentInfo) internal {
        vm.prank(facilitator);
        escrow.authorize(paymentInfo, AUTH_AMOUNT, address(collector), "");
    }

    function _mockPaymentInfo(
        uint256 randomSalt
    ) internal view returns (IAuthCaptureEscrow.PaymentInfo memory) {
        return IAuthCaptureEscrow.PaymentInfo({
            operator: address(authorizer),
            payer: payerWallet.addr,
            receiver: receiver,
            token: address(token),
            maxAmount: MAX_AMOUNT,
            preApprovalExpiry: uint48(block.timestamp + 1 hours),
            authorizationExpiry: uint48(block.timestamp + 2 hours),
            refundExpiry: uint48(block.timestamp + 3 hours),
            minFeeBps: 0,
            maxFeeBps: 1000,
            feeReceiver: feeReceiver,
            salt: authorizer.getSalt(authorizerWallet.addr, address(0), randomSalt)
        });
    }

    function _authorizeMock(IAuthCaptureEscrow.PaymentInfo memory paymentInfo, uint256 randomSalt) internal {
        bytes memory authorizerSignature = _signDigest(
            authorizerWallet,
            authorizer.getAuthorizeDigest(
                escrow.getHash(paymentInfo), AUTH_AMOUNT, address(collector), keccak256("")
            )
        );

        vm.prank(facilitator);
        authorizer.authorize(
            paymentInfo, AUTH_AMOUNT, address(collector), "", authorizerWallet.addr, address(0), randomSalt, authorizerSignature
        );
    }

    function _captureMock(
        IAuthCaptureEscrow.PaymentInfo memory paymentInfo,
        uint256 amount,
        uint256 randomSalt
    ) internal {
        (, uint120 capturable, uint120 refundable) = escrow.paymentState(escrow.getHash(paymentInfo));
        x402AuthCaptureOperator.ExpectedBalances memory expected = x402AuthCaptureOperator.ExpectedBalances({
            capturableAmount: capturable, refundableAmount: refundable
        });
        bytes memory authorizerSignature = _signDigest(
            authorizerWallet,
            authorizer.getCaptureDigest(escrow.getHash(paymentInfo), amount, FEE_BPS, feeReceiver, expected)
        );

        vm.prank(facilitator);
        authorizer.capture(
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

    function _signDigest(VmSafe.Wallet memory wallet, bytes32 digest) internal returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(wallet, digest);
        return abi.encodePacked(r, s, v);
    }

    // =========================================================================
    // Helpers — fork
    // =========================================================================

    function _forkInit() internal {
        if (address(forkAuthorizer) != address(0)) return;

        require(FORK_ESCROW.code.length > 0, "AuthCaptureEscrow not deployed");
        require(FORK_ERC3009_COLLECTOR.code.length > 0, "ERC3009PaymentCollector not deployed");
        require(FORK_USDC.code.length > 0, "USDC not deployed");

        forkEscrow = IAuthCaptureEscrow(FORK_ESCROW);
        forkAuthorizer = new x402AuthCaptureOperator(FORK_ESCROW);
        forkPayerWallet = vm.createWallet("fork-gas-payer");
        forkAuthorizerWallet = vm.createWallet("fork-gas-authorizer");
        deal(FORK_USDC, forkPayerWallet.addr, 1000e6);
    }

    function _forkPlainPaymentInfo(
        uint256 salt
    ) internal view returns (IAuthCaptureEscrow.PaymentInfo memory) {
        return IAuthCaptureEscrow.PaymentInfo({
            operator: facilitator,
            payer: forkPayerWallet.addr,
            receiver: receiver,
            token: FORK_USDC,
            maxAmount: MAX_AMOUNT,
            preApprovalExpiry: uint48(block.timestamp + 1 hours),
            authorizationExpiry: uint48(block.timestamp + 2 hours),
            refundExpiry: uint48(block.timestamp + 3 hours),
            minFeeBps: 0,
            maxFeeBps: 1000,
            feeReceiver: feeReceiver,
            salt: salt
        });
    }

    function _forkAuthorizePlain(IAuthCaptureEscrow.PaymentInfo memory paymentInfo) internal {
        bytes memory collectorData = _signUsdcReceiveWithAuthorizationPlain(paymentInfo);
        vm.prank(facilitator);
        forkEscrow.authorize(paymentInfo, AUTH_AMOUNT, FORK_ERC3009_COLLECTOR, collectorData);
    }

    function _signUsdcReceiveWithAuthorizationPlain(
        IAuthCaptureEscrow.PaymentInfo memory paymentInfo
    ) internal returns (bytes memory) {
        bytes32 structHash = keccak256(
            abi.encode(
                RECEIVE_WITH_AUTHORIZATION_TYPEHASH,
                paymentInfo.payer,
                FORK_ERC3009_COLLECTOR,
                uint256(paymentInfo.maxAmount),
                uint256(0),
                uint256(paymentInfo.preApprovalExpiry),
                _payerAgnosticHashForkPlain(paymentInfo)
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", IEIP712Domain(FORK_USDC).DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(forkPayerWallet, digest);
        return abi.encodePacked(r, s, v);
    }

    function _payerAgnosticHashForkPlain(
        IAuthCaptureEscrow.PaymentInfo memory paymentInfo
    ) internal view returns (bytes32) {
        address payer = paymentInfo.payer;
        paymentInfo.payer = address(0);
        bytes32 hashPayerAgnostic = forkEscrow.getHash(paymentInfo);
        paymentInfo.payer = payer;
        return hashPayerAgnostic;
    }

    function _forkPaymentInfo(
        uint256 randomSalt
    ) internal view returns (IAuthCaptureEscrow.PaymentInfo memory) {
        return IAuthCaptureEscrow.PaymentInfo({
            operator: address(forkAuthorizer),
            payer: forkPayerWallet.addr,
            receiver: receiver,
            token: FORK_USDC,
            maxAmount: MAX_AMOUNT,
            preApprovalExpiry: uint48(block.timestamp + 1 hours),
            authorizationExpiry: uint48(block.timestamp + 2 hours),
            refundExpiry: uint48(block.timestamp + 3 hours),
            minFeeBps: 0,
            maxFeeBps: 1000,
            feeReceiver: feeReceiver,
            salt: forkAuthorizer.getSalt(forkAuthorizerWallet.addr, address(0), randomSalt)
        });
    }

    function _signUsdcTransferWithAuthorization(
        VmSafe.Wallet memory payer,
        address to,
        uint256 value,
        bytes32 nonce
    ) internal returns (bytes memory) {
        bytes32 structHash = keccak256(
            abi.encode(
                TRANSFER_WITH_AUTHORIZATION_TYPEHASH, payer.addr, to, value, uint256(0), block.timestamp + 1 hours, nonce
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", IEIP712Domain(FORK_USDC).DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(payer, digest);
        return abi.encodePacked(r, s, v);
    }

    function _forkAuthorize(IAuthCaptureEscrow.PaymentInfo memory paymentInfo, uint256 randomSalt) internal {
        bytes memory collectorData = _signUsdcReceiveWithAuthorization(paymentInfo);
        bytes memory authorizerSignature = _signDigest(
            forkAuthorizerWallet,
            forkAuthorizer.getAuthorizeDigest(
                forkEscrow.getHash(paymentInfo), AUTH_AMOUNT, FORK_ERC3009_COLLECTOR, keccak256(collectorData)
            )
        );

        vm.prank(facilitator);
        forkAuthorizer.authorize(
            paymentInfo,
            AUTH_AMOUNT,
            FORK_ERC3009_COLLECTOR,
            collectorData,
            forkAuthorizerWallet.addr, address(0), randomSalt,
            authorizerSignature
        );
    }

    function _forkCapture(
        IAuthCaptureEscrow.PaymentInfo memory paymentInfo,
        uint256 amount,
        uint256 randomSalt
    ) internal {
        (, uint120 capturable, uint120 refundable) = forkEscrow.paymentState(forkEscrow.getHash(paymentInfo));
        x402AuthCaptureOperator.ExpectedBalances memory expected = x402AuthCaptureOperator.ExpectedBalances({
            capturableAmount: capturable, refundableAmount: refundable
        });
        bytes memory authorizerSignature = _signDigest(
            forkAuthorizerWallet,
            forkAuthorizer.getCaptureDigest(forkEscrow.getHash(paymentInfo), amount, FEE_BPS, feeReceiver, expected)
        );

        vm.prank(facilitator);
        forkAuthorizer.capture(
            paymentInfo,
            amount,
            FEE_BPS,
            feeReceiver,
            forkAuthorizerWallet.addr,
            address(0),
            randomSalt,
            expected,
            authorizerSignature
        );
    }

    function _signUsdcReceiveWithAuthorization(
        IAuthCaptureEscrow.PaymentInfo memory paymentInfo
    ) internal returns (bytes memory) {
        bytes32 structHash = keccak256(
            abi.encode(
                RECEIVE_WITH_AUTHORIZATION_TYPEHASH,
                paymentInfo.payer,
                FORK_ERC3009_COLLECTOR,
                uint256(paymentInfo.maxAmount),
                uint256(0),
                uint256(paymentInfo.preApprovalExpiry),
                _payerAgnosticHashFork(paymentInfo)
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", IEIP712Domain(FORK_USDC).DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(forkPayerWallet, digest);
        return abi.encodePacked(r, s, v);
    }

    function _payerAgnosticHashFork(
        IAuthCaptureEscrow.PaymentInfo memory paymentInfo
    ) internal view returns (bytes32) {
        address payer = paymentInfo.payer;
        paymentInfo.payer = address(0);
        bytes32 hashPayerAgnostic = forkEscrow.getHash(paymentInfo);
        paymentInfo.payer = payer;
        return hashPayerAgnostic;
    }
}
