package main

import (
	"bytes"
	"context"
	"errors"
	"sort"
	"time"
)

const defaultCommitDelay = 30 * time.Second
const defaultPendingBytes = 16 << 20
const maxPendingCanvases = 64
const persistenceRetry = 5 * time.Second

type pendingCanvas struct {
	body       []byte
	name       string
	updated    time.Time
	retryAfter time.Time
	source     string
}

// Pending snapshots are acknowledged data, not an evictable read cache. The
// caller holds store.mu. Memory pressure persists older entries before admitting
// another update; a failed flush never silently drops acknowledged content.
func (s *store) stage(id string, body, current []byte, name string, now time.Time, source string) (bool, error) {
	if bytes.Equal(body, current) {
		return s.pending[id] == nil, nil
	}
	if s.commitDelay == 0 || s.pendingBudget == 0 || len(body) > s.pendingBudget {
		if err := s.persistBody(id, body, now, "canvas: save"); err != nil {
			return false, err
		}
		s.removePending(id)
		s.notifyChange(id, body, true, source)
		return true, nil
	}
	oldBytes := 0
	extra := 1
	if old := s.pending[id]; old != nil {
		oldBytes = len(old.body)
		extra = 0
	}
	for s.pendingBytes-oldBytes+len(body) > s.pendingBudget || len(s.pending)+extra > maxPendingCanvases {
		oldest := ""
		for key, entry := range s.pending {
			if key != id && (oldest == "" || entry.updated.Before(s.pending[oldest].updated)) {
				oldest = key
			}
		}
		if oldest == "" {
			return false, errors.New("cannot free pending snapshot budget")
		}
		if err := s.flushPending(oldest); err != nil {
			return false, err
		}
	}
	// Own an exact-sized buffer rather than retaining spare HTTP/JSON capacity.
	owned := make([]byte, len(body))
	copy(owned, body)
	s.pending[id] = &pendingCanvas{body: owned, name: name, updated: now, source: source}
	s.pendingBytes += len(body) - oldBytes
	select {
	case s.pendingRequests <- struct{}{}:
	default:
	}
	s.notifyChange(id, body, false, source)
	return false, nil
}

func (s *store) persistBody(id string, body []byte, updated time.Time, message string) error {
	committed, err := s.readCommitted(id)
	if err != nil {
		return err
	}
	return s.saveAt(id, body, committed, message, updated)
}
func (s *store) removePending(id string) {
	if entry := s.pending[id]; entry != nil {
		s.pendingBytes -= len(entry.body)
		delete(s.pending, id)
	}
}
func (s *store) flushPending(id string) error {
	entry := s.pending[id]
	if entry == nil {
		return nil
	}
	if s.failed {
		return errors.New("cannot flush after uncertain Git publication; restart required")
	}
	if err := s.persistBody(id, entry.body, entry.updated, "canvas: save"); err != nil {
		return err
	}
	s.removePending(id)
	s.events.publish(id, "persisted", revision(entry.body), true, entry.source)
	return nil
}
func (s *store) flushAll() error {
	ids := make([]string, 0, len(s.pending))
	for id := range s.pending {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	for _, id := range ids {
		if err := s.flushPending(id); err != nil {
			return err
		}
	}
	return nil
}

// Schedule each canvas from its most recent content change, unlike maintenance
// (which uses the first dirty Git write). One timer and one notification slot
// cover the entire store; idle canvases don't retain individual goroutines.
func (s *store) persistDue(now time.Time) (time.Duration, error) {
	if !s.mu.TryLock() {
		return 100 * time.Millisecond, nil
	}
	defer s.mu.Unlock()
	if s.closed || s.failed {
		return 0, nil
	}
	var next time.Time
	var result error
	for id, entry := range s.pending {
		due := entry.updated.Add(s.commitDelay)
		if entry.retryAfter.After(due) {
			due = entry.retryAfter
		}
		if !now.Before(due) {
			if err := s.flushPending(id); err == nil {
				continue
			} else {
				result = errors.Join(result, err)
				if s.failed {
					return 0, result
				}
				entry.retryAfter = time.Now().Add(persistenceRetry)
				due = entry.retryAfter
			}
		}
		if next.IsZero() || due.Before(next) {
			next = due
		}
	}
	if next.IsZero() {
		return 0, result
	}
	return max(time.Millisecond, time.Until(next)), result
}
func (s *store) runPersistence(ctx context.Context, logf func(string, ...any)) {
	timer := time.NewTimer(time.Hour)
	timer.Stop()
	defer timer.Stop()
	var tick <-chan time.Time
	for {
		select {
		case <-ctx.Done():
			return
		case <-s.pendingRequests:
		case <-tick:
		}
		next, err := s.persistDue(time.Now())
		if err != nil {
			logf("Canvas persistence failed; pending snapshots retained: %v", err)
		}
		if next > 0 {
			timer.Reset(next)
			tick = timer.C
		} else {
			timer.Stop()
			tick = nil
		}
	}
}
