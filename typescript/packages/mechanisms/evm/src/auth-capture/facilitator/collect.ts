import type {
  FacilitatorContext,
  PaymentPayload,
  PaymentRequirements,
  SettleResponse,
  VerifyResponse,
} from "@x402/core/types";
import {
  encodeFunctionData,
  hexToBigInt,
  isAddressEqual,
  parseErc6492Signature,
  parseEventLogs,
  type Log,
} from "viem";
import type { FacilitatorEvmSigner } from "../../signer";
import {
  ERC20_BALANCE_OF_ABI,
  ESCROW_ABI_WITH_ERRORS,
  ESCROW_EVENTS_ABI,
  ESCROW_VIEW_ABI,
} from "../abi";
import {
  AUTH_CAPTURE_ESCROW_ADDRESS,
  AUTH_CAPTURE_SCHEME,
  DEFAULT_CUSTOM_OPERATOR_AUTHORIZE_GAS_LIMIT,
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
import { appendDataSuffix, resolveDataSuffix } from "../../shared/extensions";
import { getEvmChainId } from "../../utils";
import { paymentInfoToContractTuple, reconstructPaymentInfo, unpackForSettle } from "../utils";
import { verifyCharge } from "../authorizerSigner";
import type {
  AuthCaptureCollectPayload,
  AuthCaptureFacilitatorConfig,
  Eip3009Payload,
  PaymentInfoStruct,
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
  facilitatorAddresses,
  normalizePaymentState,
  readPaymentStateForBalances,
  resolveSubmitter,
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
 * @param signers - Facilitator signer set.
 * @param config - Facilitator config.
 * @param payload - Wire payment envelope.
 * @param requirements - Published requirements.
 * @param wirePayload - Narrowed collect payload.
 * @param dataSuffix - Optional settlement suffix included in custom-operator simulation.
 * @returns VerifyResponse.
 */
export async function verifyCollect(
  signers: readonly FacilitatorEvmSigner[],
  config: AuthCaptureFacilitatorConfig | undefined,
  payload: PaymentPayload,
  requirements: PaymentRequirements,
  wirePayload: AuthCaptureCollectPayload,
  dataSuffix?: `0x${string}`,
): Promise<VerifyResponse> {
  const payer = collectPayer(wirePayload);
  const common = verifyCommon(
    payload.accepted.scheme,
    payload.accepted.network,
    requirements,
    AUTH_CAPTURE_SCHEME,
    facilitatorAddresses(signers),
    config,
    false,
  );
  if ("error" in common) {
    return { isValid: false, invalidReason: common.error, payer };
  }
  const extra = common.extra;
  const submitter = resolveSubmitter(signers, extra);
  if (!submitter) {
    return { isValid: false, invalidReason: Errors.ErrOperatorNotAdmitted, payer };
  }
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
          submitter,
          (wirePayload as Eip3009Payload).authorization,
          parsed.signature,
          { ...extra, chainId },
          requirements.asset as `0x${string}`,
        )
      : await verifyPermit2Signature(
          submitter,
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
      submitter,
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
    submitter,
    config,
    extra,
    paymentInfo,
    settleAmount,
    unpacked.tokenCollector,
    unpacked.collectorData,
    feeBps,
    feeReceiver,
    chainId,
    dataSuffix,
  );
  if (simulateResult !== "ok") {
    try {
      const balance = (await submitter.readContract({
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
 * @param signers - Facilitator signer set.
 * @param config - Facilitator config.
 * @param payload - Wire payment envelope.
 * @param requirements - Published requirements.
 * @param wirePayload - Narrowed collect payload.
 * @param context - Optional facilitator context for extension hooks.
 * @returns SettleResponse, including the settled amount.
 */
export async function settleCollect(
  signers: readonly FacilitatorEvmSigner[],
  config: AuthCaptureFacilitatorConfig | undefined,
  payload: PaymentPayload,
  requirements: PaymentRequirements,
  wirePayload: AuthCaptureCollectPayload,
  context?: FacilitatorContext,
): Promise<SettleResponse> {
  const dataSuffix = await resolveDataSuffix(context, {
    paymentPayload: payload,
    paymentRequirements: requirements,
  });
  const verification = await verifyCollect(
    signers,
    config,
    payload,
    requirements,
    wirePayload,
    dataSuffix,
  );
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
  const submitter = resolveSubmitter(signers, extra);
  if (!submitter) {
    return {
      success: false,
      errorReason: Errors.ErrOperatorNotAdmitted,
      transaction: "",
      network: requirements.network,
      payer: verification.payer,
    };
  }
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
  const customGasLimit =
    extra.operatorType === "custom"
      ? (config?.customOperatorAuthorizeGasLimit ?? DEFAULT_CUSTOM_OPERATOR_AUTHORIZE_GAS_LIMIT)
      : undefined;
  let customBalanceCheck:
    | {
        before: CollectBalanceSnapshot;
        tokenStore: `0x${string}`;
        facilitator: `0x${string}`;
      }
    | undefined;
  if (extra.operatorType === "custom") {
    const facilitator = submitter.getAddresses()[0];
    if (!facilitator) {
      return {
        success: false,
        errorReason: Errors.ErrSimulationFailed,
        transaction: "",
        network: requirements.network,
        payer,
      };
    }
    let tokenStore: `0x${string}`;
    try {
      tokenStore = (await submitter.readContract({
        address: AUTH_CAPTURE_ESCROW_ADDRESS,
        abi: ESCROW_VIEW_ABI,
        functionName: "getTokenStore",
        args: [extra.captureAuthorizer],
      })) as `0x${string}`;
    } catch {
      return {
        success: false,
        errorReason: Errors.ErrSimulationFailed,
        transaction: "",
        network: requirements.network,
        payer,
      };
    }
    const before = await readCollectBalanceSnapshot(
      submitter,
      paymentInfo.token,
      payer,
      tokenStore,
      facilitator,
      functionName,
      paymentInfo.receiver,
      feeReceiver,
    );
    if (!before) {
      return {
        success: false,
        errorReason: Errors.ErrSimulationFailed,
        transaction: "",
        network: requirements.network,
        payer,
      };
    }
    customBalanceCheck = { before, tokenStore, facilitator };
  }
  const submitted = await submitEscrowCall(submitter, settleTarget, functionName, args, {
    gas: customGasLimit,
    dataSuffix,
  });
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

  if (extra.operatorType === "custom") {
    const eventOk =
      functionName === "charge"
        ? verifyPaymentChargedEvent(submitted.logs, AUTH_CAPTURE_ESCROW_ADDRESS, {
            paymentInfoHash,
            amount: settleAmount,
            tokenCollector: unpacked.tokenCollector,
            operator: extra.captureAuthorizer,
            feeBps,
            feeReceiver,
          })
        : verifyPaymentAuthorizedEvent(submitted.logs, AUTH_CAPTURE_ESCROW_ADDRESS, {
            paymentInfoHash,
            amount: settleAmount,
            tokenCollector: unpacked.tokenCollector,
            operator: extra.captureAuthorizer,
          });
    if (!eventOk) {
      return {
        success: false,
        errorReason: Errors.ErrSimulationFailed,
        transaction: submitted.txHash,
        network: requirements.network,
        payer,
      };
    }
  }

  const expectedCapturable = functionName === "authorize" ? settleAmount : 0n;
  const expectedRefundable = functionName === "charge" ? settleAmount : 0n;
  const { state } = await readPaymentStateForBalances(
    submitter,
    paymentInfoHash,
    expectedCapturable,
    expectedRefundable,
  );
  if (
    !state ||
    !state.hasCollectedPayment ||
    state.capturableAmount !== expectedCapturable ||
    state.refundableAmount !== expectedRefundable
  ) {
    return {
      success: false,
      errorReason: Errors.ErrUnexpectedPaymentState,
      transaction: submitted.txHash,
      network: requirements.network,
      payer,
    };
  }

  if (customBalanceCheck) {
    const after = await readCollectBalanceSnapshot(
      submitter,
      paymentInfo.token,
      payer,
      customBalanceCheck.tokenStore,
      customBalanceCheck.facilitator,
      functionName,
      paymentInfo.receiver,
      feeReceiver,
    );
    if (
      !after ||
      !hasExpectedCollectBalanceChanges(
        customBalanceCheck.before,
        after,
        functionName,
        settleAmount,
        feeBps,
      )
    ) {
      return {
        success: false,
        errorReason: Errors.ErrSimulationFailed,
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
 * @param config - Facilitator config.
 * @param extra - Normalized extra.
 * @param paymentInfo - Reconstructed PaymentInfo.
 * @param amount - Amount to collect.
 * @param tokenCollector - Canonical collector for the asset-transfer method.
 * @param collectorData - Raw signature bytes.
 * @param feeBps - Fee for charge; ignored for authorize.
 * @param feeReceiver - Fee recipient for charge; ignored for authorize.
 * @param chainId - EVM chain id for paymentInfoHash.
 * @param dataSuffix - Optional settlement suffix appended to the simulated calldata.
 * @returns `"ok"` or a stable invalidReason.
 */
async function simulateCollect(
  signer: FacilitatorEvmSigner,
  config: AuthCaptureFacilitatorConfig | undefined,
  extra: NormalizedAuthCaptureExtra,
  paymentInfo: PaymentInfoStruct,
  amount: bigint,
  tokenCollector: `0x${string}`,
  collectorData: `0x${string}`,
  feeBps: number,
  feeReceiver: `0x${string}`,
  chainId: number,
  dataSuffix?: `0x${string}`,
): Promise<"ok" | string> {
  const functionName = extra.paymentFlow === "authorization" ? "charge" : "authorize";
  const tuple = paymentInfoToContractTuple(paymentInfo);
  const args =
    functionName === "charge"
      ? ([tuple, amount, tokenCollector, collectorData, feeBps, feeReceiver] as const)
      : ([tuple, amount, tokenCollector, collectorData] as const);

  if (extra.operatorType === "delegated") {
    // Delegated collect calls the escrow directly; eth_call success is sufficient preflight.
    const settleTarget = resolveSettleTarget(extra, AUTH_CAPTURE_ESCROW_ADDRESS);
    return simulateEscrowCall(signer, settleTarget, functionName, args, extra.captureAuthorizer);
  }

  // Custom operators relay through captureAuthorizer — require eth_simulateV1 outcome checks.
  if (!signer.simulateCalls) {
    return Errors.ErrSimulationFailed;
  }

  const gasLimit =
    config?.customOperatorAuthorizeGasLimit ?? DEFAULT_CUSTOM_OPERATOR_AUTHORIZE_GAS_LIMIT;
  const facilitator = signer.getAddresses()[0]!;
  const paymentInfoHash = computePaymentInfoHash(chainId, paymentInfo);
  const operator = extra.captureAuthorizer;
  const token = paymentInfo.token;
  const payer = paymentInfo.payer;
  const receiver = paymentInfo.receiver;

  // Token store is CREATE2-predictable from the operator even before deployment.
  let tokenStore: `0x${string}`;
  try {
    tokenStore = (await signer.readContract({
      address: AUTH_CAPTURE_ESCROW_ADDRESS,
      abi: ESCROW_VIEW_ABI,
      functionName: "getTokenStore",
      args: [operator],
    })) as `0x${string}`;
  } catch {
    return Errors.ErrSimulationFailed;
  }

  const balanceCall = (account: `0x${string}`) =>
    ({
      to: token,
      abi: ERC20_BALANCE_OF_ABI,
      functionName: "balanceOf",
      args: [account],
    }) as const;

  const paymentStateCall = () =>
    ({
      to: AUTH_CAPTURE_ESCROW_ADDRESS,
      abi: ESCROW_VIEW_ABI,
      functionName: "paymentState",
      args: [paymentInfoHash],
    }) as const;

  const preCalls = [
    paymentStateCall(),
    balanceCall(payer),
    balanceCall(tokenStore),
    balanceCall(facilitator),
    ...(functionName === "charge" ? [balanceCall(receiver), balanceCall(feeReceiver)] : []),
  ];

  const forwardedData = appendDataSuffix(
    encodeFunctionData({
      abi: ESCROW_ABI_WITH_ERRORS,
      functionName,
      args,
    }),
    dataSuffix,
  );

  // One batch: snapshot pre-state, simulate the operator relay (gas-capped), then re-read deltas.
  const forwardedCall = {
    to: operator,
    data: forwardedData,
    gas: gasLimit,
  } as const;

  const postCalls = [
    paymentStateCall(),
    balanceCall(payer),
    balanceCall(tokenStore),
    balanceCall(facilitator),
    ...(functionName === "charge" ? [balanceCall(receiver), balanceCall(feeReceiver)] : []),
  ];

  const calls = [...preCalls, forwardedCall, ...postCalls];
  const forwardedIndex = preCalls.length;

  let results: Awaited<ReturnType<NonNullable<FacilitatorEvmSigner["simulateCalls"]>>>["results"];
  try {
    ({ results } = await signer.simulateCalls({ account: facilitator, calls }));
  } catch {
    return Errors.ErrSimulationFailed;
  }

  if (results.length !== calls.length) {
    return Errors.ErrSimulationFailed;
  }

  // Every view call in the batch must succeed so deltas are readable.
  for (let i = 0; i < results.length; i++) {
    if (i === forwardedIndex) continue;
    if (results[i]?.status !== "success") {
      return Errors.ErrSimulationFailed;
    }
  }

  const forwarded = results[forwardedIndex];
  if (!forwarded || forwarded.status !== "success") {
    return Errors.ErrSimulationFailed;
  }
  // Reject over-limit gas even when the call returns success under the sim cap.
  if (forwarded.gasUsed !== undefined && forwarded.gasUsed > gasLimit) {
    return Errors.ErrSimulationFailed;
  }

  // Top-level operator success is not enough — require a canonical escrow event
  // (operator-emitted logs are ignored by filtering on escrow address).
  const eventOk =
    functionName === "charge"
      ? verifyPaymentChargedEvent(forwarded.logs, AUTH_CAPTURE_ESCROW_ADDRESS, {
          paymentInfoHash,
          amount,
          tokenCollector,
          operator,
          feeBps,
          feeReceiver,
        })
      : verifyPaymentAuthorizedEvent(forwarded.logs, AUTH_CAPTURE_ESCROW_ADDRESS, {
          paymentInfoHash,
          amount,
          tokenCollector,
          operator,
        });
  if (!eventOk) {
    return Errors.ErrSimulationFailed;
  }

  const preState = normalizePaymentState(results[0]?.result);
  const postState = normalizePaymentState(results[forwardedIndex + 1]?.result);
  // Payment must start uncollected; a non-zero pre-state means reuse or stale sim state.
  if (
    !preState ||
    !postState ||
    preState.hasCollectedPayment ||
    preState.capturableAmount !== 0n ||
    preState.refundableAmount !== 0n
  ) {
    return Errors.ErrSimulationFailed;
  }

  const readBalance = (index: number): bigint | undefined => {
    const result = results[index]?.result;
    if (result === undefined || result === null) return undefined;
    return BigInt(result as bigint | number | string);
  };

  const prePayer = readBalance(1);
  const preTokenStore = readBalance(2);
  const preFacilitator = readBalance(3);
  const postPayer = readBalance(forwardedIndex + 2);
  const postTokenStore = readBalance(forwardedIndex + 3);
  const postFacilitator = readBalance(forwardedIndex + 4);

  if (
    prePayer === undefined ||
    preTokenStore === undefined ||
    preFacilitator === undefined ||
    postPayer === undefined ||
    postTokenStore === undefined ||
    postFacilitator === undefined
  ) {
    return Errors.ErrSimulationFailed;
  }

  const beforeBalances: CollectBalanceSnapshot = {
    payer: prePayer,
    tokenStore: preTokenStore,
    facilitator: preFacilitator,
  };
  const afterBalances: CollectBalanceSnapshot = {
    payer: postPayer,
    tokenStore: postTokenStore,
    facilitator: postFacilitator,
  };
  if (functionName === "authorize") {
    // Authorize: escrow hold (capturable=amount); payer debited into the operator token store.
    if (
      !postState.hasCollectedPayment ||
      postState.capturableAmount !== amount ||
      postState.refundableAmount !== 0n ||
      !hasExpectedCollectBalanceChanges(beforeBalances, afterBalances, functionName, amount, feeBps)
    ) {
      return Errors.ErrSimulationFailed;
    }
    return "ok";
  }

  const preReceiver = readBalance(4);
  const preFeeReceiver = readBalance(5);
  const postReceiver = readBalance(forwardedIndex + 5);
  const postFeeReceiver = readBalance(forwardedIndex + 6);

  if (
    preReceiver === undefined ||
    preFeeReceiver === undefined ||
    postReceiver === undefined ||
    postFeeReceiver === undefined
  ) {
    return Errors.ErrSimulationFailed;
  }

  beforeBalances.receiver = preReceiver;
  beforeBalances.feeReceiver = preFeeReceiver;
  afterBalances.receiver = postReceiver;
  afterBalances.feeReceiver = postFeeReceiver;

  // Charge: payer debited, token store net zero, receiver/feeReceiver split matches _distributeTokens.
  if (
    !postState.hasCollectedPayment ||
    postState.capturableAmount !== 0n ||
    postState.refundableAmount !== amount ||
    !hasExpectedCollectBalanceChanges(beforeBalances, afterBalances, functionName, amount, feeBps)
  ) {
    return Errors.ErrSimulationFailed;
  }

  return "ok";
}

type CollectBalanceSnapshot = {
  payer: bigint;
  tokenStore: bigint;
  facilitator: bigint;
  receiver?: bigint;
  feeReceiver?: bigint;
};

/**
 * Read the payment-token balances used to verify a custom collect outcome.
 *
 * @param signer - Facilitator signer used for reads.
 * @param token - Payment token.
 * @param payer - Payer address.
 * @param tokenStore - Operator's escrow token store.
 * @param facilitator - Facilitator submitter address.
 * @param functionName - Collect operation.
 * @param receiver - Payment receiver.
 * @param feeReceiver - Charge fee recipient.
 * @returns A balance snapshot, or undefined when any read fails.
 */
async function readCollectBalanceSnapshot(
  signer: FacilitatorEvmSigner,
  token: `0x${string}`,
  payer: `0x${string}`,
  tokenStore: `0x${string}`,
  facilitator: `0x${string}`,
  functionName: "authorize" | "charge",
  receiver: `0x${string}`,
  feeReceiver: `0x${string}`,
): Promise<CollectBalanceSnapshot | undefined> {
  const readBalance = async (account: `0x${string}`): Promise<bigint> =>
    BigInt(
      (await signer.readContract({
        address: token,
        abi: ERC20_BALANCE_OF_ABI,
        functionName: "balanceOf",
        args: [account],
        account: facilitator,
      })) as bigint | number | string,
    );

  try {
    const common = await Promise.all([
      readBalance(payer),
      readBalance(tokenStore),
      readBalance(facilitator),
    ]);
    if (functionName === "authorize") {
      return { payer: common[0], tokenStore: common[1], facilitator: common[2] };
    }
    const [receiverBalance, feeReceiverBalance] = await Promise.all([
      readBalance(receiver),
      readBalance(feeReceiver),
    ]);
    return {
      payer: common[0],
      tokenStore: common[1],
      facilitator: common[2],
      receiver: receiverBalance,
      feeReceiver: feeReceiverBalance,
    };
  } catch {
    return undefined;
  }
}

/**
 * Check actual payment-token balance changes against the simulated collect invariants.
 *
 * @param before - Balances immediately before submission.
 * @param after - Balances after the transaction confirms.
 * @param functionName - Collect operation.
 * @param amount - Settled amount.
 * @param feeBps - Charge fee in basis points.
 * @returns True when all expected deltas match.
 */
function hasExpectedCollectBalanceChanges(
  before: CollectBalanceSnapshot,
  after: CollectBalanceSnapshot,
  functionName: "authorize" | "charge",
  amount: bigint,
  feeBps: number,
): boolean {
  if (after.facilitator < before.facilitator || after.payer !== before.payer - amount) {
    return false;
  }
  if (functionName === "authorize") {
    return after.tokenStore === before.tokenStore + amount;
  }
  if (
    before.receiver === undefined ||
    before.feeReceiver === undefined ||
    after.receiver === undefined ||
    after.feeReceiver === undefined
  ) {
    return false;
  }
  const fee = (amount * BigInt(feeBps)) / 10_000n;
  return (
    after.tokenStore === before.tokenStore &&
    after.receiver === before.receiver + (amount - fee) &&
    after.feeReceiver === before.feeReceiver + fee
  );
}

/**
 * Filter receipt or simulation logs down to the canonical escrow address.
 *
 * @param logs - Logs from the forwarded call or mined receipt.
 * @param escrowAddress - Canonical AuthCaptureEscrow address.
 * @returns Logs emitted by the escrow.
 */
function escrowEventLogs(logs: readonly Log[] | undefined, escrowAddress: `0x${string}`): Log[] {
  return (logs ?? []).filter(log => isAddressEqual(log.address, escrowAddress));
}

/**
 * Whether logs contain a PaymentAuthorized event matching the expected collect.
 *
 * @param logs - Logs from the forwarded call or mined receipt.
 * @param escrowAddress - Canonical AuthCaptureEscrow address.
 * @param expected - Expected event fields.
 * @param expected.paymentInfoHash - Escrow payment identifier.
 * @param expected.amount - Authorized amount.
 * @param expected.tokenCollector - Collector used for the collect.
 * @param expected.operator - PaymentInfo.operator.
 * @returns True when a matching event is present.
 */
function verifyPaymentAuthorizedEvent(
  logs: readonly Log[] | undefined,
  escrowAddress: `0x${string}`,
  expected: {
    paymentInfoHash: `0x${string}`;
    amount: bigint;
    tokenCollector: `0x${string}`;
    operator: `0x${string}`;
  },
): boolean {
  const parsed = parseEventLogs({
    abi: ESCROW_EVENTS_ABI,
    eventName: "PaymentAuthorized",
    logs: escrowEventLogs(logs, escrowAddress),
  });
  return parsed.some(
    event =>
      event.args.paymentInfoHash?.toLowerCase() === expected.paymentInfoHash.toLowerCase() &&
      event.args.amount === expected.amount &&
      isAddressEqual(event.args.tokenCollector, expected.tokenCollector) &&
      isAddressEqual(event.args.paymentInfo.operator, expected.operator),
  );
}

/**
 * Whether logs contain a PaymentCharged event matching the expected collect.
 *
 * @param logs - Logs from the forwarded call or mined receipt.
 * @param escrowAddress - Canonical AuthCaptureEscrow address.
 * @param expected - Expected event fields.
 * @param expected.paymentInfoHash - Escrow payment identifier.
 * @param expected.amount - Charged amount.
 * @param expected.tokenCollector - Collector used for the collect.
 * @param expected.operator - PaymentInfo.operator.
 * @param expected.feeBps - Submitted fee in basis points.
 * @param expected.feeReceiver - Submitted fee recipient.
 * @returns True when a matching event is present.
 */
function verifyPaymentChargedEvent(
  logs: readonly Log[] | undefined,
  escrowAddress: `0x${string}`,
  expected: {
    paymentInfoHash: `0x${string}`;
    amount: bigint;
    tokenCollector: `0x${string}`;
    operator: `0x${string}`;
    feeBps: number;
    feeReceiver: `0x${string}`;
  },
): boolean {
  const parsed = parseEventLogs({
    abi: ESCROW_EVENTS_ABI,
    eventName: "PaymentCharged",
    logs: escrowEventLogs(logs, escrowAddress),
  });
  return parsed.some(
    event =>
      event.args.paymentInfoHash?.toLowerCase() === expected.paymentInfoHash.toLowerCase() &&
      event.args.amount === expected.amount &&
      isAddressEqual(event.args.tokenCollector, expected.tokenCollector) &&
      isAddressEqual(event.args.paymentInfo.operator, expected.operator) &&
      event.args.feeBps === expected.feeBps &&
      isAddressEqual(event.args.feeReceiver, expected.feeReceiver),
  );
}
