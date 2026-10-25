import { t } from "./i18n.ts";
import type {
  ExcalidrawInitialDataState,
  LibraryItems,
} from "@excalidraw/excalidraw/types";
import { SaveError } from "./autosave";
import { normalizeElements, normalizeLibraryItems } from "./normalize";

export type Canvas = {
  name: string;
  elements: NonNullable<ExcalidrawInitialDataState["elements"]>;
  files: NonNullable<ExcalidrawInitialDataState["files"]>;
  libraryItems: LibraryItems;
};
export type CanvasItem = { id: string; name: string; updated: string };
export const canvasURL = (id: string) =>
  `/api/canvases/${encodeURIComponent(id)}`;
export async function checked(response: Response) {
  if (response.status === 412) {
    throw new SaveError(
      t("此画布已被其他页面修改。请导出当前内容，再刷新页面。"),
      true,
    );
  }
  if (!response.ok) {
    const hint =
      response.status === 413
        ? t("画布超过服务端大小限制")
        : response.status === 401 || response.status === 403
          ? t("请检查反代登录状态")
          : t("请重试或导出备份");
    throw new SaveError(
      t("请求失败 ({status})：{hint}", { status: response.status, hint }),
    );
  }
  return response;
}
export function version(response: Response) {
  const etag = response.headers.get("ETag");
  if (!etag) {
    throw new SaveError(t("服务器未返回版本，请导出当前内容后刷新"), true);
  }
  return etag;
}
export function saveResult(response: Response) {
  const value = response.headers.get("X-Drawsrv-Persisted");
  if (value !== "true" && value !== "false") {
    throw new SaveError(t("服务器未返回保存状态，请导出当前内容后刷新"), true);
  }
  const hash = response.headers.get("X-Drawsrv-Hash");
  if (!hash || !/^[a-f0-9]{64}$/.test(hash))
    throw new SaveError(t("服务器未返回有效内容 HASH，请导出备份后刷新"), true);
  const revision = response.headers.get("X-Drawsrv-Revision");
  if (!revision) {
    throw new SaveError(t("服务器未返回修订标识，请导出当前内容后刷新"), true);
  }
  return {
    etag: version(response),
    persisted: value === "true",
    revision,
    hash,
  };
}
export async function loadCanvas(id: string) {
  const response = await checked(
    await fetch(canvasURL(id), { cache: "no-store" }),
  );
  const { name, elements, files, libraryItems } =
    (await response.json()) as Canvas;
  // Normalize before establishing the autosave baseline: restoration changing
  // null to [] must not count as an edit. Also exclude legacy shared appState.
  return {
    canvas: {
      name,
      elements: normalizeElements(elements),
      files,
      libraryItems: normalizeLibraryItems(libraryItems),
    },
    ...saveResult(response),
  };
}
