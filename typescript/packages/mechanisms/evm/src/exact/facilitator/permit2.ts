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
import {
  encodeFunctionData,
  getAddress,
  type Hex,
  isAddressEqual,
  parseErc6492Signature,
  parseTransaction,
} from "viem";
import {
  eip3009ABI,
  PERMIT2_ADDRESS,
  permit2WitnessTypes,
  x402ExactPermit2ProxyABI,
  x402ExactPermit2ProxyAddress,
  erc20AllowanceAbi,
} from "../../constants";
import * as Errors from "./errors";
import { multicall, ContractCall, RawContractCall } from "../../multicall";
import {
  MULTICALL3_ADDRESS,
  multicall3GetEthBalanceAbi,
} from "../../multicall";
import { FacilitatorEvmSigner } from "../../signer";
import { ExactPermit2Payload } from "../../types";
import { getEvmChainId } from "../../utils";
import { validateErc20ApprovalForPayment } from "./erc20approval";

export interface VerifyPermit2Options {
  /** Run on-chain simulation. Defaults to true. */
  simulate?: boolean;
}

export interface Permit2FacilitatorConfig {
  /**
   * If enabled, the facilitator will deploy ERC-4337 smart wallets
   * via EIP-6492 when encountering undeployed contract signatures.
   *
   * @default false
   */
  deployERC4337WithEIP6492?: boolean;
  /**
   * If enabled, run on-chain simulation during settle's re-verify.
   *
   * @default false
   */
  simulateInSettle?: boolean;
}

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
 * @param options - Optional verification options (simulate defaults to true)
 * @returns Promise resolving to verification response
 */
