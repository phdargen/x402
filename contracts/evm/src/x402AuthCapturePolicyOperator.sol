// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ERC165Checker} from "@openzeppelin/contracts/utils/introspection/ERC165Checker.sol";
import {Multicall} from "@openzeppelin/contracts/utils/Multicall.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";

import {IAuthCaptureEscrow} from "./interfaces/IAuthCaptureEscrow.sol";
import {ICaptureAuthorizer} from "./interfaces/ICaptureAuthorizer.sol";
import {ICaptureLifecycle} from "./interfaces/ICaptureLifecycle.sol";

/// @notice Escrow operator gated by an EIP-712 authorizer signature and an onchain {ICaptureAuthorizer} policy.
contract x402AuthCapturePolicyOperator is
    EIP712,
    Multicall,
    ReentrancyGuardTransient
{
    /// @notice Escrow balances the authorizer expects `paymentState` to hold when the call executes.
    struct ExpectedBalances {
        uint256 capturableAmount;
        uint256 refundableAmount;
    }

    IAuthCaptureEscrow public immutable ESCROW;

    bytes32 public constant AUTHORIZE_TYPEHASH =
        keccak256(
            "Authorize(bytes32 paymentInfoHash,uint256 amount,address tokenCollector,bytes32 collectorDataHash)"
        );

    bytes32 public constant CHARGE_TYPEHASH =
        keccak256(
            "Charge(bytes32 paymentInfoHash,uint256 amount,address tokenCollector,bytes32 collectorDataHash,uint16 feeBps,address feeReceiver)"
        );

    bytes32 public constant CAPTURE_TYPEHASH =
        keccak256(
            "Capture(bytes32 paymentInfoHash,uint256 amount,uint16 feeBps,address feeReceiver,uint256 expectedCapturableAmount,uint256 expectedRefundableAmount)"
        );

    bytes32 public constant VOID_TYPEHASH =
        keccak256("Void(bytes32 paymentInfoHash)");

    error WrongOperator();
    error SaltMismatch();
    error InvalidSignature();
    error UnexpectedPaymentState(
        uint120 capturableAmount,
        uint120 refundableAmount
    );
    error ZeroAuthorizer();
    error InvalidPolicy();
    error AuthorizationDenied();

    constructor(address escrow) EIP712("x402 Auth Capture Operator", "1") {
        ESCROW = IAuthCaptureEscrow(escrow);
    }

    function authorize(
        IAuthCaptureEscrow.PaymentInfo calldata paymentInfo,
        uint256 amount,
        address tokenCollector,
        bytes calldata collectorData,
        address authorizer,
        address policy,
        uint256 randomSalt,
        bytes calldata authorizerSignature
    ) external nonReentrant {
        bytes32 paymentInfoHash = _checkBinding(
            paymentInfo,
            authorizer,
            policy,
            randomSalt
        );
        _checkSignature(
            authorizer,
            getAuthorizeDigest(
                paymentInfoHash,
                amount,
                tokenCollector,
                keccak256(collectorData)
            ),
            authorizerSignature
        );
        if (
            !ICaptureAuthorizer(policy).authorizeAuthorization(
                paymentInfo,
                amount,
                tokenCollector,
                collectorData,
                ""
            )
        ) {
            revert AuthorizationDenied();
        }

        ESCROW.authorize(paymentInfo, amount, tokenCollector, collectorData);

        if (
            ERC165Checker.supportsInterface(
                policy,
                type(ICaptureLifecycle).interfaceId
            )
        ) {
            ICaptureLifecycle(policy).onAuthorize(paymentInfo);
        }
    }

    function charge(
        IAuthCaptureEscrow.PaymentInfo calldata paymentInfo,
        uint256 amount,
        address tokenCollector,
        bytes calldata collectorData,
        uint16 feeBps,
        address feeReceiver,
        address authorizer,
        address policy,
        uint256 randomSalt,
        bytes calldata authorizerSignature
    ) external nonReentrant {
        bytes32 paymentInfoHash = _checkBinding(
            paymentInfo,
            authorizer,
            policy,
            randomSalt
        );
        _checkSignature(
            authorizer,
            getChargeDigest(
                paymentInfoHash,
                amount,
                tokenCollector,
                keccak256(collectorData),
                feeBps,
                feeReceiver
            ),
            authorizerSignature
        );
        if (
            !ICaptureAuthorizer(policy).authorizeCharge(
                paymentInfo,
                amount,
                tokenCollector,
                collectorData,
                feeBps,
                feeReceiver,
                ""
            )
        ) {
            revert AuthorizationDenied();
        }

        ESCROW.charge(
            paymentInfo,
            amount,
            tokenCollector,
            collectorData,
            feeBps,
            feeReceiver
        );
    }

    function capture(
        IAuthCaptureEscrow.PaymentInfo calldata paymentInfo,
        uint256 amount,
        uint16 feeBps,
        address feeReceiver,
        address authorizer,
        address policy,
        uint256 randomSalt,
        ExpectedBalances calldata expected,
        bytes calldata authorizerSignature
    ) external nonReentrant {
        bytes32 paymentInfoHash = _checkBinding(
            paymentInfo,
            authorizer,
            policy,
            randomSalt
        );
        _checkSignature(
            authorizer,
            getCaptureDigest(
                paymentInfoHash,
                amount,
                feeBps,
                feeReceiver,
                expected
            ),
            authorizerSignature
        );
        if (
            !ICaptureAuthorizer(policy).authorizeCapture(
                paymentInfo,
                amount,
                feeBps,
                feeReceiver,
                ""
            )
        ) {
            revert AuthorizationDenied();
        }
        _checkExpectedBalances(paymentInfoHash, expected);

        ESCROW.capture(paymentInfo, amount, feeBps, feeReceiver);
    }

    function void(
        IAuthCaptureEscrow.PaymentInfo calldata paymentInfo,
        address authorizer,
        address policy,
        uint256 randomSalt,
        bytes calldata authorizerSignature
    ) external nonReentrant {
        bytes32 paymentInfoHash = _checkBinding(
            paymentInfo,
            authorizer,
            policy,
            randomSalt
        );
        _checkSignature(
            authorizer,
            getVoidDigest(paymentInfoHash),
            authorizerSignature
        );
        if (!ICaptureAuthorizer(policy).authorizeVoid(paymentInfo, ""))
            revert AuthorizationDenied();

        ESCROW.void(paymentInfo);
    }

    function getAuthorizeDigest(
        bytes32 paymentInfoHash,
        uint256 amount,
        address tokenCollector,
        bytes32 collectorDataHash
    ) public view returns (bytes32) {
        return
            _hashTypedDataV4(
                keccak256(
                    abi.encode(
                        AUTHORIZE_TYPEHASH,
                        paymentInfoHash,
                        amount,
                        tokenCollector,
                        collectorDataHash
                    )
                )
            );
    }

    function getChargeDigest(
        bytes32 paymentInfoHash,
        uint256 amount,
        address tokenCollector,
        bytes32 collectorDataHash,
        uint16 feeBps,
        address feeReceiver
    ) public view returns (bytes32) {
        return
            _hashTypedDataV4(
                keccak256(
                    abi.encode(
                        CHARGE_TYPEHASH,
                        paymentInfoHash,
                        amount,
                        tokenCollector,
                        collectorDataHash,
                        feeBps,
                        feeReceiver
                    )
                )
            );
    }

    function getCaptureDigest(
        bytes32 paymentInfoHash,
        uint256 amount,
        uint16 feeBps,
        address feeReceiver,
        ExpectedBalances calldata expected
    ) public view returns (bytes32) {
        return
            _hashTypedDataV4(
                keccak256(
                    abi.encode(
                        CAPTURE_TYPEHASH,
                        paymentInfoHash,
                        amount,
                        feeBps,
                        feeReceiver,
                        expected.capturableAmount,
                        expected.refundableAmount
                    )
                )
            );
    }

    function getVoidDigest(
        bytes32 paymentInfoHash
    ) public view returns (bytes32) {
        return
            _hashTypedDataV4(
                keccak256(abi.encode(VOID_TYPEHASH, paymentInfoHash))
            );
    }

    function getSalt(
        address authorizer,
        address policy,
        uint256 randomSalt
    ) public pure returns (uint256) {
        return uint256(keccak256(abi.encode(authorizer, policy, randomSalt)));
    }

    function _checkBinding(
        IAuthCaptureEscrow.PaymentInfo calldata paymentInfo,
        address authorizer,
        address policy,
        uint256 randomSalt
    ) internal view returns (bytes32) {
        if (paymentInfo.operator != address(this)) revert WrongOperator();
        if (authorizer == address(0)) revert ZeroAuthorizer();
        if (
            policy == address(0) ||
            !ERC165Checker.supportsInterface(
                policy,
                type(ICaptureAuthorizer).interfaceId
            )
        ) {
            revert InvalidPolicy();
        }
        if (paymentInfo.salt != getSalt(authorizer, policy, randomSalt))
            revert SaltMismatch();
        return ESCROW.getHash(paymentInfo);
    }

    function _checkSignature(
        address authorizer,
        bytes32 digest,
        bytes calldata signature
    ) internal view {
        if (
            !SignatureChecker.isValidSignatureNow(authorizer, digest, signature)
        ) revert InvalidSignature();
    }

    function _checkExpectedBalances(
        bytes32 paymentInfoHash,
        ExpectedBalances calldata expected
    ) internal view {
        (, uint120 capturableAmount, uint120 refundableAmount) = ESCROW
            .paymentState(paymentInfoHash);
        if (
            capturableAmount != expected.capturableAmount ||
            refundableAmount != expected.refundableAmount
        ) {
            revert UnexpectedPaymentState(capturableAmount, refundableAmount);
        }
    }
}
