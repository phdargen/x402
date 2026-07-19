import { getAddress, hashTypedData, recoverAddress, isAddressEqual, verifyTypedData } from "viem";
import { getEvmChainId } from "../../utils";
import {
  GATEWAY_DOMAIN,
  gatewayClaimAuthorizationTypes,
  gatewayConfigTypes,
  gatewayVoucherTypes,
  VOUCHER_GATEWAY,
} from "./constants";
import type {
  GatewayClaimAuthorization,
  GatewayConfig,
  GatewayVoucherFields,
  VoucherGatewayExtension,
  VoucherGatewayExtensionInfo,
} from "./types";

/**
 * Returns the EIP-712 domain for a gateway contract on the given chain.
 *
 * @param chainId - Numeric EVM chain id.
 * @param gateway - Gateway contract address (verifyingContract).
 * @returns EIP-712 domain object.
 */
export function getGatewayEip712Domain(chainId: number, gateway: `0x${string}`) {
  return {
    ...GATEWAY_DOMAIN,
    chainId,
    verifyingContract: getAddress(gateway),
  } as const;
}

/**
 * Computes `gatewayId` = EIP-712 hash of GatewayConfig under the gateway domain.
 *
 * @param config - Per-server gateway config.
 * @param networkOrChainId - CAIP-2 network or numeric chain id.
 * @param gateway - Gateway contract address.
 * @returns The gatewayId digest.
 */
export function computeGatewayId(
  config: GatewayConfig,
  networkOrChainId: string | number,
  gateway: `0x${string}`,
): `0x${string}` {
  const chainId =
    typeof networkOrChainId === "number" ? networkOrChainId : getEvmChainId(networkOrChainId);
  return hashTypedData({
    domain: getGatewayEip712Domain(chainId, gateway),
    types: gatewayConfigTypes,
    primaryType: "GatewayConfig",
    message: {
      channelId: config.channelId,
      receiver: getAddress(config.receiver),
      receiverAuthorizer: getAddress(config.receiverAuthorizer),
    },
  });
}

/**
 * Computes the EIP-712 digest of a GatewayVoucher.
 *
 * @param gatewayId - Gateway config digest.
 * @param maxClaimableAmount - Cumulative ceiling as a decimal string.
 * @param networkOrChainId - CAIP-2 network or numeric chain id.
 * @param gateway - Gateway contract address.
 * @returns The gateway voucher digest.
 */
export function computeGatewayVoucherDigest(
  gatewayId: `0x${string}`,
  maxClaimableAmount: string,
  networkOrChainId: string | number,
  gateway: `0x${string}`,
): `0x${string}` {
  const chainId =
    typeof networkOrChainId === "number" ? networkOrChainId : getEvmChainId(networkOrChainId);
  return hashTypedData({
    domain: getGatewayEip712Domain(chainId, gateway),
    types: gatewayVoucherTypes,
    primaryType: "GatewayVoucher",
    message: {
      gatewayId,
      maxClaimableAmount: BigInt(maxClaimableAmount),
    },
  });
}

/**
 * Signs a GatewayVoucher with the client voucher signer.
 *
 * @param signTypedData - EIP-712 signer function.
 * @param gatewayId - Gateway config digest.
 * @param maxClaimableAmount - Cumulative ceiling.
 * @param network - CAIP-2 network identifier.
 * @param gateway - Gateway contract address.
 * @returns Signed gateway voucher fields.
 */
export async function signGatewayVoucher(
  signTypedData: (params: {
    domain: Record<string, unknown>;
    types: typeof gatewayVoucherTypes;
    primaryType: "GatewayVoucher";
    message: { gatewayId: `0x${string}`; maxClaimableAmount: bigint };
  }) => Promise<`0x${string}`>,
  gatewayId: `0x${string}`,
  maxClaimableAmount: string,
  network: string,
  gateway: `0x${string}`,
): Promise<GatewayVoucherFields> {
  const chainId = getEvmChainId(network);
  const signature = await signTypedData({
    domain: getGatewayEip712Domain(chainId, gateway),
    types: gatewayVoucherTypes,
    primaryType: "GatewayVoucher",
    message: {
      gatewayId,
      maxClaimableAmount: BigInt(maxClaimableAmount),
    },
  });
  return { gatewayId, maxClaimableAmount, signature };
}

/**
 * Signs a GatewayClaimAuthorization with the receiver authorizer.
 *
 * @param signTypedData - EIP-712 signer function.
 * @param gatewayVoucherDigest - Digest of the paired GatewayVoucher.
 * @param totalClaimed - Actual cumulative charged.
 * @param network - CAIP-2 network identifier.
 * @param gateway - Gateway contract address.
 * @returns Signed claim authorization (wire shape, digest omitted).
 */
