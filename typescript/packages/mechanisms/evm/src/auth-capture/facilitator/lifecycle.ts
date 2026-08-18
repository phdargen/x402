import type {
  FacilitatorContext,
  Network,
  PaymentPayload,
  PaymentRequirements,
  SettleResponse,
  VerifyResponse,
} from "@x402/core/types";
import { isAddressEqual } from "viem";
import type { FacilitatorEvmSigner } from "../../signer";
import {
  AUTH_CAPTURE_ESCROW_ADDRESS,
  AUTH_CAPTURE_SCHEME,
  OPERATOR_REFUND_COLLECTOR_ADDRESS,
} from "../constants";
import { computePaymentInfoHash, deriveBoundSalt, isNonZeroAddress } from "../nonce";
import { resolveDataSuffix } from "../../shared/extensions";
import { getEvmChainId } from "../../utils";
import { paymentInfoToContractTuple } from "../utils";
import { verifyCapture, verifyRefund, verifyVoid } from "../authorizerSigner";
import type {
  AuthCaptureFacilitatorConfig,
  AuthCaptureLifecyclePayload,
  CapturePayload,
  PaymentInfoStruct,
  PaymentState,
  RefundPayload,
  VoidPayload,
} from "../types";
import { isCapturePayload, isRefundPayload, isVoidPayload } from "../types";
import * as Errors from "../errors";
import {
  parseAuthCaptureExtra,
  resolveSettleTarget,
  validateSubmittedFee,
  verifyCommon,
  type NormalizedAuthCaptureExtra,
} from "../extra";
import {
  readPaymentStateForBalances,
  readPaymentStateOnce,
  simulateEscrowCall,
  submitEscrowCall,
} from "./utils";

/**
 * Verify a lifecycle (capture / void / refund) payload.
 *
 * @param signer - Facilitator signer.
 * @param config - Facilitator config.
 * @param payload - Wire payment envelope.
 * @param requirements - Published requirements.
 * @param wirePayload - Payload with a lifecycle `type`.
 * @returns VerifyResponse.
 */
export async function verifyLifecycle(
  signer: FacilitatorEvmSigner,
  config: AuthCaptureFacilitatorConfig | undefined,
  payload: PaymentPayload,
  requirements: PaymentRequirements,
  wirePayload: AuthCaptureLifecyclePayload,
): Promise<VerifyResponse> {
  if (wirePayload.type === "capture" && !isCapturePayload(wirePayload)) {
    return { isValid: false, invalidReason: Errors.ErrInvalidPayloadFormat };
  }
  if (wirePayload.type === "void") {
    if (!isVoidPayload(wirePayload)) {
      if (
        typeof wirePayload === "object" &&
        wirePayload !== null &&
        "voidAuthorizerSignature" in wirePayload &&
        (wirePayload as Record<string, unknown>).voidAuthorizerSignature !== undefined
      ) {
        return { isValid: false, invalidReason: Errors.ErrVoidAuthorizerSignature };
      }
      return { isValid: false, invalidReason: Errors.ErrInvalidPayloadFormat };
    }
  }
  if (wirePayload.type === "refund") {
    if (!isRefundPayload(wirePayload)) {
      if (
        typeof wirePayload === "object" &&
        wirePayload !== null &&
        "voidAuthorizerSignature" in wirePayload &&
        (wirePayload as Record<string, unknown>).voidAuthorizerSignature !== undefined
      ) {
        return { isValid: false, invalidReason: Errors.ErrVoidAuthorizerSignature };
      }
      return { isValid: false, invalidReason: Errors.ErrInvalidPayloadFormat };
    }
  }

  const common = verifyCommon(
    payload.accepted.scheme,
    payload.accepted.network,
    requirements,
    AUTH_CAPTURE_SCHEME,
    signer.getAddresses(),
    config,
    true,
  );
  if ("error" in common) {
    return { isValid: false, invalidReason: common.error };
  }
  const extra = common.extra;

  if (
    (wirePayload.type === "capture" || wirePayload.type === "void") &&
    extra.paymentFlow !== "escrow"
  ) {
    return { isValid: false, invalidReason: Errors.ErrInvalidPayloadType };
  }

  if (
    wirePayload.type === "refund" &&
    extra.operatorType === "delegated" &&
    !config?.refundFunding
  ) {
    return { isValid: false, invalidReason: Errors.ErrRefundFundingUnavailable };
  }

  if (!isNonZeroAddress(extra.receiverAuthorizer)) {
    return { isValid: false, invalidReason: Errors.ErrMissingReceiverAuthorizer };
  }

  const paymentInfo = wirePayload.paymentInfo;
  if (!isAddressEqual(paymentInfo.operator, extra.captureAuthorizer)) {
    return { isValid: false, invalidReason: Errors.ErrOperatorMismatch };
  }

  const expectedSalt = deriveBoundSalt(
    extra.receiverAuthorizer,
    extra.policy,
    wirePayload.saltNonce,
  );
  if (BigInt(paymentInfo.salt) !== BigInt(expectedSalt)) {
    return { isValid: false, invalidReason: Errors.ErrSaltBindingMismatch };
  }

  if (!paymentInfoMatchesRequirements(paymentInfo, payload.accepted, extra)) {
    return { isValid: false, invalidReason: Errors.ErrInvalidAuthCaptureExtra };
  }

  const chainId = getEvmChainId(requirements.network);
  const paymentInfoHash = computePaymentInfoHash(chainId, paymentInfo);
  const now = Math.floor(Date.now() / 1000);

  if (!wirePayload.authorizerSignature) {
    const facilitatorControlled = signer
      .getAddresses()
      .some(a => isAddressEqual(a, extra.receiverAuthorizer));
    return {
      isValid: false,
      invalidReason: facilitatorControlled
        ? Errors.ErrUnauthenticatedLifecycleRequest
        : Errors.ErrAuthorizerSignature,
    };
  }

  if (wirePayload.type === "capture") {
    return verifyCapturePayload(
      signer,
      extra,
      chainId,
      paymentInfo,
      paymentInfoHash,
      wirePayload,
      now,
    );
  }
  if (wirePayload.type === "void") {
    return verifyVoidPayload(signer, extra, chainId, paymentInfo, paymentInfoHash, wirePayload);
  }
  return verifyRefundPayload(
    signer,
    extra,
    chainId,
    paymentInfo,
    paymentInfoHash,
    wirePayload,
    now,
  );
}

