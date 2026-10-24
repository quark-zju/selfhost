package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"
)

type snapshot struct {
	Name         string                     `json:"name"`
	Elements     []json.RawMessage          `json:"elements"`
	AppState     map[string]json.RawMessage `json:"appState"`
	Files        map[string]json.RawMessage `json:"files"`
	LibraryItems []json.RawMessage          `json:"libraryItems"`
}

type store struct {
	mu     sync.Mutex
	dir    string
	limit  int64
	failed bool
}

var canvasID = regexp.MustCompile(`^[a-f0-9]{32}$`)
var commitID = regexp.MustCompile(`^[a-f0-9]{40,64}$`)

func revision(data []byte) string {
	sum := sha256.Sum256(data)
	return `"` + hex.EncodeToString(sum[:]) + `"`
}

func (s *store) git(args ...string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	base := []string{"-C", s.dir, "-c", "user.name=drawsrv", "-c", "user.email=drawsrv@localhost", "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "-c", "gc.auto=0", "-c", "maintenance.auto=false", "-c", "pack.threads=1"}
	cmd := exec.CommandContext(ctx, "git", append(base, args...)...)
	cmd.Env = append(os.Environ(), "GIT_TERMINAL_PROMPT=0")
	output, err := cmd.CombinedOutput()
	if err != nil {
		return nil, fmt.Errorf("git %s: %w: %s", args[0], err, output)
	}
	return output, nil
}

func openStore(dir string, limit int64) (*store, error) {
	if _, err := exec.LookPath("git"); err != nil {
		return nil, fmt.Errorf("Git is required: %w", err)
	}
	s := &store{dir: dir, limit: limit}
	info, err := os.Lstat(filepath.Join(dir, ".git"))
	if os.IsNotExist(err) {
		entries, err := os.ReadDir(dir)
		if err != nil {
			return nil, err
		}
		if len(entries) != 0 {
			return nil, fmt.Errorf("new data directory must be empty")
		}
		if _, err := s.git("init"); err != nil {
			return nil, err
		}
	} else if err != nil {
		return nil, err
	} else if !info.IsDir() {
		return nil, fmt.Errorf("data needs its own Git repository, not a worktree or symlink")
	}
	return s, nil
}

func decodeSnapshot(body []byte) (*snapshot, error) {
	var state snapshot
	if json.Unmarshal(body, &state) != nil || state.Elements == nil || state.AppState == nil || state.Files == nil || strings.TrimSpace(state.Name) == "" || len(state.Name) > 200 {
		return nil, fmt.Errorf("invalid canvas (name, elements, appState and files required)")
	}
	state.Name = strings.TrimSpace(state.Name)
	if state.LibraryItems == nil {
		state.LibraryItems = []json.RawMessage{}
	}
	return &state, nil
}

// Recover a crash between an atomic file replacement and its Git commit. Only
// canvas files are allowed in the data directory; never stage unrelated files.
func (s *store) recover() error {
	entries, err := os.ReadDir(s.dir)
	if err != nil {
		return err
	}
	for _, entry := range entries {
		if entry.Name() == ".git" || strings.HasPrefix(entry.Name(), ".snapshot-") {
			continue
		}
		id := strings.TrimSuffix(entry.Name(), ".json")
		if !canvasID.MatchString(id) || entry.Name() != id+".json" || !entry.Type().IsRegular() {
			return fmt.Errorf("unexpected file in data directory: %s", entry.Name())
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		if info.Size() > s.limit {
			return fmt.Errorf("canvas exceeds size limit: %s", id)
		}
		body, err := os.ReadFile(filepath.Join(s.dir, entry.Name()))
		if err != nil {
			return err
		}
		if _, err := decodeSnapshot(body); err != nil {
			return fmt.Errorf("%s: %w", id, err)
		}
	}
	changes, err := s.git("status", "--porcelain", "--untracked-files=all", "--", "*.json")
	if err != nil {
		return err
	}
	if len(changes) == 0 {
		return nil
	}
	if _, err := s.git("add", "-A", "--", "*.json"); err != nil {
		return err
	}
	_, err = s.git("commit", "-m", "canvas: recover interrupted save", "--", "*.json")
	return err
}

func (s *store) save(id string, body, previous []byte, message string) error {
	path := filepath.Join(s.dir, id+".json")
	if string(body) == string(previous) {
		return nil
	}
	if err := atomicWrite(path, body); err != nil {
		s.failed = true
		return err
	}
	_, err := s.git("add", "--", id+".json")
	if err == nil {
		_, err = s.git("commit", "-m", message+" "+id, "--", id+".json")
	}
	if err == nil {
		return nil
	}
	// Restore the last successful revision if Git fails. Fail closed if rollback
	// also fails; restart then recovers the disk state instead of accepting writes.
	var rollback error
	if previous == nil {
		rollback = os.Remove(path)
		if rollback == nil {
			_, rollback = s.git("rm", "--cached", "--ignore-unmatch", "--", id+".json")
		}
	} else {
		rollback = atomicWrite(path, previous)
		if rollback == nil {
			_, rollback = s.git("add", "--", id+".json")
		}
	}
	if rollback != nil {
		s.failed = true
		return fmt.Errorf("%w; rollback failed: %v; restart required", err, rollback)
	}
	return err
}

func atomicWrite(path string, data []byte) error {
	f, err := os.CreateTemp(filepath.Dir(path), ".snapshot-*")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	if _, err = f.Write(data); err != nil {
		f.Close()
		return err
	}
	if err = f.Sync(); err != nil {
		f.Close()
		return err
	}
	if err = f.Close(); err != nil {
		return err
	}
	if err = os.Rename(f.Name(), path); err != nil {
		return err
	}
	dir, err := os.Open(filepath.Dir(path))
	if err != nil {
		return err
	}
	defer dir.Close()
	return dir.Sync()
}
