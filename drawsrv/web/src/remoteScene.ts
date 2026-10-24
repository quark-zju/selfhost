import { canonical, effectiveElement } from "./content.ts";

// Keep unchanged objects (and deletion tombstones used by local undo) alive.
export function reuseRemoteElements<
  T extends { id: string; isDeleted?: boolean; version?: number },
>(local: readonly T[], incoming: readonly T[]): T[] {
  const previous = new Map(local.map((element) => [element.id, element]));
  const ids = new Set(incoming.map((element) => element.id));
  // Component objects may contain undefined keys; compare the wire values.
  const elements = incoming.map((element) => {
    const old = previous.get(element.id);
    return old &&
      canonical(JSON.parse(JSON.stringify(effectiveElement(old)))) ===
        canonical(JSON.parse(JSON.stringify(effectiveElement(element))))
      ? old
      : element;
  });
  for (const element of local)
    if (!ids.has(element.id)) {
      elements.push(
        element.isDeleted
          ? element
          : {
              ...element,
              isDeleted: true,
              version: (element.version || 0) + 1,
            },
      );
    }
  return elements;
}

// addFiles() skips existing IDs. A changed value under the same ID requires a
// fresh component file cache; timestamp-only differences do not.
export function hasChangedExistingFiles(
  local: Record<string, unknown>,
  incoming: Record<string, unknown>,
): boolean {
  const content = (file: unknown) =>
    Object.fromEntries(
      Object.entries(file as Record<string, unknown>).filter(
        ([key]) => key !== "created" && key !== "lastRetrieved",
      ),
    );
  return Object.entries(incoming).some(
    ([id, file]) =>
      Object.hasOwn(local, id) &&
      canonical(JSON.parse(JSON.stringify(content(local[id])))) !==
        canonical(JSON.parse(JSON.stringify(content(file)))),
  );
}
