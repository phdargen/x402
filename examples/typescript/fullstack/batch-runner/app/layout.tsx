import type { Metadata } from "next";
import { Geist_Mono } from "next/font/google";
import { headers } from "next/headers";
import { cookieToInitialState } from "wagmi";
import { config } from "@/lib/wagmi";
import { Providers } from "./providers";
import "./globals.css";

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Batch Runner | 1,000 jumps. $1. Zero gas.",
  description:
    "Chrome-dino-style browser game showcasing x402 batch-settlement. Deposit $1 USDC, each jump costs $0.001 via a signed voucher.",
};

export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const initialState = cookieToInitialState(config, (await headers()).get("cookie"));
  return (
    <html lang="en">
      <body className={`${geistMono.variable} antialiased`}>
        <Providers initialState={initialState}>{children}</Providers>
      </body>
    </html>
  );
}
