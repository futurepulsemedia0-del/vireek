-- Leading tenant-column index (found by scripts/perf-index-audit.mjs: RLS and queries filter by user_id).
-- CONCURRENTLY: no write lock; must stay alone in this file.
-- rollback: DROP INDEX CONCURRENTLY IF EXISTS idx_chat_messages_user_id;
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_chat_messages_user_id ON public.chat_messages (user_id);
