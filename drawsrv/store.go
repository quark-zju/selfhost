package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

type snapshot struct {
	Name         string                     `json:"name"`
	Elements     []json.RawMessage          `json:"elements"`
	AppState     map[string]json.RawMessage `json:"appState"`
	Files        map[string]json.RawMessage `json:"files"`
	LibraryItems []json.RawMessage          `json:"libraryItems"`
}

// Only this small index is retained in memory. Canvas bodies live in Git blobs.
type canvasMetadata struct {
	Name    string    `json:"name"`
	Updated time.Time `json:"updated"`
	Blob    string    `json:"blob"`
}
type storeState struct {
	Version  int                       `json:"version"`
	Canvases map[string]canvasMetadata `json:"canvases"`
}
type store struct {
	mu                  sync.Mutex
	dir                 string
	limit               int64
	failed              bool
	closed              bool
	lock                *os.File
	head                string
	ref                 string
	state               storeState
	cache               *blobCache
	dirtySince          time.Time
	retryAfter          time.Time
	maintenanceRequests chan time.Time
	pending             map[string]*pendingCanvas
	pendingBytes        int
	pendingBudget       int
	commitDelay         time.Duration
	pendingRequests     chan struct{}
}

var canvasID = regexp.MustCompile(`^[a-f0-9]{32}$`)
var commitID = regexp.MustCompile(`^(?:[a-f0-9]{40}|[a-f0-9]{64})$`)
var errCanvasNotFound = errors.New("canvas not found")

const statePath = "state.json"

func revision(data []byte) string {
	sum := sha256.Sum256(data)
	return `"` + hex.EncodeToString(sum[:]) + `"`
}

// Like picomx, isolate inherited Git configuration and require durable objects
// before publishing a ref. Plumbing commands never use an index or working tree.
// Processes are short lived here, keeping idle memory small for personal use.
func (s *store) gitInput(input io.Reader, args ...string) ([]byte, error) {
	return s.runGit(context.Background(), 20*time.Second, input, args...)
}

func (s *store) runGit(parent context.Context, timeout time.Duration, input io.Reader, args ...string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(parent, timeout)
	defer cancel()
	options := []string{"--git-dir=" + s.dir,
		"-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false",
		"-c", "core.attributesFile=/dev/null", "-c", "core.autocrlf=false",
		"-c", "commit.gpgSign=false", "-c", "gc.auto=0", "-c", "maintenance.auto=false",
		"-c", "pack.threads=1", "-c", "core.fsync=committed", "-c", "core.fsyncMethod=fsync"}
	cmd := exec.CommandContext(ctx, "git", append(options, args...)...)
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Cancel = func() error { return syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL) }
	cmd.WaitDelay = time.Second
	for _, variable := range os.Environ() {
		if !strings.HasPrefix(variable, "GIT_") {
			cmd.Env = append(cmd.Env, variable)
		}
	}
	cmd.Env = append(cmd.Env, "GIT_CONFIG_NOSYSTEM=1", "GIT_CONFIG_GLOBAL=/dev/null",
		"GIT_NO_REPLACE_OBJECTS=1", "GIT_TERMINAL_PROMPT=0",
		"GIT_AUTHOR_NAME=drawsrv", "GIT_AUTHOR_EMAIL=drawsrv@localhost",
		"GIT_COMMITTER_NAME=drawsrv", "GIT_COMMITTER_EMAIL=drawsrv@localhost")
	cmd.Stdin = input
	var output, stderr bytes.Buffer
	cmd.Stdout, cmd.Stderr = &output, &stderr
	if err := cmd.Run(); err != nil {
		return nil, fmt.Errorf("git %s: %w: %s", args[0], err, strings.TrimSpace(stderr.String()))
	}
	return output.Bytes(), nil
}
func (s *store) git(args ...string) ([]byte, error) { return s.gitInput(nil, args...) }
func (s *store) Close() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.closed = true
	if s.lock == nil {
		return nil
	}
	flushErr := s.flushAll()
	err := s.lock.Close()
	s.lock = nil
	return errors.Join(flushErr, err)
}

