package main

import (
	"encoding/json"
	"os"
	"strings"
	"testing"
)

func TestContentHashIgnoresBookkeepingButPreservesSemanticChanges(t *testing.T) {
	one := []byte(`{"name":"画布<&","elements":[{"id":"a","boundElements":null,"updated":1,"version":1,"versionNonce":10,"customData":{"updated":9}}],"files":{},"libraryItems":[]}`)
	two := []byte(`{"libraryItems":[],"files":{},"elements":[{"customData":{"updated":9},"versionNonce":20,"version":2,"updated":999,"boundElements":[],"id":"a"}],"name":"画布<&"}`)
	if contentHash(one) != contentHash(two) {
		t.Fatal("bookkeeping changed content hash")
	}
	if contentHash(one) == contentHash([]byte(strings.Replace(string(two), `"updated":9`, `"updated":10`, 1))) {
		t.Fatal("custom data timestamp stripped")
	}
}

func TestContentHashMatchesBrowserFixtures(t *testing.T) {
	body, err := os.ReadFile("web/testdata/content-hash.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixtures []struct {
		Document json.RawMessage `json:"document"`
		Hash     string          `json:"hash"`
	}
	if err := json.Unmarshal(body, &fixtures); err != nil {
		t.Fatal(err)
	}
	for _, fixture := range fixtures {
		if got := contentHash(fixture.Document); got != fixture.Hash {
			t.Fatalf("Go/browser hash mismatch: %s != %s", got, fixture.Hash)
		}
	}
}
