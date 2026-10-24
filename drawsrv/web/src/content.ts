type ObjectValue = Record<string, any>;
export type Slot = { present: boolean; value?: any };
export type Change = {
  target:
    | "elements"
    | "files"
    | "libraryItems"
    | "name"
    | "elementOrder"
    | "libraryOrder";
  id?: string;
  before: Slot;
  after: Slot;
  fields?: { field: string; before: Slot; after: Slot }[];
  afterId?: string;
};

const bookkeeping = new Set(["updated", "version", "versionNonce"]);
const encoder = new TextEncoder();
const compareKeys = (a: string, b: string) => {
  const x = encoder.encode(a),
    y = encoder.encode(b);
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    if (x[i] !== y[i]) return x[i] - y[i];
  }
  return x.length - y.length;
};

// See content.go: deterministic across Go/JS, independent of JSON formatting.
export function canonical(value: any): string {
  if (value === null) return "n";
  if (typeof value === "boolean") return value ? "t" : "f";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw Error("non-finite JSON number");
    const bytes = new Uint8Array(8);
    new DataView(bytes.buffer).setFloat64(0, value === 0 ? 0 : value);
    return (
      "d" +
      Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")
    );
  }
  if (typeof value === "string")
    return `s${encoder.encode(value).length}:${value}`;
  if (Array.isArray(value))
    return `a${value.length}:` + value.map(canonical).join("");
  const keys = Object.keys(value).sort(compareKeys);
  return (
    `o${keys.length}:` +
    keys.map((key) => canonical(key) + canonical(value[key])).join("")
  );
}

const without = (value: ObjectValue, keys: Set<string>) =>
  Object.fromEntries(Object.entries(value).filter(([key]) => !keys.has(key)));

export function effectiveElement(value: ObjectValue): ObjectValue {
  const clean = without(value, bookkeeping);
  clean.boundElements ??= [];
  return clean;
}
export function effectiveCanvas(value: ObjectValue): ObjectValue {
  return {
    name: value.name,
    elements: value.elements.map(effectiveElement),
    files: Object.fromEntries(
      Object.entries(value.files).map(([id, file]) => [
        id,
        without(file as ObjectValue, new Set(["created", "lastRetrieved"])),
      ]),
    ),
    libraryItems: (value.libraryItems || []).map((item: ObjectValue) => ({
      ...without(item, new Set(["created"])),
      elements: item.elements.map(effectiveElement),
    })),
  };
}
function sorted(value: any): any {
  if (Array.isArray(value)) return value.map(sorted);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort(compareKeys)
        .map((key) => [key, sorted(value[key])]),
    );
  return value;
}
export const serializeCanvas = (value: ObjectValue) =>
  JSON.stringify(sorted(effectiveCanvas(value)));

export async function effectiveHash(
  body: string,
  crypto: Pick<Crypto, "subtle">,
): Promise<string> {
  const bytes = encoder.encode(canonical(effectiveCanvas(JSON.parse(body))));
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hash), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

const slot = (object: ObjectValue, key: string): Slot =>
  Object.hasOwn(object, key)
    ? { present: true, value: object[key] }
    : { present: false };
const present = (value: any): Slot => ({ present: true, value });
const absent: Slot = { present: false };
const equal = (a: any, b: any) => canonical(a) === canonical(b);

// The baseline is only this client's last acknowledged content, not a retained
// server snapshot. One field group per element makes geometry edits atomic.
export function diffCanvas(beforeBody: string, afterBody: string): Change[] {
  const before = effectiveCanvas(JSON.parse(beforeBody));
  const after = effectiveCanvas(JSON.parse(afterBody));
  const changes: Change[] = [];
  if (!equal(before.name, after.name))
    changes.push({
      target: "name",
      before: present(before.name),
      after: present(after.name),
    });
  for (const target of ["files", "elements", "libraryItems"] as const) {
    const old: ObjectValue =
      target === "files"
        ? before.files
        : Object.fromEntries(
            before[target].map((item: ObjectValue) => [item.id, item]),
          );
    const next: ObjectValue =
      target === "files"
        ? after.files
        : Object.fromEntries(
            after[target].map((item: ObjectValue) => [item.id, item]),
          );
    for (const id of Object.keys(old))
      if (!Object.hasOwn(next, id)) {
        changes.push({ target, id, before: present(old[id]), after: absent });
      }
    let afterId = "";
    for (const id of target === "files"
      ? Object.keys(next)
      : after[target].map((item: ObjectValue) => item.id)) {
      if (!Object.hasOwn(old, id))
        changes.push({
          target,
          id,
          before: absent,
          after: present(next[id]),
          afterId,
        });
      else if (!equal(old[id], next[id])) {
        if (target === "elements") {
          const fields = Array.from(
            new Set([...Object.keys(old[id]), ...Object.keys(next[id])]),
          )
            .filter((field) => field !== "id" && !bookkeeping.has(field))
            .map((field) => ({
              field,
              before: slot(old[id], field),
              after: slot(next[id], field),
            }))
            .filter((field) => !equal(field.before, field.after));
          if (fields.length)
            changes.push({ target, id, before: absent, after: absent, fields });
        } else
          changes.push({
            target,
            id,
            before: present(old[id]),
            after: present(next[id]),
          });
      }
      afterId = id;
    }
    if (target !== "files") {
      const commonBefore = before[target]
        .map((item: ObjectValue) => item.id)
        .filter((id: string) => Object.hasOwn(next, id));
      const commonAfter = after[target]
        .map((item: ObjectValue) => item.id)
        .filter((id: string) => Object.hasOwn(old, id));
      if (!equal(commonBefore, commonAfter))
        changes.push({
          target: target === "elements" ? "elementOrder" : "libraryOrder",
          before: present(commonBefore),
          after: present(commonAfter),
        });
    }
  }
  return changes;
}
