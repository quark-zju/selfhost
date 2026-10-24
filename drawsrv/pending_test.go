package main

import (
	"context"
	"encoding/json"
	"os"
	"strings"
	"sync"
	"testing"
	"time"
)

func bufferedStore(t *testing.T) *store {
	t.Helper()
	s := testStore(t)
	s.commitDelay = defaultCommitDelay
	return s
}
func changeName(body, name string) string { return strings.Replace(body, "我的画布", name, 1) }

func TestBufferedUpdatesAreVisibleWithoutWritingGit(t *testing.T) {
	s := bufferedStore(t)
	id, original, etag := createCanvas(t, s)
	path := "/api/canvases/" + id
	head := s.head
	gitPath := os.Getenv("PATH")
	t.Setenv("PATH", t.TempDir())
	for _, name := range []string{"first", "latest"} {
		w := request(s, "PUT", path, changeName(original, name), etag)
		if w.Code != 202 || w.Header().Get("X-Drawsrv-Persisted") != "false" {
			t.Fatalf("stage: %d %s", w.Code, w.Body.String())
		}
		etag = w.Header().Get("ETag")
	}
	w := request(s, "GET", path, "", "")
	if !strings.Contains(w.Body.String(), "latest") || w.Header().Get("ETag") != etag {
		t.Fatal("GET did not expose latest in-memory state")
	}
	w = request(s, "GET", path+"/status", "", "")
	if w.Code != 200 || !strings.Contains(w.Body.String(), `"persisted":false`) {
		t.Fatal("missing pending status")
	}
	w = request(s, "GET", "/api/canvases", "", "")
	if !strings.Contains(w.Body.String(), "latest") {
		t.Fatal("list did not expose draft name")
	}
	if s.head != head || len(s.pending) != 1 {
		t.Fatal("updates committed or accumulated extra versions")
	}
	t.Setenv("PATH", gitPath)
	if len(history(t, s, id)) != 1 {
		t.Fatal("buffered update appeared in Git history")
	}
	w = request(s, "POST", path+"/flush", `{}`, etag)
	if w.Code != 204 || w.Header().Get("ETag") != etag || w.Header().Get("X-Drawsrv-Persisted") != "true" {
		t.Fatalf("flush: %d %s", w.Code, w.Body.String())
	}
	if len(history(t, s, id)) != 2 || len(s.pending) != 0 || s.pendingBytes != 0 {
		t.Fatal("flush should commit only the latest snapshot")
	}
}

func TestIdleDeadlineResetsOnlyOnContentChanges(t *testing.T) {
	s := bufferedStore(t)
	id, original, etag := createCanvas(t, s)
	path := "/api/canvases/" + id
	w := request(s, "PUT", path, changeName(original, "one"), etag)
	first := s.pending[id].updated
	s.persistDue(first.Add(29 * time.Second))
	if len(history(t, s, id)) != 1 {
		t.Fatal("committed before 30 seconds idle")
	}
	w = request(s, "PUT", path, changeName(original, "two"), w.Header().Get("ETag"))
	second := s.pending[id].updated
	if !second.After(first) {
		t.Fatal("new content did not restart idle period")
	}
	w = request(s, "PUT", path, changeName(original, "two"), w.Header().Get("ETag"))
	if !s.pending[id].updated.Equal(second) {
		t.Fatal("duplicate content restarted idle deadline")
	}
	if _, err := s.persistDue(second.Add(30 * time.Second)); err != nil {
		t.Fatal(err)
	}
	if len(history(t, s, id)) != 2 || len(s.pending) != 0 {
		t.Fatal("idle snapshot was not committed")
	}
}

