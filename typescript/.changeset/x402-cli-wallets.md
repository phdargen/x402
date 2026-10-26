---
"@x402/cli": patch
---

Add `@x402/cli`: the `x402` binary and a small library built around a pluggable `Wallet` interface. Ships `local` (environment variables) and `keychain` (macOS Keychain, Linux Secret Service) wallets, with EVM and SVM support opt-in through `@x402/cli/evm` and `@x402/cli/svm`. Payments skip testnets unless selected with `pay --network` or listed in the ordered `networks` allowlist, and RPC URLs can be set per network through config, `X402_RPC`, or `--rpc`.
