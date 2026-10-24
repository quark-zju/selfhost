package main

import (
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"
)

func patchCanvas(t *testing.T, s *store, id string, changes string) (*httptest.ResponseRecorder, changeResult) {
	t.Helper()
	w := sourceRequest(s, "POST", "/api/canvases/"+id+"/changes", `{"changes":`+changes+`}`, "", "test-client")
	var result changeResult
	if w.Code != 200 {
		t.Fatalf("changes %d: %s", w.Code, w.Body.String())
	}
	if err := json.Unmarshal(w.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if result.Hash != w.Header().Get("X-Drawsrv-Hash") || len(result.Hash) != 64 {
		t.Fatal("hash mismatch", result, w.Header())
	}
	return w, result
}
func decodedCanvas(t *testing.T, s *store, id string) map[string]any {
	t.Helper()
	w := request(s, "GET", "/api/canvases/"+id, "", "")
	if w.Code != 200 {
		t.Fatal(w.Code)
	}
	document, err := documentJSON(w.Body.Bytes())
	if err != nil {
		t.Fatal(err)
	}
	return document
}
func TestConditionalElementChangesAndServerBookkeeping(t *testing.T) {
	s := bufferedStore(t)
	id, _, _ := createCanvas(t, s)
	_, result := patchCanvas(t, s, id, `[{"target":"elements","id":"box","before":{"present":false},"after":{"present":true,"value":{"id":"box","type":"rectangle","x":0,"y":0,"updated":9999999999999,"version":1234,"versionNonce":12}}}]`)
	if len(result.Applied) != 1 || len(result.Dropped) != 0 {
		t.Fatal(result)
	}
	document := decodedCanvas(t, s, id)
	element := document["elements"].([]any)[0].(map[string]any)
	if element["updated"] == float64(9999999999999) || element["version"] != float64(1) {
		t.Fatal("client metadata trusted", element)
	}
	x := `{"target":"elements","id":"box","fields":[{"field":"x","before":{"present":true,"value":0},"after":{"present":true,"value":10}}]}`
	_, result = patchCanvas(t, s, id, `[`+x+`]`)
	if len(result.Dropped) != 0 {
		t.Fatal(result)
	}
	// Another client still saw x=0, but its independent y edit can be accepted.
	_, result = patchCanvas(t, s, id, `[{"target":"elements","id":"box","fields":[{"field":"y","before":{"present":true,"value":0},"after":{"present":true,"value":20}}]}]`)
	if len(result.Dropped) != 0 {
		t.Fatal(result)
	}
	document = decodedCanvas(t, s, id)
	element = document["elements"].([]any)[0].(map[string]any)
	if element["x"] != float64(10) || element["y"] != float64(20) || element["version"] != float64(3) {
		t.Fatal(element)
	}
	// Retry after a lost response: no new timestamp, version, event or idle delay.
	before := s.pending[id]
	etag := revision(before.body)
	w, result := patchCanvas(t, s, id, `[`+x+`]`)
	if len(result.Dropped) != 0 || w.Header().Get("ETag") != etag || s.pending[id] != before {
		t.Fatal("retry changed snapshot", result)
	}
	// Geometry field group is all-or-nothing, while another element can succeed.
	_, result = patchCanvas(t, s, id, `[{"target":"elements","id":"box","fields":[{"field":"x","before":{"present":true,"value":0},"after":{"present":true,"value":30}},{"field":"y","before":{"present":true,"value":20},"after":{"present":true,"value":30}}]},{"target":"elements","id":"other","after":{"present":true,"value":{"id":"other"}}}]`)
	if len(result.Applied) != 1 || result.Applied[0] != 1 || len(result.Dropped) != 1 || result.Dropped[0].Index != 0 {
		t.Fatal(result)
	}
	for _, item := range decodedCanvas(t, s, id)["elements"].([]any) {
		if objectID(item) == "box" {
			element = item.(map[string]any)
		}
	}
	if element["x"] != float64(10) || element["y"] != float64(20) {
		t.Fatal("partial geometry applied", element)
	}
}

func TestDanglingAssociationsPropagateDropsAndDeletionDetaches(t *testing.T) {
	s := bufferedStore(t)
	id, _, _ := createCanvas(t, s)
	_, result := patchCanvas(t, s, id, `[{"target":"elements","id":"text","after":{"present":true,"value":{"id":"text","containerId":"box"}}},{"target":"elements","id":"box","after":{"present":true,"value":{"id":"box","frameId":"missing"}}},{"target":"elements","id":"independent","after":{"present":true,"value":{"id":"independent"}}}]`)
	if len(result.Dropped) != 2 || len(result.Applied) != 1 {
		t.Fatal(result)
	}
	_, result = patchCanvas(t, s, id, `[{"target":"elements","id":"box","after":{"present":true,"value":{"id":"box"}}},{"target":"elements","id":"arrow","after":{"present":true,"value":{"id":"arrow","startBinding":{"elementId":"box"}}}}]`)
	if len(result.Dropped) != 0 {
		t.Fatal(result)
	}
	_, result = patchCanvas(t, s, id, `[{"target":"elements","id":"box","before":{"present":true,"value":{"id":"box"}},"after":{"present":false}}]`)
	if len(result.Dropped) != 0 {
		t.Fatal(result)
	}
	elements := decodedCanvas(t, s, id)["elements"].([]any)
	for _, item := range elements {
		element := item.(map[string]any)
		if element["id"] == "box" {
			t.Fatal("delete failed")
		}
		if element["id"] == "arrow" && element["startBinding"] != nil {
			t.Fatal("dangling binding survived", element)
		}
	}
	_, result = patchCanvas(t, s, id, `[{"target":"elements","id":"arrow","fields":[{"field":"endBinding","before":{"present":false},"after":{"present":true,"value":{"elementId":"box"}}}]}]`)
	if len(result.Dropped) != 1 {
		t.Fatal("missing binding target accepted", result)
	}
}

func TestConcurrentAdditionsOrderAndReferencedFiles(t *testing.T) {
	s := bufferedStore(t)
	id, _, _ := createCanvas(t, s)
	_, result := patchCanvas(t, s, id, `[{"target":"elements","id":"a","after":{"present":true,"value":{"id":"a"}}},{"target":"elements","id":"b","afterId":"a","after":{"present":true,"value":{"id":"b"}}}]`)
	_, result = patchCanvas(t, s, id, `[{"target":"elements","id":"c","afterId":"a","after":{"present":true,"value":{"id":"c"}}},{"target":"elementOrder","before":{"present":true,"value":["a","b"]},"after":{"present":true,"value":["b","a"]}}]`)
	if len(result.Dropped) != 0 {
		t.Fatal(result)
	}
	elements := decodedCanvas(t, s, id)["elements"].([]any)
	ids := []string{}
	for _, element := range elements {
		ids = append(ids, objectID(element))
	}
	if strings.Join(ids, ",") != "b,c,a" {
		t.Fatal(ids)
	}
	_, result = patchCanvas(t, s, id, `[{"target":"files","id":"image","after":{"present":true,"value":{"id":"image","dataURL":"data:image/png;base64,aGVsbG8=","mimeType":"image/png"}}},{"target":"elements","id":"image-shape","after":{"present":true,"value":{"id":"image-shape","type":"image","fileId":"image"}}}]`)
	if len(result.Dropped) != 0 {
		t.Fatal(result)
	}
	_, result = patchCanvas(t, s, id, `[{"target":"files","id":"image","before":{"present":true,"value":{"id":"image","dataURL":"data:image/png;base64,aGVsbG8=","mimeType":"image/png"}},"after":{"present":false}}]`)
	if len(result.Dropped) != 1 {
		t.Fatal("referenced image bytes removed", result)
	}
}

func TestMalformedOrOversizedChangesNeverPartiallyPublish(t *testing.T) {
	s := bufferedStore(t)
	id, body, _ := createCanvas(t, s)
	w := request(s, "POST", "/api/canvases/"+id+"/changes", `{"changes":[{"target":"name","before":{"present":true,"value":"我的画布"},"after":{"present":true,"value":"changed"}},{"target":"invalid"}]}`, "")
	if w.Code != 400 || len(s.pending) != 0 {
		t.Fatal(w.Code, w.Body.String())
	}
	oldLimit := s.limit
	s.limit = int64(len(body) + 10)
	changes := `[{"target":"name","before":{"present":true,"value":"我的画布"},"after":{"present":true,"value":"` + strings.Repeat("x", 100) + `"}}]`
	w = request(s, "POST", "/api/canvases/"+id+"/changes", `{"changes":`+changes+`}`, "")
	s.limit = oldLimit
	if w.Code != 413 || len(s.pending) != 0 {
		t.Fatal("oversized candidate applied", w.Code, w.Body.String())
	}
}

func TestLegacyPutCannotChooseElementMetadata(t *testing.T) {
	s := bufferedStore(t)
	id, _, _ := createCanvas(t, s)
	patchCanvas(t, s, id, `[{"target":"elements","id":"box","after":{"present":true,"value":{"id":"box","x":0}}}]`)
	path := "/api/canvases/" + id
	get := request(s, "GET", path, "", "")
	document := decodedCanvas(t, s, id)
	element := document["elements"].([]any)[0].(map[string]any)
	element["updated"] = float64(9999999999999)
	element["version"] = float64(8888)
	element["versionNonce"] = float64(1234)
	body, _ := json.Marshal(document)
	entry := s.pending[id]
	w := request(s, "PUT", path, string(body), get.Header().Get("ETag"))
	if w.Code != 202 || s.pending[id] != entry || w.Header().Get("ETag") != get.Header().Get("ETag") {
		t.Fatal("metadata-only upload changed server snapshot", w.Code, w.Body.String())
	}
	element["x"] = float64(100)
	body, _ = json.Marshal(document)
	w = request(s, "PUT", path, string(body), w.Header().Get("ETag"))
	if w.Code != 202 {
		t.Fatal(w.Code, w.Body.String())
	}
	element = decodedCanvas(t, s, id)["elements"].([]any)[0].(map[string]any)
	if element["version"] != float64(2) || element["updated"] == float64(9999999999999) || element["versionNonce"] == float64(1234) {
		t.Fatal("client chose server metadata", element)
	}
}

func TestChangesUpdateLibraryAndHashHeaders(t *testing.T) {
	s := bufferedStore(t)
	id, _, _ := createCanvas(t, s)
	w, result := patchCanvas(t, s, id, `[{"target":"libraryItems","id":"item","after":{"present":true,"value":{"id":"item","status":"unpublished","created":9999999999999,"elements":[{"id":"shape","version":500,"updated":9999999999999}]}}}]`)
	if len(result.Dropped) != 0 {
		t.Fatal(result)
	}
	item := decodedCanvas(t, s, id)["libraryItems"].([]any)[0].(map[string]any)
	element := item["elements"].([]any)[0].(map[string]any)
	if item["created"] == float64(9999999999999) || element["version"] != float64(1) {
		t.Fatal("library metadata trusted", item)
	}
	event := s.currentEvent(id, s.pending[id].body)
	if event.Hash != result.Hash || event.Hash != w.Header().Get("X-Drawsrv-Hash") {
		t.Fatal("SSE hash differs from save result", event, result)
	}
	before := event
	request(s, "POST", "/api/canvases/"+id+"/flush", `{}`, w.Header().Get("ETag"))
	committed, err := s.read(id)
	if err != nil {
		t.Fatal(err)
	}
	event = s.currentEvent(id, committed)
	if event.Hash != before.Hash || event.Revision != before.Revision || !event.Persisted {
		t.Fatal("persistence changed effective state", event)
	}
}

func TestLibraryAssociationOutsideItemIsDropped(t *testing.T) {
	s := bufferedStore(t)
	id, _, _ := createCanvas(t, s)
	_, result := patchCanvas(t, s, id, `[{"target":"libraryItems","id":"item","after":{"present":true,"value":{"id":"item","elements":[{"id":"text","containerId":"missing"}]}}}]`)
	if len(result.Dropped) != 1 || len(decodedCanvas(t, s, id)["libraryItems"].([]any)) != 0 {
		t.Fatal(result)
	}
}

func TestFileDeletionRetainsLibraryImages(t *testing.T) {
	document, err := documentJSON([]byte(`{"name":"test","elements":[],"files":{"image":{"id":"image","dataURL":"data:image/png;base64,aGVsbG8="}},"libraryItems":[{"id":"library","elements":[{"id":"shape","type":"image","fileId":"image"}]}]}`))
	if err != nil {
		t.Fatal(err)
	}
	var changes []change
	json.Unmarshal([]byte(`[{"target":"files","id":"image","before":{"present":true,"value":{"id":"image","dataURL":"data:image/png;base64,aGVsbG8="}},"after":{"present":false}}]`), &changes)
	next, result, err := applyChanges(document, changes, 123)
	if err != nil || len(result.Dropped) != 1 || next["files"].(map[string]any)["image"] == nil {
		t.Fatal("library image bytes deleted", result, err)
	}
}
