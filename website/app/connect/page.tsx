import type { Metadata } from 'next';
import { ConnectAccount } from './ConnectAccount';
export const metadata: Metadata = { title: 'Zana Connect', robots: { index: false, follow: false }, referrer: 'no-referrer' };
export default function ConnectPage() { return <ConnectAccount />; }
