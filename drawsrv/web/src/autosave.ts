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
export type SaveResult = {
  etag: string;
  persisted: boolean;
  revision: string;
  hash?: string;
  applied?: number[];
  dropped?: { index: number; reason: string }[];
};
export class SaveError extends Error {
  blocked: boolean;
  constructor(message: string, blocked = false) {
    super(message);
    this.blocked = blocked;
  }
}
type Mode = "auto" | "sync" | "persist";

// Coalesce same-turn edits and edits during a request, without a fixed wait.
// Uploads and explicit disk flushes share one queue and one version sequence.
export class Autosave {
  private pending: string | null = null;
  private inFlight: string | null = null;
  private saved: string;
  private etag: string;
  private persisted: boolean;
  private revisionID: string;
  private observedDurable: string | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private ready = false;
  private running: Promise<boolean> | null = null;
  private blocked = false;
  private send: (
    body: string,
    etag: string,
    baseline: string,
  ) => Promise<SaveResult>;
  private hashBody?: (body: string) => Promise<string>;
  private refresh?: () => void;
  private log: (decision: string, details?: unknown) => void = () => {};
  private remote: SaveResult | null = null;
  private remoteDirty = false;
  private reloading = false;
  private publish?: (etag: string) => Promise<SaveResult>;
  private notify: (state: SaveState) => void;
  private delay: number;

  constructor(
    saved: string,
    etag: string,
    send: (body: string, etag: string, baseline: string) => Promise<SaveResult>,
    notify: (state: SaveState) => void,
    delay = 0,
    disk?: {
      persisted: boolean;
      revision?: string;
      hash?: string;
      hashBody?: (body: string) => Promise<string>;
      refresh?: () => void;
      log?: (decision: string, details?: unknown) => void;
      publish: (etag: string) => Promise<SaveResult>;
    },
  ) {
    this.saved = saved;
    this.etag = etag;
    this.send = send;
    this.notify = notify;
    this.delay = delay;
    this.persisted = disk?.persisted ?? true;
    this.revisionID = disk?.revision ?? etag;
    this.publish = disk?.publish;
    this.hashBody = disk?.hashBody;
    this.refresh = disk?.refresh;
    this.log = disk?.log ?? (() => {});
    if (disk?.hash)
      this.remote = {
        etag,
        persisted: this.persisted,
        revision: this.revisionID,
        hash: disk.hash,
      };
  }
  get version() {
    return this.etag;
  }
  get revision() {
    return this.revisionID;
  }
  get dirty() {
    return this.pending !== null || this.inFlight !== null;
  }
  get needsPersistence() {
    return !this.persisted;
  }

  private recordRemote(state: SaveResult, event = false) {
    if (!state.hash) return;
    if (this.remote) {
      const [oldEpoch, oldSequence] = this.remote.revision.split("-");
      const [epoch, sequence] = state.revision.split("-");
      if (oldEpoch === epoch && Number(sequence) < Number(oldSequence)) return;
      if (oldEpoch !== epoch && !event) return;
      if (state.revision === this.remote.revision && this.remote.persisted)
        state = { ...state, persisted: true };
    }
    this.remote = state;
    this.remoteDirty = true;
  }
  async observeRemote(state: SaveResult, source = "") {
    this.recordRemote(state, true);
    this.observePersistence(state.etag, state.persisted, state.revision);
    this.log("SSE", {
      ...state,
      source,
      localDirty: this.dirty,
      blocked: this.blocked,
    });
    if (this.blocked || this.reloading) {
      this.log("保留本地冲突副本，忽略自动刷新");
      return;
    }
    if (this.running) {
      this.log("等待当前保存完成后比较 HASH");
      return;
    }
    this.log(this.dirty ? "本地有修改，先尝试保存" : "本地无修改，比较 HASH");
    await this.run("sync");
  }
  private async reconcile() {
    if (
      !this.hashBody ||
      !this.refresh ||
      !this.remoteDirty ||
      this.blocked ||
      this.reloading
    )
      return;
    while (this.remote && !this.dirty) {
      const remote = this.remote,
        baseline = this.saved;
      const localHash = await this.hashBody(baseline);
      if (this.dirty || this.blocked) {
        this.log("比较期间有新修改，延后刷新");
        return;
      }
      if (remote !== this.remote || baseline !== this.saved) continue;
      this.remoteDirty = false;
      const compatible = localHash === remote.hash;
      this.log("HASH 比较", { localHash, serverHash: remote.hash, compatible });
      if (compatible) {
        this.etag = remote.etag;
        this.revisionID = remote.revision;
        this.persisted = remote.persisted;
        this.log("有效内容一致，继续编辑");
      } else {
        this.reloading = true;
        this.log("本地无待保存修改，刷新到服务端状态");
        this.refresh();
      }
      return;
    }
  }
  observePersistence(etag: string, persisted: boolean, revision = etag) {
    if (persisted) {
      this.observedDurable = revision;
    }
    // A delayed status response must not label a newer local upload as durable.
    if (
      etag !== this.etag ||
      revision !== this.revisionID ||
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
      this.running = this.drain(mode)
        .catch((error) => {
          this.failure(error);
          return false;
        })
        .finally(() => {
          this.running = null;
        });
    }
    const result = await this.running;
    if (
      result &&
      this.hashBody &&
      this.refresh &&
      this.remoteDirty &&
      !this.dirty &&
      !this.blocked &&
      !this.reloading
    )
      return this.run("sync");
    // A one-shot SSE event may have arrived while the HTTP ACK was in flight.
    if (
      this.observedDurable === this.revisionID &&
      !this.persisted &&
      !this.dirty &&
      !this.blocked
    ) {
      this.persisted = true;
      this.report();
    }
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
          const result = await this.send(body, this.etag, this.saved);
          this.log("保存结果", {
            applied: result.applied?.length,
            dropped: result.dropped?.length,
            details: result.dropped,
            hash: result.hash,
          });
          this.recordRemote(result);
          if (result.dropped?.length) {
            this.pending ??= body;
            this.failure(
              new SaveError(
                `部分修改冲突：${result.applied?.length ?? 0} 项已应用，${result.dropped.length} 项未应用。请导出备份后手动刷新。`,
                true,
              ),
            );
            return false;
          }
          this.etag = result.etag;
          this.revisionID = result.revision;
          this.saved = body;
          this.persisted =
            result.persisted || this.observedDurable === result.revision;
        } catch (error) {
          this.pending ??= body;
          this.failure(error);
          return false;
        } finally {
          this.inFlight = null;
        }
      }
      await this.reconcile();
      if (this.reloading) return false;
      if (mode === "persist" && !this.persisted) {
        this.notify({ phase: "persisting", message: "正在落盘并记录历史…" });
        try {
          if (!this.publish) {
            throw new SaveError("无法请求落盘，请重试");
          }
          const result = await this.publish(this.etag);
          this.recordRemote(result);
          if (!result.persisted) {
            throw new SaveError("服务器尚未确认落盘，请重试");
          }
          this.etag = result.etag;
          this.revisionID = result.revision;
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
    await this.reconcile();
    if (this.reloading) return false;
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
