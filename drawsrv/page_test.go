package main

import (
	"encoding/json"
	"html"
	"net/http/httptest"
	"regexp"
	"strings"
	"testing"
	"testing/fstest"
)

func TestCanvasPageTitleAndValidation(t *testing.T) {
	s := testStore(t)
	id, _, _ := createCanvas(t, s)
	name := `标题 "<& </script><script>alert(1)</script>`
	s.pending[id] = &pendingCanvas{name: name}
	page := `<meta name="drawsrv-canvas" content="" /><title>我的画布 | drawsrv</title><div id="root"><!--drawsrv-initial--></div>`
	handler := newHandler(s, fstest.MapFS{"index.html": {Data: []byte(page)}})
	get := func(etag string) *httptest.ResponseRecorder {
		req := httptest.NewRequest("GET", "/?canvas="+id, nil)
		req.Header.Set("If-None-Match", etag)
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, req)
		return w
	}
	w := get("")
	if w.Code != 200 || w.Header().Get("Cache-Control") != "no-cache" {
		t.Fatalf("response: %d %v", w.Code, w.Header())
	}
	body := w.Body.String()
	if strings.Contains(body, "<script>") || !strings.Contains(body, `view-transition-name:canvas-title-`+id) || !strings.Contains(body, `value="`+html.EscapeString(name)+`"`) {
		t.Fatal(body)
	}
	match := regexp.MustCompile(`<meta name="drawsrv-canvas" content="([^"]*)"`).FindStringSubmatch(body)
	var hint struct{ ID, Name string }
	if len(match) != 2 || json.Unmarshal([]byte(html.UnescapeString(match[1])), &hint) != nil || hint.ID != id || hint.Name != name {
		t.Fatalf("metadata: %#v %v", hint, match)
	}
	etag := w.Header().Get("ETag")
	if etag == "" || get(etag).Code != 304 {
		t.Fatal("missing conditional validation")
	}
	s.pending[id].name = "更新后的名称"
	if next := get(etag); next.Code != 200 || next.Header().Get("ETag") == etag {
		t.Fatal("stale title cached")
	}
	delete(s.pending, id)
}
