//! Generate Foundry fixtures: encoding parity vectors and an optional Groth16 proof fixture.
//!
//! ```shell
//! # Parity vectors only (no prover)
//! cargo run --release --bin fixture -- --parity
//!
//! # Sample + benchmark prove inputs (1 / 10 / 100 channels)
//! cargo run --release --bin fixture -- --sample-input --bench-inputs
//!
//! # Groth16 fixture for the fork test (slow; needs Docker or network prover)
//! SP1_PROVER=cpu cargo run --release --bin fixture -- --groth16
//! ```

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use alloy_primitives::{address, b256, keccak256, Address, B256};
use clap::Parser;
use k256::ecdsa::SigningKey;
use serde::Serialize;
use sp1_sdk::{
    blocking::{ProveRequest, Prover, ProverClient},
    include_elf, Elf, HashableKey, ProvingKey, SP1Stdin,
};
use x402_attribution_core::{
    attribution_digest, attribution_leaf, attribution_root, attribution_typehash, batch_commitment,
    claim_leaf, credit_leaf, sign_digest, signing_key_address, verify_batch, AttributionPair,
    BatchWitness, ChannelWitness, Credit, SignedPair,
};

const ELF: Elf = include_elf!("x402-attribution-program");

/// New `payTo` pairs per channel in benchmark batches (each needs an ECDSA verify in-circuit).
const BENCH_PAIRS_PER_CHANNEL: usize = 5;
/// Attribution amount per pair on the initial commit.
const BENCH_AMOUNT_PER_PAIR: u128 = 20;
/// Extra claim on the follow-up commit (one increased pair per channel).
const BENCH_FOLLOWUP_DELTA: u128 = 10;

#[derive(Parser, Debug)]
#[command(author, version, about)]
struct Args {
    /// Write `test/fixtures/zk-attribution-vectors.json`.
    #[arg(long)]
    parity: bool,

    /// Prove a sample batch with Groth16 and write `test/fixtures/zk-attribution-groth16.json`.
    #[arg(long)]
    groth16: bool,

    /// Also write a `batch.json` prove-input for the sample batch (for `--execute` / proving).
    #[arg(long)]
    sample_input: bool,

    /// Write `batch-10ch.json` and `batch-100ch.json` benchmark prove inputs.
    #[arg(long)]
    bench_inputs: bool,

    /// Override the Foundry `test/fixtures` directory (defaults to ../../test/fixtures).
    #[arg(long)]
    out_dir: Option<PathBuf>,
}

