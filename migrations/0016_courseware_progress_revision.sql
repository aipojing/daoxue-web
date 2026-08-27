ALTER TABLE coursewares
ADD COLUMN progress_revision INTEGER NOT NULL DEFAULT 0
CHECK (progress_revision >= 0);
