use alloy_primitives::{Address, B256};
use std::collections::BTreeMap;

use crate::attribution::{
    attribution_digest, attribution_root, attribution_root_signed, batch_commitment, claim_leaf,
    credit_leaf,
};
use crate::ecdsa::recover_signer;
use crate::types::{AttributionPair, BatchWitness, ADDRESS_ZERO};

/// Errors from [`verify_batch`]. The guest panics on any of these; host tests match on them.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum VerifyError {
    EmptyBatch,
    UnsortedOrDuplicateChannel,
    ZeroPayerAuthorizer,
    NoClaimDelta,
    UnsortedOrDuplicatePair,
    UnchangedAttributionRoot,
    NotMonotonic,
    MissingOldPair,
    InvalidAttributionSignature,
    ChannelConservationMismatch,
    UnsortedOrDuplicateCredit,
    ZeroCredit,
    InvalidCreditReceiver,
    CreditMismatch,
}

impl core::fmt::Display for VerifyError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        write!(f, "{self:?}")
    }
}

impl std::error::Error for VerifyError {}

/// Verify a batch witness and return the recomputed `batchCommitment`.
///
/// Enforcement order matches the plan: channel ordering → authorizer → claim delta →
/// pair ordering / roots / monotonicity / signatures → per-channel conservation →
/// credit ordering / cross-batch credit equality → commitment.
pub fn verify_batch(witness: &BatchWitness) -> Result<B256, VerifyError> {
    let n = witness.channels.len();
    let m = witness.credits.len();
    if n == 0 || m == 0 {
        return Err(VerifyError::EmptyBatch);
    }

    let mut claim_leaves = Vec::with_capacity(n);
    let mut previous_channel_id = B256::ZERO;
    // Aggregate attributed deltas per (payTo, token).
    let mut attributed: BTreeMap<(Address, Address), u128> = BTreeMap::new();

    for (i, ch) in witness.channels.iter().enumerate() {
        if i != 0 && ch.channel_id <= previous_channel_id {
            return Err(VerifyError::UnsortedOrDuplicateChannel);
        }
        previous_channel_id = ch.channel_id;

        if ch.payer_authorizer == ADDRESS_ZERO {
            return Err(VerifyError::ZeroPayerAuthorizer);
        }
        if ch.total_claimed <= ch.prior_claimed {
            return Err(VerifyError::NoClaimDelta);
        }

        ensure_pairs_sorted_old(&ch.old_pairs)?;
        ensure_pairs_sorted_new(&ch.new_pairs)?;

        let old_root = attribution_root(&ch.old_pairs);
        let new_root = attribution_root_signed(&ch.new_pairs);
        if new_root == old_root {
            return Err(VerifyError::UnchangedAttributionRoot);
        }

        let sum_delta = check_monotonic_and_sigs(
            witness.domain_separator,
            ch.channel_id,
            ch.payer_authorizer,
            &ch.old_pairs,
            &ch.new_pairs,
        )?;

        let claim_delta = ch.total_claimed - ch.prior_claimed;
        if sum_delta != claim_delta {
            return Err(VerifyError::ChannelConservationMismatch);
        }

        // Fold per-payTo deltas into the batch credit map for this channel's token.
        accumulate_deltas(&mut attributed, ch.token, &ch.old_pairs, &ch.new_pairs)?;

        claim_leaves.push(claim_leaf(
            ch.channel_id,
            ch.payer,
            ch.payer_authorizer,
            ch.token,
            ch.prior_claimed,
            ch.total_claimed,
            old_root,
            new_root,
        ));
    }

    let mut credit_leaves = Vec::with_capacity(m);
    let mut expected_credits: BTreeMap<(Address, Address), u128> = BTreeMap::new();
    for (j, c) in witness.credits.iter().enumerate() {
        if c.receiver == ADDRESS_ZERO {
            return Err(VerifyError::InvalidCreditReceiver);
        }
        if c.amount == 0 {
            return Err(VerifyError::ZeroCredit);
        }
        if j != 0 {
            let prev = &witness.credits[j - 1];
            if c.receiver < prev.receiver || (c.receiver == prev.receiver && c.token <= prev.token)
            {
                return Err(VerifyError::UnsortedOrDuplicateCredit);
            }
        }
        expected_credits.insert((c.receiver, c.token), c.amount);
        credit_leaves.push(credit_leaf(c.receiver, c.token, c.amount));
    }

    if attributed != expected_credits {
        return Err(VerifyError::CreditMismatch);
    }

    Ok(batch_commitment(
        witness.domain_separator,
        &claim_leaves,
        &credit_leaves,
    ))
}

fn ensure_pairs_sorted_old(pairs: &[AttributionPair]) -> Result<(), VerifyError> {
    for w in pairs.windows(2) {
        if w[0].pay_to >= w[1].pay_to {
            return Err(VerifyError::UnsortedOrDuplicatePair);
        }
    }
    Ok(())
}

