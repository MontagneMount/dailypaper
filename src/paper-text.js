// Give both CLIs a paginated text reference and literal PDF page images, using the same pdf.js
// runtime as crop-figure.js. No Python or terminal PDF-reader installation is required.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { pathToFileURL } from "node:url";
import { launchBrowser } from "./frames.js";
import { safePath } from "./production-gates.js";

const PDFJS = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174";

export async function preparePaper(folder, versionedId) {
  if (!/^\d{4}\.\d{4,5}v[1-9]\d*$/.test(versionedId)) throw new Error("必须指定论文版本");
  const pdf = safePath(folder, `${versionedId}.pdf`);
  const bytes = fs.readFileSync(pdf);
  if (bytes.subarray(0, 5).toString() !== "%PDF-") throw new Error("不是 PDF 文件");
  const out = safePath(folder, "output/paper");
  fs.mkdirSync(out, { recursive: true });
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    await page.setContent("<!doctype html><html><body></body></html>");
    await page.addScriptTag({ url: `${PDFJS}/pdf.min.js` });
    const count = await page.evaluate(async ({ data, worker }) => {
      pdfjsLib.GlobalWorkerOptions.workerSrc = worker;
      window.paper = await pdfjsLib.getDocument({ data: Uint8Array.from(atob(data), (c) => c.charCodeAt(0)) }).promise;
      return window.paper.numPages;
    }, { data: bytes.toString("base64"), worker: `${PDFJS}/pdf.worker.min.js` });
    if (!Number.isInteger(count) || count < 1 || count > 1000) throw new Error("论文页数异常");
    const manifest = { versionedId, pdfSha256: crypto.createHash("sha256").update(bytes).digest("hex"), pages: [] };
    const text = [`# ${versionedId} 原文阅读材料`, "", "> 从本地PDF自动提取，多栏文字、表格、公式可能错序或缺失。关键结论仍回原页图片/PDF核对；页码按本地PDF从1开始。", ""];
    for (let number = 1; number <= count; number++) {
      const result = await page.evaluate(async (number) => {
        const pdfPage = await window.paper.getPage(number);
        const content = await pdfPage.getTextContent();
        const viewport = pdfPage.getViewport({ scale: 1.5 });
        const canvas = document.createElement("canvas");
        canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height);
        await pdfPage.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
        const chunks = content.items.map((item) => (item.str ?? "") + (item.hasEOL ? "\n" : " "));
        const png = canvas.toDataURL("image/png").split(",")[1];
        canvas.remove(); pdfPage.cleanup();
        return { text: chunks.join(""), png };
      }, number);
      const file = `page${String(number).padStart(3, "0")}.png`;
      fs.writeFileSync(safePath(out, file), Buffer.from(result.png, "base64"));
      manifest.pages.push({ number, file, textCharacters: result.text.length });
      text.push(`## PDF 第 ${number} 页`, "", result.text, "");
    }
    fs.writeFileSync(safePath(out, "text.md"), text.join("\n"));
    fs.writeFileSync(safePath(out, "manifest.json"), JSON.stringify(manifest, null, 2));
    return { pages: count, folder: out };
  } finally { await browser.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [folder, id] = process.argv.slice(2);
  preparePaper(path.resolve(folder ?? ""), id)
    .then((result) => console.log(`论文阅读材料：${result.pages} 页；文本与原页图片在 ${result.folder}`))
    .catch((error) => { console.error(error.message); process.exitCode = 1; });
}
