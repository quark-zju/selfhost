import { locale } from "./locales/index.ts";
import type { AppState } from "@excalidraw/excalidraw/types";
// sessionStorage is scoped to this tab and canvas: separate clients can pan,
// zoom or change presentation settings without producing a shared revision.
export class LocalAppStateStore {
  private owner: Pick<Window, "sessionStorage" | "setTimeout" | "clearTimeout">;
  private key: string;
  private saved: string | null = null;
  private pending: string | null = null;
  private timer: number | undefined;
  private failed = false;
  constructor(
    id: string,
    owner: Pick<Window, "sessionStorage" | "setTimeout" | "clearTimeout">,
  ) {
    this.owner = owner;
    this.key = `drawsrv:appState:${id}`;
  }
  load(): Partial<AppState> {
    try {
      const raw = this.owner.sessionStorage.getItem(this.key);
      const state: unknown = raw === null ? null : JSON.parse(raw);
      if (state && typeof state === "object" && !Array.isArray(state)) {
        this.saved = raw;
        return state as Partial<AppState>;
      }
    } catch {
      // Storage may be unavailable or stale; the editor can use its defaults.
    }
    return {};
  }
  save(state: Partial<AppState>) {
    const serialized = JSON.stringify(state);
    if (serialized === this.pending) {
      return;
    }
    this.owner.clearTimeout(this.timer);
    this.timer = undefined;
    if (serialized === this.saved) {
      this.pending = null;
      return;
    }
    this.pending = serialized;
    this.timer = this.owner.setTimeout(() => this.flush(), 300);
  }
  flush() {
    this.owner.clearTimeout(this.timer);
    this.timer = undefined;
    if (this.pending === null) {
      return;
    }
    try {
      this.owner.sessionStorage.setItem(this.key, this.pending);
      this.saved = this.pending;
      this.pending = null;
      this.failed = false;
    } catch {
      if (!this.failed) {
        console.log(locale.Local.Unavailable);
      }
      this.failed = true;
    }
  }
  dispose() {
    this.flush();
  }
}
