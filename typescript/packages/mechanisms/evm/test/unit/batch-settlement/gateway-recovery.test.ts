import { describe, it, expect, vi } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { getAddress } from "viem";
import type { PaymentRequired, PaymentRequirements } from "@x402/core/types";
import type { ClientEvmSigner } from "../../../src/signer";
import {
  processGatewayCorrectivePaymentRequired,
  recoverGatewayChannel,
} from "../../../src/batch-settlement/gateway/client/recovery";
import { InMemoryGatewayClientStorage } from "../../../src/batch-settlement/gateway/client/storage";
import type { GatewayClientPaymentDeps } from "../../../src/batch-settlement/gateway/client/deps";
import { buildGatewayChannelConfig } from "../../../src/batch-settlement/gateway/client/deps";
import { computeChannelId } from "../../../src/batch-settlement/utils";
import * as GwErrors from "../../../src/batch-settlement/gateway/errors";
import { createVoucherGatewayServerExtension } from "../../../src/batch-settlement/gateway/server/extension";
import { VOUCHER_GATEWAY } from "../../../src/batch-settlement/gateway/constants";

const PAYER_PRIVATE_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const GATEWAY = "0x55B151f55038e7FCF2a5440a0ea0ea39D415EC2D" as `0x${string}`;
const RECEIVER = "0x1c47E9C085c2B7458F5b6C16cCBD65A65255a9f6" as `0x${string}`;
const RECEIVER_AUTHORIZER = "0xa1aD2CD47DB081d2E72507D64df0B85e4fe646e5" as `0x${string}`;
const ASSET = "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as `0x${string}`;
const NETWORK = "eip155:84532";
const DEFAULT_SALT =
  "0x0000000000000000000000000000000000000000000000000000000000000000" as `0x${string}`;

function buildSigner(privateKey: `0x${string}`): ClientEvmSigner {
  const account = privateKeyToAccount(privateKey);
  return {
    address: account.address,
    signTypedData: msg =>
      account.signTypedData({
        domain: msg.domain,
        types: msg.types,
        primaryType: msg.primaryType,
        message: msg.message,
      } as Parameters<typeof account.signTypedData>[0]),
  };
}

function makeRequirements(): PaymentRequirements {
  return {
    scheme: "batch-settlement",
    network: NETWORK,
    amount: "10000",
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
}

function makeDeps(readContract?: ClientEvmSigner["readContract"]): GatewayClientPaymentDeps {
  const signer = buildSigner(PAYER_PRIVATE_KEY);
  return {
    signer: readContract ? { ...signer, readContract } : signer,
    storage: {
      get: async () => undefined,
      set: async () => undefined,
      delete: async () => undefined,
    },
    salt: DEFAULT_SALT,
    gatewayStorage: new InMemoryGatewayClientStorage(),
  };
}

describe("gateway corrective recovery", () => {
  it("returns false for non-corrective errors", async () => {
    const deps = makeDeps();
    const paymentRequired: PaymentRequired = {
      x402Version: 2,
      error: GwErrors.ErrVoucherSignature,
      accepts: [makeRequirements()],
      extensions: {
        [VOUCHER_GATEWAY]: { info: { gateway: GATEWAY } },
      },
    };
    expect(await processGatewayCorrectivePaymentRequired(deps, paymentRequired)).toBe(false);
  });

  it("recovers from below_distributed using onchain distributedCumulative", async () => {
    const requirements = makeRequirements();
    const deps = makeDeps();
    const config = buildGatewayChannelConfig(deps, requirements, GATEWAY);
    const channelId = computeChannelId(config, NETWORK);

    const readContract = vi.fn(async ({ functionName }: { functionName: string }) => {
      if (functionName === "channels") {
        return [40000n, 14100n];
      }
      if (functionName === "distributedCumulative") {
        return 14100n;
      }
      throw new Error(`unexpected ${functionName}`);
    });
    deps.signer = { ...deps.signer, readContract };

    const paymentRequired: PaymentRequired = {
      x402Version: 2,
      error: GwErrors.ErrReceiverCumulativeBelowDistributed,
      accepts: [
        {
          ...requirements,
          extra: {
            ...requirements.extra,
            channelState: {
              channelId,
              balance: "40000",
              totalClaimed: "14100",
              chargedCumulativeAmount: "14100",
            },
          },
        },
      ],
      extensions: {
        [VOUCHER_GATEWAY]: {
          info: {
            gateway: GATEWAY,
            gatewayState: {
              gatewayId: "0x179632017c109b2ff1bdab7962ff89da3dad28faae56f543f4a5709862e47d4e",
              distributedCumulative: "14100",
            },
          },
        },
      },
    };

    const ok = await processGatewayCorrectivePaymentRequired(deps, paymentRequired);
    expect(ok).toBe(true);

    const stored = await deps.gatewayStorage.get(channelId);
    expect(stored?.balance).toBe("40000");
    expect(stored?.totalClaimed).toBe("14100");
    expect(stored?.servers[getAddress(RECEIVER).toLowerCase()]?.chargedCumulativeAmount).toBe(
      "14100",
    );
  });

  it("cold-starts from onchain via recoverGatewayChannel", async () => {
    const requirements = makeRequirements();
    const deps = makeDeps();
    const config = buildGatewayChannelConfig(deps, requirements, GATEWAY);
    const channelId = computeChannelId(config, NETWORK);

    deps.signer = {
      ...deps.signer,
      readContract: vi.fn(async ({ functionName }: { functionName: string }) => {
        if (functionName === "channels") {
          return [40000n, 14100n];
        }
        if (functionName === "distributedCumulative") {
          return 14100n;
        }
        throw new Error(`unexpected ${functionName}`);
      }),
    };

    const ctx = await recoverGatewayChannel(deps, requirements, GATEWAY);
    expect(ctx.balance).toBe("40000");
    expect(ctx.servers[getAddress(RECEIVER).toLowerCase()]?.chargedCumulativeAmount).toBe("14100");
    expect(await deps.gatewayStorage.get(channelId)).toEqual(ctx);
  });

  it("server extension enrich preserves gatewayState", async () => {
    const extension = createVoucherGatewayServerExtension();
    const result = await extension.enrichPaymentRequiredResponse?.(
      { info: { gateway: GATEWAY }, schema: { type: "object" } },
      {
        requirements: [makeRequirements()],
        resourceInfo: { url: "http://localhost/weather", description: "", mimeType: "" },
        error: GwErrors.ErrReceiverCumulativeBelowDistributed,
        paymentRequiredResponse: {
          x402Version: 2,
          error: GwErrors.ErrReceiverCumulativeBelowDistributed,
          accepts: [makeRequirements()],
          extensions: {
            [VOUCHER_GATEWAY]: {
              info: {
                gateway: GATEWAY,
                gatewayState: {
                  gatewayId: "0xgid",
                  distributedCumulative: "14100",
                },
              },
            },
          },
        },
        facilitatorExtensionInfo: {
          [VOUCHER_GATEWAY]: { gateway: GATEWAY, withdrawDelay: 900 },
        },
      },
    );

    expect(result?.info.gateway).toBe(getAddress(GATEWAY));
    expect(result?.info.gatewayState?.distributedCumulative).toBe("14100");
  });
});
