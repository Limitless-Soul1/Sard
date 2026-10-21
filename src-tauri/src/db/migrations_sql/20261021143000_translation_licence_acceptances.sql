-- TRANSLATION LICENCE ACCEPTANCES — the user's acceptance of the terms a model is distributed under, which Sard's
-- backend requires before it downloads that model.
--
-- ADDITIVE ONLY: one new table, and NOT ONE existing table or column is altered.
--
-- ONE ROW PER LICENCE AND REVISION OF ITS TERMS. A new revision is a new row to accept, so an acceptance never
-- carries over to a text the user has not been shown. It is not a setting: the interface can write any setting,
-- and an acceptance may only be recorded by the backend, against the revision it checked.
CREATE TABLE IF NOT EXISTS translation_licence_acceptances (
  licence     TEXT NOT NULL CHECK (licence IN ('gemma_terms')),
  revision    TEXT NOT NULL CHECK (length(revision) > 0),
  accepted_at INTEGER NOT NULL CHECK (accepted_at > 0),
  PRIMARY KEY (licence, revision)
);