export async function verifyPermit2(
  signer: FacilitatorEvmSigner,
  payload: PaymentPayload,
  requirements: PaymentRequirements,
  permit2Payload: ExactPermit2Payload,
  context?: FacilitatorContext,
  options?: VerifyPermit2Options,
): Promise<VerifyResponse> {
  const payer = permit2Payload.permit2Authorization.from;

  if (payload.accepted.scheme !== "exact" || requirements.scheme !== "exact") {
    return {
      isValid: false,
      invalidReason: "unsupported_scheme",
      payer,
    };
  }

  if (payload.accepted.network !== requirements.network) {
    return {
      isValid: false,
      invalidReason: "network_mismatch",
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
      invalidReason: "invalid_permit2_spender",
      payer,
    };
  }

  if (
    getAddress(permit2Payload.permit2Authorization.witness.to) !== getAddress(requirements.payTo)
  ) {
    return {
      isValid: false,
      invalidReason: "invalid_permit2_recipient_mismatch",
      payer,
    };
  }

  const now = Math.floor(Date.now() / 1000);
  if (BigInt(permit2Payload.permit2Authorization.deadline) < BigInt(now + 6)) {
    return {
      isValid: false,
      invalidReason: "permit2_deadline_expired",
      payer,
    };
  }

  if (BigInt(permit2Payload.permit2Authorization.witness.validAfter) > BigInt(now)) {
    return {
      isValid: false,
      invalidReason: "permit2_not_yet_valid",
      payer,
    };
  }

  // Verify amount exactly matches requirements
  if (
    BigInt(permit2Payload.permit2Authorization.permitted.amount) !== BigInt(requirements.amount)
  ) {
    return {
      isValid: false,
      invalidReason: "permit2_amount_mismatch",
      payer,
    };
  }

  if (getAddress(permit2Payload.permit2Authorization.permitted.token) !== tokenAddress) {
    return {
      isValid: false,
      invalidReason: "permit2_token_mismatch",
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

  let isValid = false;
  try {
    isValid = await signer.verifyTypedData({
      address: payer,
      ...permit2TypedData,
      signature: permit2Payload.signature,
    });
  } catch {
    isValid = false;
  }

  const sigLen = permit2Payload.signature.startsWith("0x")
    ? permit2Payload.signature.length - 2
    : permit2Payload.signature.length;
  const erc6492Data = parseErc6492Signature(permit2Payload.signature);
  const hasDeploymentInfo =
    erc6492Data.address &&
    erc6492Data.data &&
    !isAddressEqual(erc6492Data.address, "0x0000000000000000000000000000000000000000");

  if (!isValid) {
    const isSmartWallet = sigLen > 130;

    if (!isSmartWallet) {
      return {
        isValid: false,
        invalidReason: "invalid_permit2_signature",
        payer,
      };
    }

    const bytecode = await signer.getCode({ address: payer });
    const isDeployed = bytecode && bytecode !== "0x";

    if (isDeployed) {
      return {
        isValid: false,
        invalidReason: "invalid_permit2_signature",
        payer,
      };
    }

    if (!hasDeploymentInfo) {
      return {
        isValid: false,
        invalidReason: Errors.ErrPermit2UndeployedSmartWallet,
        payer,
      };
    }
  }

  const allowanceResult = await _verifyPermit2Allowance(
    signer,
    payload,
    requirements,
    payer,
    tokenAddress,
    context,
  );
  if (!allowanceResult.continue) {
    return allowanceResult.response;
  }

  const allowancePath = allowanceResult.path;

  if (options?.simulate !== false) {
    const simulationResult = await _simulatePermit2Settlement(
      signer,
      payload,
      requirements,
      permit2Payload,
      context,
      allowancePath,
      erc6492Data,
    );
    if (simulationResult) {
      return simulationResult;
    }
  }

  return {
    isValid: true,
    invalidReason: undefined,
    payer,
  };
}

type AllowancePath = "standard" | "eip2612" | "erc20approval";

type AllowanceVerifyResult =
  | { continue: false; response: VerifyResponse }
  | { continue: true; path: AllowancePath };

/**
 * Checks Permit2 allowance and validates gas sponsoring extensions if allowance is insufficient.
 *
 * @param signer - The facilitator signer for on-chain reads
 * @param payload - The payment payload
 * @param requirements - The payment requirements
 * @param payer - The payer address
 * @param tokenAddress - The token contract address
 * @param context - Optional facilitator context for extension lookup
 * @returns Result indicating whether to continue and which settlement path applies
 */
async function _verifyPermit2Allowance(
  signer: FacilitatorEvmSigner,
  payload: PaymentPayload,
  requirements: PaymentRequirements,
  payer: `0x${string}`,
  tokenAddress: `0x${string}`,
  context?: FacilitatorContext,
): Promise<AllowanceVerifyResult> {
  try {
    const allowance = (await signer.readContract({
      address: tokenAddress,
      abi: erc20AllowanceAbi,
      functionName: "allowance",
      args: [payer, PERMIT2_ADDRESS],
    })) as bigint;

    if (allowance >= BigInt(requirements.amount)) {
      return { continue: true, path: "standard" };
    }

    // Allowance insufficient — try EIP-2612 gas sponsoring first
    const eip2612Info = extractEip2612GasSponsoringInfo(payload);
    if (eip2612Info) {
      const result = validateEip2612PermitForPayment(eip2612Info, payer, tokenAddress);
      if (!result.isValid) {
        return { continue: false, response: { isValid: false, invalidReason: result.invalidReason!, payer } };
      }
      return { continue: true, path: "eip2612" };
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
          return { continue: false, response: { isValid: false, invalidReason: result.invalidReason!, payer } };
        }
        return { continue: true, path: "erc20approval" };
      }
    }

    return { continue: false, response: { isValid: false, invalidReason: "permit2_allowance_required", payer } };
  } catch {
    // If allowance check fails, validate extensions if present; otherwise proceed optimistically
    const eip2612Info = extractEip2612GasSponsoringInfo(payload);
    if (eip2612Info) {
      const result = validateEip2612PermitForPayment(eip2612Info, payer, tokenAddress);
      if (!result.isValid) {
        return { continue: false, response: { isValid: false, invalidReason: result.invalidReason!, payer } };
      }
      return { continue: true, path: "eip2612" };
    }
    return { continue: true, path: "standard" };
  }
}

function _buildSettleArgs(
  permit2Payload: ExactPermit2Payload,
  signature: `0x${string}`,
): [
  { permitted: { token: `0x${string}`; amount: bigint }; nonce: bigint; deadline: bigint },
  `0x${string}`,
  { to: `0x${string}`; validAfter: bigint },
  `0x${string}`,
] {
  const auth = permit2Payload.permit2Authorization;
  return [
    {
      permitted: {
        token: getAddress(auth.permitted.token),
        amount: BigInt(auth.permitted.amount),
      },
      nonce: BigInt(auth.nonce),
      deadline: BigInt(auth.deadline),
    },
    getAddress(auth.from),
    {
      to: getAddress(auth.witness.to),
      validAfter: BigInt(auth.witness.validAfter),
    },
    signature,
  ];
}

