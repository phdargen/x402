import { hashTypedData, getAddress, verifyTypedData } from "viem";
import type { ClientEvmSigner, ChannelConfig } from "@x402/evm";
import {
  BATCH_SETTLEMENT_ADDRESS,
  BATCH_SETTLEMENT_DOMAIN,
  voucherTypes,
} from "@x402/evm";
import { CHAIN_ID, USDC_ADDRESS, WITHDRAW_DELAY } from "./config";

const channelConfigTypes = {
  ChannelConfig: [
    { name: "payer", type: "address" },
    { name: "payerAuthorizer", type: "address" },
    { name: "receiver", type: "address" },
    { name: "receiverAuthorizer", type: "address" },
    { name: "token", type: "address" },
    { name: "withdrawDelay", type: "uint40" },
    { name: "salt", type: "bytes32" },
  ],
} as const;

function getBatchSettlementEip712Domain(chainId: number) {
  return {
    ...BATCH_SETTLEMENT_DOMAIN,
    chainId,
    verifyingContract: getAddress(BATCH_SETTLEMENT_ADDRESS),
  } as const;
}

export function computeChannelId(config: ChannelConfig, chainId: number): `0x${string}` {
  return hashTypedData({
    domain: getBatchSettlementEip712Domain(chainId),
    types: channelConfigTypes,
    primaryType: "ChannelConfig",
    message: {
      payer: config.payer,
      payerAuthorizer: config.payerAuthorizer,
      receiver: config.receiver,
      receiverAuthorizer: config.receiverAuthorizer,
      token: config.token,
      withdrawDelay: config.withdrawDelay,
      salt: config.salt,
    },
  });
}

export type GameChannelState = {
  channelId: `0x${string}`;
  channelConfig: ChannelConfig;
  depositAmount: string;
  chargedCumulativeAmount: bigint;
  jumpCount: number;
  distance: number;
  lastVoucher: {
    channelId: `0x${string}`;
    maxClaimableAmount: string;
    signature: `0x${string}`;
  } | null;
};

export function buildGameChannelConfig(
  playerAddress: `0x${string}`,
  sessionAddress: `0x${string}`,
  receiverAddress: `0x${string}`,
  receiverAuthorizerAddress: `0x${string}`,
  salt: `0x${string}`,
): { config: ChannelConfig; channelId: `0x${string}` } {
  const config: ChannelConfig = {
    payer: playerAddress,
    payerAuthorizer: sessionAddress,
    receiver: receiverAddress,
    receiverAuthorizer: receiverAuthorizerAddress,
    token: USDC_ADDRESS,
    withdrawDelay: WITHDRAW_DELAY,
    salt,
  };
  const channelId = computeChannelId(config, CHAIN_ID);
  return { config, channelId };
}

export async function signGameVoucher(
  signer: ClientEvmSigner,
  channelId: `0x${string}`,
  cumulativeAmount: bigint,
) {
  const signature = await signer.signTypedData({
    domain: getBatchSettlementEip712Domain(CHAIN_ID),
    types: voucherTypes,
    primaryType: "Voucher",
    message: {
      channelId,
      maxClaimableAmount: cumulativeAmount,
    },
  });

  return {
    channelId,
    maxClaimableAmount: cumulativeAmount.toString(),
    signature,
  };
}

export async function verifyGameVoucher(
  signerAddress: `0x${string}`,
  voucher: {
    channelId: `0x${string}`;
    maxClaimableAmount: string;
    signature: `0x${string}`;
  },
): Promise<boolean> {
  try {
    return await verifyTypedData({
      address: getAddress(signerAddress),
      domain: getBatchSettlementEip712Domain(CHAIN_ID),
      types: voucherTypes,
      primaryType: "Voucher",
      message: {
        channelId: voucher.channelId,
        maxClaimableAmount: BigInt(voucher.maxClaimableAmount),
      },
      signature: voucher.signature,
    });
  } catch {
    return false;
  }
}
