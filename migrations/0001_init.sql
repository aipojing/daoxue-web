-- 题解导学网站初始 schema
CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  is_admin INTEGER NOT NULL DEFAULT 0,
  daily_message_limit INTEGER NOT NULL DEFAULT 100,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE invite_codes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  note TEXT NOT NULL DEFAULT '',
  max_uses INTEGER NOT NULL DEFAULT 1,
  used_count INTEGER NOT NULL DEFAULT 0,
  disabled INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token_hash TEXT NOT NULL UNIQUE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE students (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  grade TEXT NOT NULL,
  textbook TEXT NOT NULL DEFAULT '',
  region TEXT NOT NULL DEFAULT '',
  color TEXT NOT NULL DEFAULT '#4f6ef7',
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE conversations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  subject TEXT NOT NULL CHECK (subject IN ('math','chinese','physics','english','selflearn')),
  mode TEXT NOT NULL DEFAULT 'subject' CHECK (mode IN ('subject','selflearn-profiling','selflearn-daily')),
  title TEXT NOT NULL DEFAULT '新会话',
  deep_thinking INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user','assistant')),
  content TEXT NOT NULL,
  reasoning_content TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE mistake_cards (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  subject TEXT NOT NULL CHECK (subject IN ('math','chinese','physics','english','selflearn')),
  direction TEXT NOT NULL DEFAULT '',
  conversation_id INTEGER REFERENCES conversations(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  knowledge_point TEXT NOT NULL DEFAULT '',
  my_answer TEXT NOT NULL DEFAULT '',
  key_error TEXT NOT NULL DEFAULT '',
  error_tags TEXT NOT NULL DEFAULT '[]',
  correct_steps TEXT NOT NULL DEFAULT '',
  reminder TEXT NOT NULL DEFAULT '',
  retest_question TEXT NOT NULL DEFAULT '',
  next_review_date TEXT NOT NULL,
  review_status TEXT NOT NULL DEFAULT 'pending' CHECK (review_status IN ('pending','passed')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE student_profiles (
  student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  subject TEXT NOT NULL CHECK (subject IN ('math','chinese','physics','english')),
  profile_text TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (student_id, subject)
);

CREATE TABLE selflearn_profiles (
  student_id INTEGER PRIMARY KEY REFERENCES students(id) ON DELETE CASCADE,
  profile_text TEXT NOT NULL DEFAULT '',
  form_json TEXT NOT NULL DEFAULT '',
  ready INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE knowledge_points (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  direction TEXT NOT NULL DEFAULT '',
  chain TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL,
  level TEXT NOT NULL DEFAULT 'L1' CHECK (level IN ('L1','L2','L3','L4')),
  evidence TEXT NOT NULL DEFAULT '',
  needs_warmup INTEGER NOT NULL DEFAULT 0,
  needs_retest INTEGER NOT NULL DEFAULT 0,
  needs_rebuild INTEGER NOT NULL DEFAULT 0,
  can_network INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (student_id, direction, name)
);

CREATE TABLE lesson_outputs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  conversation_id INTEGER REFERENCES conversations(id) ON DELETE SET NULL,
  direction TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL,
  next_instruction TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE daily_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  conversation_id INTEGER REFERENCES conversations(id) ON DELETE SET NULL,
  report_date TEXT NOT NULL DEFAULT (date('now')),
  content TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE usage_log (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  message_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, date)
);

CREATE INDEX idx_sessions_token ON sessions(token_hash);
CREATE INDEX idx_students_user ON students(user_id);
CREATE INDEX idx_conversations_student ON conversations(student_id, updated_at DESC);
CREATE INDEX idx_messages_conversation ON messages(conversation_id, id);
CREATE INDEX idx_mistakes_student ON mistake_cards(student_id, next_review_date);
CREATE INDEX idx_lesson_outputs_student ON lesson_outputs(student_id, id DESC);
CREATE INDEX idx_daily_reports_student ON daily_reports(student_id, id DESC);
CREATE INDEX idx_knowledge_points_student ON knowledge_points(student_id, direction);
