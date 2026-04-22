import { PaymentRequirements, VerifyResponse, SettleResponse } from "@x402/core/types";
import { getAddress } from "viem";
import { FacilitatorEvmSigner } from "../../signer";
import { BatchSettlementDepositPayload } from "../types";
import { batchSettlementABI, erc20BalanceOfABI } from "../abi";
import {
  BATCH_SETTLEMENT_ADDRESS,
  ERC3009_DEPOSIT_COLLECTOR_ADDRESS,
  receiveAuthorizationTypes,
} from "../constants";
import { getEvmChainId } from "../../utils";
import { multicall } from "../../multicall";
import * as Errors from "./errors";
import {
  erc3009AuthorizationTimeInvalidReason,
  readChannelState,
  toContractChannelConfig,
  validateChannelConfig,
  verifyBatchSettlementVoucherTypedData,
} from "./utils";
import { buildErc3009CollectorData, buildErc3009DepositNonce } from "../encoding";

/**
 * Verifies a deposit payload (ERC-3009 authorization + voucher) without executing any
 * on-chain transaction.
 *
 * Performs the following validations:
 * - Token in channelConfig matches the payment requirements asset.
 * - ERC-3009 authorization is present and its time window is valid.
 * - `ReceiveWithAuthorization` signature is valid (payer → contract).
 * - Accompanying voucher signature is valid (ECDSA or ERC-1271).
 * - Payer has sufficient token balance for the deposit.
 * - Resulting `maxClaimableAmount` does not exceed effective balance (existing + deposit).
 *
 * @param signer - Facilitator signer for on-chain reads and signature verification.
 * @param payload - The full deposit payload including channelConfig, amount, authorization, and voucher.
 * @param requirements - Server payment requirements (asset, EIP-712 domain info, timeout, etc.).
 * @returns A {@link VerifyResponse} with channel state in `extra` on success.
 */
