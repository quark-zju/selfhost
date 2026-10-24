package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"slices"
	"strings"
	"time"
)

const maxChanges = 4096

type fieldValue struct {
	Present bool `json:"present"`
	Value   any  `json:"value,omitempty"`
}
type fieldChange struct {
	Field  string     `json:"field"`
	Before fieldValue `json:"before"`
	After  fieldValue `json:"after"`
}
type change struct {
	Target  string        `json:"target"`
	ID      string        `json:"id,omitempty"`
	Before  fieldValue    `json:"before"`
	After   fieldValue    `json:"after"`
	Fields  []fieldChange `json:"fields,omitempty"`
	AfterID string        `json:"afterId,omitempty"`
}
type droppedChange struct {
	Index  int    `json:"index"`
	Reason string `json:"reason"`
}
type changeResult struct {
	Applied []int           `json:"applied"`
	Dropped []droppedChange `json:"dropped"`
	Hash    string          `json:"hash"`
}

func lookup(object map[string]any, key string) fieldValue {
	v, ok := object[key]
	return fieldValue{ok, v}
}
func equalSlot(a, b fieldValue) bool {
	return a.Present == b.Present && (!a.Present || sameValue(a.Value, b.Value))
}
func setSlot(object map[string]any, key string, value fieldValue) {
	if value.Present {
		object[key] = value.Value
	} else {
		delete(object, key)
	}
}
func objectID(value any) string {
	object, _ := value.(map[string]any)
	id, _ := object["id"].(string)
	return id
}

func collection(document map[string]any, target string) (map[string]any, []string, error) {
	objects := map[string]any{}
	order := []string{}
	if target == "files" {
		for id, value := range document["files"].(map[string]any) {
			objects[id] = value
		}
		return objects, order, nil
	}
	items, _ := document[target].([]any)
	for _, item := range items {
		id := objectID(item)
		if id == "" {
			return nil, nil, errors.New("element/library item missing id")
		}
		if _, ok := objects[id]; ok {
			return nil, nil, errors.New("duplicate id")
		}
		objects[id] = item
		order = append(order, id)
	}
	return objects, order, nil
}

func validateChanges(changes []change) error {
	if len(changes) > maxChanges {
		return errors.New("too many changes")
	}
	seen := map[string]bool{}
	for _, op := range changes {
		if op.Target != "elements" && op.Target != "files" && op.Target != "libraryItems" && op.Target != "name" && op.Target != "elementOrder" && op.Target != "libraryOrder" {
			return errors.New("invalid change target")
		}
		key := op.Target + ":" + op.ID
		if seen[key] {
			return errors.New("multiple changes to the same target")
		}
		seen[key] = true
		if op.Target == "elements" || op.Target == "files" || op.Target == "libraryItems" {
			if op.ID == "" || len(op.ID) > 256 {
				return errors.New("id required")
			}
		} else if op.ID != "" {
			return errors.New("unexpected id")
		}
		if len(op.Fields) > 0 {
			if op.Target != "elements" || op.Before.Present || op.After.Present || len(op.Fields) > 256 {
				return errors.New("invalid field update")
			}
			fields := map[string]bool{}
			for _, field := range op.Fields {
				if field.Field == "" || field.Field == "id" || elementBookkeeping[field.Field] || fields[field.Field] {
					return errors.New("invalid or server-owned field")
				}
				fields[field.Field] = true
			}
		} else if !op.Before.Present && !op.After.Present {
			return errors.New("empty change")
		}
		if len(op.Fields) == 0 && op.After.Present && (op.Target == "elements" || op.Target == "libraryItems" || op.Target == "files") {
			if _, ok := op.After.Value.(map[string]any); !ok || objectID(op.After.Value) != op.ID {
				return errors.New("new object id mismatch")
			}
			if op.Target == "libraryItems" {
				object := op.After.Value.(map[string]any)
				if _, ok := object["elements"].([]any); !ok {
					return errors.New("library elements must be an array")
				}
			}
			if op.Target == "elements" && op.Before.Present {
				return errors.New("use field changes to update elements")
			}
		}
		if op.Target == "name" {
			name, ok := op.After.Value.(string)
			if !op.After.Present || !ok || strings.TrimSpace(name) == "" || name != strings.TrimSpace(name) || len(name) > 200 {
				return errors.New("invalid canvas name")
			}
		}
	}
	return nil
}