func openStore(dir string, limit int64) (result *store, err error) {
	if _, err := exec.LookPath("git"); err != nil {
		return nil, fmt.Errorf("Git 2.36+ is required: %w", err)
	}
	// Reject the old format before writing anything. No migration is performed.
	if _, err := os.Lstat(filepath.Join(dir, ".git")); err == nil {
		return nil, errors.New("data has a working copy; select a new empty directory for the bare repository (no migration)")
	} else if !os.IsNotExist(err) {
		return nil, err
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	_, headErr := os.Lstat(filepath.Join(dir, "HEAD"))
	if headErr != nil && !os.IsNotExist(headErr) {
		return nil, headErr
	}
	if os.IsNotExist(headErr) {
		for _, entry := range entries {
			if entry.Name() != "drawsrv.lock" {
				return nil, errors.New("new bare data directory must be empty; existing Git data requires HEAD repair")
			}
		}
	}
	s := &store{dir: dir, limit: limit, cache: newBlobCache(defaultCacheBytes), maintenanceRequests: make(chan time.Time, 1), pending: make(map[string]*pendingCanvas), pendingBudget: defaultPendingBytes, commitDelay: defaultCommitDelay, pendingRequests: make(chan struct{}, 1)}
	s.lock, err = os.OpenFile(filepath.Join(dir, "drawsrv.lock"), os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return nil, err
	}
	defer func() {
		if err != nil {
			s.Close()
		}
	}()
	if err = syscall.Flock(int(s.lock.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		return nil, fmt.Errorf("data directory already in use: %w", err)
	}
	version, err := s.git("version")
	if err != nil {
		return nil, err
	}
	fields := strings.Fields(string(version))
	if len(fields) < 3 {
		return nil, errors.New("cannot determine Git version")
	}
	numbers := strings.Split(fields[2], ".")
	if len(numbers) < 2 {
		return nil, errors.New("cannot determine Git version")
	}
	major, majorErr := strconv.Atoi(numbers[0])
	minor, minorErr := strconv.Atoi(numbers[1])
	if majorErr != nil || minorErr != nil || major < 2 || (major == 2 && minor < 36) {
		return nil, errors.New("Git 2.36 or newer is required")
	}
	if os.IsNotExist(headErr) {
		if _, err = s.git("init", "--bare", "--template=", "--initial-branch=main"); err != nil {
			return nil, err
		}
	}
	bare, err := s.git("rev-parse", "--is-bare-repository")
	if err != nil {
		return nil, err
	}
	if strings.TrimSpace(string(bare)) != "true" {
		return nil, errors.New("data must be a bare Git repository")
	}
	ref, err := s.git("symbolic-ref", "HEAD")
	if err != nil {
		return nil, errors.New("bare repository HEAD must point to a branch")
	}
	s.ref = strings.TrimSpace(string(ref))
	if !strings.HasPrefix(s.ref, "refs/heads/") || strings.ContainsAny(s.ref, "\r\n") {
		return nil, errors.New("invalid data branch")
	}
	head, headErr := s.git("rev-parse", "--verify", "HEAD^{commit}")
	if headErr != nil {
		if err = s.requireUnborn(); err != nil {
			return nil, err
		}
		s.state = storeState{Version: 1, Canvases: map[string]canvasMetadata{}}
		if err = s.publish(s.state, "canvas: initialize bare store"); err != nil {
			return nil, err
		}
	} else {
		s.head = strings.TrimSpace(string(head))
		if err = s.loadState(); err != nil {
			return nil, err
		}
	}
	// Reconsider maintenance after restart, including writes from a prior run.
	s.markDirty()
	return s, nil
}

// A missing branch after previous writes must never silently create a new
// history. Even unreferenced objects require explicit administrator recovery.
func (s *store) requireUnborn() error {
	found := errors.New("bare repository has existing Git data; repair HEAD before restarting")
	for _, name := range []string{"objects", "refs", "logs"} {
		root := filepath.Join(s.dir, name)
		if err := filepath.WalkDir(root, func(path string, entry fs.DirEntry, err error) error {
			if os.IsNotExist(err) && path == root {
				return nil
			}
			if err != nil {
				return err
			}
			if !entry.IsDir() {
				return found
			}
			return nil
		}); err != nil {
			return err
		}
	}
	if info, err := os.Stat(filepath.Join(s.dir, "packed-refs")); err == nil {
		if info.Size() != 0 {
			return found
		}
	} else if !os.IsNotExist(err) {
		return err
	}
	return nil
}

func (s *store) loadState() error {
	body, err := s.git("show", s.head+":"+statePath)
	if err != nil {
		return fmt.Errorf("read committed store state: %w", err)
	}
	var state storeState
	if json.Unmarshal(body, &state) != nil || state.Version != 1 || state.Canvases == nil {
		return errors.New("invalid committed store state")
	}
	for id, meta := range state.Canvases {
		if !canvasID.MatchString(id) || !commitID.MatchString(meta.Blob) || strings.TrimSpace(meta.Name) == "" || len(meta.Name) > 200 || meta.Updated.IsZero() {
			return errors.New("invalid committed canvas metadata")
		}
	}
	// Verify the manifest against the tree without reading all canvas bodies.
	tree, err := s.git("ls-tree", "-z", s.head)
	if err != nil {
		return err
	}
	count := 0
	for _, entry := range bytes.Split(tree, []byte{0}) {
		if len(entry) == 0 {
			continue
		}
		fields := bytes.SplitN(entry, []byte{'\t'}, 2)
		if len(fields) != 2 {
			return errors.New("invalid committed tree")
		}
		info := strings.Fields(string(fields[0]))
		path := string(fields[1])
		if len(info) != 3 || info[0] != "100644" || info[1] != "blob" {
			return errors.New("invalid committed tree entry")
		}
		if path == statePath {
			continue
		}
		id := strings.TrimSuffix(path, ".json")
		meta, ok := state.Canvases[id]
		if !ok || path != id+".json" || info[2] != meta.Blob {
			return errors.New("canvas tree does not match committed metadata")
		}
		count++
	}
	if count != len(state.Canvases) {
		return errors.New("canvas missing from committed tree")
	}
	s.state = state
	return nil
}

func decodeSnapshot(body []byte) (*snapshot, error) {
	var state snapshot
	if json.Unmarshal(body, &state) != nil || state.Elements == nil || state.AppState == nil || state.Files == nil || strings.TrimSpace(state.Name) == "" || len(state.Name) > 200 {
		return nil, errors.New("invalid canvas (name, elements, appState and files required)")
	}
	state.Name = strings.TrimSpace(state.Name)
	if state.LibraryItems == nil {
		state.LibraryItems = []json.RawMessage{}
	}
	return &state, nil
}

func (s *store) read(id string) ([]byte, error) {
	if entry := s.pending[id]; entry != nil {
		return entry.body, nil
	}
	return s.readCommitted(id)
}
func (s *store) readCommitted(id string) ([]byte, error) {
	meta, ok := s.state.Canvases[id]
	if !ok {
		return nil, errCanvasNotFound
	}
	return s.readBlob(meta.Blob)
}
func (s *store) readBlob(oid string) ([]byte, error) {
	if body, ok := s.cache.get(oid); ok {
		return body, nil
	}
	size, err := s.git("cat-file", "-s", oid)
	if err != nil {
		return nil, err
	}
	n, err := strconv.ParseInt(strings.TrimSpace(string(size)), 10, 64)
	if err != nil || n < 0 || n > s.limit {
		return nil, errors.New("committed canvas exceeds size limit")
	}
	body, err := s.git("cat-file", "blob", oid)
	if err == nil {
		s.cache.add(oid, body)
	}
	return body, err
}
func (s *store) writeBlob(body []byte) (string, error) {
	out, err := s.gitInput(bytes.NewReader(body), "hash-object", "-w", "--stdin")
	oid := strings.TrimSpace(string(out))
	if err != nil {
		return "", err
	}
	if !commitID.MatchString(oid) {
		return "", errors.New("invalid Git blob ID")
	}
	s.markDirty()
	return oid, nil
}

func (s *store) save(id string, body, previous []byte, message string) error {
	return s.saveAt(id, body, previous, message, time.Now().UTC())
}
func (s *store) saveAt(id string, body, previous []byte, message string, updated time.Time) error {
	if bytes.Equal(body, previous) {
		return nil
	}
	state, err := decodeSnapshot(body)
	if err != nil {
		return err
	}
	blob, err := s.writeBlob(body)
	if err != nil {
		return err
	}
	next := storeState{Version: 1, Canvases: make(map[string]canvasMetadata, len(s.state.Canvases)+1)}
	for key, meta := range s.state.Canvases {
		next.Canvases[key] = meta
	}
	next.Canvases[id] = canvasMetadata{Name: state.Name, Updated: updated.UTC(), Blob: blob}
	if err := s.publish(next, message+" "+id); err != nil {
		return err
	}
	s.cache.add(blob, body)
	return nil
}

// Write immutable blobs/tree/commit first, then atomically publish the branch
// with an expected-old-ID check. A crash before publication leaves HEAD intact;
// after publication the committed state is sufficient to restart. No rollback.
func (s *store) publish(next storeState, message string) error {
	metadata, err := json.MarshalIndent(next, "", "  ")
	if err != nil {
		return err
	}
	stateBlob, err := s.writeBlob(metadata)
	if err != nil {
		return err
	}
	paths := make([]string, 0, len(next.Canvases))
	for key := range next.Canvases {
		paths = append(paths, key)
	}
	sort.Strings(paths)
	var tree bytes.Buffer
	for _, key := range paths {
		fmt.Fprintf(&tree, "100644 blob %s\t%s.json\x00", next.Canvases[key].Blob, key)
	}
	fmt.Fprintf(&tree, "100644 blob %s\t%s\x00", stateBlob, statePath)
	out, err := s.gitInput(&tree, "mktree", "-z")
	if err != nil {
		return err
	}
	treeID := strings.TrimSpace(string(out))
	args := []string{"commit-tree", treeID, "-m", message}
	if s.head != "" {
		args = append(args, "-p", s.head)
	}
	out, err = s.git(args...)
	if err != nil {
		return err
	}
	commit := strings.TrimSpace(string(out))
	if !commitID.MatchString(commit) {
		return errors.New("invalid Git commit ID")
	}
	old := s.head
	if old == "" {
		old = strings.Repeat("0", len(commit))
	}
	if _, err = s.git("update-ref", s.ref, commit, old); err != nil {
		// Publication could be uncertain (e.g. timeout); never write from stale state.
		s.failed = true
		return err
	}
	head, err := s.git("rev-parse", "--verify", "HEAD^{commit}")
	if err != nil || strings.TrimSpace(string(head)) != commit {
		s.failed = true
		return fmt.Errorf("cannot verify Git publication: %v", err)
	}
	s.head = commit
	s.state = next
	return nil
}
