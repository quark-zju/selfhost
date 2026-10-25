import { test } from "node:test";
import assert from "node:assert/strict";
import { selectLanguage, setLanguage, getLanguage, t } from "./i18n.ts";

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
    assert.equal(t("我的画布"), "My canvases");
    assert.equal(
      t("第 {page} / {pages} 页", { page: 2, pages: 3 }),
      "Page 2 of 3",
    );
    assert.equal(
      t("请求失败 ({status})：{hint}", {
        status: 403,
        hint: t("请检查反代登录状态"),
      }),
      "Request failed (403): Check your reverse proxy login",
    );
    assert.match(
      t(
        "部分修改冲突：{applied} 项已应用，{dropped} 项未应用。请导出备份后手动刷新。",
        { applied: 3, dropped: 1 },
      ),
      /3 applied, 1 dropped/,
    );
    setLanguage("zh-CN");
    assert.equal(t("我的画布"), "我的画布");
    assert.equal(
      t("第 {page} / {pages} 页", { page: 2, pages: 3 }),
      "第 2 / 3 页",
    );
  } finally {
    setLanguage("zh-CN");
  }
});