export async function verifyDeposit(
  signer: FacilitatorEvmSigner,
  payload: BatchSettlementDepositPayload,
  requirements: PaymentRequirements,
): Promise<VerifyResponse> {
  const { deposit, voucher } = payload;
  const config = deposit.channelConfig;
  const payer = config.payer;
  const chainId = getEvmChainId(requirements.network);

  const configErr = validateChannelConfig(config, voucher.channelId, requirements);
  if (configErr) {
    return { isValid: false, invalidReason: configErr, payer };
  }

  const extra = requirements.extra as
    | { name?: string; version?: string; assetTransferMethod?: string }
    | undefined;

  const transferMethod = extra?.assetTransferMethod ?? "eip3009";
  if (transferMethod !== "eip3009") {
    return { isValid: false, invalidReason: Errors.ErrInvalidPayloadType, payer };
  }

  const auth = deposit.authorization.erc3009Authorization;
  if (!auth) {
    return { isValid: false, invalidReason: Errors.ErrErc3009AuthorizationRequired, payer };
  }

  if (!extra?.name || !extra?.version) {
    return { isValid: false, invalidReason: Errors.ErrMissingEip712Domain, payer };
  }

  const validAfter = BigInt(auth.validAfter);
  const validBefore = BigInt(auth.validBefore);
  const timeInvalid = erc3009AuthorizationTimeInvalidReason(validAfter, validBefore);
  if (timeInvalid) {
    return { isValid: false, invalidReason: timeInvalid, payer };
  }

  const erc3009Nonce = buildErc3009DepositNonce(voucher.channelId, auth.salt);

  const receiveAuthOk = await verifyReceiveAuth(signer, {
    payer,
    asset: requirements.asset,
    name: extra.name,
    version: extra.version,
    chainId,
    amount: deposit.amount,
    validAfter,
    validBefore,
    nonce: erc3009Nonce,
    signature: auth.signature,
  });

  if (!receiveAuthOk) {
    return { isValid: false, invalidReason: Errors.ErrInvalidReceiveAuthorizationSignature, payer };
  }

  const voucherOk = await verifyBatchSettlementVoucherTypedData(
    signer,
    {
      channelId: voucher.channelId,
      maxClaimableAmount: voucher.maxClaimableAmount,
      payerAuthorizer: config.payerAuthorizer,
      payer: config.payer,
      signature: voucher.signature,
    },
    chainId,
  );
  if (!voucherOk) {
    return { isValid: false, invalidReason: Errors.ErrInvalidVoucherSignature, payer };
  }

  const mcResults = await multicall(signer.readContract.bind(signer), [
    {
      address: getAddress(BATCH_SETTLEMENT_ADDRESS),
      abi: batchSettlementABI,
      functionName: "channels",
      args: [voucher.channelId],
    },
    {
      address: getAddress(requirements.asset),
      abi: erc20BalanceOfABI,
      functionName: "balanceOf",
      args: [getAddress(payer)],
    },
    {
      address: getAddress(BATCH_SETTLEMENT_ADDRESS),
      abi: batchSettlementABI,
      functionName: "pendingWithdrawals",
      args: [voucher.channelId],
    },
    {
      address: getAddress(BATCH_SETTLEMENT_ADDRESS),
      abi: batchSettlementABI,
      functionName: "refundNonce",
      args: [voucher.channelId],
    },
  ]);

  const [chRes, balRes, wdRes, rnRes] = mcResults;
  if (
    chRes.status === "failure" ||
    balRes.status === "failure" ||
    wdRes.status === "failure" ||
    rnRes.status === "failure"
  ) {
    return { isValid: false, invalidReason: Errors.ErrRpcReadFailed, payer };
  }

  const [chBalance, chTotalClaimed] = chRes.result as [bigint, bigint];
  const payerBalance = balRes.result as bigint;
  const [, wdInitiatedAt] = wdRes.result as [bigint, bigint];
  const refundNonceVal = rnRes.result as bigint;
  const depositAmount = BigInt(deposit.amount);

  if (payerBalance < depositAmount) {
    return { isValid: false, invalidReason: Errors.ErrInsufficientBalance, payer };
  }

  const effectiveBalance = chBalance + depositAmount;
  const maxClaimableAmount = BigInt(voucher.maxClaimableAmount);

  if (maxClaimableAmount > effectiveBalance) {
    return { isValid: false, invalidReason: Errors.ErrCumulativeExceedsBalance, payer };
  }

  if (maxClaimableAmount <= chTotalClaimed) {
    return { isValid: false, invalidReason: Errors.ErrCumulativeAmountBelowClaimed, payer };
  }

  const configTuple = toContractChannelConfig(config);

  const collectorData = buildErc3009CollectorData(
    auth.validAfter,
    auth.validBefore,
    auth.salt,
    auth.signature,
  );

  try {
    await signer.readContract({
      address: getAddress(BATCH_SETTLEMENT_ADDRESS),
      abi: batchSettlementABI,
      functionName: "deposit",
      args: [
        configTuple,
        depositAmount,
        getAddress(ERC3009_DEPOSIT_COLLECTOR_ADDRESS),
        collectorData,
      ],
    });
  } catch (e) {
    return {
      isValid: false,
      invalidReason: Errors.ErrDepositSimulationFailed,
      invalidMessage: e instanceof Error ? e.message : String(e),
      payer,
    };
  }

  return {
    isValid: true,
    payer,
    extra: {
      channelId: voucher.channelId,
      balance: chBalance.toString(),
      totalClaimed: chTotalClaimed.toString(),
      withdrawRequestedAt: Number(wdInitiatedAt),
      refundNonce: refundNonceVal.toString(),
    },
  };
}

/**
 * Executes an ERC-3009 deposit on-chain by calling `deposit` with the
 * ERC3009DepositCollector on the batched contract.
 *
 * The deposit is first verified via {@link verifyDeposit}; if invalid the returned
 * {@link SettleResponse} will have `success: false` with the verification reason.
 *
 * @param signer - Facilitator signer used to submit the on-chain transaction.
 * @param payload - The deposit payload (channelConfig, amount, authorization, voucher).
 * @param requirements - Server payment requirements.
 * @returns A {@link SettleResponse} with the transaction hash and updated channel state in `extra`.
 */
