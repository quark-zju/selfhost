// drawsrv serves an unmodified Excalidraw wrapper and a personal Git-backed store.
package main

import (
	"flag"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

func main() {
	addr := flag.String("listen", "127.0.0.1:8080", "HTTP listen address")
	static := flag.String("static", "web/dist", "built frontend directory")
	data := flag.String("data", "data", "private Git data directory, outside static directory")
	limit := flag.Int64("max-canvas-mib", 16, "maximum canvas size including base64 images")
	flag.Parse()
	if *limit < 1 || *limit > 256 {
		log.Fatal("max-canvas-mib must be 1..256")
	}
	if err := os.MkdirAll(*data, 0700); err != nil {
		log.Fatal(err)
	}
	staticPath, err := filepath.EvalSymlinks(*static)
	if err != nil {
		log.Fatal(err)
	}
	staticPath, err = filepath.Abs(staticPath)
	if err != nil {
		log.Fatal(err)
	}
	dataPath, err := filepath.EvalSymlinks(*data)
	if err != nil {
		log.Fatal(err)
	}
	dataPath, err = filepath.Abs(dataPath)
	if err != nil {
		log.Fatal(err)
	}
	rel, err := filepath.Rel(staticPath, dataPath)
	if err != nil || (rel != ".." && !strings.HasPrefix(rel, ".."+string(os.PathSeparator))) {
		log.Fatal("data must be outside static directory")
	}
	if _, err := os.Stat(filepath.Join(staticPath, "index.html")); err != nil {
		log.Fatal(err)
	}
	s, err := openStore(dataPath, *limit<<20)
	if err != nil {
		log.Fatal(err)
	}
	defer s.Close()
	staticRoot, err := os.OpenRoot(staticPath)
	if err != nil {
		log.Fatal(err)
	}
	defer staticRoot.Close()
	server := &http.Server{
		Addr: *addr, Handler: newHandler(s, staticRoot.FS()),
		ReadTimeout: 30 * time.Second, WriteTimeout: 60 * time.Second,
		IdleTimeout: 60 * time.Second, MaxHeaderBytes: 16 << 10,
	}
	log.Printf("Serving %s at http://%s; Git data: %s", staticPath, *addr, dataPath)
	log.Fatal(server.ListenAndServe())
}
