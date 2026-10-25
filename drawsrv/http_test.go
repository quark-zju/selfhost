package main

import (
	"encoding/json"
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
	// Exercise the synchronous Git API in legacy storage tests; buffering has
	// its own tests with the production delay enabled.
	s.commitDelay = 0
	t.Cleanup(func() { s.Close() })
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
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
	restarted, err := openStore(s.dir, s.limit)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { restarted.Close() })
	if len(history(t, restarted, id)) != 3 {
		t.Fatal("restart generated spurious commit")
	}
}

func TestFailedGitPublicationLeavesHEADUnchanged(t *testing.T) {
	s := testStore(t)
	id, original, etag := createCanvas(t, s)
	before := s.head
	lock := filepath.Join(s.dir, "refs", "heads", "main.lock")
	if err := os.WriteFile(lock, []byte("test"), 0600); err != nil {
		t.Fatal(err)
	}
	body := strings.Replace(original, "我的画布", "changed", 1)
	w := request(s, "PUT", "/api/canvases/"+id, body, etag)
	if w.Code != 500 {
		t.Fatalf("expected publication failure, got %d: %s", w.Code, w.Body.String())
	}
	if err := os.Remove(lock); err != nil {
		t.Fatal(err)
	}
	head, err := s.git("rev-parse", "HEAD")
	if err != nil || strings.TrimSpace(string(head)) != before {
		t.Fatal("failed save changed HEAD")
	}
	if !s.failed {
		t.Fatal("writes must stop after uncertain publication")
	}
	s.Close()
	restarted, err := openStore(s.dir, s.limit)
	if err != nil {
		t.Fatal(err)
	}
	defer restarted.Close()
	restarted.commitDelay = 0
	w = request(restarted, "GET", "/api/canvases/"+id, "", "")
	if w.Code != 200 || w.Body.String() != original {
		t.Fatal("restart did not recover last published canvas")
	}
	if len(history(t, restarted, id)) != 1 {
		t.Fatal("unpublished commit appeared in history")
	}
	// Later saves build on HEAD, not the dangling objects from the failed save.
	if w = request(restarted, "PUT", "/api/canvases/"+id, body, etag); w.Code != 204 {
		t.Fatalf("retry %d: %s", w.Code, w.Body.String())
	}
	if len(history(t, restarted, id)) != 2 {
		t.Fatal("retry history is incorrect")
	}
}

func TestBareStoreHasNoWorkingCopyOrIndex(t *testing.T) {
	s := testStore(t)
	id, _, _ := createCanvas(t, s)
	bare, err := s.git("rev-parse", "--is-bare-repository")
	if err != nil || strings.TrimSpace(string(bare)) != "true" {
		t.Fatalf("not bare: %s %v", bare, err)
	}
	for _, name := range []string{".git", "index", id + ".json", statePath} {
		if _, err := os.Lstat(filepath.Join(s.dir, name)); !os.IsNotExist(err) {
			t.Fatalf("unexpected working file %s: %v", name, err)
		}
	}
	// The state and canvas still exist in the committed logical tree.
	tree, err := s.git("ls-tree", "--name-only", "HEAD")
	if err != nil || !strings.Contains(string(tree), id+".json") || !strings.Contains(string(tree), statePath) {
		t.Fatalf("tree: %s %v", tree, err)
	}
}

func TestUnpublishedObjectsAreIgnoredAfterRestart(t *testing.T) {
	s := testStore(t)
	id, original, _ := createCanvas(t, s)
	head := s.head
	if _, err := s.writeBlob([]byte(strings.Replace(original, "我的画布", "unpublished", 1))); err != nil {
		t.Fatal(err)
	}
	s.Close()
	restarted, err := openStore(s.dir, s.limit)
	if err != nil {
		t.Fatal(err)
	}
	defer restarted.Close()
	restarted.commitDelay = 0
	if restarted.head != head {
		t.Fatal("unpublished objects changed HEAD")
	}
	w := request(restarted, "GET", "/api/canvases/"+id, "", "")
	if w.Body.String() != original {
		t.Fatal("read unpublished data")
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
		{"PATCH", path, "", etag, 405},
		{"DELETE", path, "", "", 412},
		{"DELETE", path + "/history", "", etag, 405},
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

func TestListingUsesCommittedMetadata(t *testing.T) {
	s := testStore(t)
	id, _, _ := createCanvas(t, s)
	// Removing Git from PATH demonstrates that list never forks Git or reads
	// canvas blobs; only the committed lightweight manifest is needed.
	t.Setenv("PATH", t.TempDir())
	w := request(s, "GET", "/api/canvases", "", "")
	if w.Code != 200 || !strings.Contains(w.Body.String(), id) || !strings.Contains(w.Body.String(), "我的画布") {
		t.Fatalf("list: %d %s", w.Code, w.Body.String())
	}
}

func TestStoreRequiresOwnEmptyDirectory(t *testing.T) {
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "unrelated.txt"), []byte("keep"), 0600)
	if _, err := openStore(dir, 1<<20); err == nil {
		t.Fatal("accepted nonempty directory without own repository")
	}
}

