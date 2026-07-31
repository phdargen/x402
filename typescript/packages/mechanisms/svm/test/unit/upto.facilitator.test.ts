import { generateKeyPairSigner } from "@solana/kit";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { beforeEach, describe, expect, it, vi } from "vitest";

const channelMocks = vi.hoisted(() => ({
  broadcastOpen: vi.fn(),
  channelExists: vi.fn(),
  fetchAndVerifyOpenChannel: vi.fn(),
  simulateOpenSettleDistribute: vi.fn(),
  simulateZeroChargeSettle: vi.fn(),
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
    simulateOpenSettleDistribute: channelMocks.simulateOpenSettleDistribute,
    simulateZeroChargeSettle: channelMocks.simulateZeroChargeSettle,
    submitSettle: channelMocks.submitSettle,
  };
});

vi.mock("../../src/utils", async () => {
  const actual = await vi.importActual<typeof import("../../src/utils")>("../../src/utils");
  return {
    ...actual,
    createRpcClient: () => ({
      getSlot: () => ({ send: async () => 123_456_789n }),
    }),
  };
});

import {
  TOKEN_PROGRAM_ADDRESS,
  SOLANA_DEVNET_CAIP2,
  USDC_DEVNET_ADDRESS,
  USDC_MAINNET_ADDRESS,
} from "../../src/constants";
import { buildOpenPaymentChannelTransaction } from "../../src/payment-channels/open";
import { signVoucher } from "../../src/payment-channels/voucher";
import { toFacilitatorSvmSigner } from "../../src/signer";
import { UptoSvmScheme } from "../../src/upto/facilitator/scheme";
import type { UptoSvmPayloadV2 } from "../../src/types";

const OPEN_SLOT = 123_456_789n;
const WITHDRAW_DELAY = 900;
const FAR_FUTURE = 4_102_444_800;

