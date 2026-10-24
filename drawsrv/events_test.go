package main

import (
	"bufio"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"
)

func TestEventBrokerKeepsOnlyLatestNotificationAndBoundsConnections(t *testing.T) {
	broker, err := newEventBroker()
	if err != nil {
		t.Fatal(err)
	}
	defer broker.close()
	broker.snapshot("canvas", "initial", true)
	listeners := make([]chan eventFrame, 0, maxEventStreams)
	for i := 0; i < maxEventStreams; i++ {
		ch, err := broker.subscribe("canvas")
		if err != nil {
			t.Fatal(err)
		}
		listeners = append(listeners, ch)
	}
	if _, err := broker.subscribe("canvas"); err == nil {
		t.Fatal("unbounded event subscriptions")
	}
	for _, etag := range []string{"one", "two", "latest"} {
		broker.publish("canvas", "change", etag, false, "writer")
	}
	for _, ch := range listeners {
		if len(ch) != 1 {
			t.Fatal("unbounded event queue")
		}
		if frame := <-ch; frame.state.ETag != "latest" || frame.state.Source != "writer" {
			t.Fatal(frame)
		}
	}
	broker.unsubscribe("canvas", listeners[0])
	if _, err := broker.subscribe("canvas"); err != nil {
		t.Fatal("disconnected subscriber retained capacity")
	}
	broker.close()
	for _, ch := range listeners[1:] {
		if _, ok := <-ch; ok {
			t.Fatal("shutdown did not close stream")
		}
	}
	broker.publish("canvas", "change", "closed", false, "writer")
}

func TestEventRevisionDistinguishesRevertedPayloads(t *testing.T) {
	broker, err := newEventBroker()
	if err != nil {
		t.Fatal(err)
	}
	defer broker.close()
	first := broker.snapshot("canvas", "same payload", true)
	broker.publish("canvas", "change", "other payload", false, "one")
	broker.publish("canvas", "change", "same payload", false, "two")
	current := broker.snapshot("canvas", "same payload", false)
	if current.Revision == first.Revision {
		t.Fatal("old durability event could confirm a new reverted draft")
	}
	broker.publish("canvas", "persisted", "same payload", true, "two")
	saved := broker.snapshot("canvas", "same payload", true)
	if saved.Revision != current.Revision || !saved.Persisted {
		t.Fatal("persistence should preserve revision identity")
	}
}

func readEvent(t *testing.T, reader *bufio.Reader) eventFrame {
	t.Helper()
	var frame eventFrame
	for {
		line, err := reader.ReadString('\n')
		if err != nil {
			t.Fatal(err)
		}
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, "event: ") {
			frame.kind = strings.TrimPrefix(line, "event: ")
		}
		if strings.HasPrefix(line, "data: ") {
			if err := json.Unmarshal([]byte(strings.TrimPrefix(line, "data: ")), &frame.state); err != nil {
				t.Fatal(err)
			}
		}
		if line == "" && frame.kind != "" {
			return frame
		}
	}
}
func sourceRequest(s *store, method, path, body, etag, source string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(method, path, strings.NewReader(body))
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("If-Match", etag)
	r.Header.Set("X-Drawsrv-Client", source)
	w := httptest.NewRecorder()
	s.serve(w, r)
	return w
}

func TestSSEPushesMemoryChangesAndDiskPersistence(t *testing.T) {
	s := bufferedStore(t)
	id, body, etag := createCanvas(t, s)
	path := "/api/canvases/" + id
	server := httptest.NewServer(newHandler(s, fstest.MapFS{}))
	defer server.Close()
	response, err := http.Get(server.URL + path + "/events")
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != 200 || response.Header.Get("Content-Type") != "text/event-stream" {
		t.Fatal(response.Status)
	}
	reader := bufio.NewReader(response.Body)
	initial := readEvent(t, reader)
	if initial.kind != "state" || initial.state.ETag != etag || !initial.state.Persisted || initial.state.Revision == "" {
		t.Fatal(initial)
	}
	w := sourceRequest(s, "PUT", path, changeName(body, "from first client"), etag, "client-a")
	if w.Code != 202 {
		t.Fatal(w.Code, w.Body.String())
	}
	memory := readEvent(t, reader)
	if memory.kind != "change" || memory.state.Persisted || memory.state.Source != "client-a" || memory.state.Revision != w.Header().Get("X-Drawsrv-Revision") {
		t.Fatal(memory)
	}
	w = request(s, "POST", path+"/flush", `{}`, w.Header().Get("ETag"))
	if w.Code != 204 {
		t.Fatal(w.Code, w.Body.String())
	}
	disk := readEvent(t, reader)
	if disk.kind != "persisted" || !disk.state.Persisted || disk.state.Revision != memory.state.Revision || disk.state.Source != "client-a" {
		t.Fatal(disk)
	}
	// A second writer can be identified without putting snapshots on the stream.
	w = sourceRequest(s, "PUT", path, changeName(body, "from second client"), w.Header().Get("ETag"), "client-b")
	next := readEvent(t, reader)
	if next.state.Source != "client-b" || next.state.Revision == disk.state.Revision {
		t.Fatal(next)
	}
	// Closing the broker must end an active SSE handler, allowing HTTP shutdown.
	s.events.close()
	if _, err := reader.ReadString('\n'); err == nil {
		t.Fatal("stream did not terminate on shutdown")
	}
}

func TestSSEReconnectStartsWithLatestState(t *testing.T) {
	s := bufferedStore(t)
	id, body, etag := createCanvas(t, s)
	path := "/api/canvases/" + id
	w := sourceRequest(s, "PUT", path, changeName(body, "latest"), etag, "client-a")
	server := httptest.NewServer(newHandler(s, fstest.MapFS{}))
	defer server.Close()
	response, err := http.Get(server.URL + path + "/events")
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	current := readEvent(t, bufio.NewReader(response.Body))
	if current.kind != "state" || current.state.ETag != w.Header().Get("ETag") || current.state.Revision != w.Header().Get("X-Drawsrv-Revision") || current.state.Persisted {
		t.Fatal(current)
	}
}

func TestInvalidSourceDoesNotModifyCanvas(t *testing.T) {
	s := bufferedStore(t)
	id, body, etag := createCanvas(t, s)
	w := sourceRequest(s, "PUT", "/api/canvases/"+id, changeName(body, "invalid"), etag, strings.Repeat("x", 129))
	if w.Code != 400 || len(s.pending) != 0 {
		t.Fatal("invalid source accepted")
	}
}
