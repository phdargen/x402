use alloy_primitives::{keccak256, Address, B256};
use alloy_sol_types::SolValue;

use crate::types::{AttributionPair, SignedPair};

/// EIP-712 type string for Attribution messages (must match the gateway contract).
pub const ATTRIBUTION_TYPEHASH_STRING: &str =
    "Attribution(bytes32 channelId,address payTo,uint128 cumulativeAmount)";

/// `keccak256` of [`ATTRIBUTION_TYPEHASH_STRING`].
pub fn attribution_typehash() -> B256 {
    keccak256(ATTRIBUTION_TYPEHASH_STRING.as_bytes())
}

/// Leaf for one attribution vector entry: `keccak256(abi.encode(payTo, cumulative))`.
pub fn attribution_leaf(pay_to: Address, cumulative: u128) -> B256 {
    keccak256((pay_to, cumulative).abi_encode())
}

/// Sorted-vector attribution root.
///
/// - empty vector → `bytes32(0)`
/// - otherwise → `keccak256(leaf₁ ‖ … ‖ leaf_k)` with leaves in the given order
///
/// Callers must supply pairs already sorted strictly ascending by `pay_to`.
pub fn attribution_root_from_leaves(leaves: &[B256]) -> B256 {
    if leaves.is_empty() {
        return B256::ZERO;
    }
    let mut packed = Vec::with_capacity(leaves.len() * 32);
    for leaf in leaves {
        packed.extend_from_slice(leaf.as_slice());
    }
    keccak256(packed)
}

/// Root over an attribution pair vector.
pub fn attribution_root(pairs: &[AttributionPair]) -> B256 {
    let leaves: Vec<B256> = pairs
        .iter()
        .map(|p| attribution_leaf(p.pay_to, p.cumulative))
        .collect();
    attribution_root_from_leaves(&leaves)
}

/// Root over a signed-pair vector (signature bytes ignored for the commitment).
pub fn attribution_root_signed(pairs: &[SignedPair]) -> B256 {
    let leaves: Vec<B256> = pairs
        .iter()
        .map(|p| attribution_leaf(p.pay_to, p.cumulative))
        .collect();
    attribution_root_from_leaves(&leaves)
}

/// EIP-712 digest for `Attribution(channelId, payTo, cumulativeAmount)`.
pub fn attribution_digest(
    domain_separator: B256,
    channel_id: B256,
    pay_to: Address,
    cumulative: u128,
) -> B256 {
    let struct_hash =
        keccak256((attribution_typehash(), channel_id, pay_to, cumulative).abi_encode());
    let mut buf = [0u8; 66];
    buf[0] = 0x19;
    buf[1] = 0x01;
    buf[2..34].copy_from_slice(domain_separator.as_slice());
    buf[34..66].copy_from_slice(struct_hash.as_slice());
    keccak256(buf)
}

/// Claim leaf hashed into the batch commitment (matches the amended gateway).
#[allow(clippy::too_many_arguments)]
pub fn claim_leaf(
    channel_id: B256,
    payer: Address,
    payer_authorizer: Address,
    token: Address,
    prior_claimed: u128,
    total_claimed: u128,
    old_root: B256,
    new_root: B256,
) -> B256 {
    keccak256(
        (
            channel_id,
            payer,
            payer_authorizer,
            token,
            prior_claimed,
            total_claimed,
            old_root,
            new_root,
        )
            .abi_encode(),
    )
}

/// Credit leaf: `keccak256(abi.encode(receiver, token, amount))`.
pub fn credit_leaf(receiver: Address, token: Address, amount: u128) -> B256 {
    keccak256((receiver, token, amount).abi_encode())
}

/// `keccak256(abi.encodePacked(leaves))` — concatenation of `bytes32` values.
pub fn packed_hash(leaves: &[B256]) -> B256 {
    let mut packed = Vec::with_capacity(leaves.len() * 32);
    for leaf in leaves {
        packed.extend_from_slice(leaf.as_slice());
    }
    keccak256(packed)
}

/// Final public commitment bound by the gateway and the circuit.
pub fn batch_commitment(
    domain_separator: B256,
    claim_leaves: &[B256],
    credit_leaves: &[B256],
) -> B256 {
    keccak256(
        (
            domain_separator,
            packed_hash(claim_leaves),
            packed_hash(credit_leaves),
        )
            .abi_encode(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloy_primitives::address;

    #[test]
    fn empty_root_is_zero() {
        assert_eq!(attribution_root(&[]), B256::ZERO);
    }

    #[test]
    fn single_pair_root() {
        let pay_to = address!("0x0000000000000000000000000000000000000001");
        let leaf = attribution_leaf(pay_to, 100);
        assert_eq!(attribution_root_from_leaves(&[leaf]), keccak256(leaf));
    }

    #[test]
    fn typehash_matches_string() {
        assert_eq!(
            attribution_typehash(),
            keccak256(ATTRIBUTION_TYPEHASH_STRING.as_bytes())
        );
    }
}
