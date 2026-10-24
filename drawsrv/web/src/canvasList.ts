import type { CanvasItem } from "./api";

export const CANVASES_PER_PAGE = 20;

// Work on metadata only. Never mutate the fetched list, and filter/sort the
// entire collection before slicing so search and recent ordering span pages.
export function paginateCanvases(
  canvases: readonly CanvasItem[],
  query: string,
  page: number,
) {
  const search = query.trim().toLowerCase();
  const ordered = canvases.filter((canvas) =>
    canvas.name.toLowerCase().includes(search),
  );
  ordered.sort(
    (a, b) =>
      Date.parse(b.updated) - Date.parse(a.updated) ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  const pages = Math.max(1, Math.ceil(ordered.length / CANVASES_PER_PAGE));
  const current = Math.min(pages, Math.max(1, Math.trunc(page) || 1));
  const offset = (current - 1) * CANVASES_PER_PAGE;
  return {
    items: ordered.slice(offset, offset + CANVASES_PER_PAGE),
    total: ordered.length,
    page: current,
    pages,
  };
}
