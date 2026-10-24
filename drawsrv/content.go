package main

import (
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"sort"
	"strconv"
)

// Canonical, typed encoding shared with content.ts. Numbers use their IEEE754
// bits, keys sort by UTF-8 bytes, and strings carry their UTF-8 byte length.
// This avoids differences in JSON escaping, key order and number formatting.
func canonicalValue(out io.Writer, value any) {
	switch v := value.(type) {
	case nil:
		io.WriteString(out, "n")
	case bool:
		if v {
			io.WriteString(out, "t")
		} else {
			io.WriteString(out, "f")
		}
	case float64:
		if v == 0 {
			v = 0
		}
		fmt.Fprintf(out, "d%016x", math.Float64bits(v))
	case string:
		io.WriteString(out, "s"+strconv.Itoa(len(v))+":")
		io.WriteString(out, v)
	case []any:
		io.WriteString(out, "a"+strconv.Itoa(len(v))+":")
		for _, item := range v {
			canonicalValue(out, item)
		}
	case map[string]any:
		keys := make([]string, 0, len(v))
		for key := range v {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		io.WriteString(out, "o"+strconv.Itoa(len(keys))+":")
		for _, key := range keys {
			canonicalValue(out, key)
			canonicalValue(out, v[key])
		}
	default:
		panic("canonicalValue requires decoded JSON")
	}
}
func valueHash(value any) string {
	hash := sha256.New()
	canonicalValue(hash, value)
	return hex.EncodeToString(hash.Sum(nil))
}
func sameValue(a, b any) bool { return valueHash(a) == valueHash(b) }

var elementBookkeeping = map[string]bool{"updated": true, "version": true, "versionNonce": true}

func effectiveElement(element any) any {
	object, ok := element.(map[string]any)
	if !ok {
		return element
	}
	copy := make(map[string]any, len(object))
	for key, value := range object {
		if !elementBookkeeping[key] {
			copy[key] = value
		}
	}
	if copy["boundElements"] == nil {
		copy["boundElements"] = []any{}
	}
	return copy
}
func effectiveDocument(document map[string]any) map[string]any {
	result := map[string]any{"name": document["name"]}
	elements := []any{}
	for _, element := range document["elements"].([]any) {
		elements = append(elements, effectiveElement(element))
	}
	result["elements"] = elements
	files := map[string]any{}
	for id, file := range document["files"].(map[string]any) {
		if object, ok := file.(map[string]any); ok {
			copy := map[string]any{}
			for key, value := range object {
				if key != "created" && key != "lastRetrieved" {
					copy[key] = value
				}
			}
			files[id] = copy
		} else {
			files[id] = file
		}
	}
	result["files"] = files
	items := []any{}
	if library, ok := document["libraryItems"].([]any); ok {
		for _, item := range library {
			if object, ok := item.(map[string]any); ok {
				copy := map[string]any{}
				for key, value := range object {
					if key != "created" {
						copy[key] = value
					}
				}
				if contents, ok := copy["elements"].([]any); ok {
					clean := make([]any, 0, len(contents))
					for _, element := range contents {
						clean = append(clean, effectiveElement(element))
					}
					copy["elements"] = clean
				}
				items = append(items, copy)
			} else {
				items = append(items, item)
			}
		}
	}
	result["libraryItems"] = items
	return result
}
func documentJSON(body []byte) (map[string]any, error) {
	var document map[string]any
	if err := json.Unmarshal(body, &document); err != nil {
		return nil, err
	}
	if _, ok := document["elements"].([]any); !ok {
		return nil, fmt.Errorf("elements must be an array")
	}
	if _, ok := document["files"].(map[string]any); !ok {
		return nil, fmt.Errorf("files must be an object")
	}
	return document, nil
}
func contentHash(body []byte) string {
	document, err := documentJSON(body)
	if err != nil {
		return ""
	}
	return valueHash(effectiveDocument(document))
}

// The server owns revision metadata. A client changing only bookkeeping is a
// no-op. Restore and the compatibility PUT endpoint follow the same rule.
func stampElements(previous, next []any, now int64) {
	old := map[string]map[string]any{}
	for _, item := range previous {
		if element, ok := item.(map[string]any); ok {
			if id, ok := element["id"].(string); ok {
				old[id] = element
			}
		}
	}
	for _, item := range next {
		element, ok := item.(map[string]any)
		if !ok {
			continue
		}
		id, _ := element["id"].(string)
		before := old[id]
		if before != nil && sameValue(effectiveElement(before), effectiveElement(element)) {
			for key := range elementBookkeeping {
				if v, ok := before[key]; ok {
					element[key] = v
				} else {
					delete(element, key)
				}
			}
			continue
		}
		element["updated"] = float64(now)
		version, _ := before["version"].(float64)
		element["version"] = max(1, version+1)
		hash, _ := hex.DecodeString(valueHash(effectiveElement(element)))
		element["versionNonce"] = float64(binary.BigEndian.Uint32(hash[:4]) & 0x7fffffff)
	}
}
