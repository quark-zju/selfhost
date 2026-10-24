package main

import (
	"context"
	"errors"
	"strings"
	"time"
)

const defaultMaintenanceDelay = 10 * time.Minute
const maintenanceTimeout = 5 * time.Minute
const maintenanceBusyRetry = time.Minute
const maintenanceFailureRetry = 5 * time.Minute

// Called with store.mu held, or before the maintenance worker starts. Keep the
// first dirty time: later saves must not indefinitely postpone compaction.
func (s *store) markDirty() {
	if s.dirtySince.IsZero() {
		s.dirtySince = time.Now()
	}
	select {
	case s.maintenanceRequests <- s.dirtySince:
	default:
	}
}

// The same mutex covers HTTP reads, writes and foreground GC. A busy request
// postpones GC; once admitted, no repository operation can race the repack.
func (s *store) maintain(ctx context.Context, delay time.Duration, now time.Time) (time.Duration, bool, error) {
	if err := ctx.Err(); err != nil {
		return 0, false, err
	}
	if !s.mu.TryLock() {
		return maintenanceBusyRetry, false, nil
	}
	defer s.mu.Unlock()
	if s.failed || s.closed {
		return 0, false, errors.New("storage needs restart before maintenance")
	}
	if s.dirtySince.IsZero() {
		return 0, false, nil
	}
	due := s.dirtySince.Add(delay)
	if s.retryAfter.After(due) {
		due = s.retryAfter
	}
	if now.Before(due) {
		return due.Sub(now), false, nil
	}
	// Keep history and unreachable objects; GC packs storage without deleting
	// old canvas versions. Limit packing memory and forbid a detached worker.
	_, err := s.runGit(ctx, maintenanceTimeout, nil,
		"-c", "gc.autoDetach=false", "-c", "pack.windowMemory=8m",
		"-c", "pack.deltaCacheSize=8m", "gc", "--prune=never")
	if err != nil {
		s.retryAfter = time.Now().Add(maintenanceFailureRetry)
		return maintenanceFailureRetry, false, err
	}
	head, err := s.runGit(ctx, 20*time.Second, nil, "rev-parse", "--verify", "HEAD^{commit}")
	if ctx.Err() != nil {
		return 0, false, ctx.Err()
	}
	if err != nil || strings.TrimSpace(string(head)) != s.head {
		s.failed = true
		return 0, false, errors.New("cannot verify HEAD after maintenance; restart required")
	}
	s.dirtySince = time.Time{}
	s.retryAfter = time.Time{}
	return 0, true, nil
}

// No periodic wakeups when clean. One coalesced notification arms the timer;
// failures get a bounded retry delay rather than being retried on every save.
func (s *store) runMaintenance(ctx context.Context, delay time.Duration, logf func(string, ...any)) {
	if delay <= 0 {
		return
	}
	timer := time.NewTimer(delay)
	timer.Stop()
	defer timer.Stop()
	var tick <-chan time.Time
	for {
		select {
		case <-ctx.Done():
			return
		case dirtyAt := <-s.maintenanceRequests:
			// Arming a timer needs no store lock and can happen while the
			// request that first wrote Git objects is still completing.
			if tick == nil {
				timer.Reset(max(0, time.Until(dirtyAt.Add(delay))))
				tick = timer.C
			}
			continue
		case <-tick:
		}
		next, ran, err := s.maintain(ctx, delay, time.Now())
		if ctx.Err() != nil {
			return
		}
		if err != nil {
			logf("Git maintenance failed: %v", err)
		} else if ran {
			logf("Git maintenance completed")
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
