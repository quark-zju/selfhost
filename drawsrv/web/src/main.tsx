import {
  locale,
  getLanguage,
  selectLanguage,
  setLanguage,
} from "./locales/index.ts";
import { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import {
  Excalidraw,
  MainMenu,
  serializeAsJSON,
  restoreElements,
  CaptureUpdateAction,
} from "@excalidraw/excalidraw";
import type {
  ExcalidrawImperativeAPI,
  ExcalidrawProps,
  LibraryItems,
} from "@excalidraw/excalidraw/types";
import {
  Autosave,
  SaveError,
  UPLOAD_INTERVAL_MS,
  type SaveState,
} from "./autosave";
import {
  canvasURL,
  checked,
  loadCanvas,
  saveResult,
  type Canvas,
  type CanvasItem,
} from "./api";
import "@excalidraw/excalidraw/index.css";
import "./style.css";
import { LocalAppStateStore } from "./localAppState";
import { normalizeElements, normalizeLibraryItems } from "./normalize";
import { serializeCanvas, diffCanvas, effectiveHash } from "./content";
import { reuseRemoteElements, hasChangedExistingFiles } from "./remoteScene";
import { paginateCanvases } from "./canvasList";

const message = (error: unknown) =>
  error instanceof Error ? error.message : locale.Common.RequestFailed;

// Keep the shared title node outside React so editor updates cannot replace it.
function updateCanvasTitle(root: HTMLElement, id: string, name: string) {
  const doc = root.ownerDocument;
  let title = doc.getElementById("canvas-title");
  if (!title) {
    const header = doc.createElement("header");
    header.className = "editor-header";
    title = doc.createElement("h1");
    title.id = "canvas-title";
    title.className = "canvas-title";
    title.dataset.canvasId = id;
    title.style.viewTransitionName = titleTransition(id).viewTransitionName;
    header.append(title);
    root.before(header);
  }
  if (title.dataset.canvasId === id && title.textContent !== name) {
    title.textContent = name;
  }
  doc.title = `${name} | drawsrv`;
}
const titleTransition = (id: string) => ({
  viewTransitionName: `canvas-title-${id.replace(/[^a-zA-Z0-9_-]/g, "_")}`,
});

function Gallery() {
  const [canvases, setCanvases] = useState<CanvasItem[] | null>(null);
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const visible = useMemo(
    () => paginateCanvases(canvases ?? [], query, page),
    [canvases, query, page],
  );
  const load = () => {
    setError("");
    void fetch("/api/canvases", { cache: "no-store" })
      .then(checked)
      .then((r) => r.json())
      .then(setCanvases)
      .catch((e) => setError(message(e)));
  };
  useEffect(load, []);
  return (
    <main className="gallery">
      <h1>{locale.Gallery.Title}</h1>
      <form
        className="create"
        onSubmit={async (event) => {
          event.preventDefault();
          setBusy(true);
          setError("");
          const ownerWindow = event.currentTarget.ownerDocument.defaultView;
          try {
            const response = await checked(
              await fetch("/api/canvases", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ name }),
              }),
            );
            const { id } = await response.json();
            ownerWindow?.location.assign(`/?canvas=${id}`);
          } catch (error) {
            setError(message(error));
          } finally {
            setBusy(false);
          }
        }}
      >
        <input
          aria-label={locale.Gallery.NewCanvasName}
          placeholder={locale.Gallery.NewCanvasPlaceholder}
          value={name}
          maxLength={60}
          required
          onChange={(event) => setName(event.target.value)}
        />
        <button className="primary" disabled={busy || !name.trim()}>
          {locale.Gallery.CreateCanvas}
        </button>
      </form>
      {error && (
        <p className="error" role="alert">
          {error} <button onClick={load}>{locale.Common.Retry}</button>
        </p>
      )}
      <div className="list-heading">
        <div>
          <h2>
            {canvases
              ? locale.Gallery.Count(visible.total)
              : locale.Common.Loading}
          </h2>
          <span className="muted">{locale.Gallery.SortHint}</span>
        </div>
        <input
          aria-label={locale.Gallery.Search}
          placeholder={locale.Gallery.Search}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setPage(1);
          }}
        />
      </div>
      <ul className="canvas-list" aria-label={locale.Gallery.ListLabel}>
        {visible.items.map((canvas) => (
          <li key={canvas.id} className="canvas-entry">
            <a className="canvas-row" href={`/?canvas=${canvas.id}`}>
              <strong style={titleTransition(canvas.id)}>{canvas.name}</strong>
              <time dateTime={canvas.updated}>
                {new Date(canvas.updated).toLocaleString(getLanguage())}
              </time>
            </a>
            <button
              className="delete-canvas"
              aria-label={locale.Gallery.DeleteLabel(canvas.name)}
              disabled={deleting !== null}
              onClick={async (event) => {
                const ownerWindow =
                  event.currentTarget.ownerDocument.defaultView;
                setDeleting(canvas.id);
                setError("");
                try {
                  const latest = await loadCanvas(canvas.id);
                  if (
                    !ownerWindow?.confirm(
                      locale.Gallery.DeleteConfirm(latest.canvas.name),
                    )
                  )
                    return;
                  const response = await fetch(canvasURL(canvas.id), {
                    method: "DELETE",
                    headers: {
                      "Content-Type": "application/json",
                      "If-Match": latest.etag,
                    },
                  });
                  if (response.status === 412)
                    throw new Error(locale.Gallery.DeleteChanged);
                  await checked(response);
                  setCanvases(
                    (items) =>
                      items?.filter((item) => item.id !== canvas.id) ?? null,
                  );
                } catch (error) {
                  setError(message(error));
                } finally {
                  setDeleting(null);
                }
              }}
            >
              {deleting === canvas.id
                ? locale.Gallery.Deleting
                : locale.Gallery.Delete}
            </button>
          </li>
        ))}
      </ul>
      {canvases && visible.total === 0 && (
        <p className="empty">
          {query.trim() ? locale.Gallery.NoMatches : locale.Gallery.Empty}
        </p>
      )}
      {visible.pages > 1 && (
        <nav className="pagination" aria-label={locale.Gallery.PaginationLabel}>
          <button
            disabled={visible.page <= 1}
            onClick={() => setPage(visible.page - 1)}
          >
            {locale.Gallery.Previous}
          </button>
          <span role="status" aria-live="polite">
            {locale.Gallery.Page(visible.page, visible.pages)}
          </span>
          <button
            disabled={visible.page >= visible.pages}
            onClick={() => setPage(visible.page + 1)}
          >
            {locale.Gallery.Next}
          </button>
        </nav>
      )}
    </main>
  );
}

