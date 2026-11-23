// Unquoted characters exclude '<' so a malformed tag stops at the next '<' instead of rescanning to the end (linear time).
const ATTRS = `(?:"[^"]*"|'[^']*'|[^>"'<])*`;
const DANGEROUS = 'script|style|iframe|object|embed';

// <script ...>...</script>, attributes may hold '>' inside quotes.
const DANGEROUS_PAIRED = new RegExp(
  `<(${DANGEROUS})\\b${ATTRS}>[\\s\\S]*?<\\/\\1\\s*>`,
  'gi',
);
// Opening tag with no closing tag: drop everything to the end.
const DANGEROUS_UNCLOSED = new RegExp(
  `<(?:${DANGEROUS})\\b${ATTRS}(?:>[\\s\\S]*)?$`,
  'gi',
);
const ANY_TAG = new RegExp(`<\\/?[a-zA-Z!?]${ATTRS}>`, 'g');
// A tag that never closes, e.g. a trailing "<scr": cut from the first tag start after the last '>'.
const TAG_START = /<\/?[a-zA-Z!?]/;
const dropDanglingTag = (text: string): string => {
  const tailStart = text.lastIndexOf('>') + 1;
  const found = TAG_START.exec(text.slice(tailStart));
  return found ? text.slice(0, tailStart + found.index) : text;
};

const stripMarkup = (text: string): string =>
  dropDanglingTag(
    text
      .replace(DANGEROUS_PAIRED, '')
      .replace(DANGEROUS_UNCLOSED, '')
      .replace(ANY_TAG, ''),
  );

const collapseWhitespace = (text: string): string =>
  text
    .replace(/\r\n?/g, '\n')
    .replace(/[^\S\n]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

/**
 * Reduces user input to plain text: dangerous elements are removed with their
 * content, remaining tags are removed but their text kept. Entities are not decoded.
 */
export const sanitizeText = (input: string): string => {
  let current = input;
  // Removing a tag can splice its neighbours into a new one ("<<b>script>"), so repeat.
  for (let pass = 0; pass < 10; pass += 1) {
    const next = stripMarkup(current);
    if (next === current) break;
    current = next;
  }
  return collapseWhitespace(current);
};
