-- 将化学加入解题辅导的严格学科白名单。
-- D1 无法关闭外键，且延迟检查不会阻止级联删除，因此先备份并按依赖顺序重建相关表。
PRAGMA defer_foreign_keys = on;

CREATE TABLE _0005_conversations AS SELECT * FROM conversations;
CREATE TABLE _0005_messages AS SELECT * FROM messages;
CREATE TABLE _0005_mistake_cards AS SELECT * FROM mistake_cards;
CREATE TABLE _0005_student_profiles AS SELECT * FROM student_profiles;
CREATE TABLE _0005_lesson_outputs AS SELECT * FROM lesson_outputs;
CREATE TABLE _0005_daily_reports AS SELECT * FROM daily_reports;

DROP TABLE messages;
DROP TABLE mistake_cards;
DROP TABLE lesson_outputs;
DROP TABLE daily_reports;
DROP TABLE conversations;
DROP TABLE student_profiles;

CREATE TABLE conversations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  subject TEXT NOT NULL CHECK (subject IN ('math','chinese','physics','english','chemistry','selflearn')),
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
  subject TEXT NOT NULL CHECK (subject IN ('math','chinese','physics','english','chemistry','selflearn')),
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
  subject TEXT NOT NULL CHECK (subject IN ('math','chinese','physics','english','chemistry')),
  profile_text TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (student_id, subject)
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

INSERT INTO conversations
  (id, student_id, subject, mode, title, deep_thinking, created_at, updated_at)
  SELECT id, student_id, subject, mode, title, deep_thinking, created_at, updated_at
  FROM _0005_conversations;

INSERT INTO messages
  (id, conversation_id, role, content, reasoning_content, created_at)
  SELECT id, conversation_id, role, content, reasoning_content, created_at
  FROM _0005_messages;

INSERT INTO mistake_cards
  (id, student_id, subject, direction, conversation_id, title, knowledge_point, my_answer,
   key_error, error_tags, correct_steps, reminder, retest_question, next_review_date,
   review_status, created_at)
  SELECT id, student_id, subject, direction, conversation_id, title, knowledge_point, my_answer,
         key_error, error_tags, correct_steps, reminder, retest_question, next_review_date,
         review_status, created_at
  FROM _0005_mistake_cards;

INSERT INTO student_profiles (student_id, subject, profile_text, updated_at)
  SELECT student_id, subject, profile_text, updated_at FROM _0005_student_profiles;

INSERT INTO lesson_outputs
  (id, student_id, conversation_id, direction, content, next_instruction, created_at)
  SELECT id, student_id, conversation_id, direction, content, next_instruction, created_at
  FROM _0005_lesson_outputs;

INSERT INTO daily_reports
  (id, student_id, conversation_id, report_date, content, created_at)
  SELECT id, student_id, conversation_id, report_date, content, created_at
  FROM _0005_daily_reports;

CREATE INDEX idx_conversations_student ON conversations(student_id, updated_at DESC);
CREATE INDEX idx_messages_conversation ON messages(conversation_id, id);
CREATE INDEX idx_mistakes_student ON mistake_cards(student_id, next_review_date);
CREATE INDEX idx_lesson_outputs_student ON lesson_outputs(student_id, id DESC);
CREATE INDEX idx_daily_reports_student ON daily_reports(student_id, id DESC);

DROP TABLE _0005_messages;
DROP TABLE _0005_mistake_cards;
DROP TABLE _0005_student_profiles;
DROP TABLE _0005_lesson_outputs;
DROP TABLE _0005_daily_reports;
DROP TABLE _0005_conversations;

PRAGMA foreign_key_check;
PRAGMA defer_foreign_keys = off;
