CREATE TABLE memory_events (
  id TEXT PRIMARY KEY NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('qq', 'pet', 'douyin')),
  source_key TEXT NOT NULL,
  conversation_kind TEXT NOT NULL CHECK (conversation_kind IN ('private', 'group', 'pet', 'system')),
  conversation_key TEXT NOT NULL,
  actor_key TEXT NOT NULL,
  actor_name TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('incoming', 'outgoing')),
  content_text TEXT NOT NULL,
  occurred_at INTEGER NOT NULL,
  visibility TEXT NOT NULL CHECK (visibility IN ('owner-private', 'conversation', 'group', 'public')),
  state TEXT NOT NULL CHECK (state IN ('active', 'review-pending', 'recycle')),
  review_due_at INTEGER NOT NULL,
  purge_due_at INTEGER,
  external_key TEXT NOT NULL UNIQUE,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  updated_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER))
) STRICT;

CREATE TABLE memory_items (
  id TEXT PRIMARY KEY NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('fact', 'preference', 'relationship', 'experience', 'behavior-note')),
  subject_key TEXT NOT NULL,
  subject_name TEXT NOT NULL,
  content TEXT NOT NULL,
  importance REAL NOT NULL CHECK (importance >= 0 AND importance <= 1),
  confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  visibility TEXT NOT NULL CHECK (visibility IN ('owner-private', 'conversation', 'group', 'public')),
  promoted_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('active', 'recycle')),
  source_refs_json TEXT NOT NULL CHECK (json_valid(source_refs_json) AND json_type(source_refs_json) = 'array'),
  supersedes_id TEXT REFERENCES memory_items(id) ON DELETE SET NULL,
  purge_due_at INTEGER,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  updated_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER))
) STRICT;

CREATE TABLE diary_entries (
  id TEXT PRIMARY KEY NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  written_at INTEGER NOT NULL,
  visibility TEXT NOT NULL CHECK (visibility IN ('owner-private', 'conversation', 'group', 'public')),
  source_refs_json TEXT NOT NULL CHECK (json_valid(source_refs_json) AND json_type(source_refs_json) = 'array'),
  supersedes_id TEXT REFERENCES diary_entries(id) ON DELETE SET NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  updated_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER))
) STRICT;

CREATE TABLE review_jobs (
  id TEXT PRIMARY KEY NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('short-term', 'long-term')),
  batch_key TEXT NOT NULL UNIQUE,
  source_ids_json TEXT NOT NULL CHECK (json_valid(source_ids_json) AND json_type(source_ids_json) = 'array'),
  state TEXT NOT NULL CHECK (state IN ('queued', 'leased', 'completed', 'failed')),
  due_at INTEGER NOT NULL,
  lease_until INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at INTEGER,
  last_error_code TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;

CREATE TABLE import_ledger (
  source TEXT NOT NULL,
  external_key TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  result TEXT NOT NULL,
  target_type TEXT,
  target_id TEXT,
  imported_at INTEGER NOT NULL,
  PRIMARY KEY (source, external_key)
) STRICT;

CREATE TABLE purge_ledger (
  source_hash TEXT NOT NULL,
  object_kind TEXT NOT NULL,
  purged_at INTEGER NOT NULL,
  PRIMARY KEY (source_hash, object_kind)
) STRICT;

CREATE TABLE schema_meta (
  key TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL
) STRICT;

CREATE INDEX memory_events_due ON memory_events (state, review_due_at);
CREATE INDEX memory_events_purge ON memory_events (state, purge_due_at);
CREATE INDEX memory_events_conversation ON memory_events (source, conversation_kind, conversation_key, state, occurred_at);
CREATE INDEX memory_items_due ON memory_items (state, expires_at);
CREATE INDEX memory_items_purge ON memory_items (state, purge_due_at);
CREATE INDEX memory_items_subject ON memory_items (subject_key, state, promoted_at);
CREATE INDEX diary_entries_written ON diary_entries (visibility, written_at);
CREATE INDEX review_jobs_due ON review_jobs (state, due_at, next_attempt_at);
CREATE INDEX review_jobs_lease ON review_jobs (state, lease_until);
