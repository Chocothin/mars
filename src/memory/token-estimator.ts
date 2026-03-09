/**
 * Estimate token count: ~4 chars/token for prose, ~3.5 for code-heavy content.
 * Intentionally approximate — exact counts aren't needed for memory management.
 */
export function estimateTokens(text: string): number {
  if (text.length === 0) return 0;

  const codeIndicators = /[{}();=><\[\]]/g;
  const matches = text.match(codeIndicators);
  const codeRatio = matches ? matches.length / text.length : 0;
  const charsPerToken = codeRatio > 0.05 ? 3.5 : 4.0;

  return Math.ceil(text.length / charsPerToken);
}

/** SHA-256 checksum via Bun's built-in CryptoHasher for fast change detection. */
export function calculateChecksum(content: string): string {
  const hasher = new Bun.CryptoHasher('sha256');
  hasher.update(content);
  return hasher.digest('hex');
}