func reorder(order []string, before, after any) ([]string, bool) {
	toIDs := func(value any) ([]string, bool) {
		array, ok := value.([]any)
		if !ok {
			return nil, false
		}
		ids := []string{}
		seen := map[string]bool{}
		for _, v := range array {
			id, ok := v.(string)
			if !ok || id == "" || seen[id] {
				return nil, false
			}
			seen[id] = true
			ids = append(ids, id)
		}
		return ids, true
	}
	old, ok := toIDs(before)
	if !ok {
		return order, false
	}
	next, ok := toIDs(after)
	if !ok {
		return order, false
	}
	set := map[string]bool{}
	for _, id := range old {
		set[id] = true
	}
	if len(old) != len(next) {
		return order, false
	}
	for _, id := range next {
		if !set[id] {
			return order, false
		}
	}
	actual := []string{}
	for _, id := range order {
		if set[id] {
			actual = append(actual, id)
		}
	}
	if slices.Equal(actual, next) {
		return order, true
	}
	if !slices.Equal(actual, old) {
		return order, false
	}
	result := slices.Clone(order)
	index := 0
	for i, id := range result {
		if set[id] {
			result[i] = next[index]
			index++
		}
	}
	return result, true
}

func references(element any) []string {
	object, ok := element.(map[string]any)
	if !ok {
		return nil
	}
	refs := []string{}
	for _, key := range []string{"containerId", "frameId"} {
		if id, ok := object[key].(string); ok && id != "" {
			refs = append(refs, id)
		}
	}
	for _, key := range []string{"startBinding", "endBinding"} {
		if binding, ok := object[key].(map[string]any); ok {
			if id, ok := binding["elementId"].(string); ok {
				refs = append(refs, id)
			}
		}
	}
	if bindings, ok := object["boundElements"].([]any); ok {
		for _, binding := range bindings {
			if id := objectID(binding); id != "" {
				refs = append(refs, id)
			}
		}
	}
	return refs
}

