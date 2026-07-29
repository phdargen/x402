//! Shared attribution circuit logic for the hybrid ZK gateway.
//!
//! The guest and host both call [`verify_batch`], which re-derives every commitment leaf
//! and the final `batchCommitment`. Any violation panics (guest) or returns an error (host
//! tests), so no proof can exist for an invalid witness.

mod attribution;
mod ecdsa;
pub mod serde_hex;
mod types;
mod verify;

pub use serde_hex::bytes_hex;

pub use attribution::{
    attribution_digest, attribution_leaf, attribution_root, attribution_typehash, batch_commitment,
    claim_leaf, credit_leaf, ATTRIBUTION_TYPEHASH_STRING,
};
pub use ecdsa::{recover_signer, sign_digest, signing_key_address, SECP256K1_HALF_ORDER};
pub use types::{AttributionPair, BatchWitness, ChannelWitness, Credit, SignedPair, ADDRESS_ZERO};
pub use verify::{verify_batch, VerifyError};
