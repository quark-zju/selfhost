package main

import (
	"net/http/httptest"
	"testing"
	"testing/fstest"
)

func TestHashedAssetCaching(t *testing.T) {
	handler := newHandler(testStore(t), fstest.MapFS{
		"index.html":              {Data: []byte("homepage")},
		"assets/main-ABcd1234.js": {Data: []byte("script")},
		"favicon.svg":             {Data: []byte("icon")},
	})
	for _, tc := range []struct {
		path, cache string
		code        int
	}{
		{"/assets/main-ABcd1234.js", "public, max-age=31536000, immutable", 200},
		{"/assets/main-ABcd1234.js?x=1", "public, max-age=31536000, immutable", 200},
		{"/assets/missing-ABcd1234.js", "", 404},
		{"/favicon.svg", "no-cache", 200},
		{"/?canvas=invalid", "no-cache", 200},
	} {
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, httptest.NewRequest("GET", tc.path, nil))
		if w.Code != tc.code || w.Header().Get("Cache-Control") != tc.cache {
			t.Errorf("%s: %d %v", tc.path, w.Code, w.Header())
		}
	}
}
