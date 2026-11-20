package adminapi

import (
	"errors"
	"net/http"

	"github.com/dottio123/ferricade/internal/grouprules"
)

func (a *api) autoSortPreview(w http.ResponseWriter, r *http.Request) {
	result, err := a.d.GroupRules.AutoSortPreview(r.Context())
	if err != nil {
		a.writeGroupRulesError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (a *api) autoSort(w http.ResponseWriter, r *http.Request) {
	actor, ok := a.actor(w, r)
	if !ok {
		return
	}
	result, err := a.d.GroupRules.AutoSort(r.Context(), actor)
	if err != nil {
		a.writeGroupRulesError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (a *api) writeGroupRulesError(w http.ResponseWriter, r *http.Request, err error) {
	if errors.Is(err, grouprules.ErrAutoSortBusy) {
		writeError(w, http.StatusServiceUnavailable, codeBusy, grouprules.ErrAutoSortBusy.Error())
		return
	}
	if errors.Is(err, grouprules.ErrPatternTaken) {
		writeError(w, http.StatusConflict, codePatternTaken, "pattern already exists in this group")
		return
	}
	a.writeDevicesError(w, r, err)
}

func (a *api) listGroupRules(w http.ResponseWriter, r *http.Request) {
	rules, err := a.d.GroupRules.List(r.Context())
	if err != nil {
		a.writeGroupRulesError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, listJSON[grouprules.RuleView]{Items: rules})
}

func (a *api) addGroupRule(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r, "id")
	if !ok {
		return
	}
	act, ok := a.actor(w, r)
	if !ok {
		return
	}
	var req struct {
		Pattern string `json:"pattern"`
	}
	if !decode(w, r, &req) {
		return
	}
	rule, err := a.d.GroupRules.Add(r.Context(), act, id, req.Pattern)
	if err != nil {
		a.writeGroupRulesError(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, rule)
}

func (a *api) removeGroupRule(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r, "id")
	if !ok {
		return
	}
	ruleID, ok := pathID(w, r, "rule_id")
	if !ok {
		return
	}
	act, ok := a.actor(w, r)
	if !ok {
		return
	}
	if err := a.d.GroupRules.Remove(r.Context(), act, id, ruleID); err != nil {
		a.writeGroupRulesError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (a *api) previewGroupRule(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r, "id")
	if !ok {
		return
	}
	var req struct {
		Pattern string `json:"pattern"`
	}
	if !decode(w, r, &req) {
		return
	}
	preview, err := a.d.GroupRules.Preview(r.Context(), id, req.Pattern)
	if err != nil {
		a.writeGroupRulesError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, preview)
}
