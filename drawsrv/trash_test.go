package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestDeleteRetainsLatestDraftAndExpiresWithoutRewritingHistory(t *testing.T) {
	s := testStore(t)
	id, original, etag := createCanvas(t, s)
	other, _, _ := createCanvas(t, s)
	path := "/api/canvases/" + id
	s.commitDelay = time.Hour
	draft := strings.Replace(original, "我的画布", "latest draft", 1)
	w := request(s, "PUT", path, draft, etag)
	if w.Code != 202 {
		t.Fatalf("stage: %d %s", w.Code, w.Body.String())
	}
	w = request(s, "GET", path, "", "")
	draft = w.Body.String()
	if w = request(s, "DELETE", path, "", etag); w.Code != 412 {
		t.Fatalf("stale delete: %d", w.Code)
	}
	w = request(s, "GET", path, "", "")
	listener, err := s.events.subscribe(id)
	if err != nil {
		t.Fatal(err)
	}
	defer s.events.unsubscribe(id, listener)
	<-listener
	if w = request(s, "DELETE", path, "", w.Header().Get("ETag")); w.Code != 204 {
		t.Fatalf("delete: %d %s", w.Code, w.Body.String())
	}
	if frame := <-listener; frame.kind != "deleted" {
		t.Fatal(frame)
	}
	if s.pendingBytes != 0 || len(s.pending) != 0 || len(s.state.Trash) != 1 {
		t.Fatal("draft not moved to trash")
	}
	for _, method := range []string{"GET", "PUT", "DELETE"} {
		if w := request(s, method, path, original, etag); w.Code != 404 {
			t.Fatalf("deleted canvas %s: %d", method, w.Code)
		}
	}
	if w := request(s, "GET", "/api/canvases", "", ""); strings.Contains(w.Body.String(), id) {
		t.Fatal("deleted canvas listed")
	}
	var name string
	for key := range s.state.Trash {
		name = key
	}
	deleted, err := trashDeletedAt(name)
	if err != nil {
		t.Fatal(err)
	}
	deletionCommit := s.head
	archived, err := s.git("show", deletionCommit+":trash/"+name)
	if err != nil || string(archived) != draft {
		t.Fatalf("latest draft not archived: %s %v", archived, err)
	}
	if err := s.cleanTrash(deleted.Add(trashRetention - time.Nanosecond)); err != nil || s.head != deletionCommit {
		t.Fatal("expired too early", err)
	}
	// An unrelated save must preserve the trash manifest and subtree.
	createCanvas(t, s)
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
	restarted, err := openStore(s.dir, s.limit)
	if err != nil {
		t.Fatal(err)
	}
	defer restarted.Close()
	if len(restarted.state.Trash) != 1 {
		t.Fatal("trash lost on restart")
	}
	if err := restarted.cleanTrash(deleted.Add(trashRetention)); err != nil {
		t.Fatal(err)
	}
	if len(restarted.state.Trash) != 0 {
		t.Fatal("trash not expired")
	}
	if _, err := restarted.git("show", "HEAD:trash/"+name); err == nil {
		t.Fatal("expired entry still in HEAD")
	}
	if body, err := restarted.git("show", deletionCommit+":trash/"+name); err != nil || string(body) != draft {
		t.Fatal("history changed", err)
	}
	if w := request(restarted, "GET", "/api/canvases/"+other, "", ""); w.Code != 200 {
		t.Fatal("cleanup affected active canvas")
	}
	if err := restarted.loadState(); err != nil {
		t.Fatal("cleaned tree invalid", err)
	}
}

func TestFailedDeletePreservesLiveDraft(t *testing.T) {
	s := testStore(t)
	id, original, etag := createCanvas(t, s)
	s.commitDelay = time.Hour
	path := "/api/canvases/" + id
	request(s, "PUT", path, strings.Replace(original, "我的画布", "draft", 1), etag)
	w := request(s, "GET", path, "", "")
	before, draft, size := s.head, w.Body.String(), s.pendingBytes
	lock := filepath.Join(s.dir, "refs", "heads", "main.lock")
	if err := os.WriteFile(lock, []byte("test"), 0600); err != nil {
		t.Fatal(err)
	}
	defer os.Remove(lock)
	if w := request(s, "DELETE", path, "", w.Header().Get("ETag")); w.Code != 500 {
		t.Fatalf("expected failure: %d", w.Code)
	}
	body, err := s.read(id)
	if err != nil || string(body) != draft || s.head != before || len(s.state.Trash) != 0 || s.pendingBytes != size {
		t.Fatal("failed delete changed live state")
	}
}

func TestFailedTrashExpiryKeepsPublishedManifest(t *testing.T) {
	s := testStore(t)
	id, body, _ := createCanvas(t, s)
	deleted := time.Now().UTC().Add(-trashRetention)
	if err := s.trashCanvas(id, []byte(body), deleted); err != nil {
		t.Fatal(err)
	}
	before := s.head
	lock := filepath.Join(s.dir, "refs", "heads", "main.lock")
	if err := os.WriteFile(lock, []byte("test"), 0600); err != nil {
		t.Fatal(err)
	}
	defer os.Remove(lock)
	if err := s.cleanTrash(time.Now()); err == nil {
		t.Fatal("expected publication failure")
	}
	if s.head != before || len(s.state.Trash) != 1 {
		t.Fatal("failed expiry changed published state")
	}
}
