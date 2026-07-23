// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title CompressedSparseMerkleProof
/// @notice Verifies compressed proofs for a 160-level sparse Merkle tree keyed by address.
/// @dev Address bits are consumed least-significant first. A set bitmap bit supplies a non-empty sibling for that
///      level; an unset bit substitutes the canonical level-specific empty hash.
library CompressedSparseMerkleProof {
    uint256 internal constant TREE_DEPTH = 160;

    /// @notice Returns the root of a tree whose leaves all contain zero.
    function emptyRoot() internal pure returns (bytes32 root) {
        root = hashLeaf(0);
        for (uint256 level = 0; level < TREE_DEPTH; ++level) {
            root = hashNode(root, root);
        }
    }

    /// @notice Verifies that `value` is committed at `key` in `root`.
    function verify(
        bytes32 root,
        address key,
        uint128 value,
        uint256 nonzeroSiblingBitmap,
        bytes32[] calldata nonzeroSiblings
    ) internal pure returns (bool) {
        (bool valid,) = verifyAndUpdate(root, key, value, value, nonzeroSiblingBitmap, nonzeroSiblings);
        return valid;
    }

    /// @notice Verifies `previousValue` at `key` and computes the root after replacing it with `newValue`.
    /// @dev Returns false for a root mismatch or a non-canonical encoding: high bitmap bits, missing or extra
    ///      siblings, or an explicitly supplied canonical empty sibling.
    function verifyAndUpdate(
        bytes32 root,
        address key,
        uint128 previousValue,
        uint128 newValue,
        uint256 nonzeroSiblingBitmap,
        bytes32[] calldata nonzeroSiblings
    ) internal pure returns (bool valid, bytes32 newRoot) {
        if (nonzeroSiblingBitmap >> TREE_DEPTH != 0) return (false, bytes32(0));

        bytes32 previousHash = hashLeaf(previousValue);
        bool changesValue = previousValue != newValue;
        bytes32 newHash = changesValue ? hashLeaf(newValue) : previousHash;
        bytes32 emptyHash = hashLeaf(0);
        uint256 siblingIndex;
        uint256 path = uint256(uint160(key));

        for (uint256 level = 0; level < TREE_DEPTH; ++level) {
            bytes32 sibling;
            if (nonzeroSiblingBitmap & (uint256(1) << level) != 0) {
                if (siblingIndex == nonzeroSiblings.length) return (false, bytes32(0));
                sibling = nonzeroSiblings[siblingIndex++];
                if (sibling == emptyHash) return (false, bytes32(0));
            } else {
                sibling = emptyHash;
            }

            if (path & 1 == 0) {
                previousHash = hashNode(previousHash, sibling);
                if (changesValue) newHash = hashNode(newHash, sibling);
            } else {
                previousHash = hashNode(sibling, previousHash);
                if (changesValue) newHash = hashNode(sibling, newHash);
            }
            if (!changesValue) newHash = previousHash;

            path >>= 1;
            emptyHash = hashNode(emptyHash, emptyHash);
        }

        if (siblingIndex != nonzeroSiblings.length || previousHash != root) {
            return (false, bytes32(0));
        }
        return (true, newHash);
    }

    /// @dev Domain-separated leaf hash. A zero cumulative is the canonical empty leaf.
    function hashLeaf(
        uint128 value
    ) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(hex"00", value));
    }

    /// @dev Domain-separated ordered internal-node hash.
    function hashNode(
        bytes32 left,
        bytes32 right
    ) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(hex"01", left, right));
    }
}
