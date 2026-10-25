package main

import (
	"context"
	"errors"
	"strings"
	"time"
)

const trashRetention = 30 * 24 * time.Hour
const trashTimeFormat = "20060102T150405.000000000Z"

func trashDeletedAt(name string) (time.Time, error) {
	stamp, id, ok := strings.Cut(name, "_")
	if !ok || !strings.HasSuffix(id, ".json") || !canvasID.MatchString(strings.TrimSuffix(id, ".json")) {
		return time.Time{}, errors.New("invalid trash filename")
	}
	return time.Parse(trashTimeFormat, stamp)
}

// Clone both manifests before publication; a failed write must leave all live
// metadata and acknowledged pending content intact. Caller holds store.mu.
func (s *store) copyState() storeState {
	next := storeState{Version: s.state.Version, Canvases: make(map[string]canvasMetadata, len(s.state.Canvases)), Trash: make(map[string]canvasMetadata, len(s.state.Trash))}
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
	next.Trash[now.UTC().Format(trashTimeFormat)+"_"+id+".json"] = meta
	if err := s.publish(next, "canvas: trash "+id); err != nil {
		return err
	}
	s.removePending(id)
	s.events.publish(id, "deleted", revision(body), true, "", contentHash(body))
	return nil
}

func (s *store) cleanTrash(now time.Time) error {
	if !s.mu.TryLock() {
		return nil
	} // Retry on the next scheduled check.
	defer s.mu.Unlock()
	if s.closed || s.failed {
		return nil
	}
	var next *storeState
	for name := range s.state.Trash {
		deleted, err := trashDeletedAt(name)
		if err != nil {
			return err
		}
		if now.Before(deleted.Add(trashRetention)) {
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
