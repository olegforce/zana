CREATE TABLE IF NOT EXISTS connect_servers (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  label TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  credential_hash TEXT UNIQUE,
  created_at BIGINT NOT NULL,
  last_seen_at BIGINT,
  revoked_at BIGINT
);
CREATE INDEX IF NOT EXISTS connect_servers_owner ON connect_servers(user_id, created_at);
CREATE INDEX IF NOT EXISTS connect_servers_retention ON connect_servers(revoked_at);
CREATE TABLE IF NOT EXISTS connect_devices (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  credential_hash TEXT NOT NULL UNIQUE,
  created_at BIGINT NOT NULL,
  revoked_at BIGINT
);
CREATE INDEX IF NOT EXISTS connect_devices_owner ON connect_devices(user_id, created_at);
CREATE INDEX IF NOT EXISTS connect_devices_retention ON connect_devices(revoked_at);
CREATE TABLE IF NOT EXISTS connect_codes (
  hash TEXT PRIMARY KEY,
  purpose TEXT NOT NULL,
  user_id TEXT,
  server_id TEXT REFERENCES connect_servers(id),
  name TEXT NOT NULL,
  device_hash TEXT UNIQUE,
  expires_at BIGINT NOT NULL,
  consumed_at BIGINT,
  denied_at BIGINT,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS connect_codes_expiry ON connect_codes(expires_at);
CREATE TABLE IF NOT EXISTS connect_desktop_logins (
  hash TEXT PRIMARY KEY,
  device_hash TEXT NOT NULL UNIQUE,
  account_session_id TEXT,
  denied_at BIGINT,
  expires_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS connect_desktop_logins_expiry ON connect_desktop_logins(expires_at);
CREATE TABLE IF NOT EXISTS connect_sessions (
  hash TEXT PRIMARY KEY,
  device_id TEXT NOT NULL REFERENCES connect_devices(id),
  server_id TEXT NOT NULL REFERENCES connect_servers(id),
  expires_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS connect_sessions_device ON connect_sessions(device_id, server_id);
CREATE INDEX IF NOT EXISTS connect_sessions_expiry ON connect_sessions(expires_at);

-- Permanent reservations survive computer removal; a bookmark is never reassigned.
CREATE TABLE IF NOT EXISTS connect_addresses (
  label TEXT PRIMARY KEY,
  server_id TEXT UNIQUE REFERENCES connect_servers(id) ON DELETE SET NULL,
  user_id TEXT NOT NULL,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS connect_addresses_owner ON connect_addresses(user_id);
CREATE TABLE IF NOT EXISTS connect_browser_requests (
  hash TEXT PRIMARY KEY,
  state_hash TEXT NOT NULL,
  server_id TEXT NOT NULL REFERENCES connect_servers(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  return_path TEXT NOT NULL,
  account_session_id TEXT,
  expires_at BIGINT NOT NULL,
  consumed_at BIGINT
);
CREATE INDEX IF NOT EXISTS connect_browser_requests_expiry ON connect_browser_requests(expires_at);
CREATE TABLE IF NOT EXISTS connect_browser_sessions (
  hash TEXT PRIMARY KEY,
  server_id TEXT NOT NULL REFERENCES connect_servers(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  account_session_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  expires_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS connect_browser_sessions_expiry ON connect_browser_sessions(expires_at);
CREATE INDEX IF NOT EXISTS connect_browser_sessions_account ON connect_browser_sessions(account_session_id);

-- Execution machines are instance-scoped; existing phone grants keep their role.
CREATE TABLE IF NOT EXISTS connect_instances (
  server_id TEXT PRIMARY KEY REFERENCES connect_servers(id) ON DELETE CASCADE,
  instance_id TEXT NOT NULL,
  created_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS connect_machines (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  server_id TEXT NOT NULL REFERENCES connect_servers(id) ON DELETE CASCADE,
  host_id TEXT NOT NULL,
  name TEXT NOT NULL,
  credential_hash TEXT NOT NULL UNIQUE,
  created_at BIGINT NOT NULL,
  last_seen_at BIGINT,
  revoked_at BIGINT,
  UNIQUE(server_id, host_id)
);
CREATE INDEX IF NOT EXISTS connect_machines_owner ON connect_machines(user_id, server_id);
CREATE TABLE IF NOT EXISTS connect_machine_codes (
  hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  server_id TEXT NOT NULL REFERENCES connect_servers(id) ON DELETE CASCADE,
  host_id TEXT NOT NULL,
  name TEXT NOT NULL,
  enrollment TEXT NOT NULL,
  expires_at BIGINT NOT NULL,
  created_at BIGINT NOT NULL,
  consumed_at BIGINT,
  request_hash TEXT,
  machine_id TEXT,
  UNIQUE(server_id, host_id)
);
CREATE INDEX IF NOT EXISTS connect_machine_codes_expiry ON connect_machine_codes(expires_at);
