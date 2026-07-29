use alloy_primitives::{keccak256, Address, B256};
use k256::ecdsa::{RecoveryId, Signature, SigningKey, VerifyingKey};
use k256::elliptic_curve::scalar::IsHigh;

/// secp256k1n ÷ 2 — OpenZeppelin / EIP-2 upper bound for `s` (inclusive).
pub const SECP256K1_HALF_ORDER: [u8; 32] = [
    0x7f, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
    0x5d, 0x57, 0x6e, 0x73, 0x57, 0xa4, 0x50, 0x1d, 0xdf, 0xe9, 0x2f, 0x46, 0x68, 0x1b, 0x20, 0xa0,
];

/// Recover the Ethereum address that produced a 65-byte `(r ‖ s ‖ v)` signature over `digest`.
///
/// Enforces low-s to match OpenZeppelin `ECDSA.recoverCalldata`. Accepts `v ∈ {0,1,27,28}`.
pub fn recover_signer(digest: B256, signature: &[u8]) -> Result<Address, &'static str> {
    if signature.len() != 65 {
        return Err("signature must be 65 bytes");
    }
    let sig = Signature::from_slice(&signature[..64]).map_err(|_| "invalid signature r||s")?;
    if bool::from(sig.s().is_high()) {
        return Err("high-s signature rejected");
    }
    let v = signature[64];
    let recid_byte = match v {
        0 | 1 => v,
        27 | 28 => v - 27,
        _ => return Err("invalid signature v"),
    };
    let recid = RecoveryId::from_byte(recid_byte).ok_or("invalid recovery id")?;
    let vk = VerifyingKey::recover_from_prehash(digest.as_slice(), &sig, recid)
        .map_err(|_| "ecdsa recovery failed")?;
    Ok(verifying_key_address(&vk))
}

/// Sign an EIP-712 (or other) 32-byte digest with a secp256k1 key; returns `(r ‖ s ‖ v)` with
/// `v ∈ {27, 28}` and low-s.
pub fn sign_digest(signing_key: &SigningKey, digest: B256) -> Result<[u8; 65], &'static str> {
    let (sig, recid) = signing_key
        .sign_prehash_recoverable(digest.as_slice())
        .map_err(|_| "signing failed")?;
    // sign_prehash_recoverable already normalizes to low-s in k256 0.13.
    if bool::from(sig.s().is_high()) {
        return Err("signer produced high-s");
    }
    let mut out = [0u8; 65];
    out[..64].copy_from_slice(&sig.to_bytes());
    out[64] = recid.to_byte() + 27;
    Ok(out)
}

fn verifying_key_address(vk: &VerifyingKey) -> Address {
    let encoded = vk.to_encoded_point(false);
    let hash = keccak256(&encoded.as_bytes()[1..]);
    Address::from_slice(&hash[12..])
}

/// Derive the Ethereum address for a signing key (host-side helper).
pub fn signing_key_address(signing_key: &SigningKey) -> Address {
    verifying_key_address(signing_key.verifying_key())
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloy_primitives::b256;

    #[test]
    fn sign_and_recover_roundtrip() {
        let sk = SigningKey::from_slice(&[7u8; 32]).unwrap();
        let digest = b256!("0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef");
        let sig = sign_digest(&sk, digest).unwrap();
        let recovered = recover_signer(digest, &sig).unwrap();
        assert_eq!(recovered, signing_key_address(&sk));
    }

    #[test]
    fn rejects_high_s() {
        let sk = SigningKey::from_slice(&[7u8; 32]).unwrap();
        let digest = b256!("0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef");
        let mut sig = sign_digest(&sk, digest).unwrap();
        // Force a high-s by replacing s with n - s (and flip v). Roughly: set s = HALF+1.
        sig[32..64].copy_from_slice(&{
            let mut s = SECP256K1_HALF_ORDER;
            s[31] = s[31].wrapping_add(1);
            s
        });
        assert!(recover_signer(digest, &sig).is_err());
    }
}
