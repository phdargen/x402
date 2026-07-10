---
"@x402/evm": patch
---

Fix an unauthenticated path-traversal and pre-verification channel-mutation issue in the batch-settlement server scheme. The untrusted `channelId` from an incoming payload previously reached the file-storage path builder (only lowercased) and reserved/wrote channel state before the voucher signature was verified, so a crafted `channelId` could escape `{root}/server/` and mutate or create arbitrary channel files.

Channel ids are now validated to canonical `bytes32` form and the resolved file path is asserted to stay within the storage root before any read, lock, write, or delete (server and client file storage). Verification is now two-phase: `handleBeforeVerify` is read-only and binds the claimed `channelId` to its `channelConfig` and network before touching storage, while the reservation, cumulative re-check, and persist happen in a single atomic `updateChannel` in `handleAfterVerify`. Invalid signatures, failed facilitator results, malformed ids, and transport errors now perform zero storage mutation. Valid channel ids round-trip unchanged, so on-disk filenames and record bytes are identical; in-memory and Redis key behavior is unchanged.