async function _simulatePermit2Settlement(
  signer: FacilitatorEvmSigner,
  payload: PaymentPayload,
  requirements: PaymentRequirements,
  permit2Payload: ExactPermit2Payload,
  context: FacilitatorContext | undefined,
  allowancePath: AllowancePath,
  erc6492Data: ReturnType<typeof parseErc6492Signature>,
): Promise<VerifyResponse | null> {
  const payer = permit2Payload.permit2Authorization.from;
  const tokenAddress = getAddress(requirements.asset);
  const hasDeploymentInfo =
    erc6492Data.address &&
    erc6492Data.data &&
    !isAddressEqual(erc6492Data.address, "0x0000000000000000000000000000000000000000");
  const signatureToUse = hasDeploymentInfo ? (erc6492Data.signature as `0x${string}`) : permit2Payload.signature;

  let simulationFailed = false;

  if (hasDeploymentInfo) {
    const factoryAddress = getAddress(erc6492Data.address!);
    const factoryCalldata = erc6492Data.data as Hex;

    if (allowancePath === "eip2612") {
      const eip2612Info = extractEip2612GasSponsoringInfo(payload);
      if (!eip2612Info) {
        simulationFailed = true;
      } else {
        const { v, r, s } = splitEip2612Signature(eip2612Info.signature);
        const settleCalldata = encodeFunctionData({
          abi: x402ExactPermit2ProxyABI,
          functionName: "settleWithPermit",
          args: [
            { value: BigInt(eip2612Info.amount), deadline: BigInt(eip2612Info.deadline), r, s, v },
            ..._buildSettleArgs(permit2Payload, signatureToUse),
          ],
        });
        const results = await multicall(signer.readContract.bind(signer), [
          { address: factoryAddress, callData: factoryCalldata } satisfies RawContractCall,
          { address: x402ExactPermit2ProxyAddress, callData: settleCalldata } satisfies RawContractCall,
        ]);
        if (results[1]?.status !== "success") {
          simulationFailed = true;
        }
      }
    } else {
      const settleCalldata = encodeFunctionData({
        abi: x402ExactPermit2ProxyABI,
        functionName: "settle",
        args: _buildSettleArgs(permit2Payload, signatureToUse),
      });
      const results = await multicall(signer.readContract.bind(signer), [
        { address: factoryAddress, callData: factoryCalldata } satisfies RawContractCall,
        { address: x402ExactPermit2ProxyAddress, callData: settleCalldata } satisfies RawContractCall,
      ]);
      if (results[1]?.status !== "success") {
        simulationFailed = true;
      }
    }
  } else {
    if (allowancePath === "eip2612") {
      const eip2612Info = extractEip2612GasSponsoringInfo(payload);
      if (!eip2612Info) {
        simulationFailed = true;
      } else {
        try {
          const { v, r, s } = splitEip2612Signature(eip2612Info.signature);
          await signer.readContract({
            address: x402ExactPermit2ProxyAddress,
            abi: x402ExactPermit2ProxyABI,
            functionName: "settleWithPermit",
            args: [
              { value: BigInt(eip2612Info.amount), deadline: BigInt(eip2612Info.deadline), r, s, v },
              ..._buildSettleArgs(permit2Payload, signatureToUse),
            ],
          });
        } catch {
          simulationFailed = true;
        }
      }
    } else {
      try {
        await signer.readContract({
          address: x402ExactPermit2ProxyAddress,
          abi: x402ExactPermit2ProxyABI,
          functionName: "settle",
          args: _buildSettleArgs(permit2Payload, signatureToUse),
        });
      } catch {
        simulationFailed = true;
      }
    }
  }

  if (simulationFailed) {
    return diagnosePermit2SimulationFailure(
      signer,
      payload,
      requirements,
      permit2Payload,
      context,
      allowancePath,
    );
  }

  return null;
}

