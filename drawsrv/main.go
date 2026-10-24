// drawsrv serves an unmodified Excalidraw wrapper and a personal Git-backed store.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"
)

func main() {
	if err := run(); err != nil {
		log.Fatal(err)
	}
}

func run() (result error) {
	addr := flag.String("listen", "127.0.0.1:8080", "HTTP listen address")
	static := flag.String("static", "web/dist", "built frontend directory")
	data := flag.String("data", "data", "private Git data directory, outside static directory")
	limit := flag.Int64("max-canvas-mib", 16, "maximum canvas size including base64 images")
	cacheMiB := flag.Int("cache-mib", 4, "maximum cached canvas payload MiB (0 disables; at most 64 entries)")
	maintenanceDelay := flag.Duration("maintenance-delay", defaultMaintenanceDelay, "delay from first Git write to foreground GC (0 disables)")
	commitDelay := flag.Duration("commit-delay", defaultCommitDelay, "idle time before a canvas snapshot is committed to Git (0 saves immediately)")
	pendingMiB := flag.Int("pending-mib", 16, "total pending snapshot payload MiB (0 saves immediately; at most 64 canvases)")
	flag.Parse()
	if *limit < 1 || *limit > 256 {
		return errors.New("max-canvas-mib must be 1..256")
	}
	if *cacheMiB < 0 || *cacheMiB > 256 {
		return errors.New("cache-mib must be 0..256")
	}
	if *maintenanceDelay < 0 {
		return errors.New("maintenance-delay must not be negative")
	}
	if *commitDelay < 0 {
		return errors.New("commit-delay must not be negative")
	}
	if *pendingMiB < 0 || *pendingMiB > 256 {
		return errors.New("pending-mib must be 0..256")
	}
	if err := os.MkdirAll(*data, 0700); err != nil {
		return err
	}
	staticPath, err := filepath.EvalSymlinks(*static)
	if err != nil {
		return err
	}
	staticPath, err = filepath.Abs(staticPath)
	if err != nil {
		return err
	}
	dataPath, err := filepath.EvalSymlinks(*data)
	if err != nil {
		return err
	}
	dataPath, err = filepath.Abs(dataPath)
	if err != nil {
		return err
	}
	rel, err := filepath.Rel(staticPath, dataPath)
	if err != nil || (rel != ".." && !strings.HasPrefix(rel, ".."+string(os.PathSeparator))) {
		return errors.New("data must be outside static directory")
	}
	if _, err := os.Stat(filepath.Join(staticPath, "index.html")); err != nil {
		return err
	}
	s, err := openStore(dataPath, *limit<<20)
	if err != nil {
		return err
	}
	defer func() { result = errors.Join(result, s.Close()) }()
	s.commitDelay = *commitDelay
	s.pendingBudget = *pendingMiB << 20
	s.cache = newBlobCache(*cacheMiB << 20)
	staticRoot, err := os.OpenRoot(staticPath)
	if err != nil {
		return err
	}
	defer staticRoot.Close()
	server := &http.Server{
		Addr: *addr, Handler: newHandler(s, staticRoot.FS()),
		ReadTimeout: 30 * time.Second, WriteTimeout: 60 * time.Second,
		IdleTimeout: 60 * time.Second, MaxHeaderBytes: 16 << 10,
	}
	log.Printf("Serving %s at http://%s; Git data: %s", staticPath, *addr, dataPath)
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	done := make(chan struct{})
	go func() {
		defer close(done)
		var workers sync.WaitGroup
		workers.Add(2)
		go func() { defer workers.Done(); s.runMaintenance(ctx, *maintenanceDelay, log.Printf) }()
		go func() { defer workers.Done(); s.runPersistence(ctx, log.Printf) }()
		workers.Wait()
	}()
	defer func() { stop(); <-done }()
	serverErrors := make(chan error, 1)
	go func() { serverErrors <- server.ListenAndServe() }()
	select {
	case err := <-serverErrors:
		if !errors.Is(err, http.ErrServerClosed) {
			return fmt.Errorf("HTTP server: %w", err)
		}
	case <-ctx.Done():
	}
	// Cancel and reap GC before shutdown waits on requests queued behind its lock.
	stop()
	s.events.close()
	<-done
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := server.Shutdown(shutdownCtx); err != nil {
		server.Close()
		return err
	}
	return nil
}
