// Checks for the themes (templates/themes/*.css) and the templates that use them (visual v2, T63).
// Run with: npm test

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DEFAULT_THEME, fillTemplate, listThemes } from "../src/frames.js";

const TEMPLATES_DIR = fileURLToPath(new URL("../templates/", import.meta.url));
const THEMES_DIR = path.join(TEMPLATES_DIR, "themes");
const TEMPLATES = fs.readdirSync(TEMPLATES_DIR).filter((file) => file.endsWith(".html"));

const read = (file) => fs.readFileSync(file, "utf8");
/** The variables a stylesheet or template sets, e.g. "--accent". */
const defined = (text) => new Set([...text.matchAll(/(--[\w-]+)\s*:/g)].map((match) => match[1]));
/** The variables it reads with var(). */
const used = (text) => new Set([...text.matchAll(/var\(\s*(--[\w-]+)/g)].map((match) => match[1]));

test("有浅色学术和深色两套风格，默认浅色学术", () => {
  assert.deepEqual(listThemes(), ["academic", "dark"]);
  assert.equal(DEFAULT_THEME, "academic");
});

test("两套风格定义的变量完全一样", () => {
  const [academic, dark] = ["academic", "dark"].map((name) => defined(read(path.join(THEMES_DIR, `${name}.css`))));
  assert.deepEqual([...academic].filter((name) => !dark.has(name)), [], "深色风格缺少这些变量");
  assert.deepEqual([...dark].filter((name) => !academic.has(name)), [], "浅色学术缺少这些变量");
});

test("模板都引用风格文件，用到的变量风格文件里都有", () => {
  const themeVariables = defined(read(path.join(THEMES_DIR, "academic.css")));
  for (const file of TEMPLATES) {
    const html = read(path.join(TEMPLATES_DIR, file));
    assert.ok(html.includes('href="themes/academic.css"'), `${file} 没有引用风格文件`);
    // Variables a template sets itself (the red box position, the diagram tones) are fine too.
    const local = defined(html);
    const missing = [...used(html)].filter((name) => !themeVariables.has(name) && !local.has(name));
    assert.deepEqual(missing, [], `${file} 用到了风格文件里没有的变量`);
  }
});

test("模板里不写死颜色，颜色都从风格文件取", () => {
  for (const file of TEMPLATES) {
    const colours = read(path.join(TEMPLATES_DIR, file)).match(/(?<!&)#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?)\(/g);
    assert.equal(colours, null, `${file} 里写死了颜色：${colours}`);
  }
});

test("填模板时，风格文件的链接换成所选的风格", () => {
  const slide = { layout: "concept_diagram", values: {} };
  for (const theme of ["academic", "dark"]) {
    const html = fillTemplate(slide, theme);
    assert.ok(html.includes(`href="${pathToFileURL(path.join(THEMES_DIR, `${theme}.css`)).href}"`), `没有换成 ${theme}`);
    assert.ok(!html.includes('href="themes/academic.css"'));
  }
  assert.throws(() => fillTemplate(slide, "neon"), /没有「neon」这个风格，可选：academic、dark/);
});
