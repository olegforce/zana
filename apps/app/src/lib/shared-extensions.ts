import type { CcApi } from '@zana-ai/zcc-desktop-contract';
import type { ExtensionEntry } from '@zana-ai/zcc-domain/product';

/** Shared clients can inspect the owner's legacy inventory. Loading its renderer
 * code would imply a native module bridge which that client does not have. */
export function sharedExtensions(owner: Pick<CcApi['extensions'], 'list' | 'onChanged'>): Pick<CcApi['extensions'], 'list' | 'onChanged'> {
  const project = (rows: ExtensionEntry[]) => rows.map(row => ({ ...row, loaded: false, mainActive: false, needsConsent: null }));
  return {
    list: async () => project(await owner.list()),
    onChanged: callback => owner.onChanged(rows => callback(project(rows)))
  };
}
