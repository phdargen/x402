import type {
  PaymentPayload,
  PaymentRequirements,
  SettleResponse,
  VerifyResponse,
} from "@x402/core/types";
import { hexToBigInt, parseErc6492Signature } from "viem";
import type { FacilitatorEvmSigner } from "../../signer";
import { ERC20_BALANCE_OF_ABI } from "../abi";
import {
  AUTH_CAPTURE_ESCROW_ADDRESS,
  AUTH_CAPTURE_SCHEME,
  EIP3009_TOKEN_COLLECTOR_ADDRESS,
  PERMIT2_TOKEN_COLLECTOR_ADDRESS,
} from "../constants";
import {
  computePayerAgnosticPaymentInfoHash,
  computePaymentInfoHash,
  deriveBoundSalt,
  isNonZeroAddress,
  isSaltBindingOn,
  verifyERC3009Signature,
  verifyPermit2Signature,
} from "../nonce";
import { getEvmChainId } from "../../utils";
import { paymentInfoToContractTuple, reconstructPaymentInfo, unpackForSettle } from "../utils";
import { verifyCharge } from "../authorizerSigner";
import type {
  AuthCaptureCollectPayload,
  AuthCaptureFacilitatorConfig,
  Eip3009Payload,
  Permit2Payload,
} from "../types";
import { isEip3009Payload, isPermit2Payload } from "../types";
import * as Errors from "../errors";
import {
  defaultSubmittedFee,
  parseAuthCaptureExtra,
  resolveSettleTarget,
  validateSubmittedFee,
  verifyCommon,
  type NormalizedAuthCaptureExtra,
} from "../extra";
import {
  collectPayer,
  readPaymentStateForBalances,
  simulateEscrowCall,
  submitEscrowCall,
  SAFETY_MARGIN_SECONDS,
} from "./utils";

/**
 * Bound-collect `saltNonce`, if present.
 *
 * @param payload - Collect envelope.
 * @returns The 32-byte nonce, or undefined when unbound.
 */
function collectSaltNonce(payload: AuthCaptureCollectPayload): `0x${string}` | undefined {
  return "saltNonce" in payload ? payload.saltNonce : undefined;
}

/**
 * Partial-charge amount from a charge-completion collect payload.
 *
 * @param payload - Collect envelope.
 * @returns Atomic amount, or undefined when the field is absent.
 */
function collectChargeAmount(payload: AuthCaptureCollectPayload): string | undefined {
  return "amount" in payload && typeof payload.amount === "string" ? payload.amount : undefined;
}

/**
 * Verify a collect (authorize / charge) payload.
 *
 * @param signer - Facilitator signer.
 * @param config - Facilitator config.
 * @param payload - Wire payment envelope.
 * @param requirements - Published requirements.
 * @param wirePayload - Narrowed collect payload.
 * @returns VerifyResponse.
 */
