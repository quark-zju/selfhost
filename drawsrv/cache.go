package main

import "container/list"

const defaultCacheBytes = 4 << 20
const maxCacheEntries = 64

type cachedBlob struct {
	oid  string
	body []byte
}

// A byte budget alone would allow unlimited tiny entries. Bound both payload
// bytes and entry count. The caller holds store.mu; cached bytes are immutable.
type blobCache struct {
	budget  int
	used    int
	entries map[string]*list.Element
	recent  list.List
}

func newBlobCache(budget int) *blobCache {
	return &blobCache{budget: budget, entries: make(map[string]*list.Element)}
}
func (c *blobCache) get(oid string) ([]byte, bool) {
	if c == nil {
		return nil, false
	}
	entry, ok := c.entries[oid]
	if !ok {
		return nil, false
	}
	c.recent.MoveToFront(entry)
	return entry.Value.(cachedBlob).body, true
}
func (c *blobCache) add(oid string, body []byte) {
	if c == nil || c.budget <= 0 || len(body) > c.budget {
		return
	}
	if entry, ok := c.entries[oid]; ok {
		c.recent.MoveToFront(entry)
		return
	}
	for c.used+len(body) > c.budget || len(c.entries) >= maxCacheEntries {
		entry := c.recent.Back()
		old := entry.Value.(cachedBlob)
		c.used -= len(old.body)
		delete(c.entries, old.oid)
		c.recent.Remove(entry)
	}
	// Don't retain a larger backing buffer owned by a Git command or HTTP body.
	copyOfBody := make([]byte, len(body))
	copy(copyOfBody, body)
	c.entries[oid] = c.recent.PushFront(cachedBlob{oid, copyOfBody})
	c.used += len(body)
}
