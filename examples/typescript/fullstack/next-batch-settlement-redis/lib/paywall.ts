import { createPaywall } from "@x402/paywall";
import { evmPaywall } from "@x402/paywall/evm";

/**
 * EVM-only paywall used when batch-settlement routes need HTML discovery UI.
 */
export const paywall = createPaywall()
  .withNetwork(evmPaywall)
  .withConfig({
    appName: process.env.APP_NAME || "x402 batch-settlement (Next.js)",
    appLogo: process.env.APP_LOGO || "/x402-icon-blue.png",
    testnet: true,
  })
  .build();