func TestConditionalWritesUseBufferedVersion(t *testing.T) {
	s := bufferedStore(t)
	id, original, etag := createCanvas(t, s)
	path := "/api/canvases/" + id
	var wg sync.WaitGroup
	codes := make(chan int, 2)
	for _, name := range []string{"one", "two"} {
		wg.Add(1)
		go func(name string) {
			defer wg.Done()
			codes <- request(s, "PUT", path, changeName(original, name), etag).Code
		}(name)
	}
	wg.Wait()
	close(codes)
	counts := map[int]int{}
	for code := range codes {
		counts[code]++
	}
	if counts[202] != 1 || counts[412] != 1 {
		t.Fatal(counts)
	}
	current := request(s, "GET", path, "", "")
	version := current.Header().Get("ETag")
	if w := request(s, "POST", path+"/flush", `{}`, etag); w.Code != 412 {
		t.Fatal("stale flush accepted")
	}
	if w := request(s, "POST", path+"/flush", `{}`, version); w.Code != 204 {
		t.Fatal(w.Code)
	}
	if w := request(s, "PUT", path, changeName(original, "after flush"), version); w.Code != 202 {
		t.Fatal("disk flush changed the live ETag")
	}
}

func TestPendingPressurePersistsOldestInsteadOfEvicting(t *testing.T) {
	s := bufferedStore(t)
	one, body, tag := createCanvas(t, s)
	two, _, otherTag := createCanvas(t, s)
	first := request(s, "PUT", "/api/canvases/"+one, changeName(body, "one"), tag)
	s.pendingBudget = len(s.pending[one].body)
	w := request(s, "PUT", "/api/canvases/"+two, changeName(body, "two"), otherTag)
	if first.Code != 202 || w.Code != 202 {
		t.Fatal(first.Code, w.Code)
	}
	if s.pending[one] != nil || s.pending[two] == nil || s.pendingBytes > s.pendingBudget {
		t.Fatal("pending budget exceeded or wrong snapshot persisted")
	}
	if len(history(t, s, one)) != 2 || len(history(t, s, two)) != 1 {
		t.Fatal("pressure did not persist oldest acknowledged content")
	}
}

func TestPendingFailureRetainsAcknowledgedSnapshotAndRejectsOverflow(t *testing.T) {
	s := bufferedStore(t)
	one, body, tag := createCanvas(t, s)
	two, _, otherTag := createCanvas(t, s)
	request(s, "PUT", "/api/canvases/"+one, changeName(body, "one"), tag)
	s.pendingBudget = len(s.pending[one].body)
	gitPath := os.Getenv("PATH")
	t.Setenv("PATH", t.TempDir())
	w := request(s, "PUT", "/api/canvases/"+two, changeName(body, "two"), otherTag)
	if w.Code != 500 || s.pending[one] == nil || s.pending[two] != nil {
		t.Fatal("pressure failure dropped acknowledged content or admitted overflow")
	}
	if s.pendingBytes > s.pendingBudget {
		t.Fatal("overflow exceeded memory budget")
	}
	if _, err := s.persistDue(time.Now().Add(time.Hour)); err == nil {
		t.Fatal("expected persistence failure")
	}
	if s.pending[one] == nil || s.pending[one].retryAfter.IsZero() {
		t.Fatal("failed persistence lost snapshot or retry deadline")
	}
	t.Setenv("PATH", gitPath)
	if err := s.flushPending(one); err != nil {
		t.Fatal(err)
	}
}

func TestOversizedDraftPersistsImmediatelyAndClearsOlderDraft(t *testing.T) {
	s := bufferedStore(t)
	id, body, tag := createCanvas(t, s)
	path := "/api/canvases/" + id
	w := request(s, "PUT", path, changeName(body, "small"), tag)
	s.pendingBudget = 1
	w = request(s, "PUT", path, changeName(body, "large"), w.Header().Get("ETag"))
	if w.Code != 204 || len(s.pending) != 0 || s.pendingBytes != 0 {
		t.Fatal("oversized draft was not durably stored")
	}
	if len(history(t, s, id)) != 2 {
		t.Fatal("older uncommitted draft was unnecessarily committed")
	}
}