/**
 * Re-verify and settle a lifecycle payload.
 *
 * @param signer - Facilitator signer.
 * @param config - Facilitator config.
 * @param payload - Wire payment envelope.
 * @param requirements - Published requirements.
 * @param wirePayload - Payload with a lifecycle `type`.
 * @param context - Optional facilitator context for extension hooks.
 * @returns SettleResponse.
 */
export async function settleLifecycle(
  signer: FacilitatorEvmSigner,
  config: AuthCaptureFacilitatorConfig | undefined,
  payload: PaymentPayload,
  requirements: PaymentRequirements,
  wirePayload: AuthCaptureLifecyclePayload,
  context?: FacilitatorContext,
): Promise<SettleResponse> {
  const verification = await verifyLifecycle(signer, config, payload, requirements, wirePayload);
  if (!verification.isValid) {
    return {
      success: false,
      errorReason: verification.invalidReason ?? Errors.ErrVerificationFailed,
      transaction: "",
      network: requirements.network,
      payer: verification.payer ?? wirePayload.paymentInfo.payer,
    };
  }

  const parsed = parseAuthCaptureExtra(requirements.extra);
  if ("error" in parsed) {
    return {
      success: false,
      errorReason: parsed.error,
      transaction: "",
      network: requirements.network,
      payer: wirePayload.paymentInfo.payer,
    };
  }
  const extra = parsed.extra;
  const tuple = paymentInfoToContractTuple(wirePayload.paymentInfo);
  const settleTarget = resolveSettleTarget(extra, AUTH_CAPTURE_ESCROW_ADDRESS);
  const payer = wirePayload.paymentInfo.payer;
  const dataSuffix = await resolveDataSuffix(context, {
    paymentPayload: payload,
    paymentRequirements: requirements,
  });

  if (wirePayload.type === "void") {
    const submitted = await submitEscrowCall(signer, settleTarget, "void", [tuple], { dataSuffix });
    return settleResult(submitted, requirements.network, payer, "0");
  }

  if (wirePayload.type === "refund") {
    const amount = BigInt(wirePayload.amount);
    const submitted = await submitEscrowCall(signer, settleTarget, "refund", [
      tuple,
      amount,
      OPERATOR_REFUND_COLLECTOR_ADDRESS,
      "0x",
    ], { dataSuffix });
    return settleResult(submitted, requirements.network, payer, amount.toString());
  }

  const capture = wirePayload;
  const amount = BigInt(capture.amount);
  const captureSubmitted = await submitEscrowCall(signer, settleTarget, "capture", [
    tuple,
    amount,
    capture.feeBps,
    capture.feeReceiver,
  ], { dataSuffix });
  if ("error" in captureSubmitted) {
    return settleResult(captureSubmitted, requirements.network, payer, amount.toString());
  }

  if (capture.voidAuthorizerSignature) {
    const voidSubmitted = await submitEscrowCall(signer, settleTarget, "void", [tuple], { dataSuffix });
    if ("error" in voidSubmitted) {
      // A race that empties the hold between capture and void is capture-only success.
      const reason = voidSubmitted.error;
      if (reason !== "reverted" && !/ZeroAuthorization|revert/i.test(reason)) {
        return settleResult(voidSubmitted, requirements.network, payer, amount.toString());
      }
    }
  }

  return {
    success: true,
    transaction: captureSubmitted.txHash,
    network: requirements.network,
    payer,
    amount: amount.toString(),
  };
}

