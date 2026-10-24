package main

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"log"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"time"
)

func newHandler(s *store, static fs.FS) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/api/canvases", s.serve)
	mux.HandleFunc("/api/canvases/", s.serve)
	mux.HandleFunc("/api/", func(w http.ResponseWriter, r *http.Request) { http.NotFound(w, r) })
	files := http.FileServerFS(static)
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		for _, part := range strings.Split(r.URL.Path, "/") {
			if strings.HasPrefix(part, ".") {
				http.NotFound(w, r)
				return
			}
		}
		w.Header().Set("Cache-Control", "no-cache")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		files.ServeHTTP(w, r)
	})
	return mux
}

func (s *store) serve(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Content-Type", "application/json")
	parts := strings.Split(strings.TrimPrefix(r.URL.Path, "/api/canvases"), "/")
	collection := len(parts) == 1 && parts[0] == ""
	id, action := "", ""
	if !collection {
		if len(parts) < 2 || len(parts) > 3 || !canvasID.MatchString(parts[1]) {
			http.NotFound(w, r)
			return
		}
		id = parts[1]
		if len(parts) == 3 {
			action = parts[2]
			if action != "history" && action != "restore" {
				http.NotFound(w, r)
				return
			}
		}
	}
	allowed := "GET, PUT"
	if collection {
		allowed = "GET, POST"
	} else if action == "history" {
		allowed = "GET"
	} else if action == "restore" {
		allowed = "POST"
	}
	if !strings.Contains(", "+allowed+",", ", "+r.Method+",") {
		w.Header().Set("Allow", allowed)
		http.Error(w, "method not allowed", 405)
		return
	}
	if r.Method != "GET" {
		if r.Header.Get("Content-Type") != "application/json" {
			http.Error(w, "application/json required", 415)
			return
		}
		if origin := r.Header.Get("Origin"); origin != "" {
			u, err := url.Parse(origin)
			if err != nil || u.Host != r.Host || (u.Scheme != "https" && u.Scheme != "http") {
				http.Error(w, "cross-origin writes forbidden", 403)
				return
			}
		}
	}
	// Serialize requests, including body reads, to bound transient canvas memory
	// and ensure Git sees exactly one writer. Server ReadTimeout bounds slow peers.
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.failed {
		http.Error(w, "storage needs restart after uncertain Git publication", 503)
		return
	}
	if collection {
		if r.Method == "GET" {
			s.list(w, r)
		} else {
			s.create(w, r)
		}
		return
	}
	if action == "history" {
		if _, ok := s.state.Canvases[id]; !ok {
			http.NotFound(w, r)
			return
		}
		s.history(w, r, id)
		return
	}
	current, err := s.read(id)
	if errors.Is(err, errCanvasNotFound) {
		http.NotFound(w, r)
		return
	}
	if err != nil {
		http.Error(w, "cannot read canvas", 500)
		return
	}
	w.Header().Set("ETag", revision(current))
	if r.Method == "GET" {
		w.Write(current)
		return
	}
	if r.Header.Get("If-Match") != revision(current) {
		http.Error(w, "canvas changed; export your changes then reload", 412)
		return
	}
	var body []byte
	if action == "restore" {
		var request struct {
			Commit string `json:"commit"`
		}
		if json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&request) != nil || !commitID.MatchString(request.Commit) {
			http.Error(w, "invalid commit", 400)
			return
		}
		// IDs are validated and never interpreted as command options or paths.
		var object []byte
		object, err = s.git("rev-parse", "--verify", request.Commit+":"+id+".json")
		if err == nil {
			body, err = s.readBlob(strings.TrimSpace(string(object)))
		}
		if err != nil {
			http.Error(w, "revision not found", 404)
			return
		}
	} else {
		body, err = io.ReadAll(http.MaxBytesReader(w, r.Body, s.limit))
		if err != nil {
			http.Error(w, "canvas too large or unreadable", 413)
			return
		}
	}
	if int64(len(body)) > s.limit {
		http.Error(w, "canvas too large", 413)
		return
	}
	state, err := decodeSnapshot(body)
	if err != nil {
		http.Error(w, err.Error(), 400)
		return
	}
	body, _ = json.MarshalIndent(state, "", "  ")
	// Enforce a consistent limit on the canonical on-disk format too.
	if int64(len(body)) > s.limit {
		http.Error(w, "formatted canvas exceeds size limit", 413)
		return
	}
	message := "canvas: save"
	if action == "restore" {
		message = "canvas: restore"
	}
	if err := s.save(id, body, current, message); err != nil {
		log.Print(err)
		http.Error(w, "cannot commit canvas", 500)
		return
	}
	w.Header().Set("ETag", revision(body))
	w.WriteHeader(204)
}

func (s *store) list(w http.ResponseWriter, r *http.Request) {
	type item struct {
		ID      string    `json:"id"`
		Name    string    `json:"name"`
		Updated time.Time `json:"updated"`
	}
	items := make([]item, 0, len(s.state.Canvases))
	for id, meta := range s.state.Canvases {
		items = append(items, item{id, meta.Name, meta.Updated})
	}
	sort.Slice(items, func(i, j int) bool {
		if items[i].Updated.Equal(items[j].Updated) {
			return items[i].ID < items[j].ID
		}
		return items[i].Updated.After(items[j].Updated)
	})
	json.NewEncoder(w).Encode(items)
}

func (s *store) create(w http.ResponseWriter, r *http.Request) {
	var request struct {
		Name string `json:"name"`
	}
	if json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&request) != nil || strings.TrimSpace(request.Name) == "" || len(request.Name) > 200 {
		http.Error(w, "name required (max 200 bytes)", 400)
		return
	}
	key := make([]byte, 16)
	if _, err := rand.Read(key); err != nil {
		http.Error(w, "cannot create ID", 500)
		return
	}
	id := hex.EncodeToString(key)
	body, _ := json.MarshalIndent(snapshot{Name: strings.TrimSpace(request.Name), Elements: []json.RawMessage{}, AppState: map[string]json.RawMessage{}, Files: map[string]json.RawMessage{}, LibraryItems: []json.RawMessage{}}, "", "  ")
	if err := s.save(id, body, nil, "canvas: create"); err != nil {
		log.Print(err)
		http.Error(w, "cannot commit canvas", 500)
		return
	}
	w.WriteHeader(201)
	json.NewEncoder(w).Encode(map[string]string{"id": id})
}

func (s *store) history(w http.ResponseWriter, r *http.Request, id string) {
	output, err := s.git("log", "-100", "--format=%H %aI", "--", id+".json")
	if err != nil {
		http.Error(w, "cannot read history", 500)
		return
	}
	type item struct {
		Commit string `json:"commit"`
		Date   string `json:"date"`
	}
	items := []item{}
	for _, line := range strings.Split(strings.TrimSpace(string(output)), "\n") {
		fields := strings.Fields(line)
		if len(fields) == 2 {
			items = append(items, item{fields[0], fields[1]})
		}
	}
	json.NewEncoder(w).Encode(items)
}
