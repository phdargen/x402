import { describe, it, expect } from "vitest";
import {
  isBatchSettlementDepositPayload,
  isBatchSettlementVoucherPayload,
  isBatchSettlementRefundPayload,
  isBatchSettlementClaimPayload,
  isBatchSettlementSettlePayload,
  isBatchSettlementEnrichedRefundPayload,
  voucherStoreMode,
} from "../../../src/batch-settlement/types";
import type {
  ChannelConfig,
  BatchSettlementDelegatedRequirementsExtra,
  BatchSettlementDepositPayload,
  BatchSettlementPaymentRequirementsExtra,
  BatchSettlementSelfRequirementsExtra,
  BatchSettlementVoucherPayload,
  BatchSettlementRefundPayload,
  BatchSettlementClaimPayload,
  BatchSettlementSettlePayload,
  BatchSettlementEnrichedRefundPayload,
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
  channelConfig: CHANNEL_CONFIG,
  voucher: {
    channelId: "0xabc1230000000000000000000000000000000000000000000000000000000001",
    maxClaimableAmount: "1000000",
    signature: "0xcafebabe",
  },
  deposit: {
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
};

const VALID_PERMIT2_DEPOSIT_PAYLOAD: BatchSettlementDepositPayload = {
  type: "deposit",
  channelConfig: CHANNEL_CONFIG,
  voucher: {
    channelId: "0xabc1230000000000000000000000000000000000000000000000000000000001",
    maxClaimableAmount: "1000000",
    signature: "0xcafebabe",
  },
  deposit: {
    amount: "10000000",
    authorization: {
      permit2Authorization: {
        from: "0x1234567890123456789012345678901234567890",
        permitted: {
          token: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
          amount: "10000000",
        },
        spender: "0x4020e27bcea6C226BF888C61b6C520C0fcC50005",
        nonce: "123",
        deadline: "9999999999",
        witness: {
          channelId: "0xabc1230000000000000000000000000000000000000000000000000000000001",
        },
        signature: "0xdeadbeef",
      },
    },
  },
};

const VALID_VOUCHER_PAYLOAD: BatchSettlementVoucherPayload = {
  type: "voucher",
  channelConfig: CHANNEL_CONFIG,
  voucher: {
    channelId: "0xabc1230000000000000000000000000000000000000000000000000000000001",
    maxClaimableAmount: "2000000",
    signature: "0xfeedface",
  },
};

const VALID_REFUND_PAYLOAD: BatchSettlementRefundPayload = {
  type: "refund",
  channelConfig: CHANNEL_CONFIG,
  voucher: {
    channelId: "0xabc1230000000000000000000000000000000000000000000000000000000001",
    maxClaimableAmount: "2000000",
    signature: "0xfeedface",
  },
};

const VALID_CLAIM_PAYLOAD: BatchSettlementClaimPayload = {
  type: "claim",
  claims: [
    {
      voucher: { channel: CHANNEL_CONFIG, maxClaimableAmount: "1000000" },
      signature: "0xaa",
      totalClaimed: "1000000",
    },
  ],
};

const VALID_SETTLE_PAYLOAD: BatchSettlementSettlePayload = {
  type: "settle",
  receiver: "0x9876543210987654321098765432109876543210",
  token: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
};

const VALID_ENRICHED_REFUND_PAYLOAD: BatchSettlementEnrichedRefundPayload = {
  ...VALID_REFUND_PAYLOAD,
  amount: "100000",
  refundNonce: "0",
  claims: [],
};

describe("isBatchSettlementDepositPayload", () => {
  it("returns true for a complete deposit payload", () => {
    expect(isBatchSettlementDepositPayload(VALID_DEPOSIT_PAYLOAD)).toBe(true);
  });

  it("returns true for a Permit2 deposit payload", () => {
    expect(isBatchSettlementDepositPayload(VALID_PERMIT2_DEPOSIT_PAYLOAD)).toBe(true);
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
    const { channelId, ...voucher } = VALID_VOUCHER_PAYLOAD.voucher;
    void channelId;
    expect(isBatchSettlementVoucherPayload({ ...VALID_VOUCHER_PAYLOAD, voucher })).toBe(false);
  });

  it("returns false when maxClaimableAmount is missing", () => {
    const { maxClaimableAmount, ...voucher } = VALID_VOUCHER_PAYLOAD.voucher;
    void maxClaimableAmount;
    expect(isBatchSettlementVoucherPayload({ ...VALID_VOUCHER_PAYLOAD, voucher })).toBe(false);
  });

  it("returns false when signature is missing", () => {
    const { signature, ...voucher } = VALID_VOUCHER_PAYLOAD.voucher;
    void signature;
    expect(isBatchSettlementVoucherPayload({ ...VALID_VOUCHER_PAYLOAD, voucher })).toBe(false);
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
      name: "isBatchSettlementClaimPayload",
      fn: isBatchSettlementClaimPayload,
      matching: VALID_CLAIM_PAYLOAD as unknown as Record<string, unknown>,
    },
    {
      name: "isBatchSettlementSettlePayload",
      fn: isBatchSettlementSettlePayload,
      matching: VALID_SETTLE_PAYLOAD as unknown as Record<string, unknown>,
    },
    {
      name: "isBatchSettlementEnrichedRefundPayload",
      fn: isBatchSettlementEnrichedRefundPayload,
      matching: VALID_ENRICHED_REFUND_PAYLOAD as unknown as Record<string, unknown>,
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

describe("isBatchSettlementRefundPayload", () => {
  it("returns true for a valid refund payload", () => {
    expect(isBatchSettlementRefundPayload(VALID_REFUND_PAYLOAD)).toBe(true);
  });

  it("does not require amount for a full refund", () => {
    expect(isBatchSettlementRefundPayload(VALID_REFUND_PAYLOAD)).toBe(true);
  });
});

describe("isBatchSettlementClaimPayload (specific fields)", () => {
  it("returns false when claims array is missing", () => {
    const { claims, ...rest } = VALID_CLAIM_PAYLOAD;
    void claims;
    expect(isBatchSettlementClaimPayload(rest as unknown as Record<string, unknown>)).toBe(false);
  });
});

describe("isBatchSettlementSettlePayload (specific fields)", () => {
  it("returns false when receiver is missing", () => {
    const { receiver, ...rest } = VALID_SETTLE_PAYLOAD;
    void receiver;
    expect(isBatchSettlementSettlePayload(rest as unknown as Record<string, unknown>)).toBe(false);
  });

  it("returns false when token is missing", () => {
    const { token, ...rest } = VALID_SETTLE_PAYLOAD;
    void token;
    expect(isBatchSettlementSettlePayload(rest as unknown as Record<string, unknown>)).toBe(false);
  });
});

describe("isBatchSettlementEnrichedRefundPayload (specific fields)", () => {
  it("returns false when refundNonce is missing", () => {
    const { refundNonce, ...rest } = VALID_ENRICHED_REFUND_PAYLOAD;
    void refundNonce;
    expect(isBatchSettlementEnrichedRefundPayload(rest as unknown as Record<string, unknown>)).toBe(
      false,
    );
  });
});

describe("voucherStoreMode", () => {
  it("treats extra.voucherStore === true as facilitator-managed custody", () => {
    const extra: BatchSettlementDelegatedRequirementsExtra = {
      receiverAuthorizer: "0x1111111111111111111111111111111111111111",
      withdrawDelay: 900,
      name: "USDC",
      version: "2",
      voucherStore: true,
    };
    expect(voucherStoreMode(extra)).toBe("delegated");
  });

  it("defaults to self-managed custody for every other extra", () => {
    const selfExtra: BatchSettlementSelfRequirementsExtra = {
      receiverAuthorizer: "0x1111111111111111111111111111111111111111",
      withdrawDelay: 900,
      name: "USDC",
      version: "2",
    };
    expect(voucherStoreMode(selfExtra)).toBe("self");
    expect(voucherStoreMode({ ...selfExtra, voucherStore: false })).toBe("self");
    expect(voucherStoreMode({})).toBe("self");
    expect(voucherStoreMode(undefined)).toBe("self");
  });

  it("does not treat truthy non-boolean values as a voucher store", () => {
    expect(voucherStoreMode({ voucherStore: "true" })).toBe("self");
    expect(voucherStoreMode({ voucherStore: 1 })).toBe("self");
    expect(voucherStoreMode("voucherStore")).toBe("self");
  });

  it("narrows a requirements extra union to the delegated branch", () => {
    const extras: BatchSettlementPaymentRequirementsExtra[] = [
      {
        receiverAuthorizer: "0x1111111111111111111111111111111111111111",
        withdrawDelay: 900,
        name: "USDC",
        version: "2",
      },
      {
        receiverAuthorizer: "0x1111111111111111111111111111111111111111",
        withdrawDelay: 1800,
        name: "USDC",
        version: "2",
        voucherStore: true,
      },
    ];

    const delegated = extras.filter(
      (extra): extra is BatchSettlementDelegatedRequirementsExtra =>
        voucherStoreMode(extra) === "delegated",
    );

    expect(delegated).toHaveLength(1);
    expect(delegated[0].voucherStore).toBe(true);
    expect(delegated[0].withdrawDelay).toBe(1800);
  });
});
