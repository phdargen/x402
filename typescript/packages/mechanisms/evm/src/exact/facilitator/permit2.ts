import {
  PaymentPayload,
  PaymentRequirements,
  FacilitatorContext,
  SettleResponse,
  VerifyResponse,
} from "@x402/core/types";
import {
  extractEip2612GasSponsoringInfo,
  validateEip2612GasSponsoringInfo,
  extractErc20ApprovalGasSponsoringInfo,
  ERC20_APPROVAL_GAS_SPONSORING,
  type Erc20ApprovalGasSponsoringFacilitatorExtension,
} from "@x402/extensions";
import type { Eip2612GasSponsoringInfo } from "@x402/extensions";
import { getAddress } from "viem";
import {
  eip3009ABI,
  PERMIT2_ADDRESS,
  permit2WitnessTypes,
  x402ExactPermit2ProxyABI,
  x402ExactPermit2ProxyAddress,
  erc20AllowanceAbi,
} from "../../constants";
import {
  ErrPermit2612AmountMismatch,
  ErrPermit2InvalidAmount,
  ErrPermit2InvalidDestination,
  ErrPermit2InvalidNonce,
  ErrPermit2InvalidOwner,
  ErrPermit2InvalidSignature,
  ErrPermit2PaymentTooEarly,
  ErrUnsupportedScheme,
  ErrNetworkMismatch,
  ErrPermit2InvalidSpender,
  ErrPermit2RecipientMismatch,
  ErrPermit2DeadlineExpired,
  ErrPermit2NotYetValid,
  ErrPermit2InsufficientAmount,
  ErrPermit2TokenMismatch,
  ErrPermit2AllowanceRequired,
  ErrInvalidSchemeFallback,
  ErrInvalidTransactionState,
  ErrTransactionFailed,
  ErrErc20ApprovalBroadcastFailed,
  ErrInsufficientFunds,
  ErrInvalidEip2612ExtensionFormat,
  ErrEip2612FromMismatch,
  ErrEip2612AssetMismatch,
  ErrEip2612SpenderNotPermit2,
  ErrEip2612DeadlineExpired,
} from "./errors";
import { FacilitatorEvmSigner } from "../../signer";
import { ExactPermit2Payload } from "../../types";
import { getEvmChainId } from "../../utils";
import { validateErc20ApprovalForPayment } from "./erc20approval";

/**
 * Verifies a Permit2 payment payload.
 *
 * Handles all Permit2 verification paths:
 * - Standard: checks on-chain Permit2 allowance
 * - EIP-2612: validates the EIP-2612 permit extension when allowance is insufficient
 * - ERC-20 approval: validates the pre-signed approve tx extension when allowance is insufficient
 *
 * @param signer - The facilitator signer for contract reads
 * @param payload - The payment payload to verify
 * @param requirements - The payment requirements
 * @param permit2Payload - The Permit2 specific payload
 * @param context - Optional facilitator context for extension-provided capabilities
 * @returns Promise resolving to verification response
 */
