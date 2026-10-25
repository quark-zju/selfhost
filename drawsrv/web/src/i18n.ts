export type Language = "en" | "zh-CN";

// Match the first supported language family in browser preference order.
// Regional English variants use English; Chinese variants use Simplified Chinese.
export function selectLanguage(preferences: readonly string[]): Language {
  for (const preference of preferences) {
    const family = preference.trim().toLowerCase().split("-")[0];
    if (family === "en") return "en";
    if (family === "zh") return "zh-CN";
  }
  return "zh-CN";
}
let language: Language = "zh-CN";
export const getLanguage = () => language;
export function setLanguage(value: Language) {
  language = value;
}

const english = {
  请求失败: "Request failed",
  我的画布: "My canvases",
  新画布名称: "New canvas name",
  给新画布起个名字: "Name your new canvas",
  新建画布: "New canvas",
  重试: "Retry",
  "正在加载…": "Loading…",
  "最近更新优先 · 每页 20 项": "Recently updated first · 20 per page",
  搜索画布: "Search canvases",
  画布列表: "Canvas list",
  "没有找到匹配的画布。": "No matching canvases.",
  "创建第一个画布，或创建后导入已有的 .excalidraw 文件。":
    "Create your first canvas, then import an existing .excalidraw file if needed.",
  画布分页: "Canvas pages",
  上一页: "Previous",
  下一页: "Next",
  画布名称: "Canvas name",
  "画布名称需为 1–60 个字符": "Canvas names must contain 1–60 characters",
  导出备份: "Export backup",
  重新加载: "Reload",
  重命名: "Rename",
  保存到服务器: "Save to server",
  无法打开画布: "Unable to open canvas",
  返回列表: "Back to canvases",
  "正在加载画布…": "Loading canvas…",
  "此画布已被其他页面修改。请导出当前内容，再刷新页面。":
    "This canvas was changed in another tab. Export your current content before refreshing.",
  画布超过服务端大小限制: "The canvas exceeds the server size limit",
  请检查反代登录状态: "Check your reverse proxy login",
  请重试或导出备份: "Retry or export a backup",
  "服务器未返回版本，请导出当前内容后刷新":
    "The server did not return a version. Export your content before refreshing",
  "服务器未返回保存状态，请导出当前内容后刷新":
    "The server did not return a save status. Export your content before refreshing",
  "服务器未返回有效内容 HASH，请导出备份后刷新":
    "The server did not return a valid content hash. Export a backup before refreshing",
  "服务器未返回修订标识，请导出当前内容后刷新":
    "The server did not return a revision. Export your content before refreshing",
  "服务端返回了无效的应用结果，请导出备份后刷新":
    "The server returned an invalid change result. Export a backup before refreshing",
  编辑器尚未就绪: "The editor is not ready",
  编辑器重新初始化超时: "The editor took too long to reinitialize",
  编辑器已关闭: "The editor was closed",
  "无法原地更新画布，请导出备份后手动刷新。":
    "Unable to update the canvas in place. Export a backup before refreshing manually.",
  "无法确认同步状态，请导出备份后手动刷新。":
    "Unable to confirm the sync state. Export a backup before refreshing manually.",
  "服务端快照 HASH 不匹配，请导出备份后手动刷新。":
    "The server snapshot hash does not match. Export a backup before refreshing manually.",
  "等待同步…": "Waiting to sync…",
  "正在同步到服务器…": "Syncing to server…",
  "正在落盘并记录历史…": "Saving to disk and recording history…",
  "无法请求落盘，请重试": "Unable to request a disk save. Please retry",
  "服务器尚未确认落盘，请重试":
    "The server has not confirmed the disk save. Please retry",
  "保存失败，请重试": "Save failed. Please retry",
  "已落盘 · 历史已记录": "Saved to disk · History recorded",
  "已同步到服务器 · 等待落盘": "Synced to server · Waiting for disk save",
  "保留本地冲突副本，忽略自动刷新":
    "Keeping the local conflict copy; skipping automatic refresh",
  "等待当前保存完成后比较 HASH":
    "Waiting for the current save before comparing hashes",
  "本地有修改，按上传节流先保存":
    "Local changes pending; saving within the upload window first",
  "本地无修改，比较 HASH": "No local changes; comparing hashes",
  "正在操作编辑器，延后原地更新":
    "Editor interaction in progress; deferring the in-place update",
  "比较期间有新修改，延后更新":
    "New edits arrived during comparison; deferring the update",
  "HASH 比较": "Hash comparison",
  "有效内容一致，继续编辑": "Effective content matches; continuing editing",
  "本地无待保存修改，拉取最新快照以原地更新":
    "No pending edits; fetching the latest snapshot for an in-place update",
  "拉取期间有新修改或已退出，丢弃快照":
    "New edits or disposal during fetch; discarding the snapshot",
  "快照落后于 SSE，重新拉取":
    "Snapshot is behind the SSE revision; fetching again",
  "拉取期间开始编辑，延后原地更新":
    "Editing started during fetch; deferring the in-place update",
  快照已原地应用并更新保存基准:
    "Snapshot applied in place and save baseline updated",
  保存结果: "Save result",
  "[drawsrv:local] 无法保存本标签页的 appState":
    "[drawsrv:local] Unable to store this tab’s appState",
  "[drawsrv:sync] 同 ID 图片内容改变，仅重建编辑器图片缓存；保留视图，清空组件撤销栈":
    "[drawsrv:sync] Image content changed under the same ID; rebuilding the editor image cache, preserving the view and clearing editor undo history",
  "[drawsrv:sync] 原地更新失败，保留页面供备份":
    "[drawsrv:sync] In-place update failed; keeping the page for backup",
  "[drawsrv:sync] 同步决策失败，保留本地内容":
    "[drawsrv:sync] Sync decision failed; keeping local content",
  "[drawsrv:events] 忽略无效的状态通知":
    "[drawsrv:events] Ignoring an invalid status event",
  "[drawsrv:events] 通知连接已恢复":
    "[drawsrv:events] Event connection restored",
  "[drawsrv:events] 通知连接已建立":
    "[drawsrv:events] Event connection established",
  "[drawsrv:events] 通知连接中断，正在重连":
    "[drawsrv:events] Event connection lost; reconnecting",
  "{count} 个画布": "{count} canvases",
  "1 个画布": "1 canvas",
  "第 {page} / {pages} 页": "Page {page} of {pages}",
  "请求失败 ({status})：{hint}": "Request failed ({status}): {hint}",
  "部分修改冲突：{applied} 项已应用，{dropped} 项未应用。请导出备份后手动刷新。":
    "Some changes conflict: {applied} applied, {dropped} dropped. Export a backup before refreshing manually.",
} as const;
export type Message = keyof typeof english;
export function t(
  message: Message,
  values: Record<string, string | number> = {},
): string {
  const text = language === "en" ? english[message] : message;
  return text.replace(/\{(\w+)\}/g, (placeholder, key: string) =>
    Object.hasOwn(values, key) ? String(values[key]) : placeholder,
  );
}
