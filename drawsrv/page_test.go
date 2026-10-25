package main

import (
	"html"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"
)

func TestCanvasPageTitleAndValidation(t *testing.T) {
	s := testStore(t)
	id, _, _ := createCanvas(t, s)
	name := `标题 "<& </script><script>alert(1)</script>`
	s.pending[id] = &pendingCanvas{name: name}
	page := `<title>我的画布 | drawsrv</title><!--drawsrv-header--><div id="root"></div>`
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
	if strings.Contains(body, "<script>") || !strings.Contains(body, `view-transition-name:canvas-title-`+id) || !strings.Contains(body, `>`+html.EscapeString(name)+`</h1>`) {
		t.Fatal(body)
	}
	if strings.Index(body, `id="canvas-title"`) > strings.Index(body, `id="root"`) {
		t.Fatal("title must stay outside the React root")
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
