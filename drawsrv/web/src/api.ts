import type { ExcalidrawInitialDataState } from "@excalidraw/excalidraw/types";
import { SaveError } from "./autosave";

export type Canvas = {
  name: string;
  elements: NonNullable<ExcalidrawInitialDataState["elements"]>;
  files: NonNullable<ExcalidrawInitialDataState["files"]>;
  libraryItems: NonNullable<ExcalidrawInitialDataState["libraryItems"]>;
};
export type CanvasItem = { id: string; name: string; updated: string };
export type HistoryItem = { commit: string; date: string };
export const canvasURL = (id: string) =>
  `/api/canvases/${encodeURIComponent(id)}`;
export async function checked(response: Response) {
  if (response.status === 412) {
    throw new SaveError(
      "此画布已被其他页面修改。请导出当前内容，再刷新页面。",
      true,
    );
  }
  if (!response.ok) {
    const hint =
      response.status === 413
        ? "画布超过服务端大小限制"
        : response.status === 401 || response.status === 403
          ? "请检查反代登录状态"
          : "请重试或导出备份";
    throw new SaveError(`请求失败 (${response.status})：${hint}`);
  }
  return response;
}
export function version(response: Response) {
  const etag = response.headers.get("ETag");
  if (!etag) {
    throw new SaveError("服务器未返回版本，请导出当前内容后刷新", true);
  }
  return etag;
}
export function saveResult(response: Response) {
  const value = response.headers.get("X-Drawsrv-Persisted");
  if (value !== "true" && value !== "false") {
    throw new SaveError("服务器未返回保存状态，请导出当前内容后刷新", true);
  }
  const revision = response.headers.get("X-Drawsrv-Revision");
  if (!revision) {
    throw new SaveError("服务器未返回修订标识，请导出当前内容后刷新", true);
  }
  return { etag: version(response), persisted: value === "true", revision };
}
export async function loadCanvas(id: string) {
  const response = await checked(
    await fetch(canvasURL(id), { cache: "no-store" }),
  );
  const { name, elements, files, libraryItems } =
    (await response.json()) as Canvas;
  // Explicitly exclude appState from older servers or historical snapshots.
  return {
    canvas: { name, elements, files, libraryItems },
    ...saveResult(response),
  };
}
