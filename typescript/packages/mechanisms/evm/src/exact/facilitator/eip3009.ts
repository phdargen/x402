import {
  PaymentPayload,
  PaymentRequirements,
  SettleResponse,
  VerifyResponse,
} from "@x402/core/types";
import { getAddress, Hex, isAddressEqual, parseErc6492Signature, parseSignature } from "viem";
import { authorizationTypes, eip3009ABI } from "../../constants";
import { FacilitatorEvmSigner } from "../../signer";
import { getEvmChainId } from "../../utils";
import { ExactEIP3009Payload } from "../../types";
import {
  ErrUnsupportedScheme,
  ErrMissingEip712Domain,
  ErrNetworkMismatch,
  ErrInvalidPayloadSignature,
  ErrUndeployedSmartWallet,
  ErrPayloadRecipientMismatch,
  ErrValidBeforeExpired,
  ErrValidAfterInFuture,
  ErrInsufficientFunds,
  ErrPayloadAuthorizationValueMismatch,
  ErrInvalidSchemeFallback,
  ErrInvalidTransactionState,
  ErrTransactionFailed,
} from "./errors";

export interface EIP3009FacilitatorConfig {
  /**
   * If enabled, the facilitator will deploy ERC-4337 smart wallets
   * via EIP-6492 when encountering undeployed contract signatures.
   *
   * @default false
   */
  deployERC4337WithEIP6492: boolean;
}

/**
 * Verifies an EIP-3009 payment payload.
 *
 * @param signer - The facilitator signer for contract reads
 * @param payload - The payment payload to verify
 * @param requirements - The payment requirements
 * @param eip3009Payload - The EIP-3009 specific payload
 * @returns Promise resolving to verification response
 */
export async function verifyEIP3009(
  signer: FacilitatorEvmSigner,
  payload: PaymentPayload,
  requirements: PaymentRequirements,
  eip3009Payload: ExactEIP3009Payload,
): Promise<VerifyResponse> {
  const payer = eip3009Payload.authorization.from;

  // Verify scheme matches
  if (payload.accepted.scheme !== "exact" || requirements.scheme !== "exact") {
    return {
      isValid: false,
      invalidReason: ErrUnsupportedScheme,
      payer,
    };
  }

  // Get chain configuration
  if (!requirements.extra?.name || !requirements.extra?.version) {
    return {
      isValid: false,
      invalidReason: ErrMissingEip712Domain,
      payer,
    };
  }

  const { name, version } = requirements.extra;
  const erc20Address = getAddress(requirements.asset);

  // Verify network matches
  if (payload.accepted.network !== requirements.network) {
    return {
      isValid: false,
      invalidReason: ErrNetworkMismatch,
      payer,
    };
  }

  // Build typed data for signature verification
  const permitTypedData = {
    types: authorizationTypes,
    primaryType: "TransferWithAuthorization" as const,
    domain: {
      name,
      version,
      chainId: getEvmChainId(requirements.network),
      verifyingContract: erc20Address,
    },
    message: {
      from: eip3009Payload.authorization.from,
      to: eip3009Payload.authorization.to,
      value: BigInt(eip3009Payload.authorization.value),
      validAfter: BigInt(eip3009Payload.authorization.validAfter),
      validBefore: BigInt(eip3009Payload.authorization.validBefore),
      nonce: eip3009Payload.authorization.nonce,
    },
  };

  // Verify signature
  try {
    const recoveredAddress = await signer.verifyTypedData({
      address: eip3009Payload.authorization.from,
      ...permitTypedData,
      signature: eip3009Payload.signature!,
    });

    if (!recoveredAddress) {
      return {
        isValid: false,
        invalidReason: ErrInvalidPayloadSignature,
        payer,
      };
    }
  } catch {
    // Signature verification failed - could be an undeployed smart wallet
    // Check if smart wallet is deployed
    const signature = eip3009Payload.signature!;
    const signatureLength = signature.startsWith("0x") ? signature.length - 2 : signature.length;
    const isSmartWallet = signatureLength > 130; // 65 bytes = 130 hex chars for EOA

    if (isSmartWallet) {
      const payerAddress = eip3009Payload.authorization.from;
      const bytecode = await signer.getCode({ address: payerAddress });

      if (!bytecode || bytecode === "0x") {
        // Wallet is not deployed. Check if it's EIP-6492 with deployment info.
        const erc6492Data = parseErc6492Signature(signature);
        const hasDeploymentInfo =
          erc6492Data.address &&
          erc6492Data.data &&
          !isAddressEqual(erc6492Data.address, "0x0000000000000000000000000000000000000000");

        if (!hasDeploymentInfo) {
          // Non-EIP-6492 undeployed smart wallet - will always fail at settlement
          return {
            isValid: false,
            invalidReason: ErrUndeployedSmartWallet,
            payer: payerAddress,
          };
        }
        // EIP-6492 signature with deployment info - allow through
      } else {
        // Wallet is deployed but signature still failed - invalid signature
        return {
          isValid: false,
          invalidReason: ErrInvalidPayloadSignature,
          payer,
        };
      }
    } else {
      // EOA signature failed
      return {
        isValid: false,
        invalidReason: ErrInvalidPayloadSignature,
        payer,
      };
    }
  }

  // Verify payment recipient matches
  if (getAddress(eip3009Payload.authorization.to) !== getAddress(requirements.payTo)) {
    return {
      isValid: false,
      invalidReason: ErrPayloadRecipientMismatch,
      payer,
    };
  }

  // Verify validBefore is in the future (with 6 second buffer for block time)
  const now = Math.floor(Date.now() / 1000);
  if (BigInt(eip3009Payload.authorization.validBefore) < BigInt(now + 6)) {
    return {
      isValid: false,
      invalidReason: ErrValidBeforeExpired,
      payer,
    };
  }

  // Verify validAfter is not in the future
  if (BigInt(eip3009Payload.authorization.validAfter) > BigInt(now)) {
    return {
      isValid: false,
      invalidReason: ErrValidAfterInFuture,
      payer,
    };
  }

  // Check balance
  try {
    const balance = (await signer.readContract({
      address: erc20Address,
      abi: eip3009ABI,
      functionName: "balanceOf",
      args: [eip3009Payload.authorization.from],
    })) as bigint;

    if (BigInt(balance) < BigInt(requirements.amount)) {
      return {
        isValid: false,
        invalidReason: ErrInsufficientFunds,
        invalidMessage: `Insufficient funds to complete the payment. Required: ${requirements.amount} ${requirements.asset}, Available: ${balance.toString()} ${requirements.asset}. Please add funds to your wallet and try again.`,
        payer,
      };
    }
  } catch {
    // If we can't check balance, continue with other validations
  }

  // Verify amount exactly matches requirements
  if (BigInt(eip3009Payload.authorization.value) !== BigInt(requirements.amount)) {
    return {
      isValid: false,
      invalidReason: ErrPayloadAuthorizationValueMismatch,
      payer,
    };
  }

  return {
    isValid: true,
    invalidReason: undefined,
    payer,
  };
}

