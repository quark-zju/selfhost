// Keep empty bindings consistent across new elements, restored scenes and imports.
// Copy only elements that need normalization; never mutate Excalidraw's objects.
export function normalizeElements<
  T extends { readonly boundElements?: readonly unknown[] | null },
>(elements: readonly T[]): T[] {
  return elements.map((element) =>
    element.boundElements == null ? { ...element, boundElements: [] } : element,
  );
}

export function normalizeLibraryItems<
  T extends {
    readonly elements: readonly {
      readonly boundElements?: readonly unknown[] | null;
    }[];
  },
>(items: readonly T[]): T[] {
  return items.map((item) => ({
    ...item,
    elements: normalizeElements(item.elements),
  }));
}