fn ensure_pairs_sorted_new(pairs: &[crate::types::SignedPair]) -> Result<(), VerifyError> {
    for w in pairs.windows(2) {
        if w[0].pay_to >= w[1].pay_to {
            return Err(VerifyError::UnsortedOrDuplicatePair);
        }
    }
    Ok(())
}

/// Walk old/new vectors: enforce new ⊇ old with elementwise ≥, verify ECDSA on increases,
/// and return Σ(new − old).
fn check_monotonic_and_sigs(
    domain_separator: B256,
    channel_id: B256,
    payer_authorizer: Address,
    old_pairs: &[AttributionPair],
    new_pairs: &[crate::types::SignedPair],
) -> Result<u128, VerifyError> {
    let mut i = 0usize;
    let mut j = 0usize;
    let mut sum_delta: u128 = 0;

    while i < old_pairs.len() || j < new_pairs.len() {
        if i < old_pairs.len()
            && (j == new_pairs.len() || old_pairs[i].pay_to < new_pairs[j].pay_to)
        {
            // payTo present in old but missing from new.
            return Err(VerifyError::MissingOldPair);
        }

        if j < new_pairs.len()
            && (i == old_pairs.len() || new_pairs[j].pay_to < old_pairs[i].pay_to)
        {
            // New payTo.
            let np = &new_pairs[j];
            let old_cum = 0u128;
            if np.cumulative < old_cum {
                return Err(VerifyError::NotMonotonic);
            }
            let delta = np.cumulative - old_cum;
            if delta > 0 {
                verify_attribution_sig(
                    domain_separator,
                    channel_id,
                    payer_authorizer,
                    np.pay_to,
                    np.cumulative,
                    &np.signature,
                )?;
            }
            sum_delta = sum_delta
                .checked_add(delta)
                .ok_or(VerifyError::ChannelConservationMismatch)?;
            j += 1;
            continue;
        }

        // Same payTo in both.
        let op = &old_pairs[i];
        let np = &new_pairs[j];
        debug_assert_eq!(op.pay_to, np.pay_to);
        if np.cumulative < op.cumulative {
            return Err(VerifyError::NotMonotonic);
        }
        let delta = np.cumulative - op.cumulative;
        if delta > 0 {
            verify_attribution_sig(
                domain_separator,
                channel_id,
                payer_authorizer,
                np.pay_to,
                np.cumulative,
                &np.signature,
            )?;
        }
        sum_delta = sum_delta
            .checked_add(delta)
            .ok_or(VerifyError::ChannelConservationMismatch)?;
        i += 1;
        j += 1;
    }

    Ok(sum_delta)
}

fn verify_attribution_sig(
    domain_separator: B256,
    channel_id: B256,
    payer_authorizer: Address,
    pay_to: Address,
    cumulative: u128,
    signature: &[u8],
) -> Result<(), VerifyError> {
    let digest = attribution_digest(domain_separator, channel_id, pay_to, cumulative);
    let recovered =
        recover_signer(digest, signature).map_err(|_| VerifyError::InvalidAttributionSignature)?;
    if recovered != payer_authorizer {
        return Err(VerifyError::InvalidAttributionSignature);
    }
    Ok(())
}

fn accumulate_deltas(
    attributed: &mut BTreeMap<(Address, Address), u128>,
    token: Address,
    old_pairs: &[AttributionPair],
    new_pairs: &[crate::types::SignedPair],
) -> Result<(), VerifyError> {
    let mut i = 0usize;
    let mut j = 0usize;
    while i < old_pairs.len() || j < new_pairs.len() {
        if i < old_pairs.len()
            && (j == new_pairs.len() || old_pairs[i].pay_to < new_pairs[j].pay_to)
        {
            return Err(VerifyError::MissingOldPair);
        }
        if j < new_pairs.len()
            && (i == old_pairs.len() || new_pairs[j].pay_to < old_pairs[i].pay_to)
        {
            let np = &new_pairs[j];
            add_amount(attributed, np.pay_to, token, np.cumulative)?;
            j += 1;
            continue;
        }
        let op = &old_pairs[i];
        let np = &new_pairs[j];
        let delta = np.cumulative - op.cumulative;
        if delta > 0 {
            add_amount(attributed, np.pay_to, token, delta)?;
        }
        i += 1;
        j += 1;
    }
    Ok(())
}

