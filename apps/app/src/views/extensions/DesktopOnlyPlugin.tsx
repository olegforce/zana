import type { ExtensionEntry } from '@zana-ai/zcc-domain/product';

export function DesktopOnlyPlugin({ entry }: { entry: ExtensionEntry }) {
  return <section className="settings-section" data-testid="desktop-only-plugin">
    <h3>{entry.manifest?.title ?? entry.id}</h3>
    <p>This plugin requires the instance owner’s desktop. Open Zana on that computer to use or manage it.</p>
    <p className="settings-help">{entry.enabled ? 'Enabled' : 'Disabled'} on the owner’s computer{entry.manifest?.version ? ` · ${entry.manifest.version}` : ''}.</p>
  </section>;
}
