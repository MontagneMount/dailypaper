// Generate the narration with Edge TTS and work out when each subtitle line is spoken.
//
// Each sentence is synthesised separately and trimmed of the silence Edge TTS adds around it,
// so we control every pause ourselves and know exactly when the voice starts and stops.
// Inside a sentence, time is shared between subtitle lines by how long each line takes to say
// (see timing.js; word-level alignment is T12).

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import msedgeTts from "msedge-tts";
import { runFfmpeg } from "./ffmpeg.js";
import { groupIntoSentences, toSpeech, spreadLines } from "./timing.js";

const { MsEdgeTTS, OUTPUT_FORMAT } = msedgeTts;

// Chosen by the user on 2026-10-06 (T17). The male voice is zh-CN-YunxiNeural.
export const DEFAULT_VOICE = "zh-CN-XiaoxiaoNeural";

const SAMPLE_RATE = 24000;
const BYTES_PER_SAMPLE = 2; // 16-bit mono PCM

// Pauses, in seconds.
const PAGE_LEAD_SECONDS = 0.3; // before the first sentence of a page (no subtitle yet)
const SENTENCE_GAP_SECONDS = 0.35; // between two sentences
const PAGE_TAIL_SECONDS = 0.6; // after the last sentence of a page
const EXTRA_HOLD_SECONDS = { big_metric: 1.0, comparison: 1.0 }; // pages full of numbers stay a bit longer
const END_HOLD_SECONDS = 1.5; // extra pause at the very end; the video also fades out there

// Edge TTS pads every clip with ~0.2 s of silence before and ~0.7 s after the voice.
const TRIM_SILENCE = [
  "silenceremove=start_periods=1:start_threshold=-50dB:start_silence=0.03",
  "areverse",
  "silenceremove=start_periods=1:start_threshold=-50dB:start_silence=0.05",
  "areverse",
].join(",");
// Change this whenever the audio processing changes, so cached clips are rebuilt.
const AUDIO_PROCESSING_VERSION = "trim1";

/**
 * Pages come back in the same order as the slides.
 * Each sentence keeps its subtitle lines and the text actually spoken (after pronunciation
 * replacement); the same timeline is saved to output/narration.json for checking and alignment.
 *
 * @returns {Promise<{ audioFile: string, duration: number,
 *   pages: Array<{ number: number, start: number, end: number,
 *                  lines: Array<{ text: string, display: string, start: number, end: number }>,
 *                  sentences: Array<{ lines: string[], speech: string, start: number, duration: number }> }> }>}
 */
export async function createNarration(slides, { voice, rate, pronunciations, workDir }) {
  const audioDir = path.join(workDir, "audio");
  fs.mkdirSync(audioDir, { recursive: true });

  const synthesizer = new Synthesizer(voice, rate, audioDir);
  const pcmParts = [];
  const pages = [];
  let cursor = 0; // seconds since the start of the video

  const addSilence = (seconds) => {
    pcmParts.push(silence(seconds));
    cursor += seconds;
  };

  try {
    for (const [slideIndex, slide] of slides.entries()) {
      const page = { number: slide.number, start: cursor, end: 0, lines: [], sentences: [] };
      addSilence(PAGE_LEAD_SECONDS);

      const sentences = groupIntoSentences(slide.narration);
      for (const [index, lines] of sentences.entries()) {
        if (index > 0) addSilence(SENTENCE_GAP_SECONDS);
        const { speech, spoken } = toSpeech(lines, pronunciations);
        const pcm = await synthesizer.toPcm(speech);
        const duration = pcm.length / (SAMPLE_RATE * BYTES_PER_SAMPLE);
        page.lines.push(...spreadLines(lines, spoken, cursor, duration));
        page.sentences.push({ lines, speech, start: cursor, duration });
        pcmParts.push(pcm);
        cursor += duration;
      }

      const isLastPage = slideIndex === slides.length - 1;
      addSilence(PAGE_TAIL_SECONDS + (EXTRA_HOLD_SECONDS[slide.layout] ?? 0) + (isLastPage ? END_HOLD_SECONDS : 0));
      page.end = cursor;
      pages.push(page);
      console.log(`  第 ${slide.number} 页配音完成（${(page.end - page.start).toFixed(1)} 秒）`);
    }
  } finally {
    synthesizer.close();
  }

  const audioFile = path.join(workDir, "narration.wav");
  writeWav(audioFile, Buffer.concat(pcmParts));
  const timelineFile = path.join(workDir, "narration.json");
  fs.writeFileSync(timelineFile, JSON.stringify({ voice, rate, duration: cursor, pages }, null, 2));
  return { audioFile, duration: cursor, pages };
}

