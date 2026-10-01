import { CircleHelp } from 'lucide-react';
import { useHelp } from './HelpProvider.js';
import '../../styles/contextual-help.css';

export function HelpToggle({ variant = 'titlebar' }: { variant?: 'titlebar' | 'mobile' }) {
  const { enabled, setEnabled } = useHelp();
  return <button type="button" data-help-toggle={variant} data-testid={`${variant}-help-toggle`}
    className={`${variant === 'titlebar' ? 'titlebar-help' : 'mobile-nav-notifications mobile-nav-help'}${enabled ? ' is-active' : ''}`}
    aria-label="Help" aria-pressed={enabled} title={enabled ? 'Hide page hints' : 'Show page hints'}
    onClick={(event) => { event.currentTarget.focus(); setEnabled(!enabled); }}>
    <CircleHelp size={variant === 'titlebar' ? 15 : 18} aria-hidden="true" />
    {variant === 'mobile' && <>Help <span className="mobile-nav-help-status" aria-hidden="true">{enabled ? 'On' : 'Off'}</span></>}
  </button>;
}