fn main() {
    sp1_sdk::utils::setup_logger();
    dotenv::dotenv().ok();

    let args = Args::parse();
    if !args.parity && !args.groth16 && !args.sample_input && !args.bench_inputs {
        eprintln!("Error: specify --parity, --groth16, --sample-input, and/or --bench-inputs");
        std::process::exit(1);
    }

    let out_dir = args
        .out_dir
        .unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../test/fixtures"));
    std::fs::create_dir_all(&out_dir).expect("create fixtures dir");

    if args.parity {
        let vectors = build_parity_vectors();
        let path = out_dir.join("zk-attribution-vectors.json");
        std::fs::write(&path, serde_json::to_string_pretty(&vectors).unwrap())
            .expect("write parity vectors");
        println!("Wrote {}", path.display());
    }

    if args.sample_input {
        let (witness, _) = sample_batch();
        write_prove_input(&witness, &out_dir.join("batch.json"));
    }

    if args.bench_inputs {
        for channels in [10_usize, 100] {
            let (witness, _) = scaled_batch(channels, BENCH_PAIRS_PER_CHANNEL);
            write_prove_input(&witness, &out_dir.join(format!("batch-{channels}ch.json")));

            let (followup, _) = scaled_followup_batch(channels, BENCH_PAIRS_PER_CHANNEL);
            write_prove_input(
                &followup,
                &out_dir.join(format!("batch-{channels}ch-followup.json")),
            );
        }
    }

    if args.groth16 {
        let (witness, commitment) = sample_batch();
        let mut stdin = SP1Stdin::new();
        stdin.write(&witness);

        let client = ProverClient::from_env();
        let pk = client.setup(ELF).expect("setup");
        let proof = client
            .prove(&pk, stdin)
            .groth16()
            .run()
            .expect("groth16 prove");
        client
            .verify(&proof, pk.verifying_key(), None)
            .expect("verify");

        let fixture = Groth16Fixture {
            vkey: pk.verifying_key().bytes32().to_string(),
            batch_commitment: format!("0x{}", hex::encode(commitment.as_slice())),
            public_values: format!("0x{}", hex::encode(proof.public_values.as_slice())),
            proof: format!("0x{}", hex::encode(proof.bytes())),
        };
        let path = out_dir.join("zk-attribution-groth16.json");
        std::fs::write(&path, serde_json::to_string_pretty(&fixture).unwrap())
            .expect("write groth16 fixture");
        println!("Wrote {}", path.display());
        println!("vkey: {}", fixture.vkey);
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ParityVectors {
    attribution_typehash: String,
    empty_root: String,
    /// Explicit count — Foundry's `parseJsonUint` cannot read `.pairs.length`.
    pair_count: usize,
    pairs: Vec<PairVector>,
    root: String,
    attribution_digest: DigestVector,
    claim_leaf: ClaimLeafVector,
    credit_leaf: CreditLeafVector,
    batch: BatchVector,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PairVector {
    pay_to: String,
    cumulative: String,
    leaf: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DigestVector {
    domain_separator: String,
    channel_id: String,
    pay_to: String,
    cumulative: String,
    digest: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ClaimLeafVector {
    channel_id: String,
    payer: String,
    payer_authorizer: String,
    token: String,
    prior_claimed: String,
    total_claimed: String,
    old_root: String,
    new_root: String,
    leaf: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CreditLeafVector {
    receiver: String,
    token: String,
    amount: String,
    leaf: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BatchVector {
    domain_separator: String,
    claim_leaf_count: usize,
    credit_leaf_count: usize,
    claim_leaves: Vec<String>,
    credit_leaves: Vec<String>,
    batch_commitment: String,
    /// Full witness that `verify_batch` accepts (for cross-checks).
    witness_commitment: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Groth16Fixture {
    vkey: String,
    batch_commitment: String,
    public_values: String,
    proof: String,
}

fn build_parity_vectors() -> ParityVectors {
    let (witness, commitment) = sample_batch();

    let pairs = &witness.channels[0].new_pairs;
    let pair_vecs: Vec<PairVector> = pairs
        .iter()
        .map(|p| PairVector {
            pay_to: addr_hex(p.pay_to),
            cumulative: p.cumulative.to_string(),
            leaf: b256_hex(attribution_leaf(p.pay_to, p.cumulative)),
        })
        .collect();

    let attr_pairs: Vec<AttributionPair> = pairs
        .iter()
        .map(|p| AttributionPair {
            pay_to: p.pay_to,
            cumulative: p.cumulative,
        })
        .collect();
    let root = attribution_root(&attr_pairs);

    let ch = &witness.channels[0];
    let digest_pay_to = pairs[0].pay_to;
    let digest_cum = pairs[0].cumulative;
    let digest = attribution_digest(
        witness.domain_separator,
        ch.channel_id,
        digest_pay_to,
        digest_cum,
    );

    let old_root = B256::ZERO;
    let claim = claim_leaf(
        ch.channel_id,
        ch.payer,
        ch.payer_authorizer,
        ch.token,
        ch.prior_claimed,
        ch.total_claimed,
        old_root,
        root,
    );
    let credit = &witness.credits[0];
    let c_leaf = credit_leaf(credit.receiver, credit.token, credit.amount);

    let claim_leaves = vec![claim];
    let credit_leaves: Vec<B256> = witness
        .credits
        .iter()
        .map(|c| credit_leaf(c.receiver, c.token, c.amount))
        .collect();
    let recomputed = batch_commitment(witness.domain_separator, &claim_leaves, &credit_leaves);
    assert_eq!(recomputed, commitment);

    ParityVectors {
        attribution_typehash: b256_hex(attribution_typehash()),
        empty_root: b256_hex(B256::ZERO),
        pair_count: pair_vecs.len(),
        pairs: pair_vecs,
        root: b256_hex(root),
        attribution_digest: DigestVector {
            domain_separator: b256_hex(witness.domain_separator),
            channel_id: b256_hex(ch.channel_id),
            pay_to: addr_hex(digest_pay_to),
            cumulative: digest_cum.to_string(),
            digest: b256_hex(digest),
        },
        claim_leaf: ClaimLeafVector {
            channel_id: b256_hex(ch.channel_id),
            payer: addr_hex(ch.payer),
            payer_authorizer: addr_hex(ch.payer_authorizer),
            token: addr_hex(ch.token),
            prior_claimed: ch.prior_claimed.to_string(),
            total_claimed: ch.total_claimed.to_string(),
            old_root: b256_hex(old_root),
            new_root: b256_hex(root),
            leaf: b256_hex(claim),
        },
        credit_leaf: CreditLeafVector {
            receiver: addr_hex(credit.receiver),
            token: addr_hex(credit.token),
            amount: credit.amount.to_string(),
            leaf: b256_hex(c_leaf),
        },
        batch: BatchVector {
            domain_separator: b256_hex(witness.domain_separator),
            claim_leaf_count: claim_leaves.len(),
            credit_leaf_count: credit_leaves.len(),
            claim_leaves: claim_leaves.iter().map(|l| b256_hex(*l)).collect(),
            credit_leaves: credit_leaves.iter().map(|l| b256_hex(*l)).collect(),
            batch_commitment: b256_hex(recomputed),
            witness_commitment: b256_hex(commitment),
        },
    }
}

fn sample_batch() -> (BatchWitness, B256) {
    let sk = SigningKey::from_slice(&[9u8; 32]).unwrap();
    let authorizer = signing_key_address(&sk);
    // Fixed domain so fixtures are reproducible across regenerations.
    let domain = b256!("0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    let channel_id = b256!("0x1111111111111111111111111111111111111111111111111111111111111111");
    let payer = address!("0x00000000000000000000000000000000000000aa");
    let token = address!("0x00000000000000000000000000000000000000bb");
    let recv_a = address!("0x0000000000000000000000000000000000000001");
    let recv_b = address!("0x0000000000000000000000000000000000000002");

    let sig_a = sign_attr(&sk, domain, channel_id, recv_a, 60);
    let sig_b = sign_attr(&sk, domain, channel_id, recv_b, 40);

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
            new_pairs: vec![
                SignedPair {
                    pay_to: recv_a,
                    cumulative: 60,
                    signature: sig_a,
                },
                SignedPair {
                    pay_to: recv_b,
                    cumulative: 40,
                    signature: sig_b,
                },
            ],
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
    let commitment = verify_batch(&witness).expect("sample batch invalid");
    (witness, commitment)
}

/// Multi-channel benchmark batch: `channels` escrow channels, each with `pairs_per_channel`
/// fresh attribution entries (all signed; empty `old_pairs`).
fn scaled_batch(channels: usize, pairs_per_channel: usize) -> (BatchWitness, B256) {
    assert!(channels > 0);
    assert!(pairs_per_channel > 0);

    let sk = SigningKey::from_slice(&[9u8; 32]).unwrap();
    let authorizer = signing_key_address(&sk);
    let domain = b256!("0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
    let token = address!("0x00000000000000000000000000000000000000bb");

    let mut channel_witnesses = Vec::with_capacity(channels);
    let mut credit_totals: BTreeMap<(Address, Address), u128> = BTreeMap::new();

    for i in 0..channels {
        let channel_id = channel_id_for_index(i);
        let payer = Address::from_word(B256::from(alloy_primitives::U256::from(
            0xaa00u64 + i as u64,
        )));
        let mut new_pairs = Vec::with_capacity(pairs_per_channel);
        let mut total_claimed = 0u128;

        for j in 0..pairs_per_channel {
            let pay_to = pay_to_for_index(i, j);
            let cumulative = BENCH_AMOUNT_PER_PAIR;
            total_claimed = total_claimed
                .checked_add(cumulative)
                .expect("total_claimed overflow");
            new_pairs.push(SignedPair {
                pay_to,
                cumulative,
                signature: sign_attr(&sk, domain, channel_id, pay_to, cumulative),
            });
            credit_totals
                .entry((pay_to, token))
                .and_modify(|sum| *sum += cumulative)
                .or_insert(cumulative);
        }

        channel_witnesses.push(ChannelWitness {
            channel_id,
            payer,
            payer_authorizer: authorizer,
            token,
            prior_claimed: 0,
            total_claimed,
            old_pairs: vec![],
            new_pairs,
        });
    }

    let credits: Vec<Credit> = credit_totals
        .into_iter()
        .map(|((receiver, token), amount)| Credit {
            receiver,
            token,
            amount,
        })
        .collect();

    let witness = BatchWitness {
        domain_separator: domain,
        channels: channel_witnesses,
        credits,
    };
    let commitment = verify_batch(&witness).expect("scaled batch invalid");
    (witness, commitment)
}

/// Follow-up commit after [`scaled_batch`]: each channel carries a full `old_pairs` vector,
/// increases only the first `payTo` by [`BENCH_FOLLOWUP_DELTA`], and reuses empty signatures
/// on unchanged pairs (mirrors production after the initial attribution commit).
fn scaled_followup_batch(channels: usize, pairs_per_channel: usize) -> (BatchWitness, B256) {
    assert!(channels > 0);
    assert!(pairs_per_channel > 0);

    let sk = SigningKey::from_slice(&[9u8; 32]).unwrap();
    let authorizer = signing_key_address(&sk);
    let domain = b256!("0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
    let token = address!("0x00000000000000000000000000000000000000bb");

    let prior_per_channel = BENCH_AMOUNT_PER_PAIR
        .checked_mul(pairs_per_channel as u128)
        .expect("prior_per_channel overflow");
    let total_per_channel = prior_per_channel
        .checked_add(BENCH_FOLLOWUP_DELTA)
        .expect("total_per_channel overflow");

    let mut channel_witnesses = Vec::with_capacity(channels);
    let mut credit_totals: BTreeMap<(Address, Address), u128> = BTreeMap::new();

    for i in 0..channels {
        let channel_id = channel_id_for_index(i);
        let payer = Address::from_word(B256::from(alloy_primitives::U256::from(
            0xaa00u64 + i as u64,
        )));

        let mut old_pairs = Vec::with_capacity(pairs_per_channel);
        let mut new_pairs = Vec::with_capacity(pairs_per_channel);

        for j in 0..pairs_per_channel {
            let pay_to = pay_to_for_index(i, j);
            old_pairs.push(AttributionPair {
                pay_to,
                cumulative: BENCH_AMOUNT_PER_PAIR,
            });

            if j == 0 {
                let new_cumulative = BENCH_AMOUNT_PER_PAIR + BENCH_FOLLOWUP_DELTA;
                new_pairs.push(SignedPair {
                    pay_to,
                    cumulative: new_cumulative,
                    signature: sign_attr(&sk, domain, channel_id, pay_to, new_cumulative),
                });
                credit_totals
                    .entry((pay_to, token))
                    .and_modify(|sum| *sum += BENCH_FOLLOWUP_DELTA)
                    .or_insert(BENCH_FOLLOWUP_DELTA);
            } else {
                new_pairs.push(SignedPair {
                    pay_to,
                    cumulative: BENCH_AMOUNT_PER_PAIR,
                    signature: vec![],
                });
            }
        }

        channel_witnesses.push(ChannelWitness {
            channel_id,
            payer,
            payer_authorizer: authorizer,
            token,
            prior_claimed: prior_per_channel,
            total_claimed: total_per_channel,
            old_pairs,
            new_pairs,
        });
    }

    let credits: Vec<Credit> = credit_totals
        .into_iter()
        .map(|((receiver, token), amount)| Credit {
            receiver,
            token,
            amount,
        })
        .collect();

    let witness = BatchWitness {
        domain_separator: domain,
        channels: channel_witnesses,
        credits,
    };
    let commitment = verify_batch(&witness).expect("scaled followup batch invalid");
    (witness, commitment)
}

fn channel_id_for_index(i: usize) -> B256 {
    let mut bytes = [0u8; 32];
    bytes[24..].copy_from_slice(&(i as u64 + 1).to_be_bytes());
    B256::from(bytes)
}

fn pay_to_for_index(i: usize, j: usize) -> Address {
    // Globally unique, strictly ascending within each channel's pair vector.
    Address::from_word(B256::from(alloy_primitives::U256::from(
        (i as u128 * 1000) + (j as u128) + 1,
    )))
}

/// Serialize witness + placeholder claim rows for `prove --input`.
fn write_prove_input(witness: &BatchWitness, path: &Path) {
    let claims: Vec<serde_json::Value> = witness
        .channels
        .iter()
        .map(|ch| {
            serde_json::json!({
                "config": {
                    "payer": ch.payer,
                    "payerAuthorizer": ch.payer_authorizer,
                    "receiver": "0x0000000000000000000000000000000000000001",
                    "receiverAuthorizer": "0x0000000000000000000000000000000000000001",
                    "token": ch.token,
                    "withdrawDelay": 3600,
                    "salt": "0x0000000000000000000000000000000000000000000000000000000000000000"
                },
                "maxClaimableAmount": ch.total_claimed.to_string(),
                "signature": format!("0x{}", hex::encode([0u8; 65]))
            })
        })
        .collect();
    let mut input = serde_json::to_value(witness).expect("serialize witness");
    input
        .as_object_mut()
        .expect("witness object")
        .insert("claims".into(), serde_json::Value::Array(claims));
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).ok();
    }
    std::fs::write(path, serde_json::to_string_pretty(&input).unwrap()).expect("write batch");
    let sigs = witness
        .channels
        .iter()
        .flat_map(|ch| ch.new_pairs.iter())
        .filter(|p| !p.signature.is_empty())
        .count();
    let old_pair_rows = witness
        .channels
        .iter()
        .map(|ch| ch.old_pairs.len())
        .sum::<usize>();
    println!(
        "Wrote {} ({} channels, {} old_pairs rows, {} attribution signatures, {} credits)",
        path.display(),
        witness.channels.len(),
        old_pair_rows,
        sigs,
        witness.credits.len()
    );
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

fn addr_hex(a: Address) -> String {
    format!("{a}")
}

fn b256_hex(b: B256) -> String {
    format!("{b}")
}

#[allow(dead_code)]
fn _keccak_sanity() {
    let _ = keccak256(b"x");
}