export async function signGatewayClaimAuthorization(
  signTypedData: (params: {
    domain: Record<string, unknown>;
    types: typeof gatewayClaimAuthorizationTypes;
    primaryType: "GatewayClaimAuthorization";
    message: { gatewayVoucherDigest: `0x${string}`; totalClaimed: bigint };
  }) => Promise<`0x${string}`>,
  gatewayVoucherDigest: `0x${string}`,
  totalClaimed: string,
  network: string,
  gateway: `0x${string}`,
): Promise<GatewayClaimAuthorization> {
  const chainId = getEvmChainId(network);
  const signature = await signTypedData({
    domain: getGatewayEip712Domain(chainId, gateway),
    types: gatewayClaimAuthorizationTypes,
    primaryType: "GatewayClaimAuthorization",
    message: {
      gatewayVoucherDigest,
      totalClaimed: BigInt(totalClaimed),
    },
  });
  return { totalClaimed, signature };
}

/**
 * Verifies a GatewayVoucher signature against the client authorization identity.
 *
 * @param params - Verification inputs.
 * @param params.gateway - Gateway contract address.
 * @param params.network - Network identifier.
 * @param params.gatewayId - Gateway voucher id.
 * @param params.maxClaimableAmount - Max claimable amount as a decimal string.
 * @param params.signature - Gateway voucher signature bytes.
 * @param params.payerAuthorizer - Payer authorizer address; zero address selects ERC-1271 verification.
 * @param params.payer - Payer contract address (used for ERC-1271).
 * @returns Whether the signature is valid.
 */
export async function verifyGatewayVoucherSignature(params: {
  gateway: `0x${string}`;
  network: string;
  gatewayId: `0x${string}`;
  maxClaimableAmount: string;
  signature: `0x${string}`;
  payerAuthorizer: `0x${string}`;
  payer: `0x${string}`;
}): Promise<boolean> {
  const chainId = getEvmChainId(params.network);
  const domain = getGatewayEip712Domain(chainId, params.gateway);
  const message = {
    gatewayId: params.gatewayId,
    maxClaimableAmount: BigInt(params.maxClaimableAmount),
  };
  const zeroAddress = "0x0000000000000000000000000000000000000000";

  if (params.payerAuthorizer !== zeroAddress) {
    try {
      const digest = hashTypedData({
        domain,
        types: gatewayVoucherTypes,
        primaryType: "GatewayVoucher",
        message,
      });
      const recovered = await recoverAddress({ hash: digest, signature: params.signature });
      return isAddressEqual(recovered, getAddress(params.payerAuthorizer));
    } catch {
      return false;
    }
  }

  return verifyTypedData({
    address: getAddress(params.payer),
    domain,
    types: gatewayVoucherTypes,
    primaryType: "GatewayVoucher",
    message,
    signature: params.signature,
  });
}

/**
 * Verifies a GatewayClaimAuthorization signature against receiverAuthorizer.
 *
 * @param params - Verification inputs.
 * @param params.gateway - Gateway contract address.
 * @param params.network - Network identifier.
 * @param params.gatewayVoucherDigest - Digest of the gateway voucher being claimed against.
 * @param params.totalClaimed - Total claimed amount as a decimal string.
 * @param params.signature - Gateway claim authorization signature bytes.
 * @param params.receiverAuthorizer - Receiver authorizer address.
 * @returns Whether the signature is valid.
 */
export async function verifyGatewayClaimAuthorizationSignature(params: {
  gateway: `0x${string}`;
  network: string;
  gatewayVoucherDigest: `0x${string}`;
  totalClaimed: string;
  signature: `0x${string}`;
  receiverAuthorizer: `0x${string}`;
}): Promise<boolean> {
  const chainId = getEvmChainId(params.network);
  try {
    return await verifyTypedData({
      address: getAddress(params.receiverAuthorizer),
      domain: getGatewayEip712Domain(chainId, params.gateway),
      types: gatewayClaimAuthorizationTypes,
      primaryType: "GatewayClaimAuthorization",
      message: {
        gatewayVoucherDigest: params.gatewayVoucherDigest,
        totalClaimed: BigInt(params.totalClaimed),
      },
      signature: params.signature,
    });
  } catch {
    return false;
  }
}

/**
 * Narrows an untrusted payment/extensions value to voucher-gateway extension info.
 *
 * @param extensions - Payment payload or required extensions map.
 * @returns Parsed extension info, or undefined when absent/malformed.
 */
export function readVoucherGatewayInfo(
  extensions: Record<string, unknown> | undefined,
): VoucherGatewayExtensionInfo | undefined {
  if (!extensions) return undefined;
  const raw = extensions[VOUCHER_GATEWAY];
  if (typeof raw !== "object" || raw === null) return undefined;
  const info = (raw as VoucherGatewayExtension).info;
  if (typeof info !== "object" || info === null) return undefined;
  if (typeof info.gateway !== "string") return undefined;
  return info as VoucherGatewayExtensionInfo;
}

/**
 * Returns true when the payload advertises the voucher-gateway extension.
 *
 * @param extensions - Payment payload extensions map.
 * @returns Whether voucher-gateway info is present.
 */
export function hasVoucherGatewayExtension(
  extensions: Record<string, unknown> | undefined,
): boolean {
  return readVoucherGatewayInfo(extensions) !== undefined;
}
