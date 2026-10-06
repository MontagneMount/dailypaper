// Turn narration lines into speech text and subtitle timing.
// No file or network access here, so everything is easy to test.

import { applyPronunciations } from "./pronunciation.js";

const SENTENCE_END = /[。！？!?…][”’」』）)]*$/;
const MAX_SENTENCE_CHARS = 120;

/** Group subtitle lines into sentences; a sentence ends with 。！？ etc. */
export function groupIntoSentences(lines) {
  const sentences = [];
  let current = [];
  for (const line of lines) {
    current.push(line);
    if (SENTENCE_END.test(line) || joinLines(current).length > MAX_SENTENCE_CHARS) {
      sentences.push(current);
      current = [];
    }
  }
  if (current.length > 0) sentences.push(current);
  return sentences;
}

/** Join lines without spaces (Chinese), but keep a space between two English words. */
export function joinLines(lines) {
  return lines.reduce((text, line) => {
    const needsSpace = /[A-Za-z0-9]$/.test(text) && /^[A-Za-z0-9]/.test(line);
    return text + (needsSpace ? " " : "") + line;
  }, "");
}

/**
 * What a sentence sounds like: each line with its pronunciation replacements applied.
 * `spoken` keeps one entry per subtitle line, so timing can follow the real speech.
 */
export function toSpeech(lines, pronunciations) {
  const spoken = lines.map((line) => applyPronunciations(line, pronunciations));
  return { speech: joinLines(spoken), spoken };
}

/** Rough speaking time of a text, counted in Chinese characters. */
export function spokenWeight(text) {
  let weight = 0;
  for (const char of text) {
    if (/\p{Script=Han}/u.test(char)) weight += 1;
    else if (/[A-Za-z]/.test(char)) weight += 0.35; // English is read by syllable, not by letter
    else if (/\d/.test(char)) weight += 0.8;
    else if (/[，。！？、；：,.!?;:…]/.test(char)) weight += 0.4; // a short pause
  }
  return Math.max(weight, 0.5);
}

/** Share a sentence's duration between its lines, by how long each line takes to say. */
export function spreadLines(lines, spoken, start, duration) {
  const weights = spoken.map(spokenWeight);
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  let time = start;
  return lines.map((text, index) => {
    const lineDuration = duration * (weights[index] / total);
    const entry = { text, display: subtitleText(text), start: time, end: time + lineDuration };
    time += lineDuration;
    return entry;
  });
}

/** On screen, subtitles drop a trailing comma, full stop or colon; ！ and ？ stay. */
export function subtitleText(line) {
  return line.replace(/[，。、；：,.;:]+$/u, "");
}
