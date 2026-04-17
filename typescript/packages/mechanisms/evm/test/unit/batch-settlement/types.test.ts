import { describe, it, expect } from "vitest";
import {
  isBatchSettlementDepositPayload,
  isBatchSettlementVoucherPayload,
  isBatchSettlementClaimWithSignaturePayload,
  isBatchSettlementSettleActionPayload,
  isBatchSettlementRefundWithSignaturePayload,
} from "../../../src/batch-settlement/types";
import type {
  ChannelConfig,
  BatchSettlementDepositPayload,
  BatchSettlementVoucherPayload,
  BatchSettlementClaimWithSignaturePayload,
  BatchSettlementSettleActionPayload,
  BatchSettlementRefundWithSignaturePayload,
} from "../../../src/batch-settlement/types";

const CHANNEL_CONFIG: ChannelConfig = {
  payer: "0x1234567890123456789012345678901234567890",
  payerAuthorizer: "0x1234567890123456789012345678901234567890",
  receiver: "0x9876543210987654321098765432109876543210",
  receiverAuthorizer: "0x0000000000000000000000000000000000000000",
  token: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  withdrawDelay: 900,
  salt: "0x0000000000000000000000000000000000000000000000000000000000000000",
};

const VALID_DEPOSIT_PAYLOAD: BatchSettlementDepositPayload = {
  type: "deposit",
  deposit: {
    channelConfig: CHANNEL_CONFIG,
    amount: "10000000",
    authorization: {
      erc3009Authorization: {
        validAfter: "0",
        validBefore: "9999999999",
        salt: "0x0000000000000000000000000000000000000000000000000000000000000001",
        signature: "0xdeadbeef",
      },
    },
  },
  voucher: {
    channelId: "0xabc1230000000000000000000000000000000000000000000000000000000001",
    maxClaimableAmount: "1000000",
    signature: "0xcafebabe",
  },
};

const VALID_VOUCHER_PAYLOAD: BatchSettlementVoucherPayload = {
  type: "voucher",
  channelConfig: CHANNEL_CONFIG,
  channelId: "0xabc1230000000000000000000000000000000000000000000000000000000001",
  maxClaimableAmount: "2000000",
  signature: "0xfeedface",
};

const VALID_CLAIM_PAYLOAD: BatchSettlementClaimWithSignaturePayload = {
  settleAction: "claimWithSignature",
  claims: [
    {
      voucher: { channel: CHANNEL_CONFIG, maxClaimableAmount: "1000000" },
      signature: "0xaa",
      totalClaimed: "1000000",
    },
  ],
};

const VALID_SETTLE_PAYLOAD: BatchSettlementSettleActionPayload = {
  settleAction: "settle",
  receiver: "0x9876543210987654321098765432109876543210",
  token: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
};

const VALID_REFUND_PAYLOAD: BatchSettlementRefundWithSignaturePayload = {
  settleAction: "refundWithSignature",
  config: CHANNEL_CONFIG,
  amount: "100000",
  nonce: "0",
  claims: [],
};

describe("isBatchSettlementDepositPayload", () => {
  it("returns true for a complete deposit payload", () => {
    expect(isBatchSettlementDepositPayload(VALID_DEPOSIT_PAYLOAD)).toBe(true);
  });

  it("returns false for a voucher-only payload", () => {
    expect(isBatchSettlementDepositPayload(VALID_VOUCHER_PAYLOAD)).toBe(false);
  });

  it("returns false when type is missing", () => {
    const { type, ...rest } = VALID_DEPOSIT_PAYLOAD;
    void type;
    expect(isBatchSettlementDepositPayload(rest as unknown as Record<string, unknown>)).toBe(false);
  });

  it("returns false when deposit is missing", () => {
    const { deposit, ...rest } = VALID_DEPOSIT_PAYLOAD;
    void deposit;
    expect(isBatchSettlementDepositPayload(rest as unknown as Record<string, unknown>)).toBe(false);
  });

  it("returns false when voucher is missing", () => {
    const { voucher, ...rest } = VALID_DEPOSIT_PAYLOAD;
    void voucher;
    expect(isBatchSettlementDepositPayload(rest as unknown as Record<string, unknown>)).toBe(false);
  });

  it("returns false for an empty object", () => {
    expect(isBatchSettlementDepositPayload({})).toBe(false);
  });

  it("returns false for a settle-action payload", () => {
    expect(
      isBatchSettlementDepositPayload(VALID_SETTLE_PAYLOAD as unknown as Record<string, unknown>),
    ).toBe(false);
  });
});

