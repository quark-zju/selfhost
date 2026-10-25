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
  error instanceof Error ? error.message : "请求失败";

function Gallery() {
  const [canvases, setCanvases] = useState<CanvasItem[] | null>(null);
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
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
      <h1>我的画布</h1>
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
          aria-label="新画布名称"
          placeholder="给新画布起个名字"
          value={name}
          maxLength={60}
          required
          onChange={(event) => setName(event.target.value)}
        />
        <button className="primary" disabled={busy || !name.trim()}>
          新建画布
        </button>
      </form>
      {error && (
        <p className="error" role="alert">
          {error} <button onClick={load}>重试</button>
        </p>
      )}
      <div className="list-heading">
        <div>
          <h2>{canvases ? `${visible.total} 个画布` : "正在加载…"}</h2>
          <span className="muted">最近更新优先 · 每页 20 项</span>
        </div>
        <input
          aria-label="搜索画布"
          placeholder="搜索画布"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setPage(1);
          }}
        />
      </div>
      <div className="cards">
        {visible.items.map((canvas) => (
          <a className="card" key={canvas.id} href={`/?canvas=${canvas.id}`}>
            <span className="card-icon" aria-hidden>
              ▱
            </span>
            <strong>{canvas.name}</strong>
            <time>{new Date(canvas.updated).toLocaleString()}</time>
          </a>
        ))}
      </div>
      {canvases && visible.total === 0 && (
        <p className="empty">
          {query.trim()
            ? "没有找到匹配的画布。"
            : "创建第一个画布，或创建后导入已有的 .excalidraw 文件。"}
        </p>
      )}
      {visible.pages > 1 && (
        <nav className="pagination" aria-label="画布分页">
          <button
            disabled={visible.page <= 1}
            onClick={() => setPage(visible.page - 1)}
          >
            上一页
          </button>
          <span role="status" aria-live="polite">
            第 {visible.page} / {visible.pages} 页
          </span>
          <button
            disabled={visible.page >= visible.pages}
            onClick={() => setPage(visible.page + 1)}
          >
            下一页
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
}: {
  id: string;
  loaded: Awaited<ReturnType<typeof loadCanvas>>;
  clientId: string;
  ownerWindow: Window;
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
  const sceneReady = useRef<{ resolve: () => void; cancel: () => void } | null>(
    null,
  );
  const current = useRef<Canvas>(loaded.canvas);
  const library = useRef(loaded.canvas.libraryItems);
  const [name, setName] = useState(loaded.canvas.name);
  useEffect(() => {
    ownerWindow.document.title = `${name.trim() || current.current.name} | drawsrv`;
  }, [name, ownerWindow]);
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
            throw new SaveError(
              "服务端返回了无效的应用结果，请导出备份后刷新",
              true,
            );
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
                if (!container || !instance) throw Error("编辑器尚未就绪");
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
                    console.log(
                      "[drawsrv:sync] 同 ID 图片内容改变，仅重建编辑器图片缓存；保留视图，清空组件撤销栈",
                    );
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
                        reject(Error("编辑器重新初始化超时"));
                      }, 10000);
                      sceneReady.current = {
                        resolve: finish,
                        cancel: () => {
                          ownerWindow.clearTimeout(timer);
                          sceneReady.current = null;
                          reject(Error("编辑器已关闭"));
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
                      setName(next.canvas.name);
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
                      setName(next.canvas.name);
                    });
                  }
                } catch (error) {
                  console.log(
                    "[drawsrv:sync] 原地更新失败，保留页面供备份",
                    error,
                  );
                  throw new SaveError(
                    "无法原地更新画布，请导出备份后手动刷新。",
                    true,
                  );
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
        message: loaded.persisted
          ? "已落盘 · 历史已记录"
          : "已同步到服务器 · 等待落盘",
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
          console.log("[drawsrv:sync] 同步决策失败，保留本地内容", error);
          setConflict("无法确认同步状态，请导出备份后手动刷新。");
        });
      } catch {
        console.log("[drawsrv:events] 忽略无效的状态通知");
      }
    };
    for (const kind of ["state", "change", "persisted"]) {
      events.addEventListener(kind, receive);
    }
    events.onopen = () => {
      if (!active) {
        return;
      }
      console.log(
        disconnected
          ? "[drawsrv:events] 通知连接已恢复"
          : "[drawsrv:events] 通知连接已建立",
      );
      disconnected = false;
    };
    events.onerror = () => {
      if (active && !disconnected) {
        console.log("[drawsrv:events] 通知连接中断，正在重连");
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
  return (
    <div className="workspace" ref={node}>
      <header className="editor-header">
        <input
          aria-label="画布名称"
          value={name}
          maxLength={60}
          onChange={(event) => {
            const value = event.target.value;
            setName(value);
            if (value.trim()) {
              current.current = { ...current.current, name: value.trim() };
              queue();
            }
          }}
          onFocus={() => {
            editingName.current = true;
          }}
          onBlur={() => {
            editingName.current = false;
            setName(current.current.name);
            void save.resumeRemote();
          }}
        />
      </header>
      {conflict && (
        <div className="remote-update" role="status">
          <span>{conflict}</span>
          <button onClick={exportBackup}>导出备份</button>
          <button
            onClick={() =>
              node.current!.ownerDocument.defaultView?.location.reload()
            }
          >
            重新加载
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
          langCode="zh-CN"
        >
          <MainMenu>
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
              保存到服务器
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
        <h1>无法打开画布</h1>
        <p role="alert">{error}</p>
        <button onClick={() => setAttempt(attempt + 1)}>重试</button>{" "}
        <a href="/">返回列表</a>
      </main>
    );
  }
  return loaded ? (
    <Editor
      id={id}
      loaded={loaded}
      clientId={clientId}
      ownerWindow={root.ownerDocument.defaultView!}
    />
  ) : (
    <main className="gallery">正在加载画布…</main>
  );
}

const root = document.getElementById("root")!;
createRoot(root).render(<App root={root} />);