export async function settleDeposit(
  signer: FacilitatorEvmSigner,
  payload: BatchSettlementDepositPayload,
  requirements: PaymentRequirements,
): Promise<SettleResponse> {
  const { deposit, voucher } = payload;
  const config = deposit.channelConfig;
  const payer = config.payer;
  const auth = deposit.authorization.erc3009Authorization;

  if (!auth) {
    return {
      success: false,
      errorReason: Errors.ErrInvalidPayloadType,
      errorMessage: "unsupported asset transfer method (expected erc3009Authorization)",
      transaction: "",
      network: requirements.network,
      payer,
    };
  }

  const verified = await verifyDeposit(signer, payload, requirements);
  if (!verified.isValid) {
    const reason = verified.invalidReason ?? Errors.ErrInvalidPayloadType;
    return {
      success: false,
      errorReason: reason,
      errorMessage: verified.invalidMessage ?? reason,
      transaction: "",
      network: requirements.network,
      payer: verified.payer,
    };
  }

  try {
    const configTuple = toContractChannelConfig(config);

    const collectorData = buildErc3009CollectorData(
      auth.validAfter,
      auth.validBefore,
      auth.salt,
      auth.signature,
    );

    const tx = await signer.writeContract({
      address: getAddress(BATCH_SETTLEMENT_ADDRESS),
      abi: batchSettlementABI,
      functionName: "deposit",
      args: [
        configTuple,
        BigInt(deposit.amount),
        getAddress(ERC3009_DEPOSIT_COLLECTOR_ADDRESS),
        collectorData,
      ],
    });

    const receipt = await signer.waitForTransactionReceipt({ hash: tx });

    if (receipt.status !== "success") {
      return {
        success: false,
        errorReason: Errors.ErrDepositTransactionFailed,
        errorMessage: `transaction reverted (receipt status ${receipt.status})`,
        transaction: tx,
        network: requirements.network,
        payer,
      };
    }

    const optimisticExtra = {
      channelId: voucher.channelId,
      chargedCumulativeAmount:
        payload.responseExtra?.chargedCumulativeAmount ?? requirements.amount,
      balance: (
        BigInt(String(verified.extra?.balance ?? "0")) + BigInt(deposit.amount)
      ).toString(),
      totalClaimed: verified.extra?.totalClaimed ?? "0",
      withdrawRequestedAt: Number(verified.extra?.withdrawRequestedAt ?? 0),
      refundNonce: String(verified.extra?.refundNonce ?? "0"),
    };

    // Poll the RPC until it reflects the just-confirmed deposit, so subsequent verify reads are guaranteed to see this balance
    const expectedMinBalance = BigInt(optimisticExtra.balance);
    const rpcDeadline = Date.now() + 2_000;
    let postState = await readChannelState(signer, voucher.channelId);
    while (postState.balance < expectedMinBalance && Date.now() < rpcDeadline) {
      await new Promise(resolve => setTimeout(resolve, 150));
      postState = await readChannelState(signer, voucher.channelId);
    }

    const rpcCaughtUp = postState.balance >= expectedMinBalance;

    return {
      success: true,
      transaction: tx,
      network: requirements.network,
      payer,
      amount: requirements.amount,
      extra: rpcCaughtUp
        ? {
          ...optimisticExtra,
          balance: postState.balance.toString(),
          totalClaimed: postState.totalClaimed.toString(),
          withdrawRequestedAt: postState.withdrawRequestedAt,
          refundNonce: postState.refundNonce.toString(),
        }
        : optimisticExtra,
    };
  } catch (e) {
    return {
      success: false,
      errorReason: Errors.ErrDepositTransactionFailed,
      errorMessage: e instanceof Error ? e.message : String(e),
      transaction: "",
      network: requirements.network,
      payer,
    };
  }
}

/**
 * Verifies an ERC-3009 `ReceiveWithAuthorization` signature.
 *
 * Returns `false` for known signature failures and rethrows infrastructure errors
 * (RPC outages, decode failures) so callers can distinguish a bad signature from
 * a transient transport problem.
 *
 * @param signer - Facilitator signer used for typed-data verification.
 * @param params - Authorization parameters and the signature to verify.
 * @param params.payer - Address that signed the authorization (`from`).
 * @param params.asset - ERC-20 contract address (used as `verifyingContract`).
 * @param params.name - EIP-712 domain `name` for the asset.
 * @param params.version - EIP-712 domain `version` for the asset.
 * @param params.chainId - Numeric EVM chain id.
 * @param params.amount - Authorized transfer amount as a decimal string.
 * @param params.validAfter - Unix timestamp the authorization becomes valid.
 * @param params.validBefore - Unix timestamp the authorization expires.
 * @param params.nonce - Unique 32-byte nonce for the authorization.
 * @param params.signature - 65-byte ECDSA signature over the typed data.
 * @returns `true` when the signature is valid for the supplied authorization.
 */
async function verifyReceiveAuth(
  signer: FacilitatorEvmSigner,
  params: {
    payer: `0x${string}`;
    asset: string;
    name: string;
    version: string;
    chainId: number;
    amount: string;
    validAfter: bigint;
    validBefore: bigint;
    nonce: `0x${string}`;
    signature: `0x${string}`;
  },
): Promise<boolean> {
  try {
    return await signer.verifyTypedData({
      address: getAddress(params.payer),
      domain: {
        name: params.name,
        version: params.version,
        chainId: params.chainId,
        verifyingContract: getAddress(params.asset),
      },
      types: receiveAuthorizationTypes,
      primaryType: "ReceiveWithAuthorization",
      message: {
        from: getAddress(params.payer),
        to: getAddress(ERC3009_DEPOSIT_COLLECTOR_ADDRESS),
        value: BigInt(params.amount),
        validAfter: params.validAfter,
        validBefore: params.validBefore,
        nonce: params.nonce,
      },
      signature: params.signature,
    });
  } catch {
    return false;
  }
}
