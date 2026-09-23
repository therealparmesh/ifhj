const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export function graphemes(text: string): Intl.Segments {
  return graphemeSegmenter.segment(text);
}

/** Keep arbitrary text on one safe terminal line. */
export function normalizeText(text: string): string {
  return Array.from(text, (char) => {
    const code = char.codePointAt(0) ?? 0;
    return code < 32 || code === 127 ? " " : char;
  })
    .join("")
    .replace(/\s+/g, " ")
    .trim();
}
