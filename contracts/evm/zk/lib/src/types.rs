use alloy_primitives::{Address, B256};
use serde::{Deserialize, Serialize};

/// The zero address; used for `payerAuthorizer != 0` checks.
pub const ADDRESS_ZERO: Address = Address::ZERO;

/// One entry in an attribution vector: cumulative amount attributed to `pay_to`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AttributionPair {
    pub pay_to: Address,
    /// Cumulative attributed amount for this `pay_to` (matches Solidity `uint128`).
    #[serde(with = "u128_string")]
    pub cumulative: u128,
}

/// A new attribution pair plus the payer-authorizer ECDSA signature over
/// `Attribution(channelId, payTo, cumulative)` when the value increased.
///
/// For pairs that did not increase relative to `old_pairs`, `signature` may be empty and is
/// ignored. For increased or newly introduced pairs, `signature` must be a 65-byte
/// `(r ‖ s ‖ v)` signature with low-s.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SignedPair {
    pub pay_to: Address,
    #[serde(with = "u128_string")]
    pub cumulative: u128,
    /// Hex-encoded 65-byte signature, or `"0x"` when unused.
    #[serde(with = "crate::bytes_hex")]
    pub signature: Vec<u8>,
}

/// Per-channel witness consumed by [`crate::verify_batch`].
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChannelWitness {
    pub channel_id: B256,
    pub payer: Address,
    pub payer_authorizer: Address,
    pub token: Address,
    #[serde(with = "u128_string")]
    pub prior_claimed: u128,
    #[serde(with = "u128_string")]
    pub total_claimed: u128,
    /// Prior attribution vector, strictly ascending by `pay_to`.
    pub old_pairs: Vec<AttributionPair>,
    /// New attribution vector with signatures on increased pairs, strictly ascending by `pay_to`.
    pub new_pairs: Vec<SignedPair>,
}

/// One credit leaf: `(receiver, token, amount)`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Credit {
    pub receiver: Address,
    pub token: Address,
    #[serde(with = "u128_string")]
    pub amount: u128,
}

/// Full batch witness. The only public output of the circuit is the recomputed
/// `batchCommitment`; everything here is private witness input.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchWitness {
    pub domain_separator: B256,
    pub channels: Vec<ChannelWitness>,
    pub credits: Vec<Credit>,
}

/// Serde helpers: encode `u128` as a decimal string so JSON stays JS-safe.
mod u128_string {
    use serde::{self, Deserialize, Deserializer, Serializer};

    pub fn serialize<S>(value: &u128, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(&value.to_string())
    }

    pub fn deserialize<'de, D>(deserializer: D) -> Result<u128, D::Error>
    where
        D: Deserializer<'de>,
    {
        let s = String::deserialize(deserializer)?;
        s.parse().map_err(serde::de::Error::custom)
    }
}
