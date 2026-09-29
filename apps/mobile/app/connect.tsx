import { OnlineConnect } from '../src/OnlineConnect';

/** Old QR/manual deep links also land at authenticated account sign-in. */
export default function Connect() {
  return <OnlineConnect />;
}
