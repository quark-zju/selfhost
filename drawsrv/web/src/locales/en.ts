import type { Locale } from "./types.ts";

const locale: Locale = {
  Common: {
    RequestFailed: "Request failed",
    Retry: "Retry",
    Loading: "Loading…",
  },
  Gallery: {
    Title: "My canvases",
    NewCanvasName: "New canvas name",
    NewCanvasPlaceholder: "Name your new canvas",
    CreateCanvas: "New canvas",
    Trash: "Trash",
    TrashHint: "Recently deleted first · Kept for 30 days",
    TrashEmpty: "Trash is empty.",
    DeleteHint:
      "Hold for 2 seconds to move to trash for 30 days; release to cancel",
    RestoreHint: "Restore to My canvases",
    RestoreLabel: (name) => `Restore canvas “${name}”`,
    DeleteChanged:
      "The canvas just changed in another page and was not deleted. Please try again.",
    DeleteLabel: (name) => `Delete canvas “${name}”`,
    SortHint: "Recently updated first · 20 per page",
    Search: "Search canvases",
    ListLabel: "Canvas list",
    NoMatches: "No matching canvases.",
    Empty:
      "Create your first canvas, then import an existing .excalidraw file if needed.",
    PaginationLabel: "Canvas pages",
    Previous: "Previous",
    Next: "Next",
    Count: (count) => (count === 1 ? "1 canvas" : `${count} canvases`),
    Page: (page, pages) => `Page ${page} of ${pages}`,
  },
  Editor: {
    Name: "Canvas name",
    InvalidName: "Canvas names must contain 1–60 characters",
    ExportBackup: "Export backup",
    Reload: "Reload",
    Rename: "Rename",
    SaveToServer: "Save to server",
    OpenFailed: "Unable to open canvas",
    BackToList: "Back to canvases",
    Loading: "Loading canvas…",
  },
  Errors: {
    RemoteChanged:
      "This canvas was changed in another tab. Export your current content before refreshing.",
    Deleted:
      "This canvas was deleted in another page. Sync has stopped. Export a backup to keep your local content.",
    TooLarge: "The canvas exceeds the server size limit",
    Auth: "Check your reverse proxy login",
    RetryOrBackup: "Retry or export a backup",
    MissingVersion:
      "The server did not return a version. Export your content before refreshing",
    MissingSaveStatus:
      "The server did not return a save status. Export your content before refreshing",
    InvalidHash:
      "The server did not return a valid content hash. Export a backup before refreshing",
    MissingRevision:
      "The server did not return a revision. Export your content before refreshing",
    InvalidChangeResult:
      "The server returned an invalid change result. Export a backup before refreshing",
    NotReady: "The editor is not ready",
    ReinitializeTimeout: "The editor took too long to reinitialize",
    Closed: "The editor was closed",
    ApplyFailed:
      "Unable to update the canvas in place. Export a backup before refreshing manually.",
    SyncStateFailed:
      "Unable to confirm the sync state. Export a backup before refreshing manually.",
    SnapshotHashMismatch:
      "The server snapshot hash does not match. Export a backup before refreshing manually.",
    RequestFailed: (status, hint) => `Request failed (${status}): ${hint}`,
  },
  Save: {
    Pending: "Waiting to sync…",
    Saving: "Syncing to server…",
    Persisting: "Saving to disk and recording history…",
    FlushUnavailable: "Unable to request a disk save. Please retry",
    FlushUnconfirmed:
      "The server has not confirmed the disk save. Please retry",
    Failed: "Save failed. Please retry",
    Saved: "Saved to disk · History recorded",
    Synced: "Synced to server · Waiting for disk save",
    Conflict: (applied, dropped) =>
      `Some changes conflict: ${applied} applied, ${dropped} dropped. Export a backup before refreshing manually.`,
  },
  Sync: {
    ConflictPreserved:
      "Keeping the local conflict copy; skipping automatic refresh",
    WaitForSave: "Waiting for the current save before comparing hashes",
    SavePendingFirst:
      "Local changes pending; saving within the upload window first",
    CompareWithoutEdits: "No local changes; comparing hashes",
    InteractionDeferred:
      "Editor interaction in progress; deferring the in-place update",
    EditsDuringComparison:
      "New edits arrived during comparison; deferring the update",
    CompareHashes: "Hash comparison",
    ContentMatches: "Effective content matches; continuing editing",
    FetchSnapshot:
      "No pending edits; fetching the latest snapshot for an in-place update",
    DiscardSnapshot:
      "New edits or disposal during fetch; discarding the snapshot",
    StaleSnapshot: "Snapshot is behind the SSE revision; fetching again",
    EditingDuringFetch:
      "Editing started during fetch; deferring the in-place update",
    SnapshotApplied: "Snapshot applied in place and save baseline updated",
    SaveResult: "Save result",
    ImageCacheChanged:
      "[drawsrv:sync] Image content changed under the same ID; rebuilding the editor image cache, preserving the view and clearing editor undo history",
    ApplyFailed:
      "[drawsrv:sync] In-place update failed; keeping the page for backup",
    DecisionFailed:
      "[drawsrv:sync] Sync decision failed; keeping local content",
  },
  Local: {
    Unavailable: "[drawsrv:local] Unable to store this tab’s appState",
  },
  Events: {
    InvalidStatus: "[drawsrv:events] Ignoring an invalid status event",
    Restored: "[drawsrv:events] Event connection restored",
    Connected: "[drawsrv:events] Event connection established",
    Disconnected: "[drawsrv:events] Event connection lost; reconnecting",
  },
};

export default locale;
