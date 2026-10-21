-- TRANSLATION PREPARED MODELS — a model shown to run on this computer: started by its engine on the GPU, with its
-- test translation accepted. A model is "Ready" only while its row stands.
--
-- ADDITIVE ONLY: one new table, and NOT ONE existing table or column is altered.
--
-- ONE ROW PER MODEL, bound to the exact model file and the exact engine it was prepared with (their catalog SHA-256):
-- a model or an engine of other bytes is not prepared, whatever its row says. Written and removed only by the backend.
CREATE TABLE IF NOT EXISTS translation_prepared (
  model         TEXT NOT NULL PRIMARY KEY CHECK (length(model) > 0),
  model_sha256  TEXT NOT NULL CHECK (length(model_sha256) = 64),
  engine_sha256 TEXT NOT NULL CHECK (length(engine_sha256) = 64),
  device        TEXT NOT NULL CHECK (length(device) > 0),
  prepared_at   INTEGER NOT NULL CHECK (prepared_at > 0)
);
