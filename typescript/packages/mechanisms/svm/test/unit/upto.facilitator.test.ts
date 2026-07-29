import { generateKeyPairSigner } from "@solana/kit";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { beforeEach, describe, expect, it, vi } from "vitest";

const channelMocks = vi.hoisted(() => ({
  broadcastOpen: vi.fn(),
  channelExists: vi.fn(),
  fetchAndVerifyOpenChannel: vi.fn(),
  submitSettle: vi.fn(),
}));

vi.mock("../../src/upto/facilitator/channel", async () => {
  const actual = await vi.importActual<typeof import("../../src/upto/facilitator/channel")>(
    "../../src/upto/facilitator/channel",
  );
  return {
    ...actual,
    broadcastOpen: channelMocks.broadcastOpen,
    channelExists: channelMocks.channelExists,
    fetchAndVerifyOpenChannel: channelMocks.fetchAndVerifyOpenChannel,
    submitSettle: channelMocks.submitSettle,
  };
});

vi.mock("../../src/utils", async () => {
  const actual = await vi.importActual<typeof import("../../src/utils")>("../../src/utils");
  return {
    ...actual,
    createRpcClient: () => ({}),
  };
});

import {
  TOKEN_PROGRAM_ADDRESS,
  SOLANA_DEVNET_CAIP2,
  USDC_DEVNET_ADDRESS,
  USDC_MAINNET_ADDRESS,
} from "../../src/constants";
import { buildOpenPaymentChannelTransaction } from "../../src/payment-channels/open";
import { UptoSvmScheme } from "../../src/upto/facilitator/scheme";
import type { UptoSvmPayloadV2 } from "../../src/types";

const OPEN_SLOT = 123_456_789n;
const WITHDRAW_DELAY = 900;

describe("UptoSvmScheme facilitator channel lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    channelMocks.channelExists.mockResolvedValue(true);
    channelMocks.submitSettle.mockResolvedValue(USDC_MAINNET_ADDRESS);
  });

  it("rejects concurrent channel replays and releases the reservation after settlement", async () => {
    const payer = await generateKeyPairSigner();
    const feePayer = await generateKeyPairSigner();
    const receiverAuthorizer = await generateKeyPairSigner();
    const open = await buildOpenPaymentChannelTransaction({
      authorizedSigner: receiverAuthorizer.address,
      blockhash: { blockhash: USDC_MAINNET_ADDRESS, lastValidBlockHeight: 0n },
      deposit: 1_000_000n,
      feePayer: feePayer.address,
      gracePeriod: WITHDRAW_DELAY,
      mint: USDC_DEVNET_ADDRESS,
      openSlot: OPEN_SLOT,
      payee: feePayer.address,
      payer,
      recipients: [{ bps: 10_000, recipient: receiverAuthorizer.address }],
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
    });
    const requirements: PaymentRequirements = {
      scheme: "upto",
      network: SOLANA_DEVNET_CAIP2,
      asset: USDC_DEVNET_ADDRESS,
      amount: "1000000",
      payTo: receiverAuthorizer.address,
      maxTimeoutSeconds: 300,
      extra: {
        feePayer: feePayer.address,
        recentSlot: OPEN_SLOT.toString(),
        receiverAuthorizer: receiverAuthorizer.address,
        tokenProgram: TOKEN_PROGRAM_ADDRESS,
        withdrawDelay: WITHDRAW_DELAY,
      },
    };
    const uptoPayload: UptoSvmPayloadV2 = {
      authorizedSigner: receiverAuthorizer.address,
      channelId: open.channelId,
      deposit: "1000000",
      expiresAt: 4_102_444_800,
      from: payer.address,
      maxAmount: "1000000",
      nonce: open.salt.toString(),
      openSlot: OPEN_SLOT.toString(),
      openTransaction: open.transaction,
      validAfter: 0,
    };
    const payload: PaymentPayload = {
      x402Version: 2,
      accepted: requirements,
      payload: uptoPayload as unknown as Record<string, unknown>,
    };
    channelMocks.fetchAndVerifyOpenChannel.mockResolvedValue({
      channelId: open.channelId,
      deposit: 1_000_000n,
      mint: requirements.asset,
      payee: feePayer.address,
      payer: payer.address,
      rentPayer: feePayer.address,
      splits: [{ bps: 10_000, recipient: receiverAuthorizer.address }],
    });
    const facilitator = new UptoSvmScheme(feePayer, receiverAuthorizer);

    await expect(facilitator.verify(payload, requirements)).resolves.toMatchObject({
      isValid: true,
    });
    await expect(facilitator.verify(payload, requirements)).resolves.toMatchObject({
      isValid: false,
      invalidReason: "invalid_upto_svm_payload_channel_in_flight",
    });
    expect(channelMocks.fetchAndVerifyOpenChannel).toHaveBeenCalledTimes(1);

    const tamperedPayload: PaymentPayload = {
      ...payload,
      payload: { ...uptoPayload, maxAmount: "999999999" },
    };
    await expect(
      facilitator.settle(tamperedPayload, { ...requirements, amount: "1000001" }),
    ).resolves.toMatchObject({
      success: false,
      errorReason: "invalid_upto_svm_payload_settlement_exceeds_amount",
    });

    await expect(facilitator.verify(payload, requirements)).resolves.toMatchObject({
      isValid: true,
    });
    await expect(
      facilitator.settle(payload, { ...requirements, amount: "0" }),
    ).resolves.toMatchObject({ success: true });

    await expect(facilitator.verify(payload, requirements)).resolves.toMatchObject({
      isValid: true,
    });
    expect(channelMocks.fetchAndVerifyOpenChannel).toHaveBeenCalledTimes(3);
  });
});