func TestCloseFlushesPendingState(t *testing.T) {
	s := bufferedStore(t)
	id, body, tag := createCanvas(t, s)
	request(s, "PUT", "/api/canvases/"+id, changeName(body, "shutdown"), tag)
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
	restarted, err := openStore(s.dir, s.limit)
	if err != nil {
		t.Fatal(err)
	}
	defer restarted.Close()
	got, err := restarted.read(id)
	if err != nil || !strings.Contains(string(got), "shutdown") {
		t.Fatal("normal close lost acknowledged state")
	}
	if len(history(t, restarted, id)) != 2 {
		t.Fatal("close did not commit latest snapshot")
	}
}

func TestRestorePreservesBufferedVersionInHistory(t *testing.T) {
	s := bufferedStore(t)
	id, body, tag := createCanvas(t, s)
	path := "/api/canvases/" + id
	originalCommit := history(t, s, id)[0]["commit"]
	w := request(s, "PUT", path, changeName(body, "draft before restore"), tag)
	w = request(s, "POST", path+"/restore", `{"commit":"`+originalCommit+`"}`, w.Header().Get("ETag"))
	if w.Code != 204 || len(s.pending) != 0 {
		t.Fatalf("restore: %d %s", w.Code, w.Body.String())
	}
	entries := history(t, s, id)
	if len(entries) != 3 {
		t.Fatal("restore lost the acknowledged draft")
	}
	version, err := s.git("show", entries[1]["commit"]+":"+id+".json")
	if err != nil || !strings.Contains(string(version), "draft before restore") {
		t.Fatal("draft missing from history")
	}
}

func TestPendingEntryCountIsBounded(t *testing.T) {
	s := bufferedStore(t)
	_, body, _ := createCanvas(t, s)
	blob, err := s.writeBlob([]byte(body))
	if err != nil {
		t.Fatal(err)
	}
	next := storeState{Version: 1, Canvases: map[string]canvasMetadata{}}
	for i := 0; i <= maxPendingCanvases; i++ {
		id := strings.Repeat("0", 30) + string("0123456789abcdef"[i/16]) + string("0123456789abcdef"[i%16])
		next.Canvases[id] = canvasMetadata{Name: "我的画布", Updated: time.Now(), Blob: blob}
	}
	if err := s.publish(next, "canvas: test fixture"); err != nil {
		t.Fatal(err)
	}
	for id := range next.Canvases {
		var state snapshot
		json.Unmarshal([]byte(body), &state)
		state.Name = "updated"
		changed, _ := json.MarshalIndent(state, "", "  ")
		if _, err := s.stage(id, changed, []byte(body), state.Name, time.Now()); err != nil {
			t.Fatal(err)
		}
		if len(s.pending) > maxPendingCanvases {
			t.Fatal("unbounded pending entry count")
		}
	}
}

func TestPersistenceWorkerCommitsAfterIdle(t *testing.T) {
	s := bufferedStore(t)
	s.commitDelay = 20 * time.Millisecond
	id, body, tag := createCanvas(t, s)
	w := request(s, "PUT", "/api/canvases/"+id, changeName(body, "worker"), tag)
	if w.Code != 202 {
		t.Fatal(w.Code)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan struct{})
	go func() { defer close(done); s.runPersistence(ctx, t.Logf) }()
	defer func() { cancel(); <-done }()
	deadline := time.NewTimer(3 * time.Second)
	defer deadline.Stop()
	tick := time.NewTicker(10 * time.Millisecond)
	defer tick.Stop()
	for {
		s.mu.Lock()
		remaining := len(s.pending)
		s.mu.Unlock()
		if remaining == 0 {
			return
		}
		select {
		case <-deadline.C:
			t.Fatal("persistence worker did not commit")
		case <-tick.C:
		}
	}
}

func TestCloseReportsPendingPersistenceFailure(t *testing.T) {
	s := bufferedStore(t)
	id, body, tag := createCanvas(t, s)
	request(s, "PUT", "/api/canvases/"+id, changeName(body, "not durable"), tag)
	t.Setenv("PATH", t.TempDir())
	if err := s.Close(); err == nil {
		t.Fatal("close silently succeeded without persisting acknowledged data")
	}
	if s.pending[id] == nil {
		t.Fatal("failed flush incorrectly marked pending content durable")
	}
}
