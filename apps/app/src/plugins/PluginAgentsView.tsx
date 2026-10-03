import type { PluginAgentsViewProps, PluginAgentsViewRegistration } from '@zana-ai/zcc-plugin-sdk';
import { PluginSlotBoundary } from './PluginSlotBoundary.js';
export function PluginAgentsView({ slot, ...props }: PluginAgentsViewProps & {
  slot: PluginAgentsViewRegistration;
}) {
  const View = slot.component;
  return <PluginSlotBoundary key={`${slot.pluginId}:${slot.id}:${slot.generation}`} pluginId={slot.pluginId} generation={slot.generation}>
  <View {...props}/>
 </PluginSlotBoundary>;
}
