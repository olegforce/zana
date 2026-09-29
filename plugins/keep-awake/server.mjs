export default function plugin(zcc) {
  const host = zcc.host.experimental_client();
  zcc.rpc.method("machines", async () => ({
    machines: await zcc.sdk.hosts.list(), primaryId: (await zcc.sdk.system.defaultHost())?.id ?? null
  }));
  async function target(args) {
    const id = args?.hostId;
    if (typeof id !== "string" || !(await zcc.sdk.hosts.list()).some(machine => machine.id === id)) throw new Error("Choose a registered machine");
    return { hostId: id };
  }
  zcc.rpc.method("status", async args => host.call("status", null, await target(args)));
  zcc.rpc.method("set", async args => {
    if (typeof args?.enable !== "boolean") throw new Error("Choose whether to keep the machine awake");
    return host.call(args.enable ? "enable" : "disable", null, await target(args));
  });
}
