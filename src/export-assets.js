// Export the channel assets (avatar and space banner) to PNG for uploading to Bilibili.
//   npm run assets

import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { launchBrowser } from "./frames.js";

const ASSETS_DIR = fileURLToPath(new URL("../assets/", import.meta.url));

const EXPORTS = [
  // Bilibili shows avatars as a circle, so the corners stay transparent.
  { source: "avatar.svg", output: "avatar.png", width: 800, height: 800, scale: 1, transparent: true },
  // Designed at 1280×200; exported at 2× (2560×400) so it stays sharp.
  { source: "channel-banner.html", output: "channel-banner.png", width: 1280, height: 200, scale: 2, transparent: false },
];

const browser = await launchBrowser();
try {
  for (const item of EXPORTS) {
    const page = await browser.newPage({
      viewport: { width: item.width, height: item.height },
      deviceScaleFactor: item.scale,
    });
    await page.goto(pathToFileURL(path.join(ASSETS_DIR, item.source)).href);
    await page.evaluate(() => document.fonts?.ready);
    await page.screenshot({ path: path.join(ASSETS_DIR, item.output), omitBackground: item.transparent });
    await page.close();
    console.log(`assets/${item.output}（${item.width * item.scale}×${item.height * item.scale}）`);
  }
} finally {
  await browser.close();
}
