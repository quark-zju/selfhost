package main

import (
	"fmt"
	"strings"
	"testing"
)

func TestBlobCacheEvictsLeastRecentlyUsedWithinByteBudget(t *testing.T) {
	c := newBlobCache(6)
	c.add("one", []byte("111"))
	c.add("two", []byte("222"))
	if _, ok := c.get("one"); !ok {
		t.Fatal("missing cached entry")
	}
	c.add("three", []byte("333"))
	if _, ok := c.get("two"); ok {
		t.Fatal("least recently used entry survived eviction")
	}
	if _, ok := c.get("one"); !ok {
		t.Fatal("recently used entry evicted")
	}
	if c.used > 6 || len(c.entries) != 2 {
		t.Fatal("cache exceeded budget")
	}
	c.add("large", []byte("toolarge"))
	if c.used != 6 || len(c.entries) != 2 {
		t.Fatal("oversized blob changed cache")
	}
}
func TestBlobCacheBoundsEmptyEntriesAndOwnsBuffers(t *testing.T) {
	c := newBlobCache(1024)
	for i := 0; i < maxCacheEntries*2; i++ {
		c.add(fmt.Sprint(i), nil)
	}
	if len(c.entries) != maxCacheEntries {
		t.Fatal("unbounded tiny entries")
	}
	body := []byte("original")
	c.add("owned", body)
	body[0] = 'X'
	got, _ := c.get("owned")
	if string(got) != "original" {
		t.Fatal("cache retained mutable caller buffer")
	}
	off := newBlobCache(0)
	off.add("empty", nil)
	if _, ok := off.get("empty"); ok {
		t.Fatal("disabled cache retained data")
	}
}
func TestCanvasCacheUsesImmutableBlobIDsAndAvoidsGitReads(t *testing.T) {
	s := testStore(t)
	id, original, etag := createCanvas(t, s)
	oldBlob := s.state.Canvases[id].Blob
	changed := strings.Replace(original, "我的画布", "new version", 1)
	w := request(s, "PUT", "/api/canvases/"+id, changed, etag)
	if w.Code != 204 {
		t.Fatalf("save: %d %s", w.Code, w.Body.String())
	}
	newBlob := s.state.Canvases[id].Blob
	if oldBlob == newBlob {
		t.Fatal("blob ID did not change")
	}
	t.Setenv("PATH", t.TempDir())
	old, err := s.readBlob(oldBlob)
	if err != nil || string(old) != original {
		t.Fatalf("old cached blob: %s %v", old, err)
	}
	current, err := s.read(id)
	if err != nil || !strings.Contains(string(current), "new version") {
		t.Fatalf("new cached blob: %s %v", current, err)
	}
}
