// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Multicall} from "@openzeppelin/contracts/utils/Multicall.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";

import {CompressedSparseMerkleProof} from "./libraries/CompressedSparseMerkleProof.sol";
import {x402BatchSettlement} from "./x402BatchSettlement.sol";

/// @title x402BatchSettlementGateway
/// @notice Channel `receiver` and `receiverAuthorizer` contract for the `voucher-gateway` extension of the
///         x402 `batch-settlement` scheme. One deployment per facilitator. A payer funds a single
///         {x402BatchSettlement} channel whose `receiver` and `receiverAuthorizer` are this gateway, and that one
///         deposit pays many receivers sitting behind the gateway.
///
/// @dev Two nested unidirectional channels:
///      - Channel 1 (base {x402BatchSettlement}): payer → gateway. Uses base `Voucher` / `signature`.
///      - Channel 2 (this contract): gateway → receiver. Uses `GatewayConfig` / `GatewayVoucher` /
///        `GatewayVoucherClaim`, with `payerAuthorizer` inherited from channel 1.
///
/// @author x402 Protocol
contract x402BatchSettlementGateway is EIP712, Multicall, ReentrancyGuardTransient {
    using SafeERC20 for IERC20;

    // =========================================================================
    // Structs
    // =========================================================================

    /// @notice Payer-signed per-receiver identity binding for channel 2, mirroring the base scheme's `ChannelConfig`.
    /// @dev `channelId` binds this config to one shared channel 1; `receiver` and `receiverAuthorizer` bind the
    ///      wire-level receiver identity that `ChannelConfig` itself cannot carry in gateway mode (both its onchain
    ///      `receiver` and `receiverAuthorizer` are this gateway). Hashed to form `gatewayId`, exactly as
    ///      `ChannelConfig` is hashed to form `channelId`.
    struct GatewayConfig {
        bytes32 channelId; // channel on x402BatchSettlement
        address receiver; // wire payTo and final payout address
        address receiverAuthorizer; // wire extra.receiverAuthorizer
    }

    /// @notice Payer-signed per-receiver cumulative authorization for channel 2, mirroring the base scheme's `Voucher`.
    /// @dev Signed by the same configured payer authorization identity as the channel-1 voucher
    ///      (`ChannelConfig.payerAuthorizer` via ECDSA, or `ChannelConfig.payer` via EIP-1271 when that is zero).
    ///      The signed digest covers only `(gatewayId, maxClaimableAmount)`; `config` is carried here purely as
    ///      calldata convenience, exactly as the base `Voucher` carries the full `ChannelConfig` while only its
    ///      `channelId` (not the raw config) is hashed.
    struct GatewayVoucher {
        GatewayConfig config;
        uint128 maxClaimableAmount; // payer-authorized cumulative ceiling
    }

    /// @notice Receiver-authorizer-signed actual cumulative bound to one exact `GatewayVoucher`.
    /// @dev Binding to the voucher digest prevents an actual authorization from being paired with a different
    ///      config, receiver, or ceiling. Field name `totalClaimed` matches the base scheme's claim amount.
    struct GatewayClaimAuthorization {
        bytes32 gatewayVoucherDigest;
        uint128 totalClaimed;
    }

    /// @notice One channel-2 claim: the payer `GatewayVoucher` plus the receiver-authorizer authorization.
    /// @dev The proof fields authenticate `previousCumulative` against the channel's current cumulative root. They
    ///      are calldata only and are not included in either EIP-712 signature.
    struct GatewayVoucherClaim {
        GatewayVoucher voucher;
        bytes gatewaySignature;
        GatewayClaimAuthorization claim;
        bytes receiverAuthorizerSignature;
        uint128 previousCumulative;
        uint256 nonzeroSiblingBitmap;
        bytes32[] nonzeroSiblings;
    }

    /// @notice One channel-1 redemption: the base voucher plus its channel-2 split.
    /// @dev Channel 1 uses base notation (`voucher`, `signature`). The gateway derives the aggregate
    ///      `totalClaimed` from the per-receiver deltas; callers do not choose it.
    struct ChannelDistribution {
        x402BatchSettlement.Voucher voucher;
        bytes signature;
        GatewayVoucherClaim[] claims;
    }

    /// @dev State derived while validating one distribution and applied only after the base claim and settlement.
    struct DistributionValidation {
        x402BatchSettlement.VoucherClaim baseClaim;
        bytes32 finalRoot;
        uint128[] deltas;
    }

    // =========================================================================
    // Constants — EIP-712 Type Hashes
    // =========================================================================

    bytes32 public constant GATEWAY_CONFIG_TYPEHASH =
        keccak256("GatewayConfig(bytes32 channelId,address receiver,address receiverAuthorizer)");

    /// @dev The signed `GatewayVoucher` type references `gatewayId` (the hash of `GatewayConfig`), not the raw
    ///      struct — mirroring how the base `Voucher` digest references `channelId` rather than `ChannelConfig`.
    bytes32 public constant GATEWAY_VOUCHER_TYPEHASH =
        keccak256("GatewayVoucher(bytes32 gatewayId,uint128 maxClaimableAmount)");

    bytes32 public constant GATEWAY_CLAIM_AUTHORIZATION_TYPEHASH =
        keccak256("GatewayClaimAuthorization(bytes32 gatewayVoucherDigest,uint128 totalClaimed)");

    // =========================================================================
    // Storage
    // =========================================================================

    /// @notice The immutable {x402BatchSettlement} deployment this gateway claims and settles against.
    x402BatchSettlement public immutable X402_BATCH_SETTLEMENT;

    /// @notice Canonical root of an empty cumulative sparse Merkle tree.
    bytes32 public immutable EMPTY_CUMULATIVE_ROOT;

    /// @dev Sparse Merkle root committing every receiver's cumulative for a channel.
    ///      A zero storage value is normalized to {EMPTY_CUMULATIVE_ROOT} by {getCumulativeRoot}.
    mapping(bytes32 channelId => bytes32 root) private _cumulativeRoots;

    /// @notice Total amount credited across all receivers from a channel.
    /// @dev MUST equal that channel's base-contract `totalClaimed` at every completed gateway transaction.
    mapping(bytes32 channelId => uint128) public distributedByChannel;

    /// @notice A receiver's accrued, not-yet-withdrawn balance for a token.
    mapping(address receiver => mapping(address token => uint128)) public withdrawable;

    /// @notice Aggregate accrued, not-yet-withdrawn receiver liabilities for a token.
    mapping(address token => uint128) public totalOutstanding;

    // =========================================================================
    // Events
    // =========================================================================

    /// @notice Emitted when a receiver is credited its authorized share of a channel's redemption.
    event Distributed(
        bytes32 indexed channelId,
        address indexed receiver,
        address indexed token,
        uint128 amount,
        uint128 newDistributedCumulative
    );

    /// @notice Emitted when a receiver's accrued balance for a token is transferred to its payout address.
    event Withdrawn(address indexed receiver, address indexed token, address indexed sender, uint128 amount);

    // =========================================================================
    // Errors
    // =========================================================================

    /// @dev Errors use CapWords naming.

    error InvalidSettlement();
    error EmptyBatch();
    error NotGatewayChannel();
    error DuplicateChannel();
    error DuplicateReceiver();
    error AccountingMismatch();
    error GatewayConfigChannelMismatch();
    error InvalidSignature();
    error ClaimVoucherMismatch();
    error InvalidReceiverAuthorizerSignature();
    error ClaimExceedsCeiling();
    error InvalidCumulativeProof();
    error NoClaimableDelta();
    error NothingToWithdraw();
    error GatewayInsolvent();

    // =========================================================================
    // Constructor
    // =========================================================================

    /// @notice Sets the gateway EIP-712 domain and pins the settlement address.
    /// @param settlement The canonical {x402BatchSettlement} deployment for this chain.
    constructor(
        address settlement
    ) EIP712("x402 Batch Settlement Gateway", "1") {
        if (settlement == address(0)) revert InvalidSettlement();
        X402_BATCH_SETTLEMENT = x402BatchSettlement(settlement);
        EMPTY_CUMULATIVE_ROOT = CompressedSparseMerkleProof.emptyRoot();
    }

    // =========================================================================
    // Claim & Distribute
    // =========================================================================

    /// @notice Atomically claims channel-1 vouchers, settles them into this gateway, and credits each receiver.
    ///
    /// @param distributions Per-channel base voucher plus its per-receiver split.
    ///
    /// @dev For each distribution (`config = voucher.channel`, `channelId = getChannelId(config)`,
    ///      `token = config.token`) the gateway enforces:
    ///        1. **Gateway binding.** `config.receiver` and `config.receiverAuthorizer` MUST both equal this contract,
    ///           and no `channelId` may appear twice in the batch.
    ///        2. **Exclusive-path accounting.** Base `totalClaimed` MUST equal `distributedByChannel[channelId]`; a
    ///           mismatch means a claim happened outside this path and the call reverts.
    ///        3. **Per-receiver authorization.** For each `GatewayVoucherClaim`: no other row for the same
    ///           `(channelId, voucher.config.receiver)`; `voucher.config.channelId == channelId`; a valid payer
    ///           signature over the `GatewayVoucher` digest (`gatewayId`, `maxClaimableAmount`); a matching
    ///           `claim.gatewayVoucherDigest`; a valid `receiverAuthorizer` signature over the
    ///           `GatewayClaimAuthorization` digest; `claim.totalClaimed <= voucher.maxClaimableAmount`; and a
    ///           canonical proof of `previousCumulative` against the rolling channel root. Rows at or below the
    ///           proven cumulative are no-ops.
    ///        4. **Derived channel-1 claim.** The channel delta (sum of nonzero receiver deltas) MUST be nonzero and
    ///           is added to `distributedByChannel[channelId]` to derive the base `totalClaimed`; callers cannot pick it.
    ///        5. **Atomic base claim + settle.** {x402BatchSettlement.claim} is called once with all derived rows, then
    ///           `settle(address(this), token)` once per distinct token.
    ///        6. **Credit receivers.** The final cumulative root is stored and each nonzero proven delta advances
    ///           `distributedByChannel`, `withdrawable`, and `totalOutstanding`, emitting {Distributed}. No-op rows
    ///           change nothing.
    ///        7. **Solvency.** For every affected token the gateway's balance MUST cover `totalOutstanding[token]`.
    ///
    ///      Any invalid row or failed base call reverts the entire batch. Relayers SHOULD pre-simulate and submit
    ///      bounded batches for gas and failure isolation.
    function claimAndDistribute(
        ChannelDistribution[] calldata distributions
    ) external nonReentrant {
        uint256 n = distributions.length;
        if (n == 0) revert EmptyBatch();

        x402BatchSettlement.VoucherClaim[] memory claims = new x402BatchSettlement.VoucherClaim[](n);
        DistributionValidation[] memory validations = new DistributionValidation[](n);
        bytes32[] memory channelIds = new bytes32[](n);
        address[] memory tokens = new address[](n);
        uint256 tokenCount;

        for (uint256 i = 0; i < n; ++i) {
            bytes32 channelId = X402_BATCH_SETTLEMENT.getChannelId(distributions[i].voucher.channel);
            for (uint256 j = 0; j < i; ++j) {
                if (channelIds[j] == channelId) revert DuplicateChannel();
            }
            channelIds[i] = channelId;

            validations[i] = _validateDistribution(distributions[i], channelId);
            claims[i] = validations[i].baseClaim;
            tokenCount = _trackToken(tokens, tokenCount, distributions[i].voucher.channel.token);
        }

        // Atomic base claim (gateway is the receiver, so no ClaimBatch signature is needed) then settle per token.
        X402_BATCH_SETTLEMENT.claim(claims);
        for (uint256 t = 0; t < tokenCount; ++t) {
            X402_BATCH_SETTLEMENT.settle(address(this), tokens[t]);
        }

        for (uint256 i = 0; i < n; ++i) {
            _creditReceivers(distributions[i], channelIds[i], validations[i]);
        }

        for (uint256 t = 0; t < tokenCount; ++t) {
            address token = tokens[t];
            if (IERC20(token).balanceOf(address(this)) < totalOutstanding[token]) revert GatewayInsolvent();
        }
    }

    // =========================================================================
    // Withdraw
    // =========================================================================

    /// @notice Transfers a receiver's accrued balance for a token to that receiver's payout address.
    ///
    /// @param receiver The payer-signed `GatewayConfig.receiver` (`payTo`) that accrued the balance.
    /// @param token The ERC-20 token to withdraw.
    ///
    /// @dev Permissionless (relay-friendly): a relayer MAY sponsor this so the receiver needs no gas or RPC.
    ///      Funds always go to `receiver`; the caller cannot redirect them. Follows checks-effects-interactions.
    function withdraw(
        address receiver,
        address token
    ) external nonReentrant {
        uint128 amount = withdrawable[receiver][token];
        if (amount == 0) revert NothingToWithdraw();

        withdrawable[receiver][token] = 0;
        totalOutstanding[token] -= amount;

        emit Withdrawn(receiver, token, msg.sender, amount);

        IERC20(token).safeTransfer(receiver, amount);
    }

    // =========================================================================
    // View Functions
    // =========================================================================

    /// @notice Returns the current cumulative sparse Merkle root for `channelId`.
    /// @dev Channels without a stored root return {EMPTY_CUMULATIVE_ROOT}, never the mapping's zero sentinel.
    function getCumulativeRoot(
        bytes32 channelId
    ) public view returns (bytes32) {
        bytes32 root = _cumulativeRoots[channelId];
        return root == bytes32(0) ? EMPTY_CUMULATIVE_ROOT : root;
    }

    /// @notice Verifies a receiver cumulative against the channel's current root.
    /// @dev Returns false for both a root mismatch and a non-canonical compressed proof.
    function verifyReceiverCumulative(
        bytes32 channelId,
        address receiver,
        uint128 cumulative,
        uint256 nonzeroSiblingBitmap,
        bytes32[] calldata nonzeroSiblings
    ) external view returns (bool) {
        return CompressedSparseMerkleProof.verify(
            getCumulativeRoot(channelId), receiver, cumulative, nonzeroSiblingBitmap, nonzeroSiblings
        );
    }

    /// @notice EIP-712 digest of a `GatewayConfig`, bound to this gateway's domain (chainId + address).
    /// @param config The payer-signed per-receiver identity binding.
    /// @return The `gatewayId` referenced by that receiver's `GatewayVoucher`.
    function getGatewayId(
        GatewayConfig calldata config
    ) public view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(GATEWAY_CONFIG_TYPEHASH, config)));
    }

    /// @notice EIP-712 digest of a `GatewayVoucher` with the given `gatewayId` and `maxClaimableAmount`.
    /// @param gatewayId The per-receiver config identifier from {getGatewayId}.
    /// @param maxClaimableAmount The cumulative ceiling encoded in the voucher.
    /// @return The typed-data hash the payer authorization identity signs.
    function getGatewayVoucherDigest(
        bytes32 gatewayId,
        uint128 maxClaimableAmount
    ) public view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(GATEWAY_VOUCHER_TYPEHASH, gatewayId, maxClaimableAmount)));
    }

    /// @notice EIP-712 digest of a `GatewayClaimAuthorization`, bound to this gateway's domain.
    /// @param claim The receiver-authorizer-signed actual cumulative.
    /// @return The typed-data hash the `receiverAuthorizer` signs.
    function getGatewayClaimAuthorizationDigest(
        GatewayClaimAuthorization calldata claim
    ) public view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(abi.encode(GATEWAY_CLAIM_AUTHORIZATION_TYPEHASH, claim.gatewayVoucherDigest, claim.totalClaimed))
        );
    }

    // =========================================================================
    // Internal Helpers
    // =========================================================================

    /// @dev Validates one distribution and derives its base claim, rolling cumulative root, and per-row deltas.
    ///      View-only: crediting happens in {_creditReceivers} after the base calls.
    function _validateDistribution(
        ChannelDistribution calldata dist,
        bytes32 channelId
    ) internal view returns (DistributionValidation memory validation) {
        x402BatchSettlement.ChannelConfig calldata config = dist.voucher.channel;
        if (config.receiver != address(this) || config.receiverAuthorizer != address(this)) {
            revert NotGatewayChannel();
        }

        (, uint128 baseTotalClaimed) = X402_BATCH_SETTLEMENT.channels(channelId);
        uint128 distributedSoFar = distributedByChannel[channelId];
        if (baseTotalClaimed != distributedSoFar) revert AccountingMismatch();

        GatewayVoucherClaim[] calldata claims = dist.claims;
        uint256 m = claims.length;
        uint128[] memory deltas = new uint128[](m);
        bytes32 rollingRoot = getCumulativeRoot(channelId);
        uint128 channelDelta;
        for (uint256 k = 0; k < m; ++k) {
            for (uint256 l = 0; l < k; ++l) {
                if (claims[l].voucher.config.receiver == claims[k].voucher.config.receiver) revert DuplicateReceiver();
            }
            uint128 delta;
            (delta, rollingRoot) = _validateGatewayVoucherClaim(claims[k], channelId, config, rollingRoot);
            deltas[k] = delta;
            channelDelta += delta;
        }
        if (channelDelta == 0) revert NoClaimableDelta();

        validation = DistributionValidation({
            baseClaim: x402BatchSettlement.VoucherClaim({
                voucher: dist.voucher, signature: dist.signature, totalClaimed: distributedSoFar + channelDelta
            }),
            finalRoot: rollingRoot,
            deltas: deltas
        });
    }

    /// @dev Verifies one channel-2 claim and its cumulative proof, returning its delta and replacement root.
    function _validateGatewayVoucherClaim(
        GatewayVoucherClaim calldata gvc,
        bytes32 channelId,
        x402BatchSettlement.ChannelConfig calldata config,
        bytes32 currentRoot
    ) internal view returns (uint128 delta, bytes32 newRoot) {
        GatewayConfig calldata gwConfig = gvc.voucher.config;
        if (gwConfig.channelId != channelId) {
            revert GatewayConfigChannelMismatch();
        }

        _validateGatewayAuthorization(gvc, config);
        return _validateCumulativeUpdate(gvc, currentRoot);
    }

    /// @dev Verifies the payer ceiling and receiver-authorizer approval for a gateway claim.
    function _validateGatewayAuthorization(
        GatewayVoucherClaim calldata gvc,
        x402BatchSettlement.ChannelConfig calldata config
    ) internal view {
        GatewayConfig calldata gwConfig = gvc.voucher.config;
        bytes32 gatewayId = getGatewayId(gwConfig);
        bytes32 voucherDigest = getGatewayVoucherDigest(gatewayId, gvc.voucher.maxClaimableAmount);

        // Payer authorization: same identity that signs the channel-1 voucher.
        address payerAuthorizer = config.payerAuthorizer;
        if (payerAuthorizer != address(0)) {
            if (ECDSA.recoverCalldata(voucherDigest, gvc.gatewaySignature) != payerAuthorizer) {
                revert InvalidSignature();
            }
        } else {
            if (!SignatureChecker.isValidSignatureNow(config.payer, voucherDigest, gvc.gatewaySignature)) {
                revert InvalidSignature();
            }
        }

        // The claim authorization must bind this exact voucher, then be signed by the wire-level receiver authorizer.
        if (gvc.claim.gatewayVoucherDigest != voucherDigest) {
            revert ClaimVoucherMismatch();
        }
        if (!SignatureChecker.isValidSignatureNow(
                gwConfig.receiverAuthorizer,
                getGatewayClaimAuthorizationDigest(gvc.claim),
                gvc.receiverAuthorizerSignature
            )) {
            revert InvalidReceiverAuthorizerSignature();
        }

        if (gvc.claim.totalClaimed > gvc.voucher.maxClaimableAmount) {
            revert ClaimExceedsCeiling();
        }
    }

    /// @dev Proves the prior cumulative and computes the monotonic replacement root.
    function _validateCumulativeUpdate(
        GatewayVoucherClaim calldata gvc,
        bytes32 currentRoot
    ) internal pure returns (uint128 delta, bytes32 newRoot) {
        uint128 previousCumulative = gvc.previousCumulative;
        uint128 totalClaimed = gvc.claim.totalClaimed;
        uint128 replacement = totalClaimed > previousCumulative ? totalClaimed : previousCumulative;
        bool valid;
        (valid, newRoot) = CompressedSparseMerkleProof.verifyAndUpdate(
            currentRoot,
            gvc.voucher.config.receiver,
            previousCumulative,
            replacement,
            gvc.nonzeroSiblingBitmap,
            gvc.nonzeroSiblings
        );
        if (!valid) revert InvalidCumulativeProof();

        if (totalClaimed <= previousCumulative) {
            return (0, currentRoot);
        }
        return (totalClaimed - previousCumulative, newRoot);
    }

    /// @dev Commits the validated final root and exact per-row deltas after base claim and settlement succeed.
    function _creditReceivers(
        ChannelDistribution calldata dist,
        bytes32 channelId,
        DistributionValidation memory validation
    ) internal {
        address token = dist.voucher.channel.token;
        GatewayVoucherClaim[] calldata claims = dist.claims;
        uint256 m = claims.length;

        _cumulativeRoots[channelId] = validation.finalRoot;

        uint128 channelDelta;
        for (uint256 k = 0; k < m; ++k) {
            uint128 delta = validation.deltas[k];
            if (delta == 0) continue;

            address receiver = claims[k].voucher.config.receiver;
            withdrawable[receiver][token] += delta;
            channelDelta += delta;

            emit Distributed(channelId, receiver, token, delta, claims[k].claim.totalClaimed);
        }
        totalOutstanding[token] += channelDelta;
        distributedByChannel[channelId] += channelDelta;
    }

    /// @dev Appends `token` to `tokens` if not already present and returns the resulting distinct-token count.
    function _trackToken(
        address[] memory tokens,
        uint256 count,
        address token
    ) internal pure returns (uint256) {
        for (uint256 t = 0; t < count; ++t) {
            if (tokens[t] == token) return count;
        }
        tokens[count] = token;
        return count + 1;
    }
}
