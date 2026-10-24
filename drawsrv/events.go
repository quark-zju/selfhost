package main

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

const maxEventStreams = 64
const eventHeartbeat = 15 * time.Second

type canvasEvent struct {
	ETag      string `json:"etag"`
	Hash      string `json:"hash"`
	Revision  string `json:"revision"`
	Persisted bool   `json:"persisted"`
	Source    string `json:"source"`
}
type eventFrame struct {
	kind  string
	state canvasEvent
}

type eventBroker struct {
	mu          sync.Mutex
	epoch       string
	sequence    uint64
	latest      map[string]canvasEvent
	subscribers map[string]map[chan eventFrame]struct{}
	count       int
	closed      bool
}

func newEventBroker() (*eventBroker, error) {
	epoch := make([]byte, 16)
	if _, err := rand.Read(epoch); err != nil {
		return nil, err
	}
	return &eventBroker{epoch: hex.EncodeToString(epoch), latest: map[string]canvasEvent{}, subscribers: map[string]map[chan eventFrame]struct{}{}}, nil
}
func (b *eventBroker) stateLocked(id, etag string, persisted bool, hash ...string) canvasEvent {
	state, ok := b.latest[id]
	if !ok || state.ETag != etag {
		b.sequence++
		state = canvasEvent{ETag: etag, Revision: fmt.Sprintf("%s-%d", b.epoch, b.sequence), Persisted: persisted}
		b.latest[id] = state
	}
	if len(hash) > 0 {
		state.Hash = hash[0]
		b.latest[id] = state
	}
	return state
}
func (b *eventBroker) snapshot(id, etag string, persisted bool, hash ...string) canvasEvent {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.stateLocked(id, etag, persisted, hash...)
}
func (b *eventBroker) publish(id, kind, etag string, persisted bool, source string, hash ...string) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.closed {
		return
	}
	state := b.stateLocked(id, etag, persisted, hash...)
	// A real content change gets a new identity even after reverting to an older
	// payload. This keeps delayed durability events from confirming a new draft.
	if kind == "change" {
		b.sequence++
		state.Revision = fmt.Sprintf("%s-%d", b.epoch, b.sequence)
	}
	state.Persisted = persisted
	state.Source = source
	b.latest[id] = state
	frame := eventFrame{kind, state}
	for listener := range b.subscribers[id] {
		select {
		case listener <- frame:
		default:
			// Keep only the latest state; never block writers or queue snapshots.
			select {
			case <-listener:
			default:
			}
			listener <- frame
		}
	}
}
func (b *eventBroker) subscribe(id string) (chan eventFrame, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.closed || b.count >= maxEventStreams {
		return nil, errors.New("event stream capacity unavailable")
	}
	listener := make(chan eventFrame, 1)
	if b.subscribers[id] == nil {
		b.subscribers[id] = map[chan eventFrame]struct{}{}
	}
	b.subscribers[id][listener] = struct{}{}
	b.count++
	listener <- eventFrame{"state", b.latest[id]}
	return listener, nil
}
func (b *eventBroker) unsubscribe(id string, listener chan eventFrame) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if _, ok := b.subscribers[id][listener]; !ok {
		return
	}
	delete(b.subscribers[id], listener)
	b.count--
	if len(b.subscribers[id]) == 0 {
		delete(b.subscribers, id)
	}
}
func (b *eventBroker) close() {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.closed {
		return
	}
	b.closed = true
	for _, listeners := range b.subscribers {
		for listener := range listeners {
			close(listener)
		}
	}
	b.subscribers = map[string]map[chan eventFrame]struct{}{}
	b.count = 0
}

// Called under store.mu: register and enqueue the initial state atomically with
// respect to writes, then release it for the lifetime of the HTTP connection.
func (s *store) currentEvent(id string, body []byte) canvasEvent {
	state := s.events.snapshot(id, revision(body), s.pending[id] == nil)
	if state.Hash == "" {
		state = s.events.snapshot(id, revision(body), s.pending[id] == nil, contentHash(body))
	}
	return state
}
func (s *store) notifyChange(id string, body []byte, persisted bool, source string) {
	hash := contentHash(body)
	s.events.publish(id, "change", revision(body), persisted, source, hash)
	if persisted {
		s.events.publish(id, "persisted", revision(body), true, source, hash)
	}
}
func (s *store) setStateHeaders(w http.ResponseWriter, id string, body []byte) {
	state := s.currentEvent(id, body)
	w.Header().Set("ETag", state.ETag)
	w.Header().Set("X-Drawsrv-Hash", state.Hash)
	w.Header().Set("X-Drawsrv-Revision", state.Revision)
	w.Header().Set("X-Drawsrv-Persisted", fmt.Sprint(state.Persisted))
}

func (s *store) serveEvents(w http.ResponseWriter, r *http.Request, id string) {
	if origin := r.Header.Get("Origin"); origin != "" {
		u, err := url.Parse(origin)
		if err != nil || u.Host != r.Host || (u.Scheme != "http" && u.Scheme != "https") {
			http.Error(w, "cross-origin event streams forbidden", 403)
			return
		}
	}
	controller := http.NewResponseController(w)
	if err := controller.SetWriteDeadline(time.Time{}); err != nil {
		http.Error(w, "streaming unavailable", 500)
		return
	}
	s.mu.Lock()
	if s.closed || s.failed {
		s.mu.Unlock()
		http.Error(w, "storage unavailable", 503)
		return
	}
	body, err := s.read(id)
	if errors.Is(err, errCanvasNotFound) {
		s.mu.Unlock()
		http.NotFound(w, r)
		return
	}
	if err != nil {
		s.mu.Unlock()
		http.Error(w, "cannot read canvas", 500)
		return
	}
	s.currentEvent(id, body)
	listener, err := s.events.subscribe(id)
	s.mu.Unlock()
	// Do not retain the potentially large canvas for the life of the stream.
	body = nil
	if err != nil {
		w.Header().Set("Retry-After", "5")
		http.Error(w, "too many event streams", 503)
		return
	}
	defer s.events.unsubscribe(id, listener)
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Accel-Buffering", "no")
	write := func(frame string) error {
		if err := controller.SetWriteDeadline(time.Now().Add(10 * time.Second)); err != nil {
			return err
		}
		if _, err := fmt.Fprint(w, frame); err != nil {
			return err
		}
		if err := controller.Flush(); err != nil {
			return err
		}
		return controller.SetWriteDeadline(time.Time{})
	}
	heartbeat := time.NewTicker(eventHeartbeat)
	defer heartbeat.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case <-heartbeat.C:
			if write(": keepalive\n\n") != nil {
				return
			}
		case frame, ok := <-listener:
			if !ok {
				return
			}
			data, err := json.Marshal(frame.state)
			if err != nil {
				return
			}
			if write("event: "+frame.kind+"\ndata: "+strings.TrimSpace(string(data))+"\n\n") != nil {
				return
			}
		}
	}
}