/**
 * Map a submit result onto a SettleResponse.
 *
 * @param submitted - Write result or error.
 * @param network - CAIP-2 network.
 * @param payer - PaymentInfo.payer.
 * @param amount - Settled atomic amount on success.
 * @returns SettleResponse.
 */
function settleResult(
  submitted: { txHash: `0x${string}` } | { error: string; txHash?: `0x${string}` },
  network: Network,
  payer: string,
  amount: string,
): SettleResponse {
  if ("error" in submitted && submitted.error === "reverted") {
    return {
      success: false,
      errorReason: Errors.ErrTransactionReverted,
      transaction: submitted.txHash ?? "",
      network,
      payer,
    };
  }
  if ("error" in submitted) {
    return {
      success: false,
      errorReason: submitted.error,
      transaction: "",
      network,
      payer,
    };
  }
  return {
    success: true,
    transaction: submitted.txHash,
    network,
    payer,
    amount,
  };
}

/**
 * Whether payload.paymentInfo matches the published requirements and extra.
 *
 * @param paymentInfo - Struct from the lifecycle payload.
 * @param requirements - Published requirements.
 * @param extra - Normalized extra.
 * @returns True when every committed field matches.
 */
function paymentInfoMatchesRequirements(
  paymentInfo: PaymentInfoStruct,
  requirements: PaymentRequirements,
  extra: NormalizedAuthCaptureExtra,
): boolean {
  return (
    paymentInfo.receiver.toLowerCase() === requirements.payTo.toLowerCase() &&
    paymentInfo.token.toLowerCase() === requirements.asset.toLowerCase() &&
    paymentInfo.maxAmount === requirements.amount &&
    paymentInfo.authorizationExpiry === extra.captureDeadline &&
    paymentInfo.refundExpiry === extra.refundDeadline &&
    paymentInfo.minFeeBps === extra.minFeeBps &&
    paymentInfo.maxFeeBps === extra.maxFeeBps &&
    isAddressEqual(paymentInfo.feeReceiver, extra.feeRecipient)
  );
}

/**
 * Single-use check: signed expected balances must equal onchain state.
 *
 * @param state - Escrow paymentState.
 * @param expectedCapturable - Signed expectedCapturableAmount.
 * @param expectedRefundable - Signed expectedRefundableAmount.
 * @returns True when both balances match.
 */
function balancesMatch(
  state: PaymentState,
  expectedCapturable: bigint,
  expectedRefundable: bigint,
): boolean {
  return (
    state.capturableAmount === expectedCapturable && state.refundableAmount === expectedRefundable
  );
}

/**
 * Verify a capture payload: authorizer signatures, fees, deadlines, paymentState, simulation.
 *
 * @param signer - Facilitator signer.
 * @param extra - Normalized extra.
 * @param chainId - EVM chain id.
 * @param paymentInfo - Payload PaymentInfo.
 * @param paymentInfoHash - Escrow payment identifier.
 * @param wirePayload - Capture envelope.
 * @param now - Unix seconds.
 * @returns VerifyResponse.
 */
