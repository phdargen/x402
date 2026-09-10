import { describe, it, expect } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import {
  assertDirectAuthorizerSubmitter,
  shouldRelaySubmit,
} from "../../../src/batch-settlement/facilitator/submit";
import type { FacilitatorEvmSigner } from "../../../src/signer";

function buildSubmitter(address: `0x${string}`): FacilitatorEvmSigner {
  return {
    getAddresses: () => [address],
    readContract: async () => undefined,
    verifyTypedData: async () => true,
    writeContract: async () => "0x" + "ab".repeat(32),
    sendTransaction: async () => "0x" + "cd".repeat(32),
    waitForTransactionReceipt: async () => ({ status: "success" }),
    getCode: async () => "0x6080604052",
  };
}

describe("batch-settlement submit helpers", () => {
  it("shouldRelaySubmit relays when an authorizer signature is already present", () => {
    expect(shouldRelaySubmit("direct", true)).toBe(true);
    expect(shouldRelaySubmit(undefined, true)).toBe(true);
  });

  it("shouldRelaySubmit uses direct dispatch only when configured and unsigned", () => {
    expect(shouldRelaySubmit("direct", false)).toBe(false);
    expect(shouldRelaySubmit("relay", false)).toBe(true);
    expect(shouldRelaySubmit(undefined, false)).toBe(true);
  });

  it("assertDirectAuthorizerSubmitter is a no-op outside direct mode", () => {
    expect(() => assertDirectAuthorizerSubmitter("relay", undefined, undefined)).not.toThrow();
  });

  it("assertDirectAuthorizerSubmitter requires a dedicated authorizer signer and submitter", () => {
    const authorizer = privateKeyToAccount(
      "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
    );
    expect(() =>
      assertDirectAuthorizerSubmitter("direct", undefined, buildSubmitter(authorizer.address)),
    ).toThrow('submitMode "direct" requires authorizerSigner');
    expect(() =>
      assertDirectAuthorizerSubmitter(
        "direct",
        { address: authorizer.address, signTypedData: async () => "0x" + "11".repeat(65) },
        undefined,
      ),
    ).toThrow('submitMode "direct" requires authorizerSubmitter');
  });

  it("assertDirectAuthorizerSubmitter rejects a submitter that is not exactly the authorizer", () => {
    const authorizer = privateKeyToAccount(
      "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
    );
    const other = privateKeyToAccount(
      "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
    );
    expect(() =>
      assertDirectAuthorizerSubmitter(
        "direct",
        { address: authorizer.address, signTypedData: async () => "0x" + "11".repeat(65) },
        buildSubmitter(other.address),
      ),
    ).toThrow("authorizerSubmitter.getAddresses() must be exactly [authorizerSigner.address]");
  });

  it("assertDirectAuthorizerSubmitter accepts a single-address submitter matching the authorizer", () => {
    const authorizer = privateKeyToAccount(
      "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
    );
    expect(() =>
      assertDirectAuthorizerSubmitter(
        "direct",
        { address: authorizer.address, signTypedData: async () => "0x" + "11".repeat(65) },
        buildSubmitter(authorizer.address),
      ),
    ).not.toThrow();
  });
});
