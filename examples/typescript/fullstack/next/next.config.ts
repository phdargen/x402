import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  env: {
    FACILITATOR_URL: process.env.FACILITATOR_URL,
    EVM_PAYEE_ADDRESS: process.env.EVM_PAYEE_ADDRESS,
    NETWORK: process.env.NETWORK,
    APP_NAME: process.env.APP_NAME,
    APP_LOGO: process.env.APP_LOGO,
    CDP_CLIENT_KEY: process.env.CDP_CLIENT_KEY,
  },
  webpack(config) {
    config.module.rules.push({
      test: /\.svg$/,
      use: ["@svgr/webpack"],
    });
    return config;
  },
};

export default nextConfig;

