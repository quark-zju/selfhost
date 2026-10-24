package main

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"testing/fstest"
)

func testStore(t *testing.T) *store {
	t.Helper()
	s, err := openStore(t.TempDir(), 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	return s
}
func request(s *store, method, path, body, etag string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(method, path, strings.NewReader(body))
	r.Header.Set("Content-Type", "application/json")
	if etag != "" {
		r.Header.Set("If-Match", etag)
	}
	w := httptest.NewRecorder()
	s.serve(w, r)
	return w
}
func createCanvas(t *testing.T, s *store) (string, string, string) {
	t.Helper()
	w := request(s, "POST", "/api/canvases", `{"name":"我的画布"}`, "")
	if w.Code != 201 {
		t.Fatalf("create %d: %s", w.Code, w.Body.String())
	}
	var result struct {
		ID string `json:"id"`
	}
	json.Unmarshal(w.Body.Bytes(), &result)
	w = request(s, "GET", "/api/canvases/"+result.ID, "", "")
	if w.Code != 200 {
		t.Fatal(w.Code)
	}
	return result.ID, w.Body.String(), w.Header().Get("ETag")
}
func history(t *testing.T, s *store, id string) []map[string]string {
	t.Helper()
	w := request(s, "GET", "/api/canvases/"+id+"/history", "", "")
	if w.Code != 200 {
		t.Fatalf("history %d: %s", w.Code, w.Body.String())
	}
	var items []map[string]string
	if err := json.Unmarshal(w.Body.Bytes(), &items); err != nil {
		t.Fatal(err)
	}
	return items
}
func TestCanvasLifecycle(t *testing.T) {
	s := testStore(t)
	id, original, etag := createCanvas(t, s)
	other, _, _ := createCanvas(t, s)
	path := "/api/canvases/" + id
	var state snapshot
	json.Unmarshal([]byte(original), &state)
	state.Name = "重命名"
	state.Elements = []json.RawMessage{json.RawMessage(`{"id":"image1","type":"image","fileId":"asset"}`)}
	state.Files["asset"] = json.RawMessage(`{"id":"asset","dataURL":"data:image/png;base64,aGVsbG8="}`)
	state.LibraryItems = []json.RawMessage{json.RawMessage(`{"id":"library"}`)}
	body, _ := json.Marshal(state)
	w := request(s, "PUT", path, string(body), etag)
	if w.Code != 204 {
		t.Fatalf("save %d: %s", w.Code, w.Body.String())
	}
	updatedETag := w.Header().Get("ETag")
	if updatedETag == etag {
		t.Fatal("revision did not change")
	}
	w = request(s, "PUT", path, original, etag)
	if w.Code != 412 {
		t.Fatalf("stale write: %d", w.Code)
	}
	w = request(s, "PUT", path, string(body), updatedETag)
	if w.Code != 204 {
		t.Fatalf("no-op: %d", w.Code)
	}
	items := history(t, s, id)
	if len(items) != 2 {
		t.Fatalf("expected create + save, got %v", items)
	}
	w = request(s, "POST", path+"/restore", `{"commit":"`+items[1]["commit"]+`"}`, updatedETag)
	if w.Code != 204 {
		t.Fatalf("restore %d: %s", w.Code, w.Body.String())
	}
	if len(history(t, s, id)) != 3 {
		t.Fatal("restore must create a new commit")
	}
	w = request(s, "GET", path, "", "")
	if w.Body.String() != original {
		t.Fatal("restored content differs")
	}
	w = request(s, "GET", "/api/canvases/"+other, "", "")
	if !strings.Contains(w.Body.String(), "我的画布") {
		t.Fatal("other canvas modified")
	}
	w = request(s, "GET", "/api/canvases", "", "")
	if w.Code != 200 || !strings.Contains(w.Body.String(), other) {
		t.Fatal("canvas missing from list")
	}
	restarted, err := openStore(s.dir, s.limit)
	if err != nil {
		t.Fatal(err)
	}
	if err := restarted.recover(); err != nil {
		t.Fatal(err)
	}
	if len(history(t, restarted, id)) != 3 {
		t.Fatal("restart generated spurious commit")
	}
}

func TestFailedGitCommitRollsBack(t *testing.T) {
	s := testStore(t)
	id, original, etag := createCanvas(t, s)
	lock := filepath.Join(s.dir, ".git", "index.lock")
	if err := os.WriteFile(lock, []byte("test"), 0600); err != nil {
		t.Fatal(err)
	}
	body := strings.Replace(original, "我的画布", "changed", 1)
	w := request(s, "PUT", "/api/canvases/"+id, body, etag)
	if w.Code != 500 {
		t.Fatalf("expected Git failure, got %d", w.Code)
	}
	os.Remove(lock)
	restored, err := os.ReadFile(filepath.Join(s.dir, id+".json"))
	if err != nil || string(restored) != original {
		t.Fatal("failed save changed disk content")
	}
	// An index lock also prevents index rollback, so fail closed until restart.
	if !s.failed {
		t.Fatal("expected writes blocked after rollback failure")
	}
	restarted, err := openStore(s.dir, s.limit)
	if err != nil {
		t.Fatal(err)
	}
	if err := restarted.recover(); err != nil {
		t.Fatal(err)
	}
	if len(history(t, restarted, id)) != 1 {
		t.Fatal("failure created history")
	}
}

func TestRecoverInterruptedSave(t *testing.T) {
	s := testStore(t)
	id, original, _ := createCanvas(t, s)
	changed := strings.Replace(original, "我的画布", "recovered", 1)
	if err := atomicWrite(filepath.Join(s.dir, id+".json"), []byte(changed)); err != nil {
		t.Fatal(err)
	}
	if err := s.recover(); err != nil {
		t.Fatal(err)
	}
	if len(history(t, s, id)) != 2 {
		t.Fatal("interrupted save not committed")
	}
}

func TestRejectInvalidWrites(t *testing.T) {
	s := testStore(t)
	id, original, etag := createCanvas(t, s)
	path := "/api/canvases/" + id
	for _, tc := range []struct {
		method, path, body, tag string
		code                    int
	}{
		{"PUT", path, original, "", 412},
		{"PUT", path, `{}`, etag, 400},
		{"PUT", path, strings.Repeat("x", int(s.limit)+1), etag, 413},
		{"POST", path + "/restore", `{"commit":"--help"}`, etag, 400},
		{"GET", "/api/canvases/../../.git/config", "", "", 404},
		{"DELETE", path, "", etag, 405},
		{"POST", "/api/canvases", `{"name":" "}`, "", 400},
	} {
		w := request(s, tc.method, tc.path, tc.body, tc.tag)
		if w.Code != tc.code {
			t.Errorf("%s %s got %d want %d", tc.method, tc.path, w.Code, tc.code)
		}
	}
	r := httptest.NewRequest("PUT", path, strings.NewReader(original))
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("If-Match", etag)
	r.Header.Set("Origin", "https://attacker.example")
	w := httptest.NewRecorder()
	s.serve(w, r)
	if w.Code != 403 {
		t.Fatal("cross-origin write accepted")
	}
	r.Header.Del("Origin")
	r.Header.Set("Content-Type", "text/plain")
	w = httptest.NewRecorder()
	s.serve(w, r)
	if w.Code != 415 {
		t.Fatal("non-JSON write accepted")
	}
	if len(history(t, s, id)) != 1 {
		t.Fatal("invalid request changed history")
	}
}

func TestConcurrentWriters(t *testing.T) {
	s := testStore(t)
	id, original, etag := createCanvas(t, s)
	var wg sync.WaitGroup
	codes := make(chan int, 2)
	for _, name := range []string{"first", "second"} {
		wg.Add(1)
		go func(name string) {
			defer wg.Done()
			codes <- request(s, "PUT", "/api/canvases/"+id, strings.Replace(original, "我的画布", name, 1), etag).Code
		}(name)
	}
	wg.Wait()
	close(codes)
	results := map[int]int{}
	for code := range codes {
		results[code]++
	}
	if results[204] != 1 || results[412] != 1 {
		t.Fatal(results)
	}
}

func TestStaticAndAPIRouting(t *testing.T) {
	handler := newHandler(testStore(t), fstest.MapFS{"index.html": {Data: []byte("hello")}, ".git/config": {Data: []byte("secret")}})
	for _, tc := range []struct {
		path string
		code int
	}{{"/", 200}, {"/.git/config", 404}, {"/api/missing", 404}} {
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, httptest.NewRequest("GET", tc.path, nil))
		if w.Code != tc.code {
			t.Errorf("%s: %d", tc.path, w.Code)
		}
		if strings.Contains(w.Body.String(), "secret") {
			t.Fatal("exposed dotfile")
		}
	}
}

func TestListingReadsOnlyMetadata(t *testing.T) {
	// A limited reader ensures the large files field is never read.
	data := []byte(`{"name":"small","files":"` + strings.Repeat("x", 1<<20) + `"}`)
	name, err := readName(io.LimitReader(bytes.NewReader(data), 32))
	if err != nil || name != "small" {
		t.Fatalf("%s %v", name, err)
	}
}
func TestStoreRequiresOwnEmptyDirectory(t *testing.T) {
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "unrelated.txt"), []byte("keep"), 0600)
	if _, err := openStore(dir, 1<<20); err == nil {
		t.Fatal("accepted nonempty directory without own repository")
	}
}