export async function verifyCollect(
  signer: FacilitatorEvmSigner,
  config: AuthCaptureFacilitatorConfig | undefined,
  payload: PaymentPayload,
  requirements: PaymentRequirements,
  wirePayload: AuthCaptureCollectPayload,
): Promise<VerifyResponse> {
  const payer = collectPayer(wirePayload);
  const common = verifyCommon(
    payload.accepted.scheme,
    payload.accepted.network,
    requirements,
    AUTH_CAPTURE_SCHEME,
    signer.getAddresses(),
    config,
    false,
  );
  if ("error" in common) {
    return { isValid: false, invalidReason: common.error, payer };
  }
  const extra = common.extra;
  const bindOn = isSaltBindingOn(extra);
  const saltNonce = collectSaltNonce(wirePayload);

  if (bindOn && saltNonce === undefined) {
    return { isValid: false, invalidReason: Errors.ErrInvalidPayloadFormat, payer };
  }
  if (!bindOn && saltNonce !== undefined) {
    return { isValid: false, invalidReason: Errors.ErrInvalidPayloadFormat, payer };
  }

  const hasChargeCompletion =
    "authorizerSignature" in wirePayload && wirePayload.authorizerSignature !== undefined;
  const needsChargeCompletion =
    extra.paymentFlow === "authorization" && isNonZeroAddress(extra.receiverAuthorizer);

  if (needsChargeCompletion !== hasChargeCompletion) {
    return { isValid: false, invalidReason: Errors.ErrInvalidPayloadFormat, payer };
  }
  if (extra.paymentFlow === "escrow" && hasChargeCompletion) {
    return { isValid: false, invalidReason: Errors.ErrInvalidPayloadFormat, payer };
  }

  if (extra.assetTransferMethod === "eip3009" && !isEip3009Payload(wirePayload)) {
    return { isValid: false, invalidReason: Errors.ErrPayloadMethodMismatch, payer };
  }
  if (extra.assetTransferMethod === "permit2" && !isPermit2Payload(wirePayload)) {
    return { isValid: false, invalidReason: Errors.ErrPayloadMethodMismatch, payer };
  }

  const now = Math.floor(Date.now() / 1000);
  if (extra.captureDeadline <= now + SAFETY_MARGIN_SECONDS) {
    return { isValid: false, invalidReason: Errors.ErrCaptureDeadlineExpired, payer };
  }
  if (extra.refundDeadline < extra.captureDeadline) {
    return { isValid: false, invalidReason: Errors.ErrInvalidDeadlineOrdering, payer };
  }
  if (now + requirements.maxTimeoutSeconds > extra.captureDeadline) {
    return { isValid: false, invalidReason: Errors.ErrInvalidDeadlineOrdering, payer };
  }

  const chainId = getEvmChainId(requirements.network);
  const unpacked = unpackForSettle(wirePayload, extra.assetTransferMethod);

  if (unpacked.preApprovalExpiry <= now + SAFETY_MARGIN_SECONDS) {
    return { isValid: false, invalidReason: Errors.ErrAuthorizationExpired, payer };
  }
  if (unpacked.preApprovalExpiry > extra.captureDeadline) {
    return { isValid: false, invalidReason: Errors.ErrInvalidDeadlineOrdering, payer };
  }

  if (extra.assetTransferMethod === "eip3009") {
    const eipPayload = wirePayload as Eip3009Payload;
    if (Number(eipPayload.authorization.validAfter) > now) {
      return { isValid: false, invalidReason: Errors.ErrAuthorizationNotYetValid, payer };
    }
    if (
      eipPayload.authorization.to.toLowerCase() !== EIP3009_TOKEN_COLLECTOR_ADDRESS.toLowerCase()
    ) {
      return { isValid: false, invalidReason: Errors.ErrTokenCollectorMismatch, payer };
    }
  } else {
    const permitPayload = wirePayload as Permit2Payload;
    if (
      permitPayload.permit2Authorization.spender.toLowerCase() !==
      PERMIT2_TOKEN_COLLECTOR_ADDRESS.toLowerCase()
    ) {
      return { isValid: false, invalidReason: Errors.ErrTokenCollectorMismatch, payer };
    }
    if (
      permitPayload.permit2Authorization.permitted.token.toLowerCase() !==
      requirements.asset.toLowerCase()
    ) {
      return { isValid: false, invalidReason: Errors.ErrTokenMismatch, payer };
    }
  }

  const parsed = parseErc6492Signature(wirePayload.signature);
  const signatureValid =
    extra.assetTransferMethod === "eip3009"
      ? await verifyERC3009Signature(
          signer,
          (wirePayload as Eip3009Payload).authorization,
          parsed.signature,
          { ...extra, chainId },
          requirements.asset as `0x${string}`,
        )
      : await verifyPermit2Signature(
          signer,
          (wirePayload as Permit2Payload).permit2Authorization,
          parsed.signature,
          chainId,
        );

  if (!signatureValid) {
    return { isValid: false, invalidReason: Errors.ErrInvalidAuthCaptureSignature, payer };
  }

  const originalMax = payload.accepted.amount;
  if (unpacked.amount !== BigInt(originalMax)) {
    return { isValid: false, invalidReason: Errors.ErrAmountMismatch, payer };
  }

  let settleAmount = unpacked.amount;
  let feeBps = defaultSubmittedFee(extra).feeBps;
  let feeReceiver = defaultSubmittedFee(extra).feeReceiver;

  if (needsChargeCompletion) {
    const chargeAmount = collectChargeAmount(wirePayload);
    if (chargeAmount === undefined) {
      return { isValid: false, invalidReason: Errors.ErrInvalidPayloadFormat, payer };
    }
    settleAmount = BigInt(chargeAmount);
    if (settleAmount <= 0n || settleAmount > unpacked.amount) {
      return { isValid: false, invalidReason: Errors.ErrAmountMismatch, payer };
    }
    feeBps = wirePayload.feeBps as number;
    feeReceiver = wirePayload.feeReceiver as `0x${string}`;
    const feeError = validateSubmittedFee(extra, feeBps, feeReceiver);
    if (feeError) {
      return { isValid: false, invalidReason: feeError, payer };
    }
  }

  if (bindOn && saltNonce !== undefined) {
    const expectedSalt = deriveBoundSalt(extra.receiverAuthorizer, extra.policy, saltNonce);
    if (BigInt(wirePayload.salt) !== BigInt(expectedSalt)) {
      return { isValid: false, invalidReason: Errors.ErrSaltBindingMismatch, payer };
    }
  }

  const paymentInfo = reconstructPaymentInfo(
    payer,
    unpacked.preApprovalExpiry,
    wirePayload.salt,
    { ...requirements, amount: originalMax },
    extra,
    originalMax,
  );
  const expectedNonce = computePayerAgnosticPaymentInfoHash(chainId, paymentInfo);

  if (extra.assetTransferMethod === "eip3009") {
    const wireNonce = (wirePayload as Eip3009Payload).authorization.nonce;
    if (wireNonce.toLowerCase() !== expectedNonce.toLowerCase()) {
      return { isValid: false, invalidReason: Errors.ErrNonceMismatch, payer };
    }
  } else {
    const wireNonce = BigInt((wirePayload as Permit2Payload).permit2Authorization.nonce);
    if (wireNonce !== hexToBigInt(expectedNonce)) {
      return { isValid: false, invalidReason: Errors.ErrNonceMismatch, payer };
    }
  }

  if (needsChargeCompletion) {
    const paymentInfoHash = computePaymentInfoHash(chainId, paymentInfo);
    const ok = await verifyCharge(
      signer,
      extra.receiverAuthorizer,
      chainId,
      extra.captureAuthorizer,
      {
        paymentInfoHash,
        amount: settleAmount,
        tokenCollector: unpacked.tokenCollector,
        collectorData: unpacked.collectorData,
        feeBps,
        feeReceiver,
      },
      wirePayload.authorizerSignature as `0x${string}`,
    );
    if (!ok) {
      return { isValid: false, invalidReason: Errors.ErrAuthorizerSignature, payer };
    }
  }

  const simulateResult = await simulateCollect(
    signer,
    extra,
    paymentInfo,
    settleAmount,
    unpacked.tokenCollector,
    unpacked.collectorData,
    feeBps,
    feeReceiver,
  );
  if (simulateResult !== "ok") {
    try {
      const balance = (await signer.readContract({
        address: requirements.asset as `0x${string}`,
        abi: ERC20_BALANCE_OF_ABI,
        functionName: "balanceOf",
        args: [payer],
      })) as bigint;
      if (balance < unpacked.amount) {
        return { isValid: false, invalidReason: Errors.ErrInsufficientBalance, payer };
      }
    } catch {
      /* ignore: fall through */
    }
    return { isValid: false, invalidReason: simulateResult, payer };
  }

  return { isValid: true, payer };
}

