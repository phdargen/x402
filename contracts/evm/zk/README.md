# x402 attribution zk circuit (SP1)

SP1 zkVM circuit, host prover, and fixtures for
[`x402BatchSettlementGatewayHybridZk.sol`](../src/x402BatchSettlementGatewayHybridZk.sol).

The guest’s only public output is the 32-byte `batchCommitment` the gateway recomputes onchain.
Everything else (channel ids, payer keys, attribution vectors, credits) is private witness input.

## Layout

```
zk/
├── lib/      x402-attribution-core   # types, sorted-vector roots, verify_batch (host-testable)
├── program/  SP1 guest              # reads BatchWitness, commits batchCommitment
└── script/   host binaries          # prove, vkey, fixture
```

## Prerequisites

- [sp1up](https://docs.succinct.xyz/) / `cargo-prove` (SP1 6.x)
- Rust stable + the `succinct` toolchain (installed by `sp1up`)
- `protoc` (`brew install protobuf`)
- Docker (local Groth16) or a Succinct Prover Network key

## Patches

Guest crypto is accelerated via crates.io patches in the workspace `Cargo.toml`:

- `k256` → `sp1-patches/elliptic-curves` (`patch-k256-13.4-sp1-6.0.0`)
- `tiny-keccak` → `sp1-patches/tiny-keccak` (`patch-2.0.2-sp1-6.0.0`)

Confirm with:

```bash
cargo tree -p k256
cargo tree -p tiny-keccak
```

## Develop

```bash
# Unit-test the trusted core (no zkVM)
cargo test -p x402-attribution-core

# Print the program vkey (bytes32)
cargo run --release --bin vkey

# Emit Foundry parity vectors + prove inputs (sample and benchmark batches)
cargo run --release --bin fixture -- --parity --sample-input --bench-inputs

# Execute the guest (fast; prints cycle count)
RUST_LOG=info cargo run --release --bin prove -- \
  --input ../test/fixtures/batch.json --execute

# Benchmark cycle counts (5 attribution sigs per channel)
RUST_LOG=info cargo run --release --bin prove -- \
  --input ../test/fixtures/batch-10ch.json --execute
RUST_LOG=info cargo run --release --bin prove -- \
  --input ../test/fixtures/batch-100ch.json --execute

# Follow-up commit: full old_pairs vectors, 1 new sig per channel
RUST_LOG=info cargo run --release --bin prove -- \
  --input ../test/fixtures/batch-10ch-followup.json --execute
RUST_LOG=info cargo run --release --bin prove -- \
  --input ../test/fixtures/batch-100ch-followup.json --execute
```

### Benchmark prove inputs

| File | Channels | `old_pairs` | Sigs | Credits | Cycles (`--execute`) |
|------|----------|-------------|------|---------|----------------------|
| `batch.json` | 1 | 0 | 2 | 2 | ~138k |
| `batch-10ch.json` | 10 | 0 | 50 (5/ch) | 50 | ~3.1M |
| `batch-100ch.json` | 100 | 0 | 500 (5/ch) | 500 | ~32.6M |
| `batch-10ch-followup.json` | 10 | 50 (5/ch) | 10 (1/ch) | 10 | ~1.1M |
| `batch-100ch-followup.json` | 100 | 500 (5/ch) | 100 (1/ch) | 100 | ~11.0M |

Regenerate with `cargo run --release --bin fixture -- --bench-inputs`.

- **Initial** (`batch-*ch.json`): first commit from empty attribution; all pairs new and signed.
- **Follow-up** (`batch-*ch-followup.json`): simulates a later window — full prior vectors in
  `oldPairs`, only the first `payTo` per channel increases (+10); unchanged pairs carry empty
  signatures. Prover still walks every old/new pair for roots and monotonicity; ECDSA count
  matches active deltas, not historical breadth.

## Prove (Groth16)

Iteration with a mock proof (not valid onchain):

```bash
SP1_PROVER=mock cargo run --release --bin prove -- \
  --input ../test/fixtures/batch.json --groth16 --output /tmp/proof.json
```

Real Groth16 fixture for the fork test (manual only — do not run casually; slow and
memory-hungry; needs Docker or the network prover):

```bash
# Prefer the Succinct Prover Network
SP1_PROVER=network cargo run --release --bin fixture -- --groth16

# Or local CPU + Docker gnark wrapper (last resort)
SP1_PROVER=cpu cargo run --release --bin fixture -- --groth16
```

This writes `../test/fixtures/zk-attribution-groth16.json`. Deploy
`SP1AttributionVerifier` with that file’s `vkey` and the chain’s
`SP1VerifierGateway` (`0x397A5f7f3dBd538f23DE225B51f532c34448dA9B` on most EVMs).
The fork test skips cleanly if that file is absent.

**Circuit upgrades require a new verifier + new gateway** — `PROGRAM_VKEY` is immutable on
purpose so an upgrade key cannot silently swap the attribution rules.

## Foundry checks

From `contracts/evm/`:

```bash
forge build
forge test --match-contract 'SP1AttributionVerifierUnitTest|X402BatchSettlementGatewayHybridZkTest|ZkAttributionParityTest'

# Fork test (needs regenerated Groth16 fixture + RPC)
forge test --match-contract SP1AttributionVerifierForkTest --fork-url "$BASE_RPC_URL"
```
