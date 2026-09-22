const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export function graphemes(text: string): Intl.Segments {
  return graphemeSegmenter.segment(text);
}
