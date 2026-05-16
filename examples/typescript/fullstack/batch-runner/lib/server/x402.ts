import { HTTPFacilitatorClient, x402ResourceServer } from "@x402/core/server";
import { BatchSettlementEvmScheme } from "@x402/evm/batch-settlement/server";
import { FileChannelStorage } from "@x402/evm/batch-settlement/server/file-storage";
import {
  FACILITATOR_URL,
  NETWORK,
  RECEIVER_ADDRESS,
  STORAGE_DIR,
  USDC_ADDRESS,
  WITHDRAW_DELAY,
} from "../x402/config";

if (!FACILITATOR_URL) {
  console.warn("[batch-runner] FACILITATOR_URL not set — deposit route will fail at runtime");
}

if (!RECEIVER_ADDRESS || !/^0x[0-9a-fA-F]{40}$/.test(RECEIVER_ADDRESS)) {
  console.warn("[batch-runner] EVM_ADDRESS / NEXT_PUBLIC_RECEIVER_ADDRESS not set or invalid");
}

const facilitatorClient = new HTTPFacilitatorClient({ url: FACILITATOR_URL });
const channelStorage = new FileChannelStorage({ directory: STORAGE_DIR });

const batchedScheme = new BatchSettlementEvmScheme(RECEIVER_ADDRESS, {
  withdrawDelay: WITHDRAW_DELAY,
  storage: channelStorage,
});

export const server = new x402ResourceServer(facilitatorClient).register(NETWORK, batchedScheme);
export const channelManager = batchedScheme.createChannelManager(facilitatorClient, NETWORK);
export const storage = channelStorage;
export const receiverAddress = RECEIVER_ADDRESS;
export const tokenAddress = USDC_ADDRESS;
