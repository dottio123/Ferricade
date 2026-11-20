package deploy

import (
	_ "embed"
	"encoding/json"
)

//go:embed catalog.json
var catalogJSON []byte

type Setting struct {
	Key         string            `json:"key"`
	Label       string            `json:"label"`
	Help        string            `json:"help"`
	Type        string            `json:"type"`
	Default     string            `json:"default"`
	Values      []string          `json:"values"`
	ValueLabels map[string]string `json:"value_labels"`
	OS          []string          `json:"os"`
	Lock        bool              `json:"lock"`
	Source      string            `json:"source"`
}

var settingsCatalog = func() []Setting {
	var settings []Setting
	if err := json.Unmarshal(catalogJSON, &settings); err != nil {
		panic(err)
	}
	return settings
}()

func Catalog() []Setting {
	result := make([]Setting, len(settingsCatalog))
	for i, setting := range settingsCatalog {
		result[i] = setting
		result[i].Values = append([]string(nil), setting.Values...)
		result[i].OS = append([]string(nil), setting.OS...)
		result[i].ValueLabels = cloneLabels(setting.ValueLabels)
	}
	return result
}

func Lookup(key string) (Setting, bool) {
	for _, setting := range settingsCatalog {
		if setting.Key == key {
			setting.Values = append([]string(nil), setting.Values...)
			setting.OS = append([]string(nil), setting.OS...)
			setting.ValueLabels = cloneLabels(setting.ValueLabels)
			return setting, true
		}
	}
	return Setting{}, false
}

func cloneLabels(labels map[string]string) map[string]string {
	if labels == nil {
		return nil
	}
	result := make(map[string]string, len(labels))
	for value, label := range labels {
		result[value] = label
	}
	return result
}
