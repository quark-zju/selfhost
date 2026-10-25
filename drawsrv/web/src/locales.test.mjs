import { test } from "node:test";
import assert from "node:assert/strict";
import {
  selectLanguage,
  setLanguage,
  getLanguage,
  locale,
} from "./locales/index.ts";
test("browser preferences choose the first supported language family", () => {
  for (const [preferences, expected] of [
    [["en-US", "zh-CN"], "en"],
    [["zh-CN", "en-US"], "zh-CN"],
    [["fr-FR", "en-GB", "zh-CN"], "en"],
    [["de-DE", "zh-Hans-SG", "en"], "zh-CN"],
    [["zh-TW", "en"], "zh-CN"],
    [["EN-au"], "en"],
  ])
    assert.equal(selectLanguage(preferences), expected);
});

test("empty and entirely unsupported preference lists fall back to Chinese", () => {
  for (const preferences of [[], ["fr", "ja-JP"], [""], ["not-a-language"]]) {
    assert.equal(selectLanguage(preferences), "zh-CN");
  }
});

test("UI text, pagination and conflict messages use the same selected language", () => {
  try {
    setLanguage("en");
    assert.equal(getLanguage(), "en");
    assert.equal(locale.Gallery.Title, "My canvases");
    assert.equal(locale.Gallery.Count(0), "0 canvases");
    assert.equal(locale.Gallery.Count(1), "1 canvas");
    assert.equal(locale.Gallery.Count(2), "2 canvases");
    assert.equal(locale.Gallery.Page(2, 3), "Page 2 of 3");
    assert.equal(
      locale.Errors.RequestFailed(403, locale.Errors.Auth),
      "Request failed (403): Check your reverse proxy login",
    );
    assert.match(locale.Save.Conflict(3, 1), /3 applied, 1 dropped/);
    setLanguage("zh-CN");
    assert.equal(locale.Gallery.Title, "我的画布");
    assert.equal(locale.Gallery.Count(1), "1 个画布");
    assert.equal(locale.Gallery.Count(2), "2 个画布");
    assert.equal(locale.Gallery.Page(2, 3), "第 2 / 3 页");
  } finally {
    setLanguage("zh-CN");
  }
});
