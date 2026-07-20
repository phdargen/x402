import { describe, it, expect, beforeEach, vi } from "vitest";
import type { MockedFunction } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { getAddress } from "viem";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";

vi.mock("../../../src/multicall", async importOriginal => {
  const actual = await importOriginal<typeof import("../../../src/multicall")>();
  return { ...actual, multicall: vi.fn() };
});

import { multicall } from "../../../src/multicall";
import type { FacilitatorEvmSigner } from "../../../src/signer";
import { signVoucher } from "../../../src/batch-settlement/client/voucher";
import { computeChannelId } from "../../../src/batch-settlement/utils";
import { verifyGatewayPayment } from "../../../src/batch-settlement/gateway/facilitator/verify";
import { InMemoryGatewayChannelStorage } from "../../../src/batch-settlement/gateway/facilitator/storage";
import { computeGatewayId, signGatewayVoucher } from "../../../src/batch-settlement/gateway/utils";
import { VOUCHER_GATEWAY } from "../../../src/batch-settlement/gateway/constants";
import type { ChannelConfig } from "../../../src/batch-settlement/types";

const mockedMulticall = multicall as unknown as MockedFunction<typeof multicall>;

const PAYER_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const GATEWAY = "0x55B151f55038e7FCF2a5440a0ea0ea39D415EC2D" as `0x${string}`;
const RECEIVER = "0x1c47E9C085c2B7458F5b6C16cCBD65A65255a9f6" as `0x${string}`;
const RECEIVER_AUTHORIZER = "0xa1aD2CD47DB081d2E72507D64df0B85e4fe646e5" as `0x${string}`;
const ASSET = "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as `0x${string}`;
const NETWORK = "eip155:84532";
const FACILITATOR = "0xFAC11174700123456789012345678901234aBCDe" as `0x${string}`;

describe("gateway voucher verify multicall", () => {
  beforeEach(() => {
    mockedMulticall.mockReset();
  });

  it("uses one multicall and accepts a valid voucher without further channel reads", async () => {
    const payer = privateKeyToAccount(PAYER_KEY);
    const signer: FacilitatorEvmSigner = {
      getAddresses: () => [FACILITATOR],
      readContract: vi.fn(),
      writeContract: vi.fn(),
      sendTransaction: vi.fn(),
      waitForTransactionReceipt: vi.fn(),
      getCode: vi.fn().mockResolvedValue("0x"),
      verifyTypedData: vi.fn(),
    };

    const channelConfig: ChannelConfig = {
      payer: payer.address,
      payerAuthorizer: payer.address,
      receiver: GATEWAY,
      receiverAuthorizer: GATEWAY,
      token: ASSET,
      withdrawDelay: 900,
      salt: "0x0000000000000000000000000000000000000000000000000000000000000000",
    };
    const channelId = computeChannelId(channelConfig, NETWORK);
    const aggregateMax = "40000";
    const requestAmount = "10000";
    const priorCharged = "5000";
    const gatewayMax = (BigInt(priorCharged) + BigInt(requestAmount)).toString();

    const clientSigner = {
      address: payer.address,
      signTypedData: (msg: Parameters<typeof payer.signTypedData>[0]) => payer.signTypedData(msg),
    };
    const aggregateVoucher = await signVoucher(clientSigner, channelId, aggregateMax, NETWORK);
    const gatewayConfig = {
      channelId,
      receiver: getAddress(RECEIVER),
      receiverAuthorizer: getAddress(RECEIVER_AUTHORIZER),
    };
    const gatewayId = computeGatewayId(gatewayConfig, NETWORK, GATEWAY);
    const gatewayVoucher = await signGatewayVoucher(
      params =>
        payer.signTypedData({
          domain: params.domain,
          types: params.types,
          primaryType: params.primaryType,
          message: params.message,
        } as Parameters<typeof payer.signTypedData>[0]),
      gatewayId,
      gatewayMax,
      NETWORK,
      GATEWAY,
    );

    const storage = new InMemoryGatewayChannelStorage();
    await storage.setAggregate(channelId, {
      channel: channelConfig,
      voucher: aggregateVoucher,
    });
    await storage.setAggregateCharged(channelId, priorCharged);
    await storage.setServerCommitment(channelId, RECEIVER, {
      gatewayConfig,
      gatewayVoucher: {
        gatewayId,
        maxClaimableAmount: priorCharged,
        signature: gatewayVoucher.signature,
      },
      claimAuthorization: {
        totalClaimed: priorCharged,
        signature:
          "0x1111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111",
      },
      chargedCumulativeAmount: priorCharged,
    });

    mockedMulticall.mockResolvedValue([
      { status: "success", result: [40000n, 0n] }, // channels: balance, totalClaimed
      { status: "success", result: [0n, 0n] }, // pendingWithdrawals
      { status: "success", result: 0n }, // refundNonce
      { status: "success", result: 0n }, // distributedCumulative
      { status: "success", result: 0n }, // distributedByChannel
    ]);

    const requirements: PaymentRequirements = {
      scheme: "batch-settlement",
      network: NETWORK,
      amount: requestAmount,
      asset: ASSET,
      payTo: RECEIVER,
      maxTimeoutSeconds: 300,
      extra: {
        name: "USDC",
        version: "2",
        receiverAuthorizer: RECEIVER_AUTHORIZER,
        withdrawDelay: 900,
      },
    };

    const payload: PaymentPayload = {
      x402Version: 2,
      payload: {
        type: "voucher",
        channelConfig,
        voucher: aggregateVoucher,
      },
      accepted: requirements,
      extensions: {
        [VOUCHER_GATEWAY]: {
          info: {
            gateway: GATEWAY,
            gatewayConfig,
            gatewayVoucher,
          },
        },
      },
    };

    const result = await verifyGatewayPayment(
      {
        gateway: GATEWAY,
        withdrawDelay: 900,
        storage,
        signer,
        eip6492AllowedFactories: [],
      },
      payload,
      requirements,
    );

    expect(result.isValid).toBe(true);
    expect(mockedMulticall).toHaveBeenCalledTimes(1);
    expect(mockedMulticall.mock.calls[0]?.[1]).toHaveLength(5);
    expect(signer.readContract).not.toHaveBeenCalled();
    expect(result.extra).toMatchObject({
      channelId,
      balance: "40000",
      totalClaimed: "0",
    });
    expect(result.extensions?.["voucher-gateway"]).toMatchObject({
      info: {
        gateway: getAddress(GATEWAY),
        gatewayState: {
          gatewayId,
          distributedCumulative: "0",
        },
      },
    });
  });
});
