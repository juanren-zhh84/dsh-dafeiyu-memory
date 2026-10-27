/** Adjacent Han pairs preserve useful Chinese terms without a segmenter dependency. */
export function tokenize(text) {
  const normalized = text.normalize('NFKC').toLowerCase().trim().replace(/\s+/gu, ' ');
  const tokens = [];
  for (const match of normalized.matchAll(/\p{Script=Han}+|[a-z0-9]+/gu)) {
    const word = match[0];
    if (/^\p{Script=Han}/u.test(word)) {
      const chars = [...word];
      if (chars.length === 1) tokens.push(word);
      else for (let i = 0; i < chars.length - 1; i++) tokens.push(chars[i] + chars[i + 1]);
    } else tokens.push(word);
  }
  return tokens;
}
