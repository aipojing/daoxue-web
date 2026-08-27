CREATE TABLE coursewares (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  source_conversation_id INTEGER REFERENCES conversations(id) ON DELETE SET NULL,
  assessment_conversation_id INTEGER REFERENCES conversations(id) ON DELETE SET NULL,
  subject TEXT NOT NULL,
  grade TEXT NOT NULL,
  topic TEXT NOT NULL,
  learning_goal TEXT NOT NULL,
  source_text TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'generating', 'ready', 'failed', 'deleting')),
  generation_stage TEXT NOT NULL DEFAULT 'queued'
    CHECK (generation_stage IN ('queued', 'scripting', 'speech', 'images', 'finalizing', 'ready', 'failed')),
  progress_percent INTEGER NOT NULL DEFAULT 0 CHECK (progress_percent BETWEEN 0 AND 100),
  current_segment_position INTEGER NOT NULL DEFAULT 0 CHECK (current_segment_position >= 0),
  current_time_ms INTEGER NOT NULL DEFAULT 0 CHECK (current_time_ms >= 0),
  checkpoint_answers_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(checkpoint_answers_json)),
  script_schema_version INTEGER NOT NULL DEFAULT 1 CHECK (script_schema_version = 1),
  prompt_version TEXT NOT NULL DEFAULT 'courseware-v1',
  learning_objectives_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(learning_objectives_json)),
  estimated_minutes INTEGER NOT NULL DEFAULT 0 CHECK (estimated_minutes BETWEEN 0 AND 120),
  model_snapshot_json TEXT NOT NULL CHECK (json_valid(model_snapshot_json)),
  usage_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(usage_json)),
  warnings_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(warnings_json)),
  error_code TEXT NOT NULL DEFAULT '',
  error_message TEXT NOT NULL DEFAULT '',
  retryable INTEGER NOT NULL DEFAULT 0 CHECK (retryable IN (0, 1)),
  lease_token TEXT,
  lease_expires_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT
);

CREATE TABLE courseware_segments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  courseware_id INTEGER NOT NULL REFERENCES coursewares(id) ON DELETE CASCADE,
  position INTEGER NOT NULL CHECK (position >= 0),
  segment_key TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN (
    'teacher_intro',
    'teacher_explanation',
    'student_question',
    'student_misconception',
    'teacher_reframe',
    'checkpoint',
    'summary'
  )),
  speaker TEXT NOT NULL CHECK (speaker IN ('teacher', 'student', 'system')),
  title TEXT NOT NULL,
  display_markdown TEXT NOT NULL,
  speech_text TEXT NOT NULL,
  alternate_display_markdown TEXT NOT NULL DEFAULT '',
  alternate_speech_text TEXT NOT NULL DEFAULT '',
  visual_mode TEXT NOT NULL DEFAULT 'none'
    CHECK (visual_mode IN ('none', 'formula', 'generated_image')),
  visual_prompt TEXT NOT NULL DEFAULT '',
  visual_alt_text TEXT NOT NULL DEFAULT '',
  checkpoint_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(checkpoint_json)),
  audio_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (audio_status IN ('pending', 'generating', 'ready', 'failed', 'not_required')),
  alternate_audio_status TEXT NOT NULL DEFAULT 'not_required'
    CHECK (alternate_audio_status IN ('pending', 'generating', 'ready', 'failed', 'not_required')),
  image_status TEXT NOT NULL DEFAULT 'not_required'
    CHECK (image_status IN ('pending', 'generating', 'ready', 'failed', 'not_required')),
  audio_object_key TEXT NOT NULL DEFAULT '',
  audio_content_type TEXT NOT NULL DEFAULT '',
  audio_duration_ms INTEGER NOT NULL DEFAULT 0,
  audio_request_id TEXT NOT NULL DEFAULT '',
  alternate_audio_object_key TEXT NOT NULL DEFAULT '',
  alternate_audio_content_type TEXT NOT NULL DEFAULT '',
  alternate_audio_duration_ms INTEGER NOT NULL DEFAULT 0,
  alternate_audio_request_id TEXT NOT NULL DEFAULT '',
  image_object_key TEXT NOT NULL DEFAULT '',
  image_content_type TEXT NOT NULL DEFAULT '',
  image_request_id TEXT NOT NULL DEFAULT '',
  audio_retry_count INTEGER NOT NULL DEFAULT 0,
  alternate_audio_retry_count INTEGER NOT NULL DEFAULT 0,
  image_retry_count INTEGER NOT NULL DEFAULT 0,
  audio_error_code TEXT NOT NULL DEFAULT '',
  audio_error_message TEXT NOT NULL DEFAULT '',
  alternate_audio_error_code TEXT NOT NULL DEFAULT '',
  alternate_audio_error_message TEXT NOT NULL DEFAULT '',
  image_error_code TEXT NOT NULL DEFAULT '',
  image_error_message TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (courseware_id, position),
  UNIQUE (courseware_id, segment_key)
);

CREATE INDEX idx_coursewares_student ON coursewares(student_id, updated_at DESC);
CREATE INDEX idx_coursewares_status ON coursewares(status, lease_expires_at);
CREATE INDEX idx_courseware_segments_course ON courseware_segments(courseware_id, position);

ALTER TABLE messages ADD COLUMN courseware_draft_json TEXT NOT NULL DEFAULT '';

INSERT INTO app_settings (key, value, updated_at)
VALUES ('courseware_enabled', '0', datetime('now'))
ON CONFLICT(key) DO NOTHING;
