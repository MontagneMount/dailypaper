// Replace hard-to-read terms with their readings before the text goes to TTS.
// Subtitles keep the original text; only the speech uses the readings.

/**
 * Replace every term in one pass, longest term first. A reading that was just inserted
 * is never matched again, so "GPT-4 → GPT four" is not turned into "G P T four" by "GPT → G P T".
 */
export function applyPronunciations(text, table) {
  if (table.length === 0) return text;
  const readings = new Map(table.map(({ original, reading }) => [original, reading]));
  const terms = [...readings.keys()].sort((a, b) => b.length - a.length).map(escapeRegExp);
  const pattern = new RegExp(terms.join("|"), "g");
  return text.replace(pattern, (term) => readings.get(term));
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
