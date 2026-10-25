// Language-neutral contract: every locale implements every field directly.
export interface Locale {
  Common: {
    RequestFailed: string;
    Retry: string;
    Loading: string;
  };
  Gallery: {
    Title: string;
    NewCanvasName: string;
    NewCanvasPlaceholder: string;
    CreateCanvas: string;
    SortHint: string;
    Search: string;
    ListLabel: string;
    NoMatches: string;
    Empty: string;
    PaginationLabel: string;
    Previous: string;
    Next: string;
    Count: (count: number) => string;
    Page: (page: number, pages: number) => string;
  };
  Editor: {
    Name: string;
    InvalidName: string;
    ExportBackup: string;
    Reload: string;
    Rename: string;
    SaveToServer: string;
    OpenFailed: string;
    BackToList: string;
    Loading: string;
  };
  Errors: {
    RemoteChanged: string;
    TooLarge: string;
    Auth: string;
    RetryOrBackup: string;
    MissingVersion: string;
    MissingSaveStatus: string;
    InvalidHash: string;
    MissingRevision: string;
    InvalidChangeResult: string;
    NotReady: string;
    ReinitializeTimeout: string;
    Closed: string;
    ApplyFailed: string;
    SyncStateFailed: string;
    SnapshotHashMismatch: string;
    RequestFailed: (status: number, hint: string) => string;
  };
  Save: {
    Pending: string;
    Saving: string;
    Persisting: string;
    FlushUnavailable: string;
    FlushUnconfirmed: string;
    Failed: string;
    Saved: string;
    Synced: string;
    Conflict: (applied: number, dropped: number) => string;
  };
  Sync: {
    ConflictPreserved: string;
    WaitForSave: string;
    SavePendingFirst: string;
    CompareWithoutEdits: string;
    InteractionDeferred: string;
    EditsDuringComparison: string;
    CompareHashes: string;
    ContentMatches: string;
    FetchSnapshot: string;
    DiscardSnapshot: string;
    StaleSnapshot: string;
    EditingDuringFetch: string;
    SnapshotApplied: string;
    SaveResult: string;
    ImageCacheChanged: string;
    ApplyFailed: string;
    DecisionFailed: string;
  };
  Local: {
    Unavailable: string;
  };
  Events: {
    InvalidStatus: string;
    Restored: string;
    Connected: string;
    Disconnected: string;
  };
}
