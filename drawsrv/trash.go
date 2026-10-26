package main

import (
	"context"
	"errors"
	"time"
)

const trashRetention = 30 * 24 * time.Hour

// Clone both manifests before publication; a failed write must leave all live
// metadata and acknowledged pending content intact. Caller holds store.mu.
func (s *store) copyState() storeState {
	next := storeState{Version: s.state.Version, Canvases: make(map[string]canvasMetadata, len(s.state.Canvases)), Trash: make(map[string]trashMetadata, len(s.state.Trash))}
	for id, meta := range s.state.Canvases {
		next.Canvases[id] = meta
	}
	for name, meta := range s.state.Trash {
		next.Trash[name] = meta
	}
	return next
}

func (s *store) trashCanvas(id string, body []byte, now time.Time) error {
	meta, ok := s.state.Canvases[id]
	if !ok {
		return errCanvasNotFound
	}
	// Save the latest acknowledged draft directly into trash in the same commit.
	if pending := s.pending[id]; pending != nil {
		blob, err := s.writeBlob(body)
		if err != nil {
			return err
		}
		meta = canvasMetadata{Name: pending.name, Updated: pending.updated.UTC(), Blob: blob}
	}
	next := s.copyState()
	delete(next.Canvases, id)
	next.Trash[id] = trashMetadata{canvasMetadata: meta, DeletedAt: now.UTC()}
	if err := s.publish(next, "canvas: trash "+id); err != nil {
		return err
	}
	s.removePending(id)
	s.events.publish(id, "deleted", revision(body), true, "", contentHash(body))
	return nil
}

// Restore the original ID on the same linear history, without overwriting an
// active canvas. Expired entries cannot be revived between cleanup checks.
func (s *store) restoreTrash(id string, now time.Time) (string, error) {
	meta, ok := s.state.Trash[id]
	if !ok || !now.Before(meta.DeletedAt.Add(trashRetention)) {
		return "", errCanvasNotFound
	}
	if _, exists := s.state.Canvases[id]; exists {
		return "", errCanvasExists
	}
	body, err := s.readBlob(meta.Blob)
	if err != nil {
		return "", err
	}
	next := s.copyState()
	delete(next.Trash, id)
	meta.Updated = now.UTC()
	next.Canvases[id] = meta.canvasMetadata
	if err := s.publish(next, "canvas: restore from trash "+id); err != nil {
		return "", err
	}
	s.notifyChange(id, body, true, "")
	return id, nil
}

var errCanvasExists = errors.New("canvas already exists")

func (s *store) cleanTrash(now time.Time) error {
	if !s.mu.TryLock() {
		return nil
	} // Retry on the next scheduled check.
	defer s.mu.Unlock()
	if s.closed || s.failed {
		return nil
	}
	var next *storeState
	for name, meta := range s.state.Trash {
		if now.Before(meta.DeletedAt.Add(trashRetention)) {
			continue
		}
		if next == nil {
			state := s.copyState()
			next = &state
		}
		delete(next.Trash, name)
	}
	if next == nil {
		return nil
	}
	return s.publish(*next, "canvas: expire trash after 30 days")
}

// Independent of optional Git compaction, including an immediate restart check.
func (s *store) runTrashCleanup(ctx context.Context, logf func(string, ...any)) {
	ticker := time.NewTicker(time.Hour)
	defer ticker.Stop()
	for {
		if ctx.Err() != nil {
			return
		}
		if err := s.cleanTrash(time.Now()); err != nil {
			logf("Trash cleanup failed: %v", err)
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}