export async function verifyPermit2(
  signer: FacilitatorEvmSigner,
  payload: PaymentPayload,
  requirements: PaymentRequirements,
  permit2Payload: ExactPermit2Payload,
  context?: FacilitatorContext,
): Promise<VerifyResponse> {
  const payer = permit2Payload.permit2Authorization.from;

  if (payload.accepted.scheme !== "exact" || requirements.scheme !== "exact") {
    return {
      isValid: false,
      invalidReason: ErrUnsupportedScheme,
      payer,
    };
  }

  if (payload.accepted.network !== requirements.network) {
    return {
      isValid: false,
      invalidReason: ErrNetworkMismatch,
      payer,
    };
  }

  const chainId = getEvmChainId(requirements.network);
  const tokenAddress = getAddress(requirements.asset);

  if (
    getAddress(permit2Payload.permit2Authorization.spender) !==
    getAddress(x402ExactPermit2ProxyAddress)
  ) {
    return {
      isValid: false,
      invalidReason: ErrPermit2InvalidSpender,
      payer,
    };
  }

  if (
    getAddress(permit2Payload.permit2Authorization.witness.to) !== getAddress(requirements.payTo)
  ) {
    return {
      isValid: false,
      invalidReason: ErrPermit2RecipientMismatch,
      payer,
    };
  }

  const now = Math.floor(Date.now() / 1000);
  if (BigInt(permit2Payload.permit2Authorization.deadline) < BigInt(now + 6)) {
    return {
      isValid: false,
      invalidReason: ErrPermit2DeadlineExpired,
      payer,
    };
  }

  if (BigInt(permit2Payload.permit2Authorization.witness.validAfter) > BigInt(now)) {
    return {
      isValid: false,
      invalidReason: ErrPermit2NotYetValid,
      payer,
    };
  }

  // Verify amount exactly matches requirements
  if (
    BigInt(permit2Payload.permit2Authorization.permitted.amount) !== BigInt(requirements.amount)
  ) {
    return {
      isValid: false,
      invalidReason: ErrPermit2InsufficientAmount,
      payer,
    };
  }

  if (getAddress(permit2Payload.permit2Authorization.permitted.token) !== tokenAddress) {
    return {
      isValid: false,
      invalidReason: ErrPermit2TokenMismatch,
      payer,
    };
  }

  const permit2TypedData = {
    types: permit2WitnessTypes,
    primaryType: "PermitWitnessTransferFrom" as const,
    domain: {
      name: "Permit2",
      chainId,
      verifyingContract: PERMIT2_ADDRESS,
    },
    message: {
      permitted: {
        token: getAddress(permit2Payload.permit2Authorization.permitted.token),
        amount: BigInt(permit2Payload.permit2Authorization.permitted.amount),
      },
      spender: getAddress(permit2Payload.permit2Authorization.spender),
      nonce: BigInt(permit2Payload.permit2Authorization.nonce),
      deadline: BigInt(permit2Payload.permit2Authorization.deadline),
      witness: {
        to: getAddress(permit2Payload.permit2Authorization.witness.to),
        validAfter: BigInt(permit2Payload.permit2Authorization.witness.validAfter),
      },
    },
  };

  try {
    const isValid = await signer.verifyTypedData({
      address: payer,
      ...permit2TypedData,
      signature: permit2Payload.signature,
    });

    if (!isValid) {
      return {
        isValid: false,
        invalidReason: ErrPermit2InvalidSignature,
        payer,
      };
    }
  } catch {
    return {
      isValid: false,
      invalidReason: ErrPermit2InvalidSignature,
      payer,
    };
  }

  // Check Permit2 allowance — if insufficient, try gas sponsoring extensions
  const allowanceResult = await _verifyPermit2Allowance(
    signer,
    payload,
    requirements,
    payer,
    tokenAddress,
    context,
  );
  if (allowanceResult) {
    return allowanceResult;
  }

  try {
    const balance = (await signer.readContract({
      address: tokenAddress,
      abi: eip3009ABI,
      functionName: "balanceOf",
      args: [payer],
    })) as bigint;

    if (balance < BigInt(requirements.amount)) {
      return {
        isValid: false,
        invalidReason: ErrInsufficientFunds,
        invalidMessage: `Insufficient funds to complete the payment. Required: ${requirements.amount} ${requirements.asset}, Available: ${balance.toString()} ${requirements.asset}. Please add funds to your wallet and try again.`,
        payer,
      };
    }
  } catch {
    // If we can't check balance, continue
  }

  return {
    isValid: true,
    invalidReason: undefined,
    payer,
  };
}

