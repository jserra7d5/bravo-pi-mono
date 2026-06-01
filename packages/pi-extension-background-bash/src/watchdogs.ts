export function looksLikeInteractivePrompt(text: string): boolean {
  return /(password|passphrase|\bOTP\b|confirmation|are you sure|\[y\/n\]|\(yes\/no\))/i.test(text);
}
