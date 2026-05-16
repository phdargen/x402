import { http, createConfig, createStorage, cookieStorage } from "wagmi";
import { base, baseSepolia } from "wagmi/chains";
import { baseAccount } from "wagmi/connectors";

export const config = createConfig({
  chains: [base, baseSepolia],
  multiInjectedProviderDiscovery: false,
  connectors: [
    baseAccount({
      appName: "Batch Runner",
    }),
  ],
  storage: createStorage({ storage: cookieStorage }),
  ssr: true,
  transports: {
    [base.id]: http(),
    [baseSepolia.id]: http(),
  },
});

declare module "wagmi" {
  interface Register {
    config: typeof config;
  }
}