/**
 * Settles an EIP-3009 payment by executing transferWithAuthorization.
 *
 * @param signer - The facilitator signer for contract writes
 * @param payload - The payment payload to settle
 * @param requirements - The payment requirements
 * @param eip3009Payload - The EIP-3009 specific payload
 * @param config - Facilitator configuration
 * @returns Promise resolving to settlement response
 */
export async function settleEIP3009(
  signer: FacilitatorEvmSigner,
  payload: PaymentPayload,
  requirements: PaymentRequirements,
  eip3009Payload: ExactEIP3009Payload,
  config: EIP3009FacilitatorConfig,
): Promise<SettleResponse> {
  const payer = eip3009Payload.authorization.from;

  // Re-verify before settling
  const valid = await verifyEIP3009(signer, payload, requirements, eip3009Payload);
  if (!valid.isValid) {
    return {
      success: false,
      network: payload.accepted.network,
      transaction: "",
      errorReason: valid.invalidReason ?? ErrInvalidSchemeFallback,
      payer,
    };
  }

  try {
    // Parse ERC-6492 signature if applicable
    const parseResult = parseErc6492Signature(eip3009Payload.signature!);
    const { signature, address: factoryAddress, data: factoryCalldata } = parseResult;

    // Deploy ERC-4337 smart wallet via EIP-6492 if configured and needed
    if (
      config.deployERC4337WithEIP6492 &&
      factoryAddress &&
      factoryCalldata &&
      !isAddressEqual(factoryAddress, "0x0000000000000000000000000000000000000000")
    ) {
      // Check if smart wallet is already deployed
      const bytecode = await signer.getCode({ address: payer });

      if (!bytecode || bytecode === "0x") {
        // Wallet not deployed - attempt deployment
        const deployTx = await signer.sendTransaction({
          to: factoryAddress as Hex,
          data: factoryCalldata as Hex,
        });

        // Wait for deployment transaction
        await signer.waitForTransactionReceipt({ hash: deployTx });
      }
    }

    // Determine if this is an ECDSA signature (EOA) or smart wallet signature
    const signatureLength = signature.startsWith("0x") ? signature.length - 2 : signature.length;
    const isECDSA = signatureLength === 130;

    let tx: Hex;
    if (isECDSA) {
      // For EOA wallets, parse signature into v, r, s and use that overload
      const parsedSig = parseSignature(signature);

      tx = await signer.writeContract({
        address: getAddress(requirements.asset),
        abi: eip3009ABI,
        functionName: "transferWithAuthorization",
        args: [
          getAddress(eip3009Payload.authorization.from),
          getAddress(eip3009Payload.authorization.to),
          BigInt(eip3009Payload.authorization.value),
          BigInt(eip3009Payload.authorization.validAfter),
          BigInt(eip3009Payload.authorization.validBefore),
          eip3009Payload.authorization.nonce,
          (parsedSig.v as number | undefined) || parsedSig.yParity,
          parsedSig.r,
          parsedSig.s,
        ],
      });
    } else {
      // For smart wallets, use the bytes signature overload
      tx = await signer.writeContract({
        address: getAddress(requirements.asset),
        abi: eip3009ABI,
        functionName: "transferWithAuthorization",
        args: [
          getAddress(eip3009Payload.authorization.from),
          getAddress(eip3009Payload.authorization.to),
          BigInt(eip3009Payload.authorization.value),
          BigInt(eip3009Payload.authorization.validAfter),
          BigInt(eip3009Payload.authorization.validBefore),
          eip3009Payload.authorization.nonce,
          signature,
        ],
      });
    }

    // Wait for transaction confirmation
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
  } catch {
    return {
      success: false,
      errorReason: ErrTransactionFailed,
      transaction: "",
      network: payload.accepted.network,
      payer,
    };
  }
}