func TestStoreRejectsWorkingCopyWithoutMigration(t *testing.T) {
	dir := t.TempDir()
	if err := os.Mkdir(filepath.Join(dir, ".git"), 0700); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, "old.json")
	if err := os.WriteFile(path, []byte("keep"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := openStore(dir, 1<<20); err == nil || !strings.Contains(err.Error(), "working copy") {
		t.Fatalf("expected working-copy rejection: %v", err)
	}
	if data, err := os.ReadFile(path); err != nil || string(data) != "keep" {
		t.Fatal("old data changed")
	}
	if _, err := os.Lstat(filepath.Join(dir, "HEAD")); !os.IsNotExist(err) {
		t.Fatal("unexpected bare initialization")
	}
}

func TestStoreLockPreventsSecondWriter(t *testing.T) {
	s := testStore(t)
	if other, err := openStore(s.dir, s.limit); err == nil {
		other.Close()
		t.Fatal("second writer accepted")
	}
}

func TestMissingHEADNeverReinitializesHistory(t *testing.T) {
	for _, remove := range []string{"HEAD", "refs/heads/main"} {
		t.Run(remove, func(t *testing.T) {
			s := testStore(t)
			createCanvas(t, s)
			s.Close()
			if err := os.Remove(filepath.Join(s.dir, filepath.FromSlash(remove))); err != nil {
				t.Fatal(err)
			}
			if other, err := openStore(s.dir, s.limit); err == nil {
				other.Close()
				t.Fatal("missing HEAD silently initialized new history")
			}
		})
	}
}

func TestGitEnvironmentCannotRedirectWrites(t *testing.T) {
	s := testStore(t)
	t.Setenv("GIT_DIR", t.TempDir())
	t.Setenv("GIT_WORK_TREE", t.TempDir())
	t.Setenv("GIT_INDEX_FILE", filepath.Join(t.TempDir(), "index"))
	t.Setenv("GIT_CONFIG_COUNT", "1")
	t.Setenv("GIT_CONFIG_KEY_0", "core.bare")
	t.Setenv("GIT_CONFIG_VALUE_0", "false")
	id, _, _ := createCanvas(t, s)
	if len(history(t, s, id)) != 1 {
		t.Fatal("Git environment affected repository")
	}
	if _, err := os.Stat(filepath.Join(s.dir, "index")); !os.IsNotExist(err) {
		t.Fatal("created index")
	}
}

func TestPublicationRejectsUnexpectedExternalHEAD(t *testing.T) {
	s := testStore(t)
	id, original, etag := createCanvas(t, s)
	// Simulate an unsupported external writer. CAS publication must fail rather
	// than overwrite the external branch with the service's stale cached tree.
	external, err := s.git("commit-tree", s.head+"^{tree}", "-p", s.head, "-m", "external writer")
	if err != nil {
		t.Fatal(err)
	}
	externalID := strings.TrimSpace(string(external))
	if _, err := s.git("update-ref", s.ref, externalID, s.head); err != nil {
		t.Fatal(err)
	}
	body := strings.Replace(original, "我的画布", "changed", 1)
	w := request(s, "PUT", "/api/canvases/"+id, body, etag)
	if w.Code != 500 || !s.failed {
		t.Fatal("stale service state accepted")
	}
	head, err := s.git("rev-parse", "HEAD")
	if err != nil || strings.TrimSpace(string(head)) != externalID {
		t.Fatal("overwrote external HEAD")
	}
}

func TestBareStoreSupportsSHA256Objects(t *testing.T) {
	dir := t.TempDir()
	initializer := &store{dir: dir}
	if _, err := initializer.git("init", "--bare", "--template=", "--initial-branch=main", "--object-format=sha256"); err != nil {
		t.Fatal(err)
	}
	s, err := openStore(dir, 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	id, _, _ := createCanvas(t, s)
	if len(s.head) != 64 || len(s.state.Canvases[id].Blob) != 64 {
		t.Fatal("SHA256 object IDs were not preserved")
	}
}

func TestStartupRejectsMismatchedCommittedIndex(t *testing.T) {
	s := testStore(t)
	id, _, _ := createCanvas(t, s)
	// Commit a malformed index/tree combination through the low-level publisher.
	next := s.state
	meta := next.Canvases[id]
	meta.Blob = strings.Repeat("0", 40)
	next.Canvases[id] = meta
	data, _ := json.Marshal(next)
	blob, err := s.writeBlob(data)
	if err != nil {
		t.Fatal(err)
	}
	// Replace just state.json while preserving the original canvas blob.
	canvasBlob, err := s.git("rev-parse", "HEAD:"+id+".json")
	if err != nil {
		t.Fatal(err)
	}
	tree, err := s.gitInput(strings.NewReader("100644 blob "+strings.TrimSpace(string(canvasBlob))+"\t"+id+".json\n100644 blob "+blob+"\tstate.json\n"), "mktree")
	if err != nil {
		t.Fatal(err)
	}
	commit, err := s.git("commit-tree", strings.TrimSpace(string(tree)), "-p", s.head, "-m", "invalid state")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.git("update-ref", s.ref, strings.TrimSpace(string(commit)), s.head); err != nil {
		t.Fatal(err)
	}
	s.Close()
	if other, err := openStore(s.dir, s.limit); err == nil {
		other.Close()
		t.Fatal("invalid committed index accepted")
	}
}