describe("isBatchSettlementVoucherPayload", () => {
  it("returns true for a valid voucher payload", () => {
    expect(isBatchSettlementVoucherPayload(VALID_VOUCHER_PAYLOAD)).toBe(true);
  });

  it("returns false for a deposit payload", () => {
    expect(isBatchSettlementVoucherPayload(VALID_DEPOSIT_PAYLOAD)).toBe(false);
  });

  it("returns false when channelConfig is missing", () => {
    const { channelConfig, ...rest } = VALID_VOUCHER_PAYLOAD;
    void channelConfig;
    expect(isBatchSettlementVoucherPayload(rest as unknown as Record<string, unknown>)).toBe(false);
  });

  it("returns false when channelId is missing", () => {
    const { channelId, ...rest } = VALID_VOUCHER_PAYLOAD;
    void channelId;
    expect(isBatchSettlementVoucherPayload(rest as unknown as Record<string, unknown>)).toBe(false);
  });

  it("returns false when maxClaimableAmount is missing", () => {
    const { maxClaimableAmount, ...rest } = VALID_VOUCHER_PAYLOAD;
    void maxClaimableAmount;
    expect(isBatchSettlementVoucherPayload(rest as unknown as Record<string, unknown>)).toBe(false);
  });

  it("returns false when signature is missing", () => {
    const { signature, ...rest } = VALID_VOUCHER_PAYLOAD;
    void signature;
    expect(isBatchSettlementVoucherPayload(rest as unknown as Record<string, unknown>)).toBe(false);
  });

  it("returns false for an empty object", () => {
    expect(isBatchSettlementVoucherPayload({})).toBe(false);
  });
});

describe("settle payload guards (mutual exclusivity)", () => {
  const guards: Array<{
    name: string;
    fn: (p: Record<string, unknown>) => boolean;
    matching: Record<string, unknown>;
  }> = [
    {
      name: "isBatchSettlementClaimWithSignaturePayload",
      fn: isBatchSettlementClaimWithSignaturePayload,
      matching: VALID_CLAIM_PAYLOAD as unknown as Record<string, unknown>,
    },
    {
      name: "isBatchSettlementSettleActionPayload",
      fn: isBatchSettlementSettleActionPayload,
      matching: VALID_SETTLE_PAYLOAD as unknown as Record<string, unknown>,
    },
    {
      name: "isBatchSettlementRefundWithSignaturePayload",
      fn: isBatchSettlementRefundWithSignaturePayload,
      matching: VALID_REFUND_PAYLOAD as unknown as Record<string, unknown>,
    },
  ];

  for (const guard of guards) {
    it(`${guard.name} matches its own payload`, () => {
      expect(guard.fn(guard.matching)).toBe(true);
    });

    for (const other of guards) {
      if (other === guard) continue;
      it(`${guard.name} rejects ${other.name}'s payload`, () => {
        expect(guard.fn(other.matching)).toBe(false);
      });
    }

    it(`${guard.name} rejects payment payloads (deposit/voucher)`, () => {
      expect(guard.fn(VALID_DEPOSIT_PAYLOAD as unknown as Record<string, unknown>)).toBe(false);
      expect(guard.fn(VALID_VOUCHER_PAYLOAD as unknown as Record<string, unknown>)).toBe(false);
    });

    it(`${guard.name} rejects empty object`, () => {
      expect(guard.fn({})).toBe(false);
    });
  }
});

describe("isBatchSettlementClaimWithSignaturePayload (specific fields)", () => {
  it("returns false when claims array is missing", () => {
    const { claims, ...rest } = VALID_CLAIM_PAYLOAD;
    void claims;
    expect(
      isBatchSettlementClaimWithSignaturePayload(rest as unknown as Record<string, unknown>),
    ).toBe(false);
  });
});

describe("isBatchSettlementSettleActionPayload (specific fields)", () => {
  it("returns false when receiver is missing", () => {
    const { receiver, ...rest } = VALID_SETTLE_PAYLOAD;
    void receiver;
    expect(isBatchSettlementSettleActionPayload(rest as unknown as Record<string, unknown>)).toBe(
      false,
    );
  });

  it("returns false when token is missing", () => {
    const { token, ...rest } = VALID_SETTLE_PAYLOAD;
    void token;
    expect(isBatchSettlementSettleActionPayload(rest as unknown as Record<string, unknown>)).toBe(
      false,
    );
  });
});

describe("isBatchSettlementRefundWithSignaturePayload (specific fields)", () => {
  it("returns false when config is missing", () => {
    const { config, ...rest } = VALID_REFUND_PAYLOAD;
    void config;
    expect(
      isBatchSettlementRefundWithSignaturePayload(rest as unknown as Record<string, unknown>),
    ).toBe(false);
  });
});