function Editor({
  id,
  loaded,
  clientId,
  ownerWindow,
  root,
}: {
  id: string;
  loaded: Awaited<ReturnType<typeof loadCanvas>>;
  clientId: string;
  ownerWindow: Window;
  root: HTMLElement;
}) {
  const [localState] = useState(() => new LocalAppStateStore(id, ownerWindow));
  const [scene, setScene] = useState(() => ({
    key: 0,
    initialData: { ...loaded.canvas, appState: localState.load() },
  }));
  const node = useRef<HTMLDivElement>(null);
  const api = useRef<ExcalidrawImperativeAPI | null>(null);
  const applyingRemote = useRef(false);
  const editingName = useRef(false);
  const sceneReady = useRef<{
    resolve: () => void;
    cancel: () => void;
  } | null>(null);
  const current = useRef<Canvas>(loaded.canvas);
  const library = useRef(loaded.canvas.libraryItems);
  const updateTitle = (name: string) => updateCanvasTitle(root, id, name);
  useEffect(() => {
    updateCanvasTitle(root, id, loaded.canvas.name);
  }, [root, id, loaded.canvas.name]);
  const [conflict, setConflict] = useState("");
  const lastSaveMessage = useRef<string | null>(null);
  const logSaveState = (state: SaveState) => {
    if (state.phase === "conflict") setConflict(state.message);
    const entry = `[drawsrv:${state.phase}] ${state.message}`;
    if (entry !== lastSaveMessage.current) {
      console.log(entry);
      lastSaveMessage.current = entry;
    }
  };
  const [save] = useState(
    () =>
      new Autosave(
        serializeCanvas(loaded.canvas),
        loaded.etag,
        async (body, _etag, baseline) => {
          const changes = diffCanvas(baseline, body);
          const response = await checked(
            await fetch(`${canvasURL(id)}/changes`, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "X-Drawsrv-Client": clientId,
              },
              body: JSON.stringify({ changes }),
            }),
          );
          const result = await response.json();
          const state = saveResult(response);
          const indexes = [
            ...(result.applied || []),
            ...(result.dropped || []).map(
              (entry: { index: number }) => entry.index,
            ),
          ];
          if (
            !Array.isArray(result.applied) ||
            !Array.isArray(result.dropped) ||
            result.hash !== state.hash ||
            indexes.length !== changes.length ||
            new Set(indexes).size !== changes.length ||
            indexes.some(
              (index) =>
                !Number.isInteger(index) ||
                index < 0 ||
                index >= changes.length,
            )
          ) {
            throw new SaveError(locale.Errors.InvalidChangeResult, true);
          }
          return { ...state, applied: result.applied, dropped: result.dropped };
        },
        logSaveState,
        UPLOAD_INTERVAL_MS,
        {
          persisted: loaded.persisted,
          revision: loaded.revision,
          hash: loaded.hash,
          hashBody: (body) => effectiveHash(body, ownerWindow.crypto),
          log: (decision, details) =>
            console.log(`[drawsrv:sync] ${decision}`, details ?? ""),
          canRefresh: () => {
            const state = api.current?.getAppState();
            return (
              !!state &&
              !state.isLoading &&
              !applyingRemote.current &&
              !editingName.current &&
              state.cursorButton !== "down" &&
              !state.editingTextElement &&
              !state.editingLinearElement &&
              !state.isResizing &&
              !state.isRotating
            );
          },
          loadSnapshot: async () => {
            const next = await loadCanvas(id);
            return {
              ...next,
              body: serializeCanvas(next.canvas),
              apply: async () => {
                const container = node.current,
                  instance = api.current;
                if (!container || !instance)
                  throw Error(locale.Errors.NotReady);
                // The controller rechecks pending edits before entering this
                // mutation phase. Lock input while asynchronous library work
                // runs, and suppress only this phase's component callbacks.
                const wasInert = container.inert;
                applyingRemote.current = true;
                container.inert = true;
                try {
                  const view = instance.getAppState();
                  const live = new Set(
                    next.canvas.elements
                      .filter((element) => !element.isDeleted)
                      .map((element) => element.id),
                  );
                  const groups = new Set(
                    next.canvas.elements
                      .filter((element) => !element.isDeleted)
                      .flatMap((element) => element.groupIds),
                  );
                  const selection = {
                    selectedElementIds: Object.fromEntries(
                      Object.entries(view.selectedElementIds).filter(([id]) =>
                        live.has(id),
                      ),
                    ),
                    selectedGroupIds: Object.fromEntries(
                      Object.entries(view.selectedGroupIds).filter(([id]) =>
                        groups.has(id),
                      ),
                    ),
                    selectedLinearElement:
                      view.selectedLinearElement &&
                      live.has(view.selectedLinearElement.elementId)
                        ? view.selectedLinearElement
                        : null,
                  };
                  if (
                    hasChangedExistingFiles(
                      instance.getFiles(),
                      next.canvas.files,
                    )
                  ) {
                    console.log(locale.Sync.ImageCacheChanged);
                    current.current = next.canvas;
                    library.current = next.canvas.libraryItems;
                    const ready = new Promise<void>((resolve, reject) => {
                      const finish = () => {
                        ownerWindow.clearTimeout(timer);
                        sceneReady.current = null;
                        resolve();
                      };
                      const timer = ownerWindow.setTimeout(() => {
                        sceneReady.current = null;
                        reject(Error(locale.Errors.ReinitializeTimeout));
                      }, 10000);
                      sceneReady.current = {
                        resolve: finish,
                        cancel: () => {
                          ownerWindow.clearTimeout(timer);
                          sceneReady.current = null;
                          reject(Error(locale.Errors.Closed));
                        },
                      };
                    });
                    flushSync(() => {
                      api.current = null;
                      setScene((previous) => ({
                        key: previous.key + 1,
                        initialData: {
                          ...next.canvas,
                          appState: {
                            ...view,
                            ...selection,
                            selectedLinearElement: null,
                          },
                        },
                      }));
                      updateTitle(next.canvas.name);
                    });
                    await ready;
                  } else {
                    const libraryBody = (items: LibraryItems) =>
                      serializeCanvas({
                        name: "",
                        elements: [],
                        files: {},
                        libraryItems: items,
                      });
                    if (
                      libraryBody(library.current) !==
                      libraryBody(next.canvas.libraryItems)
                    ) {
                      await instance.updateLibrary({
                        libraryItems: next.canvas.libraryItems,
                        merge: false,
                        prompt: false,
                        openLibraryMenu: false,
                      });
                    }
                    const elements = reuseRemoteElements(
                      instance.getSceneElementsIncludingDeleted(),
                      restoreElements(next.canvas.elements, null, {
                        repairBindings: true,
                      }),
                    );
                    if (selection.selectedLinearElement) {
                      const selected = instance
                        .getSceneElementsIncludingDeleted()
                        .find(
                          (element) =>
                            element.id ===
                            selection.selectedLinearElement!.elementId,
                        );
                      if (!selected || !elements.includes(selected))
                        selection.selectedLinearElement = null;
                    }
                    current.current = next.canvas;
                    library.current = next.canvas.libraryItems;
                    flushSync(() => {
                      const files = instance.getFiles();
                      instance.addFiles(
                        Object.values(next.canvas.files).filter(
                          (file) => !Object.hasOwn(files, file.id),
                        ),
                      );
                      instance.updateScene({
                        elements,
                        appState: selection,
                        captureUpdate: CaptureUpdateAction.NEVER,
                      });
                      updateTitle(next.canvas.name);
                    });
                  }
                } catch (error) {
                  console.log(locale.Sync.ApplyFailed, error);
                  throw new SaveError(locale.Errors.ApplyFailed, true);
                } finally {
                  applyingRemote.current = false;
                  container.inert = wasInert;
                }
              },
            };
          },
          publish: async (etag) =>
            saveResult(
              await checked(
                await fetch(`${canvasURL(id)}/flush`, {
                  method: "POST",
                  headers: {
                    "Content-Type": "application/json",
                    "If-Match": etag,
                    "X-Drawsrv-Client": clientId,
                  },
                  body: "{}",
                }),
              ),
            ),
        },
      ),
  );
  const queue = () => save.queue(serializeCanvas(current.current));
  const onChange: ExcalidrawProps["onChange"] = (elements, appState, files) => {
    if (!appState.isLoading && api.current) sceneReady.current?.resolve();
    if (appState.isLoading || applyingRemote.current) return;
    // The public serializer removes transient UI state and unused/deleted files.
    const data = JSON.parse(
      serializeAsJSON(
        elements.filter((element) => !element.isDeleted),
        appState,
        files,
        "local",
      ),
    );
    current.current = {
      name: current.current.name,
      elements: normalizeElements(data.elements),
      files: data.files || {},
      libraryItems: library.current,
    };
    localState.save({
      ...data.appState,
      scrollX: appState.scrollX,
      scrollY: appState.scrollY,
      zoom: appState.zoom,
    });
    queue();
    void save.resumeRemote();
  };
  const onLibraryChange = (items: LibraryItems) => {
    if (applyingRemote.current) return;
    library.current = normalizeLibraryItems(items);
    current.current = { ...current.current, libraryItems: library.current };
    queue();
  };
  useEffect(() => {
    const doc = node.current!.ownerDocument;
    const ownerWindow = doc.defaultView!;
    if (lastSaveMessage.current === null) {
      logSaveState({
        phase: loaded.persisted ? "saved" : "synced",
        message: loaded.persisted ? locale.Save.Saved : locale.Save.Synced,
      });
    }
    const beforeUnload = (event: BeforeUnloadEvent) => {
      localState.flush();
      if (save.dirty) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    const visibility = () => {
      if (doc.hidden) {
        localState.flush();
        void save.sync();
      }
    };
    const online = () => {
      void save.sync();
    };
    const events = new ownerWindow.EventSource(`${canvasURL(id)}/events`);
    let active = true;
    let disconnected = false;
    const receive = (event: Event) => {
      if (!active) {
        return;
      }
      try {
        const data = JSON.parse((event as MessageEvent<string>).data);
        if (
          typeof data.etag !== "string" ||
          typeof data.hash !== "string" ||
          typeof data.revision !== "string" ||
          typeof data.persisted !== "boolean" ||
          typeof data.source !== "string"
        ) {
          return;
        }
        void save.observeRemote(data, data.source).catch((error) => {
          console.log(locale.Sync.DecisionFailed, error);
          setConflict(locale.Errors.SyncStateFailed);
        });
      } catch {
        console.log(locale.Events.InvalidStatus);
      }
    };
    for (const kind of ["state", "change", "persisted"]) {
      events.addEventListener(kind, receive);
    }
    events.addEventListener("deleted", () => {
      if (!active) return;
      save.block(locale.Errors.Deleted);
      events.close();
    });
    events.onopen = () => {
      if (!active) {
        return;
      }
      console.log(
        disconnected ? locale.Events.Restored : locale.Events.Connected,
      );
      disconnected = false;
    };
    events.onerror = () => {
      if (active && !disconnected) {
        console.log(locale.Events.Disconnected);
      }
      disconnected = true;
    };
    ownerWindow.addEventListener("beforeunload", beforeUnload);
    ownerWindow.addEventListener("online", online);
    doc.addEventListener("visibilitychange", visibility);
    return () => {
      active = false;
      events.close();
      ownerWindow.removeEventListener("beforeunload", beforeUnload);
      ownerWindow.removeEventListener("online", online);
      doc.removeEventListener("visibilitychange", visibility);
      save.dispose();
      sceneReady.current?.cancel();
      localState.dispose();
    };
  }, [save, id, clientId, localState]);
  const exportBackup = () => {
    const doc = node.current!.ownerDocument;
    const ownerWindow = doc.defaultView!;
    const data = api.current
      ? JSON.parse(
          serializeAsJSON(
            api.current.getSceneElements(),
            api.current.getAppState(),
            api.current.getFiles(),
            "local",
          ),
        )
      : current.current;
    const blob = new Blob(
      [
        JSON.stringify(
          {
            ...data,
            name: current.current.name,
            libraryItems: library.current,
          },
          null,
          2,
        ),
      ],
      { type: "application/json" },
    );
    const url = ownerWindow.URL.createObjectURL(blob);
    const link = doc.createElement("a");
    link.href = url;
    link.download = `${current.current.name}.excalidraw`;
    link.click();
    ownerWindow.setTimeout(() => ownerWindow.URL.revokeObjectURL(url), 1000);
  };
  const rename = () => {
    editingName.current = true;
    try {
      const value = ownerWindow.prompt(
        locale.Editor.Name,
        current.current.name,
      );
      if (value === null) return;
      const name = value.trim();
      if (!name || name.length > 60) {
        ownerWindow.alert(locale.Editor.InvalidName);
        return;
      }
      if (name !== current.current.name) {
        current.current = { ...current.current, name };
        updateTitle(name);
        queue();
      }
    } finally {
      editingName.current = false;
      void save.resumeRemote();
    }
  };
  return (
    <div className="workspace" ref={node}>
      {conflict && (
        <div className="remote-update" role="status">
          <span>{conflict}</span>
          <button onClick={exportBackup}>{locale.Editor.ExportBackup}</button>
          <button
            onClick={() =>
              node.current!.ownerDocument.defaultView?.location.reload()
            }
          >
            {locale.Editor.Reload}
          </button>
        </div>
      )}
      <div className="drawing">
        <Excalidraw
          key={scene.key}
          initialData={scene.initialData}
          excalidrawAPI={(instance) => {
            api.current = instance;
          }}
          onChange={onChange}
          onLibraryChange={onLibraryChange}
          langCode={getLanguage()}
        >
          <MainMenu>
            <MainMenu.Item onSelect={rename}>
              {locale.Editor.Rename}
            </MainMenu.Item>
            <MainMenu.Item
              icon={
                <svg
                  width="20"
                  height="20"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.75"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                  focusable="false"
                >
                  <path d="M5 3h12l4 4v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z" />
                  <path d="M7 3v6h10V3M7 21v-8h10v8" />
                </svg>
              }
              onSelect={() => void save.flush()}
            >
              {locale.Editor.SaveToServer}
            </MainMenu.Item>
            <MainMenu.Separator />
            <MainMenu.DefaultItems.LoadScene />
            <MainMenu.DefaultItems.SaveToActiveFile />
            <MainMenu.DefaultItems.Export />
            <MainMenu.DefaultItems.SaveAsImage />
            <MainMenu.DefaultItems.ClearCanvas />
            <MainMenu.Separator />
            <MainMenu.DefaultItems.ChangeCanvasBackground />
          </MainMenu>
        </Excalidraw>
      </div>
    </div>
  );
}