describe("UptoSvmScheme facilitator channel lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    channelMocks.channelExists.mockResolvedValue(true);
    channelMocks.simulateOpenSettleDistribute.mockResolvedValue(undefined);
    channelMocks.simulateZeroChargeSettle.mockResolvedValue(undefined);
    channelMocks.broadcastOpen.mockResolvedValue(USDC_MAINNET_ADDRESS);
    channelMocks.submitSettle.mockResolvedValue(USDC_MAINNET_ADDRESS);
  });

  async function buildFixture() {
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
      expiresAt: FAR_FUTURE,
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
      authorizedSigner: receiverAuthorizer.address,
      channelId: open.channelId,
      deposit: 1_000_000n,
      mint: requirements.asset,
      payee: feePayer.address,
      payer: payer.address,
      rentPayer: feePayer.address,
      splits: [{ bps: 10_000, recipient: receiverAuthorizer.address }],
    });
    const facilitator = new UptoSvmScheme(toFacilitatorSvmSigner(feePayer));
    return { facilitator, payload, requirements, receiverAuthorizer, uptoPayload };
  }

  it("settles without a prior verify on the same instance when the channel is open", async () => {
    const { facilitator, payload, requirements, receiverAuthorizer, uptoPayload } =
      await buildFixture();

    const voucherSignature = await signVoucher(receiverAuthorizer, {
      channelId: uptoPayload.channelId,
      cumulativeAmount: 0n,
      expiresAt: BigInt(FAR_FUTURE),
    });
    await expect(
      facilitator.settle(
        {
          ...payload,
          payload: { ...uptoPayload, voucherSignature },
        },
        { ...requirements, amount: "0" },
      ),
    ).resolves.toMatchObject({ success: true, amount: "0" });

    expect(channelMocks.fetchAndVerifyOpenChannel).toHaveBeenCalledTimes(1);
    expect(channelMocks.broadcastOpen).not.toHaveBeenCalled();
    expect(channelMocks.simulateZeroChargeSettle).not.toHaveBeenCalled();
    expect(channelMocks.submitSettle).toHaveBeenCalledTimes(1);
  });

  it("rejects settlement that exceeds the signed ceiling without touching the chain", async () => {
    const { facilitator, payload, requirements } = await buildFixture();

    await expect(
      facilitator.settle(payload, { ...requirements, amount: "1000001" }),
    ).resolves.toMatchObject({
      success: false,
      errorReason: "invalid_upto_svm_payload_settlement_exceeds_amount",
    });
    expect(channelMocks.fetchAndVerifyOpenChannel).not.toHaveBeenCalled();
    expect(channelMocks.submitSettle).not.toHaveBeenCalled();
  });

  it("allows repeated verify for an already-open channel", async () => {
    const { facilitator, payload, requirements } = await buildFixture();

    await expect(facilitator.verify(payload, requirements)).resolves.toMatchObject({
      isValid: true,
    });
    await expect(facilitator.verify(payload, requirements)).resolves.toMatchObject({
      isValid: true,
    });
    expect(channelMocks.fetchAndVerifyOpenChannel).toHaveBeenCalledTimes(2);
    expect(channelMocks.simulateZeroChargeSettle).toHaveBeenCalledTimes(2);
    expect(channelMocks.broadcastOpen).not.toHaveBeenCalled();
  });

  it("simulates open∥settle∥distribute before broadcasting a fresh open", async () => {
    const { facilitator, payload, requirements, uptoPayload } = await buildFixture();
    channelMocks.channelExists.mockResolvedValue(false);

    const callOrder: string[] = [];
    channelMocks.simulateOpenSettleDistribute.mockImplementation(async () => {
      callOrder.push("simulateOpenSettleDistribute");
    });
    channelMocks.broadcastOpen.mockImplementation(async () => {
      callOrder.push("broadcastOpen");
      return USDC_MAINNET_ADDRESS as never;
    });

    await expect(facilitator.verify(payload, requirements)).resolves.toMatchObject({
      isValid: true,
    });

    expect(callOrder).toEqual(["simulateOpenSettleDistribute", "broadcastOpen"]);
    expect(channelMocks.simulateOpenSettleDistribute).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        openTransactionBase64: uptoPayload.openTransaction,
        channel: expect.objectContaining({
          channelId: uptoPayload.channelId,
          payer: uptoPayload.from,
        }),
      }),
    );
    expect(channelMocks.simulateZeroChargeSettle).not.toHaveBeenCalled();
  });

  it("does not broadcast open when composite settlement simulation fails", async () => {
    const { facilitator, payload, requirements } = await buildFixture();
    channelMocks.channelExists.mockResolvedValue(false);
    channelMocks.simulateOpenSettleDistribute.mockRejectedValue(
      new Error("zero-charge settlement simulation failed: missing treasury ATA"),
    );

    await expect(facilitator.verify(payload, requirements)).resolves.toMatchObject({
      isValid: false,
      invalidReason: "upto_channel_open_failed",
    });
    expect(channelMocks.simulateOpenSettleDistribute).toHaveBeenCalledTimes(1);
    expect(channelMocks.broadcastOpen).not.toHaveBeenCalled();
    expect(channelMocks.fetchAndVerifyOpenChannel).not.toHaveBeenCalled();
  });

  it("rejects a missing voucher signature at settle", async () => {
    const { facilitator, payload, requirements } = await buildFixture();
    await expect(facilitator.verify(payload, requirements)).resolves.toMatchObject({
      isValid: true,
    });
    await expect(
      facilitator.settle(payload, { ...requirements, amount: "0" }),
    ).resolves.toMatchObject({
      success: false,
      errorReason: "invalid_upto_svm_payload_missing_voucher",
    });
  });

  it("rejects a forged voucher signature at settle", async () => {
    const { facilitator, payload, requirements, receiverAuthorizer, uptoPayload } =
      await buildFixture();
    await expect(facilitator.verify(payload, requirements)).resolves.toMatchObject({
      isValid: true,
    });
    const forged = await signVoucher(receiverAuthorizer, {
      channelId: uptoPayload.channelId,
      cumulativeAmount: 1n, // wrong amount vs settle requirements
      expiresAt: BigInt(FAR_FUTURE),
    });
    await expect(
      facilitator.settle(
        { ...payload, payload: { ...uptoPayload, voucherSignature: forged } },
        { ...requirements, amount: "0" },
      ),
    ).resolves.toMatchObject({
      success: false,
      errorReason: "invalid_upto_svm_payload_voucher_signature",
    });
  });

  it("accepts a zero-amount settle with an explicit voucher for 0", async () => {
    const { facilitator, payload, requirements, receiverAuthorizer, uptoPayload } =
      await buildFixture();
    await expect(facilitator.verify(payload, requirements)).resolves.toMatchObject({
      isValid: true,
    });
    const voucherSignature = await signVoucher(receiverAuthorizer, {
      channelId: uptoPayload.channelId,
      cumulativeAmount: 0n,
      expiresAt: BigInt(FAR_FUTURE),
    });
    await expect(
      facilitator.settle(
        { ...payload, payload: { ...uptoPayload, voucherSignature } },
        { ...requirements, amount: "0" },
      ),
    ).resolves.toMatchObject({ success: true, amount: "0" });
    // Zero-charge path: no voucher is submitted onchain (has_voucher = 0).
    expect(channelMocks.submitSettle).toHaveBeenCalled();
  });
});
