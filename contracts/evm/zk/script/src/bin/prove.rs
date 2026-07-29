//! File-driven host prover for the attribution circuit.
//!
//! ```shell
//! # Execute only (fast, prints cycle count)
//! RUST_LOG=info cargo run --release --bin prove -- --input batch.json --execute
//!
//! # Groth16 proof (needs Docker / network prover; use SP1_PROVER=mock for a mock proof)
//! RUST_LOG=info cargo run --release --bin prove -- --input batch.json --groth16 --output proof.json
//! ```

use std::path::PathBuf;

use alloy_primitives::{aliases::U40, Address, B256};
use alloy_sol_types::{sol, SolCall};
use clap::Parser;
use serde::{Deserialize, Serialize};
use sp1_sdk::{
    blocking::{ProveRequest, Prover, ProverClient},
    include_elf, Elf, HashableKey, ProvingKey, SP1Stdin,
};
use x402_attribution_core::{
    attribution_root, verify_batch, AttributionPair, BatchWitness,
};

const ELF: Elf = include_elf!("x402-attribution-program");

sol! {
    struct ChannelConfig {
        address payer;
        address payerAuthorizer;
        address receiver;
        address receiverAuthorizer;
        address token;
        uint40 withdrawDelay;
        bytes32 salt;
    }

    struct ChannelClaim {
        ChannelConfig config;
        uint128 maxClaimableAmount;
        bytes signature;
        uint128 totalClaimed;
        bytes32 newAttributionRoot;
    }

    struct Credit {
        address receiver;
        address token;
        uint128 amount;
    }

    function settleBatch(
        ChannelClaim[] claims,
        Credit[] credits,
        bytes proof
    );
}

#[derive(Parser, Debug)]
#[command(author, version, about)]
struct Args {
    /// Path to a JSON file containing a [`ProveInput`].
    #[arg(long)]
    input: PathBuf,

    /// Execute the program without proving (prints cycles and commitment).
    #[arg(long)]
    execute: bool,

    /// Generate a Groth16 proof suitable for the onchain SP1 verifier.
    #[arg(long)]
    groth16: bool,

    /// Optional path to write the proof artifact JSON.
    #[arg(long)]
    output: Option<PathBuf>,
}

/// On-disk input: circuit witness plus the `settleBatch` claim rows (voucher sigs / configs).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProveInput {
    #[serde(flatten)]
    witness: BatchWitness,
    /// Channel configs + voucher signatures for calldata encoding. Must align with `witness.channels`.
    claims: Vec<ClaimInput>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClaimInput {
    config: ChannelConfigInput,
    #[serde(with = "u128_string")]
    max_claimable_amount: u128,
    /// Hex-encoded payer voucher signature.
    #[serde(with = "x402_attribution_core::bytes_hex")]
    signature: Vec<u8>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChannelConfigInput {
    payer: Address,
    payer_authorizer: Address,
    receiver: Address,
    receiver_authorizer: Address,
    token: Address,
    withdraw_delay: u64,
    salt: B256,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProofOutput {
    vkey: String,
    batch_commitment: String,
    public_values: String,
    proof: String,
    settle_batch_calldata: String,
}

fn main() {
    sp1_sdk::utils::setup_logger();
    dotenv::dotenv().ok();

    let args = Args::parse();
    if args.execute == args.groth16 {
        eprintln!("Error: specify exactly one of --execute or --groth16");
        std::process::exit(1);
    }

    let raw = std::fs::read_to_string(&args.input).expect("read input");
    let input: ProveInput = serde_json::from_str(&raw).expect("parse input JSON");

    let expected = verify_batch(&input.witness).expect("witness failed host verify_batch");
    println!("batchCommitment: {expected}");

    let mut stdin = SP1Stdin::new();
    stdin.write(&input.witness);

    let client = ProverClient::from_env();

    if args.execute {
        let (output, report) = client.execute(ELF, stdin).run().expect("execute");
        let committed = B256::from_slice(output.as_slice());
        assert_eq!(committed, expected, "guest commitment != host verify_batch");
        println!("Program executed successfully.");
        println!("Number of cycles: {}", report.total_instruction_count());
        return;
    }

    let pk = client.setup(ELF).expect("setup");
    let proof = client
        .prove(&pk, stdin)
        .groth16()
        .run()
        .expect("groth16 prove");

    client
        .verify(&proof, pk.verifying_key(), None)
        .expect("verify");

    let public_values = proof.public_values.as_slice();
    let committed = B256::from_slice(public_values);
    assert_eq!(committed, expected);

    let settle_calldata = encode_settle_batch(&input, proof.bytes());

    let out = ProofOutput {
        vkey: pk.verifying_key().bytes32().to_string(),
        batch_commitment: format!("0x{}", hex::encode(expected.as_slice())),
        public_values: format!("0x{}", hex::encode(public_values)),
        proof: format!("0x{}", hex::encode(proof.bytes())),
        settle_batch_calldata: format!("0x{}", hex::encode(&settle_calldata)),
    };

    let json = serde_json::to_string_pretty(&out).unwrap();
    if let Some(path) = args.output {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).ok();
        }
        std::fs::write(&path, &json).expect("write output");
        println!("Wrote {}", path.display());
    } else {
        println!("{json}");
    }
}

fn encode_settle_batch(input: &ProveInput, proof: Vec<u8>) -> Vec<u8> {
    assert_eq!(
        input.claims.len(),
        input.witness.channels.len(),
        "claims/channels length mismatch"
    );

    let mut claims = Vec::with_capacity(input.claims.len());
    for (claim_in, ch) in input.claims.iter().zip(input.witness.channels.iter()) {
        let pairs: Vec<AttributionPair> = ch
            .new_pairs
            .iter()
            .map(|p| AttributionPair {
                pay_to: p.pay_to,
                cumulative: p.cumulative,
            })
            .collect();
        let new_root = attribution_root(&pairs);

        claims.push(ChannelClaim {
            config: ChannelConfig {
                payer: claim_in.config.payer,
                payerAuthorizer: claim_in.config.payer_authorizer,
                receiver: claim_in.config.receiver,
                receiverAuthorizer: claim_in.config.receiver_authorizer,
                token: claim_in.config.token,
                withdrawDelay: U40::from(claim_in.config.withdraw_delay),
                salt: claim_in.config.salt,
            },
            maxClaimableAmount: claim_in.max_claimable_amount,
            signature: claim_in.signature.clone().into(),
            totalClaimed: ch.total_claimed,
            newAttributionRoot: new_root,
        });
    }

    let credits: Vec<Credit> = input
        .witness
        .credits
        .iter()
        .map(|c| Credit {
            receiver: c.receiver,
            token: c.token,
            amount: c.amount,
        })
        .collect();

    settleBatchCall {
        claims,
        credits,
        proof: proof.into(),
    }
    .abi_encode()
}

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