async function verifyCapturePayload(
  signer: FacilitatorEvmSigner,
  extra: NormalizedAuthCaptureExtra,
  chainId: number,
  paymentInfo: PaymentInfoStruct,
  paymentInfoHash: `0x${string}`,
  wirePayload: CapturePayload,
  now: number,
): Promise<VerifyResponse> {
  const payer = paymentInfo.payer;
  const ok = await verifyCapture(
    signer,
    extra.receiverAuthorizer,
    chainId,
    extra.captureAuthorizer,
    {
      paymentInfoHash,
      amount: wirePayload.amount,
      feeBps: wirePayload.feeBps,
      feeReceiver: wirePayload.feeReceiver,
      expectedCapturableAmount: wirePayload.expectedCapturableAmount,
      expectedRefundableAmount: wirePayload.expectedRefundableAmount,
    },
    wirePayload.authorizerSignature,
  );
  if (!ok) {
    return { isValid: false, invalidReason: Errors.ErrAuthorizerSignature, payer };
  }

  if (wirePayload.voidAuthorizerSignature) {
    const voidOk = await verifyVoid(
      signer,
      extra.receiverAuthorizer,
      chainId,
      extra.captureAuthorizer,
      paymentInfoHash,
      wirePayload.voidAuthorizerSignature,
    );
    if (!voidOk) {
      return { isValid: false, invalidReason: Errors.ErrVoidAuthorizerSignature, payer };
    }
  }

  const feeError = validateSubmittedFee(extra, wirePayload.feeBps, wirePayload.feeReceiver);
  if (feeError) {
    return { isValid: false, invalidReason: feeError, payer };
  }

  if (now >= paymentInfo.authorizationExpiry) {
    return { isValid: false, invalidReason: Errors.ErrCaptureDeadlineExpired, payer };
  }

  const expectedCapturable = BigInt(wirePayload.expectedCapturableAmount);
  const expectedRefundable = BigInt(wirePayload.expectedRefundableAmount);
  const { state } = await readPaymentStateForBalances(
    signer,
    paymentInfoHash,
    expectedCapturable,
    expectedRefundable,
  );
  if (!state) {
    return { isValid: false, invalidReason: Errors.ErrUnexpectedPaymentState, payer };
  }
  if (!balancesMatch(state, expectedCapturable, expectedRefundable)) {
    return { isValid: false, invalidReason: Errors.ErrUnexpectedPaymentState, payer };
  }

  const amount = BigInt(wirePayload.amount);
  if (amount <= 0n || amount > state.capturableAmount) {
    return { isValid: false, invalidReason: Errors.ErrAmountMismatch, payer };
  }
  if (wirePayload.voidAuthorizerSignature) {
    if (amount >= state.capturableAmount) {
      return { isValid: false, invalidReason: Errors.ErrVoidRemainderFullCapture, payer };
    }
  }

  const tuple = paymentInfoToContractTuple(paymentInfo);
  const captureSim = await simulateEscrowCall(
    signer,
    resolveSettleTarget(extra, AUTH_CAPTURE_ESCROW_ADDRESS),
    "capture",
    [tuple, amount, wirePayload.feeBps, wirePayload.feeReceiver],
    signer.getAddresses()[0],
  );
  if (captureSim !== "ok") {
    return { isValid: false, invalidReason: captureSim, payer };
  }
  if (wirePayload.voidAuthorizerSignature) {
    const voidSim = await simulateEscrowCall(
      signer,
      resolveSettleTarget(extra, AUTH_CAPTURE_ESCROW_ADDRESS),
      "void",
      [tuple],
      signer.getAddresses()[0],
    );
    if (voidSim !== "ok") {
      return { isValid: false, invalidReason: voidSim, payer };
    }
  }

  return { isValid: true, payer };
}

/**
 * Verify a void payload: authorizer signature, remaining hold, simulation.
 *
 * @param signer - Facilitator signer.
 * @param extra - Normalized extra.
 * @param chainId - EVM chain id.
 * @param paymentInfo - Payload PaymentInfo.
 * @param paymentInfoHash - Escrow payment identifier.
 * @param wirePayload - Void envelope.
 * @returns VerifyResponse.
 */