// Apply conditional operations against one private candidate. Each element's
// field set is atomic; independent elements can succeed when another conflicts.
func applyChanges(document map[string]any, changes []change, now int64) (map[string]any, changeResult, error) {
	if err := validateChanges(changes); err != nil {
		return nil, changeResult{}, err
	}
	clean := effectiveDocument(document)
	objects := map[string]map[string]any{}
	orders := map[string][]string{}
	for _, target := range []string{"elements", "files", "libraryItems"} {
		values, order, err := collection(clean, target)
		if err != nil {
			return nil, changeResult{}, err
		}
		objects[target] = values
		orders[target] = order
	}
	original := map[string]map[string]any{}
	for target, values := range objects {
		original[target] = map[string]any{}
		for id, value := range values {
			original[target][id] = value
		}
	}
	accepted := make([]bool, len(changes))
	reasons := make([]string, len(changes))
	elementOps := map[string]int{}
	for i, op := range changes {
		if op.Target == "elementOrder" || op.Target == "libraryOrder" {
			continue
		}
		if op.Target == "name" {
			if sameValue(clean["name"], op.After.Value) || sameValue(clean["name"], op.Before.Value) {
				clean["name"] = op.After.Value
				accepted[i] = true
			} else {
				reasons[i] = "precondition changed"
			}
			continue
		}
		values := objects[op.Target]
		current := lookup(values, op.ID)
		if len(op.Fields) > 0 {
			element, ok := current.Value.(map[string]any)
			if !current.Present || !ok {
				reasons[i] = "element no longer exists"
				continue
			}
			compatible := true
			for _, field := range op.Fields {
				slot := lookup(element, field.Field)
				if !equalSlot(slot, field.Before) && !equalSlot(slot, field.After) {
					compatible = false
					break
				}
			}
			if !compatible {
				reasons[i] = "field precondition changed"
				continue
			}
			copy := map[string]any{}
			for key, value := range element {
				copy[key] = value
			}
			for _, field := range op.Fields {
				setSlot(copy, field.Field, field.After)
			}
			values[op.ID] = effectiveElement(copy)
		} else {
			before, after := op.Before, op.After
			if op.Target == "elements" {
				if before.Present {
					before.Value = effectiveElement(before.Value)
				}
				if after.Present {
					after.Value = effectiveElement(after.Value)
				}
			}
			if !equalSlot(current, before) && !equalSlot(current, after) {
				reasons[i] = "object precondition changed"
				continue
			}
			setSlot(values, op.ID, after)
			if !current.Present && after.Present {
				order := orders[op.Target]
				position := len(order)
				if op.AfterID == "" {
					position = 0
				} else if index := slices.Index(order, op.AfterID); index >= 0 {
					position = index + 1
				}
				orders[op.Target] = slices.Insert(order, position, op.ID)
			}
		}
		accepted[i] = true
		if op.Target == "elements" {
			elementOps[op.ID] = i
		}
	}
	// Reject dangling association edits. Reverse dependencies propagate rejection
	// of an addition to other additions that reference it, without repeated scans.
	dependents := map[string][]int{}
	queue := []int{}
	for id, index := range elementOps {
		if !accepted[index] {
			continue
		}
		element, exists := objects["elements"][id]
		if !exists {
			continue
		}
		bad := false
		for _, ref := range references(element) {
			dependents[ref] = append(dependents[ref], index)
			if _, ok := objects["elements"][ref]; !ok {
				bad = true
			}
		}
		if object, ok := element.(map[string]any); ok {
			if fileID, ok := object["fileId"].(string); ok && fileID != "" {
				if _, exists := objects["files"][fileID]; !exists {
					bad = true
				}
			}
		}
		if bad {
			queue = append(queue, index)
		}
	}
	for cursor := 0; cursor < len(queue); cursor++ {
		index := queue[cursor]
		if !accepted[index] {
			continue
		}
		op := changes[index]
		accepted[index] = false
		reasons[index] = "referenced element or file no longer exists"
		if previous, exists := original["elements"][op.ID]; exists {
			objects["elements"][op.ID] = previous
		} else {
			delete(objects["elements"], op.ID)
			queue = append(queue, dependents[op.ID]...)
		}
	}
	// Library elements have their own ID namespace; reject a whole library
	// edit if a binding points outside that item's surviving element set.
	for i, op := range changes {
		if !accepted[i] || op.Target != "libraryItems" || !op.After.Present {
			continue
		}
		item, _ := objects["libraryItems"][op.ID].(map[string]any)
		contents, _ := item["elements"].([]any)
		ids := map[string]bool{}
		valid := true
		for _, element := range contents {
			id := objectID(element)
			if id == "" || ids[id] {
				valid = false
			}
			ids[id] = true
		}
		for _, element := range contents {
			for _, ref := range references(element) {
				if !ids[ref] {
					valid = false
				}
			}
		}
		if !valid {
			accepted[i] = false
			reasons[i] = "library references missing elements"
			if old, ok := original["libraryItems"][op.ID]; ok {
				objects["libraryItems"][op.ID] = old
			} else {
				delete(objects["libraryItems"], op.ID)
			}
		}
	}
	// Include library images when checking whether bytes may be removed.
	allElements := make([]any, 0, len(objects["elements"]))
	for _, element := range objects["elements"] {
		allElements = append(allElements, element)
	}
	for _, item := range objects["libraryItems"] {
		if object, ok := item.(map[string]any); ok {
			if contents, ok := object["elements"].([]any); ok {
				allElements = append(allElements, contents...)
			}
		}
	}
	// Keep image bytes if a concurrent/new element still needs a deleted file.
	for i, op := range changes {
		if !accepted[i] || op.Target != "files" || op.After.Present {
			continue
		}
		for _, element := range allElements {
			object, _ := element.(map[string]any)
			if object["fileId"] == op.ID {
				accepted[i] = false
				reasons[i] = "file is still referenced"
				objects["files"][op.ID] = original["files"][op.ID]
				break
			}
		}
	}
	for _, target := range []string{"elements", "libraryItems"} {
		orders[target] = slices.DeleteFunc(orders[target], func(id string) bool { _, ok := objects[target][id]; return !ok })
	}
	for i, op := range changes {
		target := ""
		if op.Target == "elementOrder" {
			target = "elements"
		}
		if op.Target == "libraryOrder" {
			target = "libraryItems"
		}
		if target == "" {
			continue
		}
		order, ok := reorder(orders[target], op.Before.Value, op.After.Value)
		if ok {
			orders[target] = order
			accepted[i] = true
		} else {
			reasons[i] = "order precondition changed"
		}
	}
	// Deleting an element also detaches existing associations to that element.
	deleted := map[string]bool{}
	for id := range original["elements"] {
		if _, ok := objects["elements"][id]; !ok {
			deleted[id] = true
		}
	}
	for _, element := range objects["elements"] {
		object, _ := element.(map[string]any)
		if object == nil {
			continue
		}
		for _, key := range []string{"containerId", "frameId"} {
			if id, ok := object[key].(string); ok && deleted[id] {
				object[key] = nil
			}
		}
		for _, key := range []string{"startBinding", "endBinding"} {
			if binding, ok := object[key].(map[string]any); ok {
				if id, ok := binding["elementId"].(string); ok && deleted[id] {
					object[key] = nil
				}
			}
		}
		if bound, ok := object["boundElements"].([]any); ok {
			filtered := []any{}
			for _, binding := range bound {
				if !deleted[objectID(binding)] {
					filtered = append(filtered, binding)
				}
			}
			object["boundElements"] = filtered
		}
	}
	for _, target := range []string{"elements", "libraryItems"} {
		items := []any{}
		for _, id := range orders[target] {
			items = append(items, objects[target][id])
		}
		clean[target] = items
	}
	clean["files"] = objects["files"]
	stampElements(document["elements"].([]any), clean["elements"].([]any), now)
	// Preserve/add file and library creation metadata outside effective content.
	for id, file := range objects["files"] {
		if object, ok := file.(map[string]any); ok {
			created := float64(now)
			oldFiles, _ := document["files"].(map[string]any)
			if old, ok := oldFiles[id].(map[string]any); ok {
				if v, ok := old["created"]; ok {
					createdValue := v
					object["created"] = createdValue
					continue
				}
			}
			object["created"] = created
		}
	}
	oldItems, _, _ := collection(document, "libraryItems")
	for _, item := range clean["libraryItems"].([]any) {
		object, _ := item.(map[string]any)
		if object == nil {
			continue
		}
		old, _ := oldItems[objectID(item)].(map[string]any)
		if created, ok := old["created"]; ok {
			object["created"] = created
		} else {
			object["created"] = float64(now)
		}
		next, _ := object["elements"].([]any)
		previous, _ := old["elements"].([]any)
		stampElements(previous, next, now)
	}
	result := changeResult{Applied: []int{}, Dropped: []droppedChange{}, Hash: valueHash(effectiveDocument(clean))}
	for i := range changes {
		if accepted[i] {
			result.Applied = append(result.Applied, i)
		} else {
			result.Dropped = append(result.Dropped, droppedChange{i, reasons[i]})
		}
	}
	return clean, result, nil
}

