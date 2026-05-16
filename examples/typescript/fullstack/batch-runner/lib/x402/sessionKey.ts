import { concat, getAddress, keccak256, toBytes } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { toClientEvmSigner } from "@x402/evm";

const SESSION_STORAGE_PREFIX = "x402:batch-runner:session:";

export type StoredSessionKey = {
  playerAddress: `0x${string}`;
  channelSalt: `0x${string}`;
  sessionPrivateKey: `0x${string}`;
  sessionAddress: `0x${string}`;
  createdAt: number;
  updatedAt: number;
};

/**
 * Derives a deterministic session key from a wallet delegation signature.
 * The key is unique per player per salt and is persisted only in browser storage.
 */
export function deriveSessionKey(delegationSignature: `0x${string}`, channelSalt: `0x${string}`) {
  const sessionPrivateKey = keccak256(concat([toBytes(delegationSignature), toBytes(channelSalt)]));
  const sessionAccount = privateKeyToAccount(sessionPrivateKey);
  const voucherSigner = toClientEvmSigner(sessionAccount);

  return { sessionPrivateKey, sessionAccount, voucherSigner };
}

export function signerFromStoredSession(stored: StoredSessionKey) {
  const sessionAccount = privateKeyToAccount(stored.sessionPrivateKey);
  const voucherSigner = toClientEvmSigner(sessionAccount);
  return { sessionAccount, voucherSigner };
}

export function loadStoredSessionKey(playerAddress: `0x${string}`): StoredSessionKey | null {
  if (typeof window === "undefined") return null;

  const raw = localStorage.getItem(getSessionStorageKey(playerAddress));
  if (!raw) return null;

  try {
    const stored = JSON.parse(raw) as StoredSessionKey;
    if (
      getAddress(stored.playerAddress) !== getAddress(playerAddress) ||
      !stored.channelSalt?.startsWith("0x") ||
      !stored.sessionPrivateKey?.startsWith("0x") ||
      !stored.sessionAddress?.startsWith("0x")
    ) {
      return null;
    }
    return stored;
  } catch {
    return null;
  }
}

export function saveStoredSessionKey(stored: StoredSessionKey): void {
  if (typeof window === "undefined") return;

  localStorage.setItem(getSessionStorageKey(stored.playerAddress), JSON.stringify(stored));
}

export function createStoredSessionKey(
  playerAddress: `0x${string}`,
  delegationSignature: `0x${string}`,
): StoredSessionKey {
  const channelSalt = generateChannelSalt();
  const { sessionPrivateKey, sessionAccount } = deriveSessionKey(delegationSignature, channelSalt);
  const now = Date.now();

  const stored: StoredSessionKey = {
    playerAddress: getAddress(playerAddress) as `0x${string}`,
    channelSalt,
    sessionPrivateKey,
    sessionAddress: sessionAccount.address,
    createdAt: now,
    updatedAt: now,
  };

  saveStoredSessionKey(stored);
  return stored;
}

export function generateChannelSalt(): `0x${string}` {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return ("0x" + Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("")) as `0x${string}`;
}

export function buildDelegationMessage(channelSalt: `0x${string}`): string {
  return `x402 Game Session\nChannel: ${channelSalt}`;
}

function getSessionStorageKey(playerAddress: `0x${string}`): string {
  return `${SESSION_STORAGE_PREFIX}${getAddress(playerAddress).toLowerCase()}`;
}
