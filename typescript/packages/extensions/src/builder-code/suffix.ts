const ERC_8021_MARKER = "80218021802180218021802180218021";
const SCHEMA_ID = "00";

/**
 * Encodes an ERC-8021 calldata suffix from an array of builder codes.
 *
 * Format: [codes_ascii] + [codes_length: 1 byte] + [schema_id: 1 byte] + [8021_marker: 14 bytes]
 *
 * @param codes - Array of builder codes to encode into the suffix
 * @returns Hex string (0x-prefixed) of the encoded suffix
 */
export function encodeErc8021Suffix(codes: string[]): `0x${string}` {
  const joined = codes.join(",");
  const asciiHex = Buffer.from(joined, "ascii").toString("hex");
  const lengthByte = joined.length.toString(16).padStart(2, "0");
  return `0x${asciiHex}${lengthByte}${SCHEMA_ID}${ERC_8021_MARKER}`;
}
