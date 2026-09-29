import { randomBytes, randomUUID } from 'node:crypto';
import { equal, hash, linkKey, SlackError, token } from './security.mjs';

/** Slack identities come exclusively from verified Slack ingress. */
export function createSlackRegistry({ db, sessionSecret, identity, now = Date.now }) {
  const actorLock = user => `slack:${identity.team}:${identity.app}:${user}`;
  const activeSql = `SELECT l.*,s.name AS computer FROM slack_links l JOIN connect_servers s ON s.id=l.server_id AND s.user_id=l.user_id WHERE s.revoked_at IS NULL`;
  const credential = link => `${link.id}.${linkKey(sessionSecret, link.id)}`;
  return {
    key: link => linkKey(sessionSecret, link.id),
    async start(user) {
      if (!/^[UW][A-Z0-9]{5,30}$/.test(user)) throw new SlackError('invalid_user');
      return db.transaction(actorLock(user), async query => {
        await query('DELETE FROM slack_link_codes WHERE expires_at<$1', [now()]);
        const count = (await query('SELECT COUNT(*) AS n FROM slack_link_codes'))[0];
        if (Number(count.n) >= 2000) throw new SlackError('busy', 429);
        const code = randomBytes(16).toString('base64url');
        await query('INSERT INTO slack_link_codes(hash,team_id,slack_user,expires_at,app_id) VALUES($1,$2,$3,$4,$5)', [hash(code), identity.team, user, now() + 600_000, identity.app]);
        return code;
      });
    },
    async info(code) {
      if (!/^[A-Za-z0-9_-]{22}$/.test(code ?? '')) throw new SlackError('invalid_code');
      const value = (await db.query('SELECT * FROM slack_link_codes WHERE hash=$1 AND expires_at>$2 AND consumed_at IS NULL', [hash(code), now()]))[0];
      if (!value || (value.team_id !== identity.team || value.app_id !== identity.app)) throw new SlackError('expired_code', 410);
      return value;
    },
    async approve(accountId, code, serverId) {
      const info = await this.info(code);
      return db.transaction(actorLock(info.slack_user), async query => {
        const pending = (await query('SELECT * FROM slack_link_codes WHERE hash=$1 AND expires_at>$2 AND consumed_at IS NULL', [hash(code), now()]))[0];
        if (!pending) throw new SlackError('expired_code', 410);
        const computer = (await query('SELECT * FROM connect_servers WHERE id=$1 AND user_id=$2 AND revoked_at IS NULL', [serverId, accountId]))[0];
        if (!computer) throw new SlackError('computer_not_owned', 403);
        if (Number((await query('SELECT COUNT(*) AS n FROM slack_links WHERE user_id=$1', [accountId]))[0].n) >= 200) throw new SlackError('too_many_links', 429);
        const old = (await query("SELECT * FROM slack_links WHERE team_id=$1 AND slack_user=$2 AND app_id=$3 AND state='active'", [identity.team, info.slack_user, identity.app]))[0];
        if (old && old.user_id !== accountId) throw new SlackError('unlink_previous_account_first', 409);
        const id = randomUUID(), activation = token();
        await query("UPDATE slack_links SET state='revoked',activation_hash=NULL WHERE team_id=$1 AND slack_user=$2 AND app_id=$3 AND state='pending'", [identity.team, info.slack_user, identity.app]);
        await query('INSERT INTO slack_links(id,team_id,slack_user,user_id,server_id,state,activation_hash,expires_at,created_at,app_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)', [id, identity.team, info.slack_user, accountId, serverId, 'pending', hash(activation), now() + 600_000, now(), identity.app]);
        await query('UPDATE slack_link_codes SET consumed_at=$1 WHERE hash=$2', [now(), hash(code)]);
        return { activationCode: activation, computer: computer.name, expiresAt: now() + 600_000 };
      });
    },
    async redeem(code) {
      if (!/^[A-Za-z0-9_-]{43}$/.test(code ?? '')) throw new SlackError('invalid_code');
      const link = (await db.query(`${activeSql} AND l.activation_hash=$1 AND l.expires_at>$2 AND l.state='pending' AND l.app_id=$3`, [hash(code), now(), identity.app]))[0];
      if (!link) throw new SlackError('expired_code', 410);
      // Recoverable until activation: a lost response does not strand setup.
      return { linkId: link.id, credential: credential(link), identity, owner: link.slack_user, computer: link.computer };
    },
    async authenticate(value, pending = false) {
      if (typeof value !== 'string' || value.length > 100) throw new SlackError('unauthorized', 401);
      const id = value.split('.')[0];
      if (!equal(value, credential({ id }))) throw new SlackError('unauthorized', 401);
      const link = (await db.query(`${activeSql} AND l.id=$1 AND l.team_id=$2 AND l.app_id=$3`, [id, identity.team, identity.app]))[0];
      if (!link || !(link.state === 'active' || (pending && link.state === 'pending' && Number(link.expires_at) > now()))) throw new SlackError('link_revoked', 401);
      return link;
    },
    async activate(link) {
      return db.transaction(actorLock(link.slack_user), async query => {
        const current = (await query(`${activeSql} AND l.id=$1 AND l.state='pending' AND l.expires_at>$2`, [link.id, now()]))[0];
        if (!current) throw new SlackError('activation_expired', 410);
        const other = (await query("SELECT user_id FROM slack_links WHERE team_id=$1 AND slack_user=$2 AND app_id=$3 AND state='active'", [identity.team, link.slack_user, identity.app]))[0];
        if (other && other.user_id !== link.user_id) throw new SlackError('unlink_previous_account_first', 409);
        await query("UPDATE slack_links SET state='revoked',activation_hash=NULL WHERE team_id=$1 AND slack_user=$2 AND app_id=$3 AND state='active'", [identity.team, link.slack_user, identity.app]);
        await query("UPDATE slack_links SET state='active',activation_hash=NULL WHERE id=$1", [link.id]);
        return { active: true };
      });
    },
    async owner(user) { return (await db.query(`${activeSql} AND l.team_id=$1 AND l.slack_user=$2 AND l.app_id=$3 AND l.state='active'`, [identity.team, user, identity.app]))[0]; },
    async revoke(id, accountId) {
      const link = (await db.query('SELECT * FROM slack_links WHERE id=$1 AND user_id=$2', [id, accountId]))[0];
      if (!link) throw new SlackError('not_found', 404);
      await db.transaction(actorLock(link.slack_user), query => query("UPDATE slack_links SET state='revoked',activation_hash=NULL WHERE id=$1 AND user_id=$2", [id, accountId]));
      return { revoked: true };
    },
    async list(accountId) { return db.query("SELECT l.id,l.team_id,l.slack_user,l.state,s.name AS computer FROM slack_links l JOIN connect_servers s ON s.id=l.server_id WHERE l.user_id=$1 AND l.state IN ('pending','active') AND s.revoked_at IS NULL ORDER BY l.created_at DESC LIMIT 50", [accountId]); },
    async bind(link, channel, root) {
      if (Number((await db.query('SELECT COUNT(*) AS n FROM slack_conversations WHERE link_id=$1', [link.id]))[0].n) >= 2000) throw new SlackError('conversation_limit', 429);
      await db.query('INSERT INTO slack_conversations(team_id,channel,root,link_id,created_at) VALUES($1,$2,$3,$4,$5) ON CONFLICT(team_id,channel,root) DO NOTHING', [identity.team, channel, root, link.id, now()]);
      await this.conversation(link, channel, root);
    },
    async conversation(link, channel, root) {
      const row = (await db.query('SELECT link_id FROM slack_conversations WHERE team_id=$1 AND channel=$2 AND root=$3', [identity.team, channel, root]))[0];
      if (row?.link_id !== link.id) throw new SlackError('conversation_not_owned', 403);
    },
    async remember(link, id, kind, ttl = 3_600_000) {
      if (typeof id !== 'string' || id.length > 200 || !id) throw new SlackError('invalid_object');
      const key = `${identity.team}:${kind}:${id}`;
      if (Number((await db.query('SELECT COUNT(*) AS n FROM slack_objects WHERE link_id=$1', [link.id]))[0].n) >= 10_000) throw new SlackError('object_limit', 429);
      await db.query('INSERT INTO slack_objects(id,link_id,kind,expires_at) VALUES($1,$2,$3,$4) ON CONFLICT(id) DO NOTHING', [key, link.id, kind, now() + ttl]);
      await this.object(link, id, kind);
    },
    async object(link, id, kind) {
      const row = (await db.query('SELECT link_id FROM slack_objects WHERE id=$1 AND expires_at>$2', [`${identity.team}:${kind}:${id}`, now()]))[0];
      if (row?.link_id !== link.id) throw new SlackError('object_not_owned', 403);
    },
    async prune() {
      await db.transaction('slack-cleanup', async query => {
        await query('DELETE FROM slack_link_codes WHERE expires_at<$1', [now()]);
        await query('DELETE FROM slack_objects WHERE id IN (SELECT id FROM slack_objects WHERE expires_at<$1 LIMIT 500)', [now()]);
        await query('DELETE FROM slack_requests WHERE id IN (SELECT id FROM slack_requests WHERE expires_at<$1 LIMIT 500)', [now()]);
        await query("DELETE FROM slack_links WHERE id IN (SELECT id FROM slack_links WHERE (state='revoked' OR (state='pending' AND expires_at<$1)) AND created_at<$2 LIMIT 20)", [now(), now() - 30 * 86400_000]);
        await query('DELETE FROM slack_conversations WHERE (team_id,channel,root) IN (SELECT team_id,channel,root FROM slack_conversations WHERE created_at<$1 LIMIT 500)', [now() - 90 * 86400_000]);
      });
    }
  };
}
