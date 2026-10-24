package main

import (
	"encoding/json"
	"strings"
	"testing"
)

func withAppState(t *testing.T, body, state string) string {
	t.Helper()
	var document map[string]json.RawMessage
	if err := json.Unmarshal([]byte(body), &document); err != nil {
		t.Fatal(err)
	}
	document["appState"] = json.RawMessage(state)
	result, err := json.Marshal(document)
	if err != nil {
		t.Fatal(err)
	}
	return string(result)
}

func TestAppStateOnlyChangesDoNotSaveOrNotify(t *testing.T) {
	s := bufferedStore(t)
	id, body, etag := createCanvas(t, s)
	path := "/api/canvases/" + id
	before := request(s, "GET", path, "", "")
	head := s.head
	ch, err := s.events.subscribe(id)
	if err != nil {
		t.Fatal(err)
	}
	defer s.events.unsubscribe(id, ch)
	<-ch // Subscription starts with the current state.
	for _, state := range []string{`{"scrollX":123,"zoom":{"value":2}}`, `{"viewBackgroundColor":"#000","gridModeEnabled":true}`} {
		w := sourceRequest(s, "PUT", path, withAppState(t, body, state), etag, "other-client")
		if w.Code != 204 || w.Header().Get("ETag") != etag || w.Header().Get("X-Drawsrv-Revision") != before.Header().Get("X-Drawsrv-Revision") {
			t.Fatal(w.Code, w.Header(), w.Body.String())
		}
		if s.head != head || len(s.pending) != 0 || len(ch) != 0 {
			t.Fatal("local settings changed shared state")
		}
	}
	// A real edit is buffered. Further camera changes must not reset its deadline.
	w := request(s, "PUT", path, withAppState(t, changeName(body, "edited"), `{"scrollX":1}`), etag)
	if w.Code != 202 {
		t.Fatal(w.Code, w.Body.String())
	}
	updated := s.pending[id].updated
	revision := w.Header().Get("X-Drawsrv-Revision")
	<-ch
	w = request(s, "PUT", path, withAppState(t, changeName(body, "edited"), `{"scrollX":2}`), w.Header().Get("ETag"))
	if w.Code != 202 || !s.pending[id].updated.Equal(updated) || len(ch) != 0 || w.Header().Get("X-Drawsrv-Revision") != revision {
		t.Fatal("local settings reset pending edit or notified clients")
	}
	if err := s.flushPending(id); err != nil {
		t.Fatal(err)
	}
	raw, err := s.git("show", "HEAD:"+id+".json")
	if err != nil {
		t.Fatal(err)
	}
	var saved map[string]json.RawMessage
	json.Unmarshal(raw, &saved)
	if _, ok := saved["appState"]; ok {
		t.Fatal("appState persisted in Git")
	}
}

func TestLegacyAppStateIsIgnoredWithoutRewritingHistory(t *testing.T) {
	s := testStore(t)
	id, body, _ := createCanvas(t, s)
	legacy := withAppState(t, changeName(body, "legacy"), `{"scrollX":999,"zoom":{"value":4},"viewBackgroundColor":"#000"}`)
	// Seed a pre-change Git snapshot without passing through the new PUT decoder.
	blob, err := s.writeBlob([]byte(legacy))
	if err != nil {
		t.Fatal(err)
	}
	next := storeState{Version: s.state.Version, Canvases: map[string]canvasMetadata{}}
	for id, meta := range s.state.Canvases {
		next.Canvases[id] = meta
	}
	meta := next.Canvases[id]
	meta.Blob = blob
	meta.Name = "legacy"
	next.Canvases[id] = meta
	if err := s.publish(next, "legacy fixture"); err != nil {
		t.Fatal(err)
	}
	legacyCommit := s.head
	path := "/api/canvases/" + id
	w := request(s, "GET", path, "", "")
	if w.Code != 200 {
		t.Fatal(w.Code)
	}
	state, err := decodeSnapshot([]byte(legacy))
	if err != nil {
		t.Fatal(err)
	}
	shared, _ := json.MarshalIndent(state, "", "  ")
	if w.Body.String() != string(shared) || s.head != legacyCommit {
		t.Fatal("legacy read must strip appState without changing Git")
	}
	etag := w.Header().Get("ETag")
	w = request(s, "PUT", path, legacy, etag)
	if w.Code != 204 || s.head != legacyCommit || w.Header().Get("ETag") != etag {
		t.Fatal("legacy appState caused a cleanup commit")
	}
	w = request(s, "PUT", path, strings.Replace(string(shared), "legacy", "newer", 1), etag)
	if w.Code != 204 {
		t.Fatal(w.Code, w.Body.String())
	}
	w = request(s, "POST", path+"/restore", `{"commit":"`+legacyCommit+`"}`, w.Header().Get("ETag"))
	if w.Code != 204 {
		t.Fatal(w.Code, w.Body.String())
	}
	restored, err := s.git("show", "HEAD:"+id+".json")
	if err != nil || string(restored) != string(shared) {
		t.Fatal("restore reapplied historical appState", err)
	}
	historical, err := s.git("show", legacyCommit+":"+id+".json")
	if err != nil || string(historical) != legacy {
		t.Fatal("old Git history was rewritten", err)
	}
}
