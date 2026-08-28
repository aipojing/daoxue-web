-- 学生默认头像按家长选择的性别区分；旧数据不做姓名猜测，统一标记为不指定。
ALTER TABLE students
  ADD COLUMN gender TEXT NOT NULL DEFAULT 'unspecified'
  CHECK (gender IN ('male', 'female', 'unspecified'));