/**
 * Re-verify and settle a collect payload.
 *
 * @param signer - Facilitator signer.
 * @param config - Facilitator config.
 * @param payload - Wire payment envelope.
 * @param requirements - Published requirements.
 * @param wirePayload - Narrowed collect payload.
 * @returns SettleResponse, including the settled amount.
 */
export async function settleCollect(
  signer: FacilitatorEvmSigner,
  config: AuthCaptureFacilitatorConfig | undefined,
  payload: PaymentPayload,
  requirements: PaymentRequirements,
  wirePayload: AuthCaptureCollectPayload,
): Promise<SettleResponse> {
  const verification = await verifyCollect(signer, config, payload, requirements, wirePayload);
  if (!verification.isValid) {
    return {
      success: false,
      errorReason: verification.invalidReason ?? Errors.ErrVerificationFailed,
      transaction: "",
      network: requirements.network,
      payer: verification.payer,
    };
  }

  const parsed = parseAuthCaptureExtra(requirements.extra);
  if ("error" in parsed) {
    return {
      success: false,
      errorReason: parsed.error,
      transaction: "",
      network: requirements.network,
      payer: verification.payer,
    };
  }
  const extra = parsed.extra;
  const payer = verification.payer as `0x${string}`;
  const unpacked = unpackForSettle(wirePayload, extra.assetTransferMethod);
  const originalMax = payload.accepted.amount;
  const paymentInfo = reconstructPaymentInfo(
    payer,
    unpacked.preApprovalExpiry,
    wirePayload.salt,
    { ...requirements, amount: originalMax },
    extra,
    originalMax,
  );

  const needsChargeCompletion =
    extra.paymentFlow === "authorization" && isNonZeroAddress(extra.receiverAuthorizer);
  const functionName = extra.paymentFlow === "authorization" ? "charge" : "authorize";
  let settleAmount = unpacked.amount;
  let feeBps = defaultSubmittedFee(extra).feeBps;
  let feeReceiver = defaultSubmittedFee(extra).feeReceiver;
  if (needsChargeCompletion) {
    settleAmount = BigInt(collectChargeAmount(wirePayload) ?? originalMax);
    feeBps = wirePayload.feeBps as number;
    feeReceiver = wirePayload.feeReceiver as `0x${string}`;
  }

  const tuple = paymentInfoToContractTuple(paymentInfo);
  const args =
    functionName === "charge"
      ? ([
          tuple,
          settleAmount,
          unpacked.tokenCollector,
          unpacked.collectorData,
          feeBps,
          feeReceiver,
        ] as const)
      : ([tuple, settleAmount, unpacked.tokenCollector, unpacked.collectorData] as const);

  const settleTarget = resolveSettleTarget(extra, AUTH_CAPTURE_ESCROW_ADDRESS);
  const submitted = await submitEscrowCall(signer, settleTarget, functionName, args);
  if ("error" in submitted && submitted.error === "reverted") {
    return {
      success: false,
      errorReason: Errors.ErrTransactionReverted,
      transaction: submitted.txHash ?? "",
      network: requirements.network,
      payer,
    };
  }
  if ("error" in submitted) {
    return {
      success: false,
      errorReason: submitted.error,
      transaction: "",
      network: requirements.network,
      payer,
    };
  }

  const chainId = getEvmChainId(requirements.network);
  const paymentInfoHash = computePaymentInfoHash(chainId, paymentInfo);

  if (functionName === "authorize") {
    const { state } = await readPaymentStateForBalances(signer, paymentInfoHash, settleAmount, 0n);
    if (!state || state.capturableAmount !== settleAmount || state.refundableAmount !== 0n) {
      return {
        success: false,
        errorReason: Errors.ErrUnexpectedPaymentState,
        transaction: submitted.txHash,
        network: requirements.network,
        payer,
      };
    }
  }

  return {
    success: true,
    transaction: submitted.txHash,
    network: requirements.network,
    payer,
    amount: settleAmount.toString(),
  };
}