/**
 * Checks Permit2 allowance and validates gas sponsoring extensions if allowance is insufficient.
 *
 * @param signer - The facilitator signer for on-chain reads
 * @param payload - The payment payload
 * @param requirements - The payment requirements
 * @param payer - The payer address
 * @param tokenAddress - The token contract address
 * @param context - Optional facilitator context for extension lookup
 * @returns A VerifyResponse if verification should stop (failure), or null to continue
 */
async function _verifyPermit2Allowance(
  signer: FacilitatorEvmSigner,
  payload: PaymentPayload,
  requirements: PaymentRequirements,
  payer: `0x${string}`,
  tokenAddress: `0x${string}`,
  context?: FacilitatorContext,
): Promise<VerifyResponse | null> {
  try {
    const allowance = (await signer.readContract({
      address: tokenAddress,
      abi: erc20AllowanceAbi,
      functionName: "allowance",
      args: [payer, PERMIT2_ADDRESS],
    })) as bigint;

    if (allowance >= BigInt(requirements.amount)) {
      return null; // Sufficient allowance, continue verification
    }

    // Allowance insufficient — try EIP-2612 gas sponsoring first
    const eip2612Info = extractEip2612GasSponsoringInfo(payload);
    if (eip2612Info) {
      const result = validateEip2612PermitForPayment(eip2612Info, payer, tokenAddress);
      if (!result.isValid) {
        return { isValid: false, invalidReason: result.invalidReason!, payer };
      }
      return null; // EIP-2612 is valid, allowance will be set atomically during settlement
    }

    // Try ERC-20 approval gas sponsoring as fallback
    const erc20GasSponsorshipExtension =
      context?.getExtension<Erc20ApprovalGasSponsoringFacilitatorExtension>(
        ERC20_APPROVAL_GAS_SPONSORING.key,
      );
    if (erc20GasSponsorshipExtension) {
      const erc20Info = extractErc20ApprovalGasSponsoringInfo(payload);
      if (erc20Info) {
        const result = await validateErc20ApprovalForPayment(erc20Info, payer, tokenAddress);
        if (!result.isValid) {
          return { isValid: false, invalidReason: result.invalidReason!, payer };
        }
        return null; // ERC-20 approval is valid, will be broadcast before settlement
      }
    }

    return { isValid: false, invalidReason: ErrPermit2AllowanceRequired, payer };
  } catch {
    // If allowance check fails, validate extensions if present; otherwise proceed optimistically
    const eip2612Info = extractEip2612GasSponsoringInfo(payload);
    if (eip2612Info) {
      const result = validateEip2612PermitForPayment(eip2612Info, payer, tokenAddress);
      if (!result.isValid) {
        return { isValid: false, invalidReason: result.invalidReason!, payer };
      }
    }
    return null;
  }
}

/**
 * Settles a Permit2 payment. Single entry point for all Permit2 settlement paths:
 *
 * 1. EIP-2612 extension present -> settleWithPermit (atomic single tx via contract)
 * 2. ERC-20 approval extension present + extension signer -> broadcast approval + settle (via extension signer)
 * 3. Standard -> settle directly (allowance already on-chain)
 *
 * @param signer - The base facilitator signer for contract writes
 * @param payload - The payment payload to settle
 * @param requirements - The payment requirements
 * @param permit2Payload - The Permit2 specific payload
 * @param context - Optional facilitator context for extension-provided capabilities
 * @returns Promise resolving to settlement response
 */
