import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  env: {
    NEXT_DEV: process.env.NEXT_DEV ?? "",
  },
};

export default nextConfig;
