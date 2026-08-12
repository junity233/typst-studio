/** 12-hex-char SHA-1 of a string, via SubtleCrypto. */
export async function sha1Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  return sha1HexBytes(data);
}

/**
 * 12-hex-char SHA-1 of raw bytes, via SubtleCrypto. Hashes the actual bytes
 * directly (no UTF-8 re-encode), so it's the right primitive for binary content
 * like a pasted image's pixels — used by the raw-image paste flow to name/dedup
 * files by their true contents. Truncated to 12 hex chars to match {@link
 * sha1Hex}'s naming namespace (collision-resistant enough for a filename).
 */
export async function sha1HexBytes(data: Uint8Array): Promise<string> {
  // SubtleCrypto.digest accepts BufferSource; copy into a fresh ArrayBuffer view
  // so a Node Buffer (whose .buffer may span a larger pool) digests exactly the
  // intended bytes.
  const copy = new Uint8Array(data.byteLength);
  copy.set(data);
  const buf = await crypto.subtle.digest("SHA-1", copy);
  const hex = Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return hex.slice(0, 12);
}
