export type SaveState = {
  phase:
    | "saved"
    | "synced"
    | "pending"
    | "saving"
    | "persisting"
    | "error"
    | "conflict";
  message: string;
};
export type SaveResult = { etag: string; persisted: boolean };
export class SaveError extends Error {
  blocked: boolean;
  constructor(message: string, blocked = false) {
    super(message);
    this.blocked = blocked;
  }
}
type Mode = "auto" | "sync" | "persist";

// Coalesce uploads every two seconds, including during continuous editing.
// Uploads and explicit disk flushes share one queue and one version sequence.
export class Autosave {
  private pending: string | null = null;
  private inFlight: string | null = null;
  private saved: string;
  private etag: string;
  private persisted: boolean;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private ready = false;
  private running: Promise<boolean> | null = null;
  private blocked = false;
  private send: (body: string, etag: string) => Promise<SaveResult>;
  private publish?: (etag: string) => Promise<SaveResult>;
  private notify: (state: SaveState) => void;
  private delay: number;

  constructor(
    saved: string,
    etag: string,
    send: (body: string, etag: string) => Promise<SaveResult>,
    notify: (state: SaveState) => void,
    delay = 2000,
    disk?: {
      persisted: boolean;
      publish: (etag: string) => Promise<SaveResult>;
    },
  ) {
    this.saved = saved;
    this.etag = etag;
    this.send = send;
    this.notify = notify;
    this.delay = delay;
    this.persisted = disk?.persisted ?? true;
    this.publish = disk?.publish;
  }
  get version() {
    return this.etag;
  }
  get dirty() {
    return this.pending !== null || this.inFlight !== null;
  }
  get needsPersistence() {
    return !this.persisted;
  }

  observePersistence(etag: string, persisted: boolean) {
    // A delayed status response must not label a newer local upload as durable.
    if (
      etag !== this.etag ||
      this.running ||
      this.dirty ||
      this.blocked ||
      this.persisted === persisted
    ) {
      return;
    }
    this.persisted = persisted;
    this.report();
  }
  queue(body: string) {
    if (
      this.blocked ||
      body === this.pending ||
      (!this.inFlight && body === this.saved && this.pending === null)
    ) {
      return;
    }
    this.pending = body;
    this.notify({ phase: "pending", message: "等待同步…" });
    // Do not restart this timer on every edit: continuous drawing must upload.
    if (this.timer === undefined && !this.ready) {
      this.timer = setTimeout(() => {
        this.timer = undefined;
        this.ready = true;
        void this.run("auto");
      }, this.delay);
    }
  }
  async sync(): Promise<boolean> {
    return this.run("sync");
  }
  async flush(): Promise<boolean> {
    return this.run("persist");
  }

  private async run(mode: Mode): Promise<boolean> {
    const force = mode !== "auto";
    if (force) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (!this.running) {
      if (this.blocked) {
        return false;
      }
      this.running = this.drain(mode).finally(() => {
        this.running = null;
      });
    }
    const result = await this.running;
    return result &&
      ((this.pending !== null && (force || this.ready)) ||
        (mode === "persist" && !this.persisted))
      ? this.run(mode)
      : result;
  }

  private async drain(mode: Mode): Promise<boolean> {
    const force = mode !== "auto";
    do {
      while (this.pending !== null && (force || this.ready)) {
        const body = this.pending;
        this.pending = null;
        this.ready = false;
        if (body === this.saved) {
          continue;
        }
        this.notify({ phase: "saving", message: "正在同步到服务器…" });
        this.inFlight = body;
        try {
          const result = await this.send(body, this.etag);
          this.etag = result.etag;
          this.saved = body;
          this.persisted = result.persisted;
        } catch (error) {
          this.pending ??= body;
          this.failure(error);
          return false;
        } finally {
          this.inFlight = null;
        }
      }
      if (mode === "persist" && !this.persisted) {
        this.notify({ phase: "persisting", message: "正在落盘并记录历史…" });
        try {
          if (!this.publish) {
            throw new SaveError("无法请求落盘，请重试");
          }
          const result = await this.publish(this.etag);
          if (!result.persisted) {
            throw new SaveError("服务器尚未确认落盘，请重试");
          }
          this.etag = result.etag;
          this.persisted = true;
        } catch (error) {
          // The upload was acknowledged. Retry disk flush, not the same upload.
          this.failure(error);
          return false;
        }
      }
    } while (force && this.pending !== null);
    if (this.pending === null) {
      this.ready = false;
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.report();
    return true;
  }
  private failure(error: unknown) {
    this.blocked = error instanceof SaveError && error.blocked;
    this.notify({
      phase: this.blocked ? "conflict" : "error",
      message: error instanceof Error ? error.message : "保存失败，请重试",
    });
  }
  private report() {
    this.notify(
      this.pending !== null
        ? { phase: "pending", message: "等待同步…" }
        : this.persisted
          ? { phase: "saved", message: "已落盘 · 历史已记录" }
          : { phase: "synced", message: "已同步到服务器 · 等待落盘" },
    );
  }
  dispose() {
    clearTimeout(this.timer);
  }
}