export async function settlePermit2(
  signer: FacilitatorEvmSigner,
  payload: PaymentPayload,
  requirements: PaymentRequirements,
  permit2Payload: ExactPermit2Payload,
  context?: FacilitatorContext,
): Promise<SettleResponse> {
  const payer = permit2Payload.permit2Authorization.from;

  const valid = await verifyPermit2(signer, payload, requirements, permit2Payload, context);
  if (!valid.isValid) {
    return {
      success: false,
      network: payload.accepted.network,
      transaction: "",
      errorReason: valid.invalidReason ?? ErrInvalidSchemeFallback,
      payer,
    };
  }

  // Branch: EIP-2612 gas sponsoring (atomic settleWithPermit via contract)
  const eip2612Info = extractEip2612GasSponsoringInfo(payload);
  if (eip2612Info) {
    return _settlePermit2WithEIP2612(signer, payload, permit2Payload, eip2612Info);
  }

  // Branch: ERC-20 approval gas sponsoring (broadcast approval + settle via extension signer)
  const erc20Info = extractErc20ApprovalGasSponsoringInfo(payload);
  if (erc20Info) {
    const erc20GasSponsorshipExtension =
      context?.getExtension<Erc20ApprovalGasSponsoringFacilitatorExtension>(
        ERC20_APPROVAL_GAS_SPONSORING.key,
      );
    if (erc20GasSponsorshipExtension?.signer) {
      return _settlePermit2WithERC20Approval(
        erc20GasSponsorshipExtension.signer,
        payload,
        permit2Payload,
        erc20Info,
      );
    }
  }

  // Branch: standard settle (allowance already on-chain)
  return _settlePermit2Direct(signer, payload, permit2Payload);
}

/**
 * Settles via settleWithPermit — includes the EIP-2612 permit atomically in one tx.
 *
 * @param signer - The base facilitator signer
 * @param payload - The payment payload
 * @param permit2Payload - The Permit2 specific payload
 * @param eip2612Info - The EIP-2612 gas sponsoring info from the payload extension
 * @returns Promise resolving to settlement response
 */
async function _settlePermit2WithEIP2612(
  signer: FacilitatorEvmSigner,
  payload: PaymentPayload,
  permit2Payload: ExactPermit2Payload,
  eip2612Info: Eip2612GasSponsoringInfo,
): Promise<SettleResponse> {
  const payer = permit2Payload.permit2Authorization.from;
  try {
    const { v, r, s } = splitEip2612Signature(eip2612Info.signature);

    const tx = await signer.writeContract({
      address: x402ExactPermit2ProxyAddress,
      abi: x402ExactPermit2ProxyABI,
      functionName: "settleWithPermit",
      args: [
        {
          value: BigInt(eip2612Info.amount),
          deadline: BigInt(eip2612Info.deadline),
          r,
          s,
          v,
        },
        {
          permitted: {
            token: getAddress(permit2Payload.permit2Authorization.permitted.token),
            amount: BigInt(permit2Payload.permit2Authorization.permitted.amount),
          },
          nonce: BigInt(permit2Payload.permit2Authorization.nonce),
          deadline: BigInt(permit2Payload.permit2Authorization.deadline),
        },
        getAddress(payer),
        {
          to: getAddress(permit2Payload.permit2Authorization.witness.to),
          validAfter: BigInt(permit2Payload.permit2Authorization.witness.validAfter),
        },
        permit2Payload.signature,
      ],
    });

    return _waitAndReturn(signer, tx, payload, payer);
  } catch (error) {
    return _mapSettleError(error, payload, payer);
  }
}

/**
 * Broadcasts the pre-signed ERC-20 approve tx then settles via the extension signer.
 * Both operations use the extension signer, enabling atomic bundling by production implementations.
 *
 * @param extensionSigner - The extension signer with sendRawTransaction + writeContract
 * @param payload - The payment payload
 * @param permit2Payload - The Permit2 specific payload
 * @param erc20Info - Object containing the signed approval transaction
 * @param erc20Info.signedTransaction - The RLP-encoded signed EIP-1559 approval tx
 * @returns Promise resolving to settlement response
 */
