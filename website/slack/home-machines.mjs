const plain = text => ({ type: 'plain_text', text, emoji: true });
const clean = value => String(value ?? '').replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 80);
const context = text => ({ type: 'context', elements: [plain(text)] });
const MAX_VISIBLE = 8;

/** Account ownership comes from the authenticated Slack link, never the view. */
export function createHomeMachines({ connect, now = Date.now }) {
  return async function machineBlocks(link) {
    const heading = [{ type: 'divider' }, { type: 'header', text: plain('Machines') }];
    const manage = { type: 'button', action_id: 'connect_manage_machines', text: plain('Manage machines'), url: `${connect.accountUrl}/connect/` };
    try {
      // The registry uses the same bounded inventory and heartbeat status as the
      // website dashboard. Expose only names, public addresses and status.
      const machines = (await connect.listServers(link.user_id)).filter(machine => !machine.revoked);
      machines.sort((a, b) => Number(b.id === link.server_id) - Number(a.id === link.server_id) || Number(b.live) - Number(a.live) || a.name.localeCompare(b.name));
      const rows = machines.slice(0, MAX_VISIBLE).map(machine => {
        const status = machine.live ? '🟢 Online' : machine.paired === false ? '⚪ Not connected yet' : '⚪ Offline';
        return `${clean(machine.name)} · ${status}${machine.id === link.server_id ? ' · Linked to Slack' : ''}${machine.address ? `\n${clean(machine.address)}.${connect.browserDomain}` : ''}`;
      });
      return [...heading, { type: 'section', text: plain(rows.join('\n\n') || 'No machines connected yet.'), accessory: manage }, context(
        `${machines.filter(machine => machine.live).length} online · ${machines.length} registered${machines.length > MAX_VISIBLE ? ` · Showing ${MAX_VISIBLE}; see all in Manage machines` : ''}. Status from your Zana account, checked ${new Date(now()).toISOString().slice(0, 19).replace('T', ' ')} UTC. Choose Refresh to update.`,
      )];
    } catch {
      // Inventory failure must not suppress conversations or report false offline.
      return [...heading, { type: 'section', text: plain('Machine status is unavailable. Choose Refresh to try again.'), accessory: manage }];
    }
  };
}

export async function addHomeMachines(view, link, machineBlocks) {
  const blocks = Array.isArray(view.blocks) ? view.blocks : [];
  const machines = await machineBlocks(link);
  // Home supports 100 blocks. Preserve all conversation controls at capacity.
  const addition = blocks.length + machines.length <= 100 ? machines : machines.filter(block => block.type === 'section');
  if (blocks.length + addition.length > 100) return view;
  const divider = blocks.findIndex(block => block.type === 'divider');
  const offset = divider < 0 ? blocks.length : divider;
  return { ...view, blocks: [...blocks.slice(0, offset), ...addition, ...blocks.slice(offset)] };
}