async function diagnosePermit2SimulationFailure(
  signer: FacilitatorEvmSigner,
  payload: PaymentPayload,
  requirements: PaymentRequirements,
  permit2Payload: ExactPermit2Payload,
  context: FacilitatorContext | undefined,
  allowancePath: AllowancePath,
): Promise<VerifyResponse> {
  const payer = permit2Payload.permit2Authorization.from;
  const tokenAddress = getAddress(requirements.asset);

  const proxyBytecode = await signer.getCode({ address: x402ExactPermit2ProxyAddress });
  if (!proxyBytecode || proxyBytecode === "0x") {
    return { isValid: false, invalidReason: Errors.ErrPermit2ProxyNotDeployed, payer };
  }

  const diagnosticCalls: (ContractCall | RawContractCall)[] = [
    {
      address: tokenAddress,
      abi: eip3009ABI,
      functionName: "balanceOf",
      args: [payer],
    },
    {
      address: tokenAddress,
      abi: erc20AllowanceAbi,
      functionName: "allowance",
      args: [payer, PERMIT2_ADDRESS],
    },
  ];

  if (allowancePath === "erc20approval") {
    diagnosticCalls.push({
      address: MULTICALL3_ADDRESS,
      abi: multicall3GetEthBalanceAbi,
      functionName: "getEthBalance",
      args: [payer],
    });
  }

  try {
    const results = await multicall(signer.readContract.bind(signer), diagnosticCalls);

    const [balanceResult, allowanceResult, ethBalanceResult] = results;

    if (balanceResult?.status === "success") {
      const balance = balanceResult.result as bigint;
      if (balance < BigInt(requirements.amount)) {
        return { isValid: false, invalidReason: Errors.ErrPermit2InsufficientBalance, payer };
      }
    }

    if (allowancePath === "erc20approval") {
      const erc20Info = extractErc20ApprovalGasSponsoringInfo(payload);
      const erc20Extension = context?.getExtension<Erc20ApprovalGasSponsoringFacilitatorExtension>(
        ERC20_APPROVAL_GAS_SPONSORING.key,
      );
      const hasValidErc20Approval = erc20Info && erc20Extension?.signer;

      if (hasValidErc20Approval && allowanceResult?.status === "success") {
        const allowance = allowanceResult.result as bigint;
        if (allowance < BigInt(requirements.amount)) {
          return { isValid: true, invalidReason: undefined, payer };
        }
      }

      if (ethBalanceResult?.status === "success") {
        const ethBalance = ethBalanceResult.result as bigint;
        const maxGasCost = _computeErc20ApprovalMaxGasCost(erc20Info?.signedTransaction);
        if (maxGasCost > 0n && ethBalance < maxGasCost) {
          return { isValid: false, invalidReason: Errors.ErrPermit2InsufficientGas, payer };
        }
      }
    } else if (allowanceResult?.status === "success") {
      const allowance = allowanceResult.result as bigint;
      if (allowance < BigInt(requirements.amount)) {
        return { isValid: false, invalidReason: Errors.ErrPermit2AllowanceInsufficient, payer };
      }
    }
  } catch {
    // Fall through to generic error
  }

  return { isValid: false, invalidReason: Errors.ErrPermit2SimulationFailed, payer };
}

function _computeErc20ApprovalMaxGasCost(signedTransaction?: string): bigint {
  if (!signedTransaction) {
    return 0n;
  }
  try {
    const tx = parseTransaction(signedTransaction as `0x${string}`);
    const gas = tx.gas ?? 0n;
    const maxFee = tx.maxFeePerGas ?? tx.gasPrice ?? 0n;
    return gas * maxFee;
  } catch {
    return 0n;
  }
}

async function _ensureEip6492DeployedAndGetSignature(
  signer: FacilitatorEvmSigner,
  payer: `0x${string}`,
  permit2Payload: ExactPermit2Payload,
  config?: Permit2FacilitatorConfig,
): Promise<`0x${string}`> {
  const { signature, address: factoryAddress, data: factoryCalldata } = parseErc6492Signature(
    permit2Payload.signature,
  );

  const shouldDeploy =
    config?.deployERC4337WithEIP6492 &&
    factoryAddress &&
    factoryCalldata &&
    !isAddressEqual(factoryAddress, "0x0000000000000000000000000000000000000000");

  if (shouldDeploy) {
    const bytecode = await signer.getCode({ address: payer });
    if (!bytecode || bytecode === "0x") {
      const deployTx = await signer.sendTransaction({
        to: factoryAddress as Hex,
        data: factoryCalldata as Hex,
      });
      await signer.waitForTransactionReceipt({ hash: deployTx });
    }
  }

  return signature as `0x${string}`;
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
 * @param config - Optional facilitator configuration
 * @returns Promise resolving to settlement response
 */
export async function settlePermit2(
  signer: FacilitatorEvmSigner,
  payload: PaymentPayload,
  requirements: PaymentRequirements,
  permit2Payload: ExactPermit2Payload,
  context?: FacilitatorContext,
  config?: Permit2FacilitatorConfig,
): Promise<SettleResponse> {
  const payer = permit2Payload.permit2Authorization.from;

  const valid = await verifyPermit2(signer, payload, requirements, permit2Payload, context, {
    simulate: config?.simulateInSettle ?? false,
  });
  if (!valid.isValid) {
    return {
      success: false,
      network: payload.accepted.network,
      transaction: "",
      errorReason: valid.invalidReason ?? "invalid_scheme",
      payer,
    };
  }

  // Branch: EIP-2612 gas sponsoring (atomic settleWithPermit via contract)
  const eip2612Info = extractEip2612GasSponsoringInfo(payload);
  if (eip2612Info) {
    return _settlePermit2WithEIP2612(signer, payload, permit2Payload, eip2612Info, config);
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
        config,
      );
    }
  }

  // Branch: standard settle (allowance already on-chain)
  return _settlePermit2Direct(signer, payload, permit2Payload, config);
}