async function verifyVoidPayload(
  signer: FacilitatorEvmSigner,
  extra: NormalizedAuthCaptureExtra,
  chainId: number,
  paymentInfo: PaymentInfoStruct,
  paymentInfoHash: `0x${string}`,
  wirePayload: VoidPayload,
): Promise<VerifyResponse> {
  const payer = paymentInfo.payer;
  const ok = await verifyVoid(
    signer,
    extra.receiverAuthorizer,
    chainId,
    extra.captureAuthorizer,
    paymentInfoHash,
    wirePayload.authorizerSignature,
  );
  if (!ok) {
    return { isValid: false, invalidReason: Errors.ErrAuthorizerSignature, payer };
  }

  const state = await readPaymentStateOnce(signer, paymentInfoHash);
  if (!state) {
    return { isValid: false, invalidReason: Errors.ErrUnexpectedPaymentState, payer };
  }
  if (state.capturableAmount === 0n) {
    return { isValid: false, invalidReason: Errors.ErrZeroAuthorization, payer };
  }

  const tuple = paymentInfoToContractTuple(paymentInfo);
  const sim = await simulateEscrowCall(
    signer,
    resolveSettleTarget(extra, AUTH_CAPTURE_ESCROW_ADDRESS),
    "void",
    [tuple],
    signer.getAddresses()[0],
  );
  if (sim !== "ok") {
    return { isValid: false, invalidReason: sim, payer };
  }
  return { isValid: true, payer };
}

/**
 * Verify a refund payload: authorizer signature, deadline, paymentState, simulation.
 *
 * @param signer - Facilitator signer.
 * @param extra - Normalized extra.
 * @param chainId - EVM chain id.
 * @param paymentInfo - Payload PaymentInfo.
 * @param paymentInfoHash - Escrow payment identifier.
 * @param wirePayload - Refund envelope.
 * @param now - Unix seconds.
 * @returns VerifyResponse.
 */
async function verifyRefundPayload(
  signer: FacilitatorEvmSigner,
  extra: NormalizedAuthCaptureExtra,
  chainId: number,
  paymentInfo: PaymentInfoStruct,
  paymentInfoHash: `0x${string}`,
  wirePayload: RefundPayload,
  now: number,
): Promise<VerifyResponse> {
  const payer = paymentInfo.payer;
  const ok = await verifyRefund(
    signer,
    extra.receiverAuthorizer,
    chainId,
    extra.captureAuthorizer,
    {
      paymentInfoHash,
      amount: wirePayload.amount,
      tokenCollector: OPERATOR_REFUND_COLLECTOR_ADDRESS,
      expectedCapturableAmount: wirePayload.expectedCapturableAmount,
      expectedRefundableAmount: wirePayload.expectedRefundableAmount,
    },
    wirePayload.authorizerSignature,
  );
  if (!ok) {
    return { isValid: false, invalidReason: Errors.ErrAuthorizerSignature, payer };
  }

  if (now >= paymentInfo.refundExpiry) {
    return { isValid: false, invalidReason: Errors.ErrRefundDeadlineExpired, payer };
  }

  const expectedCapturable = BigInt(wirePayload.expectedCapturableAmount);
  const expectedRefundable = BigInt(wirePayload.expectedRefundableAmount);
  const { state } = await readPaymentStateForBalances(
    signer,
    paymentInfoHash,
    expectedCapturable,
    expectedRefundable,
  );
  if (!state) {
    return { isValid: false, invalidReason: Errors.ErrUnexpectedPaymentState, payer };
  }
  if (!balancesMatch(state, expectedCapturable, expectedRefundable)) {
    return { isValid: false, invalidReason: Errors.ErrUnexpectedPaymentState, payer };
  }

  const amount = BigInt(wirePayload.amount);
  if (amount <= 0n || amount > state.refundableAmount) {
    return { isValid: false, invalidReason: Errors.ErrRefundExceedsCapture, payer };
  }

  const tuple = paymentInfoToContractTuple(paymentInfo);
  const sim = await simulateEscrowCall(
    signer,
    resolveSettleTarget(extra, AUTH_CAPTURE_ESCROW_ADDRESS),
    "refund",
    [tuple, amount, OPERATOR_REFUND_COLLECTOR_ADDRESS, "0x"],
    signer.getAddresses()[0],
  );
  if (sim !== "ok") {
    return { isValid: false, invalidReason: sim, payer };
  }
  return { isValid: true, payer };
}
