-- +goose Up
UPDATE user_preferences
SET prefs = jsonb_set(prefs, '{palette}', '"ferricade"'::jsonb)
WHERE prefs->>'palette' = 'default';

-- +goose Down
UPDATE user_preferences
SET prefs = jsonb_set(prefs, '{palette}', '"default"'::jsonb)
WHERE prefs->>'palette' IN ('ferricade', 'indigo');