fn add_amount(
    map: &mut BTreeMap<(Address, Address), u128>,
    pay_to: Address,
    token: Address,
    amount: u128,
) -> Result<(), VerifyError> {
    let entry = map.entry((pay_to, token)).or_insert(0);
    *entry = entry
        .checked_add(amount)
        .ok_or(VerifyError::ChannelConservationMismatch)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ecdsa::{sign_digest, signing_key_address};
    use crate::types::{ChannelWitness, Credit, SignedPair};
    use alloy_primitives::{address, b256, keccak256};
    use k256::ecdsa::SigningKey;

    fn auth_key() -> SigningKey {
        SigningKey::from_slice(&[9u8; 32]).unwrap()
    }

    fn sign_attr(
        sk: &SigningKey,
        domain: B256,
        channel_id: B256,
        pay_to: Address,
        cumulative: u128,
    ) -> Vec<u8> {
        let digest = attribution_digest(domain, channel_id, pay_to, cumulative);
        sign_digest(sk, digest).unwrap().to_vec()
    }

    fn sample_witness() -> (BatchWitness, B256) {
        let sk = auth_key();
        let authorizer = signing_key_address(&sk);
        let domain = keccak256(b"test-domain");
        let channel_id =
            b256!("0x1111111111111111111111111111111111111111111111111111111111111111");
        let payer = address!("0x00000000000000000000000000000000000000aa");
        let token = address!("0x00000000000000000000000000000000000000bb");
        let recv_a = address!("0x0000000000000000000000000000000000000001");
        let recv_b = address!("0x0000000000000000000000000000000000000002");

        let new_pairs = vec![
            SignedPair {
                pay_to: recv_a,
                cumulative: 60,
                signature: sign_attr(&sk, domain, channel_id, recv_a, 60),
            },
            SignedPair {
                pay_to: recv_b,
                cumulative: 40,
                signature: sign_attr(&sk, domain, channel_id, recv_b, 40),
            },
        ];

        let witness = BatchWitness {
            domain_separator: domain,
            channels: vec![ChannelWitness {
                channel_id,
                payer,
                payer_authorizer: authorizer,
                token,
                prior_claimed: 0,
                total_claimed: 100,
                old_pairs: vec![],
                new_pairs,
            }],
            credits: vec![
                Credit {
                    receiver: recv_a,
                    token,
                    amount: 60,
                },
                Credit {
                    receiver: recv_b,
                    token,
                    amount: 40,
                },
            ],
        };
        (witness, domain)
    }

    #[test]
    fn happy_path() {
        let (witness, _) = sample_witness();
        let commitment = verify_batch(&witness).unwrap();
        assert_ne!(commitment, B256::ZERO);
    }

    #[test]
    fn rejects_zero_authorizer() {
        let (mut witness, _) = sample_witness();
        witness.channels[0].payer_authorizer = ADDRESS_ZERO;
        assert_eq!(
            verify_batch(&witness),
            Err(VerifyError::ZeroPayerAuthorizer)
        );
    }

    #[test]
    fn rejects_no_claim_delta() {
        let (mut witness, _) = sample_witness();
        witness.channels[0].total_claimed = witness.channels[0].prior_claimed;
        assert_eq!(verify_batch(&witness), Err(VerifyError::NoClaimDelta));
    }

    #[test]
    fn rejects_bad_signature() {
        let (mut witness, _) = sample_witness();
        witness.channels[0].new_pairs[0].signature[0] ^= 0xff;
        assert_eq!(
            verify_batch(&witness),
            Err(VerifyError::InvalidAttributionSignature)
        );
    }

    #[test]
    fn rejects_credit_mismatch() {
        let (mut witness, _) = sample_witness();
        witness.credits[0].amount = 59;
        assert_eq!(verify_batch(&witness), Err(VerifyError::CreditMismatch));
    }

    #[test]
    fn rejects_unsorted_credits() {
        let (mut witness, _) = sample_witness();
        witness.credits.swap(0, 1);
        assert_eq!(
            verify_batch(&witness),
            Err(VerifyError::UnsortedOrDuplicateCredit)
        );
    }

    #[test]
    fn incremental_update_reuses_unchanged_pair_without_sig() {
        let sk = auth_key();
        let authorizer = signing_key_address(&sk);
        let domain = keccak256(b"test-domain-2");
        let channel_id =
            b256!("0x2222222222222222222222222222222222222222222222222222222222222222");
        let payer = address!("0x00000000000000000000000000000000000000aa");
        let token = address!("0x00000000000000000000000000000000000000bb");
        let recv_a = address!("0x0000000000000000000000000000000000000001");
        let recv_b = address!("0x0000000000000000000000000000000000000002");

        let old_pairs = vec![
            AttributionPair {
                pay_to: recv_a,
                cumulative: 60,
            },
            AttributionPair {
                pay_to: recv_b,
                cumulative: 40,
            },
        ];
        // Increase only recv_a; recv_b unchanged — empty sig ok.
        let new_pairs = vec![
            SignedPair {
                pay_to: recv_a,
                cumulative: 90,
                signature: sign_attr(&sk, domain, channel_id, recv_a, 90),
            },
            SignedPair {
                pay_to: recv_b,
                cumulative: 40,
                signature: vec![],
            },
        ];

        let witness = BatchWitness {
            domain_separator: domain,
            channels: vec![ChannelWitness {
                channel_id,
                payer,
                payer_authorizer: authorizer,
                token,
                prior_claimed: 100,
                total_claimed: 130,
                old_pairs,
                new_pairs,
            }],
            credits: vec![Credit {
                receiver: recv_a,
                token,
                amount: 30,
            }],
        };
        assert!(verify_batch(&witness).is_ok());
    }
}
