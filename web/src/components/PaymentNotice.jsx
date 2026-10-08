import { Link } from 'react-router-dom';

const Lock = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"
    strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flex: '0 0 auto', marginTop: 2 }}>
    <rect x="4" y="11" width="16" height="10" rx="2" />
    <path d="M8 11V7a4 4 0 0 1 8 0v4" />
  </svg>
);

/// One line wherever someone is about to pay. The details (what's shared
/// with Stripe, etc.) live in the privacy policy's Payments section.
///   variant="online"  Stripe checkout
///   variant="door"    paid tier with no Stripe configured
export default function PaymentNotice({ variant = 'online' }) {
  if (variant === 'door') {
    return <p className="small muted payment-notice">Paid tickets are paid at the door.</p>;
  }
  return (
    <p className="small muted payment-notice">
      <Lock />
      <span>
        All payments are handled securely by Stripe. <Link to="/legal/privacy#payments">Learn more</Link>
      </span>
    </p>
  );
}
