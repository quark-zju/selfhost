import { locale } from "./locales/index.ts";
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
export type CanvasItem = {
  id: string;
  name: string;
  updated: string;
};
export const canvasURL = (id: string) =>
  `/api/canvases/${encodeURIComponent(id)}`;
export async function checked(response: Response) {
  if (response.status === 412) {
    throw new SaveError(locale.Errors.RemoteChanged, true);
  }
  if (!response.ok) {
    const hint =
      response.status === 413
        ? locale.Errors.TooLarge
        : response.status === 401 || response.status === 403
          ? locale.Errors.Auth
          : locale.Errors.RetryOrBackup;
    throw new SaveError(locale.Errors.RequestFailed(response.status, hint));
  }
  return response;
}
export function version(response: Response) {
  const etag = response.headers.get("ETag");
  if (!etag) {
    throw new SaveError(locale.Errors.MissingVersion, true);
  }
  return etag;
}
export function saveResult(response: Response) {
  const value = response.headers.get("X-Drawsrv-Persisted");
  if (value !== "true" && value !== "false") {
    throw new SaveError(locale.Errors.MissingSaveStatus, true);
  }
  const hash = response.headers.get("X-Drawsrv-Hash");
  if (!hash || !/^[a-f0-9]{64}$/.test(hash))
    throw new SaveError(locale.Errors.InvalidHash, true);
  const revision = response.headers.get("X-Drawsrv-Revision");
  if (!revision) {
    throw new SaveError(locale.Errors.MissingRevision, true);
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