func (s *store) serveChanges(w http.ResponseWriter, r *http.Request, id string, current []byte, source string) {
	var request struct {
		Changes []change `json:"changes"`
	}
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 2*s.limit))
	if err != nil {
		http.Error(w, "changes too large", 413)
		return
	}
	if json.Unmarshal(body, &request) != nil || request.Changes == nil {
		http.Error(w, "changes array required", 400)
		return
	}
	document, err := documentJSON(current)
	if err != nil {
		http.Error(w, "cannot decode canvas", 500)
		return
	}
	now := time.Now()
	next, result, err := applyChanges(document, request.Changes, now.UnixMilli())
	if err != nil {
		http.Error(w, fmt.Sprint(err), 400)
		return
	}
	encoded, err := json.Marshal(next)
	if err != nil {
		http.Error(w, "cannot encode canvas", 500)
		return
	}
	state, err := decodeSnapshot(encoded)
	if err != nil {
		http.Error(w, fmt.Sprint(err), 400)
		return
	}
	encoded, _ = json.MarshalIndent(state, "", "  ")
	if int64(len(encoded)) > s.limit {
		http.Error(w, "result exceeds canvas limit", 413)
		return
	}
	// No effective change means no Git churn or persistence deadline reset.
	if result.Hash == contentHash(current) {
		encoded = current
	}
	_, err = s.stage(id, encoded, current, state.Name, now, source)
	if err != nil {
		log.Print(err)
		http.Error(w, "cannot apply changes", 500)
		return
	}
	s.setStateHeaders(w, id, encoded)
	json.NewEncoder(w).Encode(result)
}
