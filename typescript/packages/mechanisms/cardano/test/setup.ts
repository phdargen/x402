import { MASUMI_DEFAULT_DEPLOYMENT, masumiEscrowScriptHash } from "../src/exact/masumi/blueprint";

// Pay the UPLC parameterization cost once per worker before any test file runs,
// so CI does not hit testTimeout while deriving the canonical escrow address.
masumiEscrowScriptHash(MASUMI_DEFAULT_DEPLOYMENT);
