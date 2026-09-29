function hostReact() { return globalThis.__ZCC_HOST_REACT__; }
export default {
  __zccPluginApp: true,
  setup(app) {
    app.slots.settingsSection({
      id: "keep-awake", title: "Keep awake",
      component: function KeepAwakeSettings(props) {
        const React = hostReact();
        if (!React) return null;
        const [machines, setMachines] = React.useState([]);
        const [hostId, setHostId] = React.useState("");
        const [awake, setAwake] = React.useState(null);
        const [busy, setBusy] = React.useState(false);
        const [error, setError] = React.useState("");
        const generation = React.useRef(0);
        const rpc = (method, args) => globalThis.__ZCC_PLUGIN_HOST__.callRpc(props.pluginId, method, args);
        React.useEffect(() => {
          let current = true;
          rpc("machines", {}).then(result => {
            if (!current) return;
            setMachines(result.machines); setHostId(result.primaryId ?? "");
          }).catch(error => { if (current) setError(String(error.message ?? error)); });
          return () => { current = false; generation.current++; };
        }, [props.pluginId]);
        React.useEffect(() => {
          const id = ++generation.current;
          setAwake(null); setBusy(false); setError("");
          if (hostId) rpc("status", { hostId }).then(result => {
            if (id === generation.current) setAwake(Boolean(result.awake));
          }).catch(error => { if (id === generation.current) setError(String(error.message ?? error)); });
          return () => { generation.current++; };
        }, [props.pluginId, hostId]);
        return React.createElement("div", { style: { padding: 8 } },
          React.createElement("label", null, "Machine ", React.createElement("select", {
            value: hostId, onChange: event => setHostId(event.target.value), "aria-label": "Keep awake machine"
          }, React.createElement("option", { value: "", disabled: true }, "Choose a machine"),
          ...machines.map(machine => React.createElement("option", { key: machine.id, value: machine.id }, machine.name)))),
          error ? React.createElement("p", { role: "alert" }, error) : React.createElement("p", null,
            awake === null ? "Choose a machine or wait for its status." : awake ? "This machine will stay awake." : "This machine can sleep."),
          React.createElement("button", { type: "button", disabled: busy || awake === null || Boolean(error), onClick: async () => {
            const id = generation.current; setBusy(true); setError("");
            try { const result = await rpc("set", { hostId, enable: !awake }); if (id === generation.current) setAwake(Boolean(result.awake)); }
            catch (error) { if (id === generation.current) setError(String(error.message ?? error)); }
            finally { if (id === generation.current) setBusy(false); }
          } }, busy ? "Updating…" : awake ? "Allow sleep" : "Keep awake")
        );
      }
    });
  }
};
