//! Print the SP1 program verification key as a `bytes32` hex string.
//!
//! ```shell
//! cargo run --release --bin vkey
//! ```

use sp1_sdk::{blocking::MockProver, blocking::Prover, include_elf, Elf, HashableKey, ProvingKey};

const ELF: Elf = include_elf!("x402-attribution-program");

fn main() {
    let prover = MockProver::new();
    let pk = prover.setup(ELF).expect("failed to setup elf");
    println!("{}", pk.verifying_key().bytes32());
}
