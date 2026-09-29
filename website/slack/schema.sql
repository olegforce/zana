CREATE TABLE IF NOT EXISTS slack_links (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  app_id TEXT NOT NULL,
  slack_user TEXT NOT NULL,
  user_id TEXT NOT NULL,
  server_id TEXT NOT NULL REFERENCES connect_servers(id) ON DELETE CASCADE,
  state TEXT NOT NULL,
  activation_hash TEXT,
  expires_at BIGINT NOT NULL,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS slack_links_actor ON slack_links(team_id,app_id,slack_user,state);
CREATE INDEX IF NOT EXISTS slack_links_owner ON slack_links(user_id,created_at);
CREATE TABLE IF NOT EXISTS slack_link_codes (
  hash TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  app_id TEXT NOT NULL,
  slack_user TEXT NOT NULL,
  expires_at BIGINT NOT NULL,
  consumed_at BIGINT
);
CREATE INDEX IF NOT EXISTS slack_link_codes_expiry ON slack_link_codes(expires_at);
CREATE TABLE IF NOT EXISTS slack_requests (
  id TEXT PRIMARY KEY,
  link_id TEXT NOT NULL REFERENCES slack_links(id) ON DELETE CASCADE,
  state TEXT NOT NULL,
  payload TEXT NOT NULL,
  response TEXT,
  created_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS slack_requests_pending ON slack_requests(state,expires_at);
CREATE INDEX IF NOT EXISTS slack_requests_link ON slack_requests(link_id);
CREATE INDEX IF NOT EXISTS slack_requests_expiry ON slack_requests(expires_at);
CREATE TABLE IF NOT EXISTS slack_conversations (
  team_id TEXT NOT NULL,
  channel TEXT NOT NULL,
  root TEXT NOT NULL,
  link_id TEXT NOT NULL REFERENCES slack_links(id) ON DELETE CASCADE,
  created_at BIGINT NOT NULL,
  PRIMARY KEY(team_id,channel,root)
);
CREATE TABLE IF NOT EXISTS slack_objects (
  id TEXT PRIMARY KEY,
  link_id TEXT NOT NULL REFERENCES slack_links(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  expires_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS slack_objects_expiry ON slack_objects(expires_at);
CREATE INDEX IF NOT EXISTS slack_objects_link ON slack_objects(link_id);
CREATE INDEX IF NOT EXISTS slack_conversations_link ON slack_conversations(link_id);
CREATE INDEX IF NOT EXISTS slack_conversations_created ON slack_conversations(created_at);
CREATE UNIQUE INDEX IF NOT EXISTS slack_links_active ON slack_links(team_id,app_id,slack_user) WHERE state='active';
