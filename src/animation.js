// The screenshot plan for one page of the video (visual v2, T63): which video frames get a
// screenshot of their own, and for how many frames each screenshot stays on screen.
// The picture only changes while something moves (the page turn, later the cue table's actions)
// or when the subtitle changes; in between, one screenshot is held, as in the static video.

export const FPS = 30;

// Page turn: every page fades in from the plain background and out again (subtitles do not fade).
export const PAGE_FADE_IN = 0.6;
export const PAGE_FADE_OUT = 0.35;

/**
 * The page turn of a page that lasts `duration` seconds; the fades get shorter on a very short page.
 * @returns {{ fadeIn: number, fadeOut: number, moves: Array<[number, number]> }} seconds from the page start
 */
export function pageTurn(duration) {
  const fadeIn = Math.min(PAGE_FADE_IN, duration / 3);
  const fadeOut = Math.min(PAGE_FADE_OUT, duration / 3);
  return { fadeIn, fadeOut, moves: [[0, fadeIn], [duration - fadeOut, duration]] };
}

/**
 * @param {{ start: number, end: number, lines: Array<{ start: number }> }} timing
 *   one page of output/narration.json, in seconds from the start of the video
 * @param {Array<[number, number]>} moves  when something moves, in seconds from the page start;
 *   every frame inside a move gets its own screenshot
 * @returns {Array<{ frame: number, time: number, line: number, moving: boolean, count: number }>}
 *   one entry per screenshot: the video frame it is taken for, that frame's time from the page start,
 *   the subtitle line shown (-1 before the first one is spoken), whether it is taken during a move,
 *   and for how many video frames it stays on screen
 */
export function planPageFrames(timing, moves) {
  const firstFrame = Math.round(timing.start * FPS);
  const endFrame = Math.round(timing.end * FPS);
  const shots = [];
  let previousKey = null;

  for (let frame = firstFrame; frame < endFrame; frame++) {
    const videoTime = frame / FPS;
    const time = videoTime - timing.start;
    // A subtitle line shows from the first frame at or after the moment its voice starts.
    const line = timing.lines.findLastIndex((entry) => entry.start <= videoTime + 1e-9);
    const moving = moves.some(([from, to]) => time >= from && time < to);
    // Between moves, the picture depends only on the subtitle and on which moves have finished.
    const key = moving ? null : `${line}|${moves.filter(([, to]) => to <= time).length}`;

    if (key !== null && key === previousKey) shots.at(-1).count += 1;
    else shots.push({ frame, time, line, moving, count: 1 });
    previousKey = key;
  }
  return shots;
}
