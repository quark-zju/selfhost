export type SaveState = {
  phase: "saved" | "pending" | "saving" | "error" | "conflict";
  message: string;
};
type Result = { etag: string };
export class SaveError extends Error {
  blocked: boolean;
  constructor(message: string, blocked = false) {
    super(message);
    this.blocked = blocked;
  }
}

// Latest snapshot wins within this tab. Requests are serialized; a failed
// conditional write blocks the queue instead of overwriting a newer remote edit.
export class Autosave {
  private pending: string | null = null;
  private inFlight: string | null = null;
  private saved: string;
  private etag: string;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private ready = false;
  private running: Promise<boolean> | null = null;
  private blocked = false;
  private send: (body: string, etag: string) => Promise<Result>;
  private notify: (state: SaveState) => void;
  private delay: number;

  constructor(
    saved: string,
    etag: string,
    send: (body: string, etag: string) => Promise<Result>,
    notify: (state: SaveState) => void,
    delay = 30000,
  ) {
    this.saved = saved;
    this.etag = etag;
    this.send = send;
    this.notify = notify;
    this.delay = delay;
  }
  get version() {
    return this.etag;
  }
  get dirty() {
    return this.pending !== null || this.inFlight !== null;
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
    this.ready = false;
    this.notify({ phase: "pending", message: "等待保存…" });
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.ready = true;
      void this.run(false);
    }, this.delay);
  }
  async flush(): Promise<boolean> {
    return this.run(true);
  }
  private async run(force: boolean): Promise<boolean> {
    if (force) {
      clearTimeout(this.timer);
    }
    if (this.running) {
      const result = await this.running;
      return result && this.pending !== null && (force || this.ready)
        ? this.run(force)
        : result;
    }
    if (this.blocked) {
      return false;
    }
    this.running = this.drain(force).finally(() => {
      this.running = null;
    });
    return this.running;
  }
  private async drain(force: boolean): Promise<boolean> {
    while (this.pending !== null && (force || this.ready)) {
      const body = this.pending;
      this.pending = null;
      this.ready = false;
      if (body === this.saved) {
        continue;
      }
      this.notify({ phase: "saving", message: "正在保存并记录历史…" });
      this.inFlight = body;
      try {
        const result = await this.send(body, this.etag);
        this.etag = result.etag;
        this.saved = body;
      } catch (error) {
        this.pending ??= body;
        this.blocked = error instanceof SaveError && error.blocked;
        this.notify({
          phase: this.blocked ? "conflict" : "error",
          message: error instanceof Error ? error.message : "保存失败，请重试",
        });
        return false;
      } finally {
        this.inFlight = null;
      }
    }
    this.notify(
      this.pending !== null
        ? { phase: "pending", message: "等待保存…" }
        : { phase: "saved", message: "已保存 · Git 历史已记录" },
    );
    return true;
  }
  // Unmount should only happen after a successful flush or explicit navigation.
  dispose() {
    clearTimeout(this.timer);
  }
}