function App({ root }: { root: HTMLElement }) {
  const [clientId] = useState(() =>
    Array.from(
      root.ownerDocument.defaultView!.crypto.getRandomValues(
        new Uint8Array(16),
      ),
      (byte) => byte.toString(16).padStart(2, "0"),
    ).join(""),
  );
  const id = new URL(
    root.ownerDocument.defaultView!.location.href,
  ).searchParams.get("canvas");
  const [loaded, setLoaded] = useState<Awaited<
    ReturnType<typeof loadCanvas>
  > | null>(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!id) {
      return;
    }
    let active = true;
    setError("");
    void loadCanvas(id)
      .then((value) => {
        if (active) {
          setLoaded(value);
        }
      })
      .catch((error) => {
        if (active) {
          setError(message(error));
        }
      });
    return () => {
      active = false;
    };
  }, [id, attempt]);
  if (!id) {
    return <Gallery />;
  }
  if (error) {
    return (
      <main className="gallery">
        <h1>{locale.Editor.OpenFailed}</h1>
        <p role="alert">{error}</p>
        <button onClick={() => setAttempt(attempt + 1)}>
          {locale.Common.Retry}
        </button>{" "}
        <a href="/">{locale.Editor.BackToList}</a>
      </main>
    );
  }
  return loaded ? (
    <Editor
      id={id}
      loaded={loaded}
      clientId={clientId}
      ownerWindow={root.ownerDocument.defaultView!}
      root={root}
    />
  ) : (
    <div className="workspace">
      <div className="canvas-loading" role="status">
        {locale.Editor.Loading}
      </div>
    </div>
  );
}

const root = document.getElementById("root")!;
const owner = root.ownerDocument.defaultView!;
setLanguage(
  selectLanguage(
    owner.navigator.languages.length
      ? owner.navigator.languages
      : [owner.navigator.language],
  ),
);
root.ownerDocument.documentElement.lang = getLanguage();
if (!new URL(owner.location.href).searchParams.has("canvas")) {
  root.ownerDocument.title = `${locale.Gallery.Title} | drawsrv`;
}
createRoot(root).render(<App root={root} />);