class Synthesizer {
  constructor(voice, rate, audioDir) {
    this.voice = voice;
    this.rate = rate;
    this.audioDir = audioDir;
    this.tts = null;
  }

  /** Returns trimmed PCM for the text. Clips are cached, so re-rendering skips unchanged sentences. */
  async toPcm(text) {
    const key = crypto.createHash("sha1").update(`${this.voice}|${this.rate}|${text}`).digest("hex").slice(0, 16);
    const mp3File = path.join(this.audioDir, `${key}.mp3`);
    const wavFile = path.join(this.audioDir, `${key}-${AUDIO_PROCESSING_VERSION}.wav`);
    if (!fs.existsSync(mp3File)) {
      await this.synthesizeWithRetry(text, mp3File);
    }
    if (!fs.existsSync(wavFile)) {
      await runFfmpeg(["-y", "-i", mp3File, "-af", TRIM_SILENCE, "-ar", String(SAMPLE_RATE), "-ac", "1", "-c:a", "pcm_s16le", wavFile]);
    }
    return readWavPcm(wavFile);
  }

  async synthesizeWithRetry(text, file, attempts = 3) {
    for (let attempt = 1; ; attempt++) {
      try {
        if (!this.tts) {
          this.tts = new MsEdgeTTS();
          await this.tts.setMetadata(this.voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
        }
        await this.synthesize(text, file);
        return;
      } catch (error) {
        this.close();
        fs.rmSync(file, { force: true }); // never keep a half-written clip in the cache
        if (attempt >= attempts) {
          throw new Error(`配音失败（已试 ${attempts} 次）：${error.message}\n  句子：${text}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
      }
    }
  }

  synthesize(text, file) {
    const { audioStream } = this.tts.toStream(escapeXml(text), { rate: this.rate });
    return new Promise((resolve, reject) => {
      const output = fs.createWriteStream(file);
      audioStream.on("error", reject);
      output.on("error", reject);
      output.on("finish", resolve);
      audioStream.pipe(output);
    });
  }

  close() {
    this.tts?.close();
    this.tts = null;
  }
}

function escapeXml(text) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function silence(seconds) {
  return Buffer.alloc(Math.round(seconds * SAMPLE_RATE) * BYTES_PER_SAMPLE);
}

/** Return the PCM samples of a WAV file (skips the header chunks). */
function readWavPcm(file) {
  const buffer = fs.readFileSync(file);
  let offset = 12; // after "RIFF" + size + "WAVE"
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString("ascii", offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    if (id === "data") return buffer.subarray(offset + 8, Math.min(offset + 8 + size, buffer.length));
    offset += 8 + size + (size % 2);
  }
  throw new Error(`读不到音频数据：${file}`);
}

function writeWav(file, pcm) {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16); // fmt chunk size
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(SAMPLE_RATE * BYTES_PER_SAMPLE, 28); // byte rate
  header.writeUInt16LE(BYTES_PER_SAMPLE, 32); // block align
  header.writeUInt16LE(16, 34); // bits per sample
  header.write("data", 36, "ascii");
  header.writeUInt32LE(pcm.length, 40);
  fs.writeFileSync(file, Buffer.concat([header, pcm]));
}