async function _settlePermit2WithERC20Approval(
  extensionSigner: Erc20ApprovalGasSponsoringFacilitatorExtension["signer"] & {},
  payload: PaymentPayload,
  permit2Payload: ExactPermit2Payload,
  erc20Info: { signedTransaction: string },
): Promise<SettleResponse> {
  const payer = permit2Payload.permit2Authorization.from;

  try {
    const approvalTxHash = await extensionSigner.sendRawTransaction({
      serializedTransaction: erc20Info.signedTransaction as `0x${string}`,
    });

    const approvalReceipt = await extensionSigner.waitForTransactionReceipt({
      hash: approvalTxHash,
    });

    if (approvalReceipt.status !== "success") {
      return {
        success: false,
        errorReason: ErrErc20ApprovalBroadcastFailed,
        transaction: approvalTxHash,
        network: payload.accepted.network,
        payer,
      };
    }

    const tx = await extensionSigner.writeContract({
      address: x402ExactPermit2ProxyAddress,
      abi: x402ExactPermit2ProxyABI,
      functionName: "settle",
      args: [
        {
          permitted: {
            token: getAddress(permit2Payload.permit2Authorization.permitted.token),
            amount: BigInt(permit2Payload.permit2Authorization.permitted.amount),
          },
          nonce: BigInt(permit2Payload.permit2Authorization.nonce),
          deadline: BigInt(permit2Payload.permit2Authorization.deadline),
        },
        getAddress(payer),
        {
          to: getAddress(permit2Payload.permit2Authorization.witness.to),
          validAfter: BigInt(permit2Payload.permit2Authorization.witness.validAfter),
        },
        permit2Payload.signature,
      ],
    });

    return _waitAndReturn(extensionSigner, tx, payload, payer);
  } catch (error) {
    return _mapSettleError(error, payload, payer);
  }
}

/**
 * Standard Permit2 settle — allowance is already on-chain.
 *
 * @param signer - The base facilitator signer
 * @param payload - The payment payload
 * @param permit2Payload - The Permit2 specific payload
 * @returns Promise resolving to settlement response
 */
async function _settlePermit2Direct(
  signer: FacilitatorEvmSigner,
  payload: PaymentPayload,
  permit2Payload: ExactPermit2Payload,
): Promise<SettleResponse> {
  const payer = permit2Payload.permit2Authorization.from;
  try {
    const tx = await signer.writeContract({
      address: x402ExactPermit2ProxyAddress,
      abi: x402ExactPermit2ProxyABI,
      functionName: "settle",
      args: [
        {
          permitted: {
            token: getAddress(permit2Payload.permit2Authorization.permitted.token),
            amount: BigInt(permit2Payload.permit2Authorization.permitted.amount),
          },
          nonce: BigInt(permit2Payload.permit2Authorization.nonce),
          deadline: BigInt(permit2Payload.permit2Authorization.deadline),
        },
        getAddress(payer),
        {
          to: getAddress(permit2Payload.permit2Authorization.witness.to),
          validAfter: BigInt(permit2Payload.permit2Authorization.witness.validAfter),
        },
        permit2Payload.signature,
      ],
    });

    return _waitAndReturn(signer, tx, payload, payer);
  } catch (error) {
    return _mapSettleError(error, payload, payer);
  }
}

/**
 * Waits for tx receipt and returns the appropriate SettleResponse.
 *
 * @param signer - Signer with waitForTransactionReceipt capability
 * @param tx - The transaction hash to wait for
 * @param payload - The payment payload (for network info)
 * @param payer - The payer address
 * @returns Promise resolving to settlement response
 */
async function _waitAndReturn(
  signer: Pick<FacilitatorEvmSigner, "waitForTransactionReceipt">,
  tx: `0x${string}`,
  payload: PaymentPayload,
  payer: `0x${string}`,
): Promise<SettleResponse> {
  const receipt = await signer.waitForTransactionReceipt({ hash: tx });

  if (receipt.status !== "success") {
    return {
      success: false,
      errorReason: ErrInvalidTransactionState,
      transaction: tx,
      network: payload.accepted.network,
      payer,
    };
  }

  return {
    success: true,
    transaction: tx,
    network: payload.accepted.network,
    payer,
  };
}