/**
 * Simulate authorize or charge against the resolved settle target.
 *
 * @param signer - Facilitator signer.
 * @param extra - Normalized extra.
 * @param paymentInfo - Reconstructed PaymentInfo.
 * @param amount - Amount to collect.
 * @param tokenCollector - Canonical collector for the asset-transfer method.
 * @param collectorData - Raw signature bytes.
 * @param feeBps - Fee for charge; ignored for authorize.
 * @param feeReceiver - Fee recipient for charge; ignored for authorize.
 * @returns `"ok"` or a stable invalidReason.
 */
async function simulateCollect(
  signer: FacilitatorEvmSigner,
  extra: NormalizedAuthCaptureExtra,
  paymentInfo: ReturnType<typeof reconstructPaymentInfo>,
  amount: bigint,
  tokenCollector: `0x${string}`,
  collectorData: `0x${string}`,
  feeBps: number,
  feeReceiver: `0x${string}`,
): Promise<"ok" | string> {
  const functionName = extra.paymentFlow === "authorization" ? "charge" : "authorize";
  const tuple = paymentInfoToContractTuple(paymentInfo);
  const args =
    functionName === "charge"
      ? ([tuple, amount, tokenCollector, collectorData, feeBps, feeReceiver] as const)
      : ([tuple, amount, tokenCollector, collectorData] as const);
  const settleTarget = resolveSettleTarget(extra, AUTH_CAPTURE_ESCROW_ADDRESS);
  return simulateEscrowCall(signer, settleTarget, functionName, args, signer.getAddresses()[0]);
}
