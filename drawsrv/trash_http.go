package main

import (
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"time"
)

// The shared API handler has validated method, origin and storage availability
// and holds store.mu. Trash listing needs only metadata, never canvas blobs.
func (s *store) serveTrashLocked(w http.ResponseWriter, r *http.Request, name string) {
	now := time.Now().UTC()
	if r.Method == "GET" {
		type item struct {
			ID      string    `json:"id"`
			Name    string    `json:"name"`
			Updated time.Time `json:"updated"`
			Deleted time.Time `json:"deleted"`
			Expires time.Time `json:"expires"`
		}
		items := make([]item, 0, len(s.state.Trash))
		for name, meta := range s.state.Trash {
			deleted := meta.DeletedAt
			if !now.Before(deleted.Add(trashRetention)) {
				continue
			}
			items = append(items, item{name, meta.Name, deleted, deleted, deleted.Add(trashRetention)})
		}
		json.NewEncoder(w).Encode(items)
		return
	}
	id, err := s.restoreTrash(name, now)
	if errors.Is(err, errCanvasNotFound) {
		http.NotFound(w, r)
		return
	}
	if errors.Is(err, errCanvasExists) {
		http.Error(w, "canvas already exists", http.StatusConflict)
		return
	}
	if err != nil {
		log.Print(err)
		http.Error(w, "cannot restore canvas", 500)
		return
	}
	w.Header().Set("Location", "/api/canvases/"+id)
	w.WriteHeader(http.StatusNoContent)
}
