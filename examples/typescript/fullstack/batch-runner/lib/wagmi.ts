import { http, createConfig, createStorage, cookieStorage } from "wagmi";
import { baseSepolia } from "wagmi/chains";
import { baseAccount, injected } from "wagmi/connectors";

export const config = createConfig({
  chains: [baseSepolia],
  connectors: [
    baseAccount({
      appName: "Batch Runner",
    }),
    injected(),
  ],
  storage: createStorage({ storage: cookieStorage }),
  ssr: true,
  transports: {
    [baseSepolia.id]: http("https://sepolia.base.org"),
  },
});

declare module "wagmi" {
  interface Register {
    config: typeof config;
  }
}
