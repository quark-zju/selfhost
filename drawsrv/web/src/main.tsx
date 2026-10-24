import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Excalidraw, MainMenu, serializeAsJSON } from "@excalidraw/excalidraw";
import type {
  ExcalidrawImperativeAPI,
  ExcalidrawProps,
  LibraryItems,
} from "@excalidraw/excalidraw/types";
import { Autosave, type SaveState } from "./autosave";
import {
  canvasURL,
  checked,
  loadCanvas,
  saveResult,
  type Canvas,
  type CanvasItem,
  type HistoryItem,
} from "./api";
import "@excalidraw/excalidraw/index.css";
import "./style.css";
import { LocalAppStateStore } from "./localAppState";

const message = (error: unknown) =>
  error instanceof Error ? error.message : "请求失败";

function Gallery() {
  const [canvases, setCanvases] = useState<CanvasItem[] | null>(null);
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState("");
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
        <h2>{canvases ? `${canvases.length} 个画布` : "正在加载…"}</h2>
        <input
          aria-label="搜索画布"
          placeholder="搜索画布"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>
      <div className="cards">
        {canvases
          ?.filter((canvas) =>
            canvas.name.toLowerCase().includes(query.toLowerCase()),
          )
          .map((canvas) => (
            <a className="card" key={canvas.id} href={`/?canvas=${canvas.id}`}>
              <span className="card-icon" aria-hidden>
                ▱
              </span>
              <strong>{canvas.name}</strong>
              <time>{new Date(canvas.updated).toLocaleString()}</time>
            </a>
          ))}
      </div>
      {canvases?.length === 0 && (
        <p className="empty">
          创建第一个画布，或创建后导入已有的 .excalidraw 文件。
        </p>
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
  const [initialScene] = useState(() => ({
    ...loaded.canvas,
    appState: localState.load(),
  }));
  const node = useRef<HTMLDivElement>(null);
  const api = useRef<ExcalidrawImperativeAPI | null>(null);
  const current = useRef<Canvas>(loaded.canvas);
  const library = useRef(loaded.canvas.libraryItems);
  const [name, setName] = useState(loaded.canvas.name);
  useEffect(() => {
    ownerWindow.document.title = `${name.trim() || current.current.name} | drawsrv`;
  }, [name, ownerWindow]);
  const lastSaveMessage = useRef<string | null>(null);
  const logSaveState = (state: SaveState) => {
    const entry = `[drawsrv:${state.phase}] ${state.message}`;
    if (entry !== lastSaveMessage.current) {
      console.log(entry);
      lastSaveMessage.current = entry;
    }
  };
  const [remoteUpdate, setRemoteUpdate] = useState(false);
  const [history, setHistory] = useState<HistoryItem[] | null>(null);
  const [historyError, setHistoryError] = useState("");
  const [restoring, setRestoring] = useState(false);
  const [restoreTarget, setRestoreTarget] = useState<string | null>(null);
  const [save] = useState(
    () =>
      new Autosave(
        JSON.stringify(loaded.canvas),
        loaded.etag,
        async (body, etag) => {
          const response = await checked(
            await fetch(canvasURL(id), {
              method: "PUT",
              headers: {
                "Content-Type": "application/json",
                "If-Match": etag,
                "X-Drawsrv-Client": clientId,
              },
              body,
            }),
          );
          setRemoteUpdate(false);
          return saveResult(response);
        },
        logSaveState,
        2000,
        {
          persisted: loaded.persisted,
          revision: loaded.revision,
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

  const queue = () => save.queue(JSON.stringify(current.current));
  const onChange: ExcalidrawProps["onChange"] = (elements, appState, files) => {
    if (appState.isLoading || restoring) {
      return;
    }
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
      elements: data.elements,
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
  };
  const onLibraryChange = (items: LibraryItems) => {
    library.current = items;
    current.current = { ...current.current, libraryItems: items };
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
          typeof data.revision !== "string" ||
          typeof data.persisted !== "boolean" ||
          typeof data.source !== "string"
        ) {
          return;
        }
        save.observePersistence(data.etag, data.persisted, data.revision);
        if (data.source === clientId) {
          setRemoteUpdate(false);
        } else if (data.revision !== save.revision) {
          console.log(
            "[drawsrv:remote] 其他客户端已更新此画布，可重新加载查看",
          );
          setRemoteUpdate(true);
        }
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
      [JSON.stringify({ ...data, libraryItems: library.current }, null, 2)],
      { type: "application/json" },
    );
    const url = ownerWindow.URL.createObjectURL(blob);
    const link = doc.createElement("a");
    link.href = url;
    link.download = `${current.current.name}.excalidraw`;
    link.click();
    ownerWindow.setTimeout(() => ownerWindow.URL.revokeObjectURL(url), 1000);
  };
  const showHistory = async () => {
    setHistoryError("");
    if (!(await save.flush())) {
      return;
    }
    try {
      const response = await checked(
        await fetch(`${canvasURL(id)}/history`, { cache: "no-store" }),
      );
      setHistory(await response.json());
    } catch (error) {
      setHistoryError(message(error));
    }
  };
  return (
    <div className="workspace" ref={node}>
      <header className="editor-header">
        <button
          onClick={async () => {
            if (await save.flush()) {
              node.current!.ownerDocument.defaultView?.location.assign("/");
            }
          }}
        >
          ← 画布
        </button>
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
          onBlur={() => setName(current.current.name)}
        />
        <button onClick={() => void save.flush()}>保存 / 重试</button>
        <button onClick={exportBackup}>导出备份</button>
        <button onClick={() => void showHistory()}>历史</button>
      </header>
      {remoteUpdate && (
        <div className="remote-update" role="status">
          <span>其他客户端已更新此画布，重新加载可查看最新内容。</span>
          <button
            onClick={() =>
              node.current!.ownerDocument.defaultView?.location.reload()
            }
          >
            重新加载
          </button>
        </div>
      )}
      {historyError && (
        <p className="error" role="alert">
          {historyError}
        </p>
      )}
      <div className="drawing" inert={restoring}>
        <Excalidraw
          initialData={initialScene}
          excalidrawAPI={(instance) => {
            api.current = instance;
          }}
          onChange={onChange}
          onLibraryChange={onLibraryChange}
          langCode="zh-CN"
        >
          <MainMenu>
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
      {history && (
        <aside className="history" aria-label="画布历史">
          <div className="list-heading">
            <h2>历史记录</h2>
            <button
              onClick={() => {
                setHistory(null);
                setRestoreTarget(null);
              }}
            >
              关闭
            </button>
          </div>
          <p className="muted">
            最近 100 次保存。恢复会创建新提交，保留原有历史。
          </p>
          {history.map((item, index) => (
            <div className="revision" key={item.commit}>
              <time>{new Date(item.date).toLocaleString()}</time>
              <code>{item.commit.slice(0, 8)}</code>
              {index === 0 ? (
                <span className="muted">最近落盘</span>
              ) : (
                <button
                  disabled={restoring}
                  onClick={() => setRestoreTarget(item.commit)}
                >
                  恢复此版本
                </button>
              )}
              {restoreTarget === item.commit && (
                <div className="restore-confirm">
                  <p>
                    将当前画布恢复到此版本？恢复前会先保存当前内容，原有历史会保留。
                  </p>
                  <button
                    disabled={restoring}
                    onClick={async () => {
                      setRestoring(true);
                      try {
                        if (!(await save.flush())) {
                          return;
                        }
                        await checked(
                          await fetch(`${canvasURL(id)}/restore`, {
                            method: "POST",
                            headers: {
                              "Content-Type": "application/json",
                              "If-Match": save.version,
                              "X-Drawsrv-Client": clientId,
                            },
                            body: JSON.stringify({ commit: item.commit }),
                          }),
                        );
                        node.current!.ownerDocument.defaultView?.location.reload();
                      } catch (error) {
                        setHistoryError(message(error));
                      } finally {
                        setRestoring(false);
                      }
                    }}
                  >
                    确认恢复
                  </button>
                  <button onClick={() => setRestoreTarget(null)}>取消</button>
                </div>
              )}
            </div>
          ))}
        </aside>
      )}
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
