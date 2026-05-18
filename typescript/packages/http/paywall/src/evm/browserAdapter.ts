import type { ClientEvmSigner } from "@x402/evm";
import type { Account, PublicClient, WalletClient } from "viem";

/**
 * Converts a wagmi/viem WalletClient to a ClientEvmSigner for x402Client
 *
 * @param walletClient - The wagmi wallet client from useWalletClient()
 * @param publicClient - Optional public client for readContract (EIP-2612 gas sponsoring)
 * @returns ClientEvmSigner compatible with ExactEvmClient / UptoEvmScheme
 */
export function wagmiToClientSigner(
  walletClient: WalletClient,
  publicClient?: Pick<PublicClient, "readContract">,
): ClientEvmSigner {
  if (!walletClient.account) {
    throw new Error("Wallet client must have an account");
  }

  return {
    address: walletClient.account.address,
    signTypedData: async message => {
      const signature = await walletClient.signTypedData({
        account: walletClient.account as Account,
        domain: message.domain,
        types: message.types,
        primaryType: message.primaryType,
        message: message.message,
      });
      return signature;
    },
    readContract: publicClient
      ? args => publicClient.readContract(args as never) as Promise<unknown>
      : undefined,
  };
}