/**
 * Maps contract revert errors to structured SettleResponse error reasons.
 *
 * @param error - The caught error
 * @param payload - The payment payload (for network info)
 * @param payer - The payer address
 * @returns A failed SettleResponse with mapped error reason
 */
function _mapSettleError(
  error: unknown,
  payload: PaymentPayload,
  payer: `0x${string}`,
): SettleResponse {
  let errorReason = ErrTransactionFailed;
  if (error instanceof Error) {
    const message = error.message;
    if (message.includes("Permit2612AmountMismatch")) {
      errorReason = ErrPermit2612AmountMismatch;
    } else if (message.includes("InvalidAmount")) {
      errorReason = ErrPermit2InvalidAmount;
    } else if (message.includes("InvalidDestination")) {
      errorReason = ErrPermit2InvalidDestination;
    } else if (message.includes("InvalidOwner")) {
      errorReason = ErrPermit2InvalidOwner;
    } else if (message.includes("PaymentTooEarly")) {
      errorReason = ErrPermit2PaymentTooEarly;
    } else if (message.includes("InvalidSignature") || message.includes("SignatureExpired")) {
      errorReason = ErrPermit2InvalidSignature;
    } else if (message.includes("InvalidNonce")) {
      errorReason = ErrPermit2InvalidNonce;
    } else {
      errorReason = `${ErrTransactionFailed}: ${message.slice(0, 500)}`;
    }
  }
  return {
    success: false,
    errorReason,
    transaction: "",
    network: payload.accepted.network,
    payer,
  };
}

/**
 * Validates EIP-2612 permit extension data for a Permit2 payment.
 *
 * @param info - The EIP-2612 gas sponsoring info
 * @param payer - The expected payer address
 * @param tokenAddress - The expected token address
 * @returns Validation result with optional invalidReason
 */
function validateEip2612PermitForPayment(
  info: Eip2612GasSponsoringInfo,
  payer: `0x${string}`,
  tokenAddress: `0x${string}`,
): { isValid: boolean; invalidReason?: string } {
  if (!validateEip2612GasSponsoringInfo(info)) {
    return { isValid: false, invalidReason: ErrInvalidEip2612ExtensionFormat };
  }

  if (getAddress(info.from as `0x${string}`) !== getAddress(payer)) {
    return { isValid: false, invalidReason: ErrEip2612FromMismatch };
  }

  if (getAddress(info.asset as `0x${string}`) !== tokenAddress) {
    return { isValid: false, invalidReason: ErrEip2612AssetMismatch };
  }

  if (getAddress(info.spender as `0x${string}`) !== getAddress(PERMIT2_ADDRESS)) {
    return { isValid: false, invalidReason: ErrEip2612SpenderNotPermit2 };
  }

  const now = Math.floor(Date.now() / 1000);
  if (BigInt(info.deadline) < BigInt(now + 6)) {
    return { isValid: false, invalidReason: ErrEip2612DeadlineExpired };
  }

  return { isValid: true };
}

/**
 * Splits a 65-byte EIP-2612 signature into v, r, s components.
 *
 * @param signature - The hex-encoded 65-byte signature
 * @returns Object with v (uint8), r (bytes32), s (bytes32)
 */
function splitEip2612Signature(signature: string): {
  v: number;
  r: `0x${string}`;
  s: `0x${string}`;
} {
  const sig = signature.startsWith("0x") ? signature.slice(2) : signature;

  if (sig.length !== 130) {
    throw new Error(
      `invalid EIP-2612 signature length: expected 65 bytes (130 hex chars), got ${sig.length / 2} bytes`,
    );
  }

  const r = `0x${sig.slice(0, 64)}` as `0x${string}`;
  const s = `0x${sig.slice(64, 128)}` as `0x${string}`;
  const v = parseInt(sig.slice(128, 130), 16);

  return { v, r, s };
}