/**
 * Settles via settleWithPermit — includes the EIP-2612 permit atomically in one tx.
 *
 * @param signer - The base facilitator signer
 * @param payload - The payment payload
 * @param permit2Payload - The Permit2 specific payload
 * @param eip2612Info - The EIP-2612 gas sponsoring info from the payload extension
 * @param config - Optional facilitator configuration for EIP-6492 deployment
 * @returns Promise resolving to settlement response
 */
async function _settlePermit2WithEIP2612(
  signer: FacilitatorEvmSigner,
  payload: PaymentPayload,
  permit2Payload: ExactPermit2Payload,
  eip2612Info: Eip2612GasSponsoringInfo,
  config?: Permit2FacilitatorConfig,
): Promise<SettleResponse> {
  const payer = permit2Payload.permit2Authorization.from;
  try {
    const signature = await _ensureEip6492DeployedAndGetSignature(
      signer,
      payer,
      permit2Payload,
      config,
    );
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
        signature,
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
  config?: Permit2FacilitatorConfig,
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
        errorReason: "erc20_approval_tx_failed",
        transaction: approvalTxHash,
        network: payload.accepted.network,
        payer,
      };
    }

    const signature = await _ensureEip6492DeployedAndGetSignature(
      extensionSigner as FacilitatorEvmSigner,
      payer,
      permit2Payload,
      config,
    );

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
        signature,
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
 * @param config - Optional facilitator configuration for EIP-6492 deployment
 * @returns Promise resolving to settlement response
 */
async function _settlePermit2Direct(
  signer: FacilitatorEvmSigner,
  payload: PaymentPayload,
  permit2Payload: ExactPermit2Payload,
  config?: Permit2FacilitatorConfig,
): Promise<SettleResponse> {
  const payer = permit2Payload.permit2Authorization.from;
  try {
    const signature = await _ensureEip6492DeployedAndGetSignature(
      signer,
      payer,
      permit2Payload,
      config,
    );

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
        signature,
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
      errorReason: "invalid_transaction_state",
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
  let errorReason = "transaction_failed";
  if (error instanceof Error) {
    const message = error.message;
    if (message.includes("Permit2612AmountMismatch")) {
      errorReason = Errors.ErrPermit2612AmountMismatch;
    } else if (message.includes("InvalidAmount")) {
      errorReason = Errors.ErrPermit2InvalidAmount;
    } else if (message.includes("InvalidDestination")) {
      errorReason = Errors.ErrPermit2InvalidDestination;
    } else if (message.includes("InvalidOwner")) {
      errorReason = Errors.ErrPermit2InvalidOwner;
    } else if (message.includes("PaymentTooEarly")) {
      errorReason = Errors.ErrPermit2PaymentTooEarly;
    } else if (message.includes("InvalidSignature") || message.includes("SignatureExpired")) {
      errorReason = Errors.ErrPermit2InvalidSignature;
    } else if (message.includes("InvalidNonce")) {
      errorReason = Errors.ErrPermit2InvalidNonce;
    } else {
      errorReason = `transaction_failed: ${message.slice(0, 500)}`;
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
    return { isValid: false, invalidReason: "invalid_eip2612_extension_format" };
  }

  if (getAddress(info.from as `0x${string}`) !== getAddress(payer)) {
    return { isValid: false, invalidReason: "eip2612_from_mismatch" };
  }

  if (getAddress(info.asset as `0x${string}`) !== tokenAddress) {
    return { isValid: false, invalidReason: "eip2612_asset_mismatch" };
  }

  if (getAddress(info.spender as `0x${string}`) !== getAddress(PERMIT2_ADDRESS)) {
    return { isValid: false, invalidReason: "eip2612_spender_not_permit2" };
  }

  const now = Math.floor(Date.now() / 1000);
  if (BigInt(info.deadline) < BigInt(now + 6)) {
    return { isValid: false, invalidReason: "eip2612_deadline_expired" };
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
