//! SP1 guest: verify a [`BatchWitness`] and commit the 32-byte `batchCommitment`.
//!
//! All channel / attribution / credit data is untrusted witness input. Binding to onchain
//! state is done by the gateway, which recomputes the same commitment from data it read
//! onchain and checks equality against the proof's public values.

#![no_main]
sp1_zkvm::entrypoint!(main);

use x402_attribution_core::{verify_batch, BatchWitness};

pub fn main() {
    let witness = sp1_zkvm::io::read::<BatchWitness>();
    let batch_commitment = verify_batch(&witness).expect("invalid batch witness");
    // Public values: abi.encode(bytes32) == the raw 32 bytes.
    sp1_zkvm::io::commit_slice(batch_commitment.as_slice());
}
