package main

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestMaintenanceWaitsFromFirstDirtyWriteAndPreservesHistory(t *testing.T) {
	s := testStore(t)
	id, original, _ := createCanvas(t, s)
	head := s.head
	now := time.Now()
	s.dirtySince = now
	next, ran, err := s.maintain(context.Background(), 10*time.Minute, now.Add(9*time.Minute))
	if err != nil || ran || next != time.Minute {
		t.Fatalf("early maintenance: %v %v %v", next, ran, err)
	}
	s.markDirty()
	if !s.dirtySince.Equal(now) {
		t.Fatal("later write postponed maintenance")
	}
	next, ran, err = s.maintain(context.Background(), 10*time.Minute, now.Add(10*time.Minute))
	if err != nil || !ran || next != 0 {
		t.Fatalf("due maintenance: %v %v %v", next, ran, err)
	}
	if s.head != head || !s.dirtySince.IsZero() {
		t.Fatal("maintenance changed HEAD or did not clear dirty state")
	}
	packs, err := filepath.Glob(filepath.Join(s.dir, "objects", "pack", "*.pack"))
	if err != nil || len(packs) == 0 {
		t.Fatal("maintenance did not pack objects")
	}
	s.cache = newBlobCache(0)
	got, err := s.read(id)
	if err != nil || string(got) != original {
		t.Fatalf("packed canvas: %s %v", got, err)
	}
	if len(history(t, s, id)) != 1 {
		t.Fatal("maintenance changed canvas history")
	}
	t.Setenv("PATH", t.TempDir())
	next, ran, err = s.maintain(context.Background(), time.Minute, now.Add(24*time.Hour))
	if err != nil || ran || next != 0 {
		t.Fatal("clean store tried to run maintenance")
	}
}

func TestMaintenancePostponesWhenStoreBusy(t *testing.T) {
	s := testStore(t)
	s.mu.Lock()
	next, ran, err := s.maintain(context.Background(), time.Minute, time.Now().Add(time.Hour))
	s.mu.Unlock()
	if err != nil || ran || next != maintenanceBusyRetry {
		t.Fatalf("busy: %v %v %v", next, ran, err)
	}
}

func TestMaintenanceFailureRetainsDirtyStateAndBacksOff(t *testing.T) {
	s := testStore(t)
	originalDirty := time.Now().Add(-time.Hour)
	s.dirtySince = originalDirty
	t.Setenv("PATH", t.TempDir())
	next, ran, err := s.maintain(context.Background(), time.Minute, time.Now())
	if err == nil || ran || next != maintenanceFailureRetry {
		t.Fatalf("expected failure: %v %v %v", next, ran, err)
	}
	if !s.dirtySince.Equal(originalDirty) || s.failed {
		t.Fatal("GC failure should retain pending maintenance without breaking the store")
	}
	s.markDirty()
	next, ran, err = s.maintain(context.Background(), time.Minute, time.Now())
	if err != nil || ran || next <= 0 {
		t.Fatal("new write bypassed maintenance backoff")
	}
}

func TestMaintenanceCancellationAndClosedStore(t *testing.T) {
	s := testStore(t)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, _, err := s.maintain(ctx, time.Minute, time.Now()); !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
	s.Close()
	if _, ran, err := s.maintain(context.Background(), time.Minute, time.Now()); err == nil || ran {
		t.Fatal("maintenance accepted closed store")
	}
}

func TestMaintenanceWorkerRearmsAfterAnotherWrite(t *testing.T) {
	s := testStore(t)
	createCanvas(t, s)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	logs := make(chan string, 4)
	go func() {
		defer close(done)
		s.runMaintenance(ctx, 20*time.Millisecond, func(format string, args ...any) { logs <- format })
	}()
	defer func() { cancel(); <-done }()
	wait := func() {
		t.Helper()
		select {
		case msg := <-logs:
			if msg != "Git maintenance completed" {
				t.Fatal(msg)
			}
		case <-time.After(5 * time.Second):
			t.Fatal("maintenance worker did not run")
		}
	}
	wait()
	s.mu.Lock()
	_, err := s.writeBlob([]byte("another immutable Git write"))
	s.mu.Unlock()
	if err != nil {
		t.Fatal(err)
	}
	wait()
	if _, err := os.Stat(filepath.Join(s.dir, "index")); !os.IsNotExist(err) {
		t.Fatal("GC created an index")
	}
}
