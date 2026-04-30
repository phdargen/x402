import type { ClientEvmSigner } from "../../signer";
import type { EvmSchemeOptions } from "../../shared/rpc";
import { type ClientChannelStorage, InMemoryClientChannelStorage } from "./storage";

const DEFAULT_SALT =
  "0x0000000000000000000000000000000000000000000000000000000000000000" as `0x${string}`;

/**
 * Caller-tunable policy controlling how the client sizes channel deposits and
 * whether top-ups are issued automatically.
 */
export interface BatchSettlementDepositPolicy {
  depositMultiplier?: number;
  maxDeposit?: string;
  autoTopUp?: boolean;
}

/**
 * Full options object accepted by `BatchSettlementEvmScheme`. Either this or a
 * bare {@link BatchSettlementDepositPolicy} can be passed as the second
 * constructor argument.
 */
export interface BatchSettlementEvmSchemeOptions {
  depositPolicy?: BatchSettlementDepositPolicy;
  storage?: ClientChannelStorage;
  salt?: `0x${string}`;
  payerAuthorizer?: `0x${string}`;
  rpcUrl?: string;
  /** When set, EIP-712 vouchers are signed with this key; deposits still use the main `signer`. */
  voucherSigner?: ClientEvmSigner;
}

/**
 * Resolved options after merging defaults — used internally by the scheme,
 * recovery, and refund modules.
 */
export interface ResolvedClientOptions {
  depositPolicy?: BatchSettlementDepositPolicy;
  storage: ClientChannelStorage;
  salt: `0x${string}`;
  payerAuthorizer?: `0x${string}`;
  voucherSigner?: ClientEvmSigner;
  extensionRpcOptions?: EvmSchemeOptions;
}

/**
 * Discriminates a full options object from a bare deposit-policy object.
 *
 * @param o - Constructor argument that may be options, deposit policy only, or undefined.
 * @returns `true` when `o` is a {@link BatchSettlementEvmSchemeOptions} object.
 */
export function isBatchSettlementEvmSchemeOptions(
  o: BatchSettlementEvmSchemeOptions | BatchSettlementDepositPolicy | undefined,
): o is BatchSettlementEvmSchemeOptions {
  return (
    o !== undefined &&
    typeof o === "object" &&
    ("storage" in o ||
      "depositPolicy" in o ||
      "salt" in o ||
      "payerAuthorizer" in o ||
      "rpcUrl" in o ||
      "voucherSigner" in o)
  );
}

/**
 * Normalises the constructor's second argument into a uniform options shape.
 *
 * @param second - Optional second constructor argument (options or deposit policy).
 * @returns Resolved storage, salt, deposit policy, and optional payer authorizer.
 */
export function resolveClientOptions(
  second?: BatchSettlementEvmSchemeOptions | BatchSettlementDepositPolicy,
): ResolvedClientOptions {
  if (second === undefined) {
    return { storage: new InMemoryClientChannelStorage(), salt: DEFAULT_SALT };
  }
  if (isBatchSettlementEvmSchemeOptions(second)) {
    return {
      storage: second.storage ?? new InMemoryClientChannelStorage(),
      depositPolicy: second.depositPolicy,
      salt: second.salt ?? DEFAULT_SALT,
      payerAuthorizer: second.payerAuthorizer,
      voucherSigner: second.voucherSigner,
      extensionRpcOptions: second.rpcUrl ? { rpcUrl: second.rpcUrl } : undefined,
    };
  }
  return {
    storage: new InMemoryClientChannelStorage(),
    depositPolicy: second,
    salt: DEFAULT_SALT,
  };
}

/**
 * Validates a {@link BatchSettlementDepositPolicy}, throwing on invalid fields.
 *
 * @param policy - The policy to validate (no-op when undefined).
 */
export function validateDepositPolicy(policy: BatchSettlementDepositPolicy | undefined): void {
  if (!policy) return;

  const m = policy.depositMultiplier;
  if (m !== undefined && (!Number.isInteger(m) || m < 1)) {
    throw new Error("depositMultiplier must be an integer >= 1");
  }

  if (policy.maxDeposit !== undefined && !/^\d+$/.test(policy.maxDeposit)) {
    throw new Error("maxDeposit must be a non-negative integer string");
  }
}

/**
 * Computes the deposit amount based on the deposit policy (multiplier and cap).
 *
 * @param policy - Deposit policy controlling multiplier and cap (may be undefined).
 * @param requestAmount - Amount requested for this operation, in token base units.
 * @returns Deposit amount string in token base units.
 */
export function depositAmountForRequest(
  policy: BatchSettlementDepositPolicy | undefined,
  requestAmount: bigint,
): string {
  const mult = BigInt(policy?.depositMultiplier ?? 10);
  let depositBig = mult * requestAmount;
  const cap = policy?.maxDeposit;
  if (cap !== undefined) {
    const capBig = BigInt(cap);
    if (depositBig > capBig) depositBig = capBig;
  }
  return depositBig.toString();
}
