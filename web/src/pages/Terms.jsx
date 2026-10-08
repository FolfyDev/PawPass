import { useEffect } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useSession } from '../lib/session.jsx';
import { usePageMeta } from '../lib/meta.js';
import Breadcrumbs from '../components/Breadcrumbs.jsx';

export default function Terms() {
  const { settings } = useSession();
  usePageMeta({ title: 'Terms of Service', description: 'The terms that govern use of this site.' });

  const entity = settings?.legal?.entityName || settings?.orgName || 'this instance';
  const contact = settings?.legal?.contactEmail || settings?.supportEmail || '';

  // In-page links like /legal/privacy#payments: the router doesn't scroll to
  // the hash on its own.
  const { hash } = useLocation();
  useEffect(() => {
    if (hash) document.getElementById(hash.slice(1))?.scrollIntoView({ block: 'start' });
  }, [hash]);

  return (
    <article style={{ padding: '40px 0 60px', maxWidth: 720 }}>
      <Breadcrumbs items={[{ label: 'Home', to: '/' }, { label: 'Terms of Service' }]} />
      <p className="eyebrow">Legal</p>
      <div className="hero-rule" style={{ maxWidth: 80 }} />
      <h1>Terms of Service</h1>
      <p className="muted small">Last updated: October 8, 2026</p>

      <div className="stack" style={{ gap: 22 }}>
        <p>
          These Terms of Service ("Terms") govern your use of the PawPass registration platform operated by{' '}
          <strong>{entity}</strong> (“we”, “us”). By creating an account, registering for an event, or otherwise
          using this site, you agree to these Terms.
        </p>

        <section>
          <h2>1. What PawPass is</h2>
          <p>
            PawPass is event registration software: it lets attendees sign up for events, receive a ticket (a QR
            code, optionally added to Apple Wallet or Google Wallet), and lets event staff check attendees in and
            print badges. We operate this specific deployment; we do not organize, endorse, or take responsibility
            for the content or conduct of any individual event listed here beyond the registration process itself.
          </p>
        </section>

        <section>
          <h2>2. Accounts and accuracy</h2>
          <p>
            You may sign in with a Telegram account or with an email and password. You are responsible for keeping
            your credentials secure. The preferred name you provide at registration must match the photo ID you bring
            to check-in  providing false identity information may result in your registration being cancelled at
            the door.
          </p>
        </section>

        <section>
          <h2>3. Event-specific terms</h2>
          <p>
            Individual events may publish their own terms (shown to you before you complete registration for that
            event). Those terms are set by the event's organizers and apply in addition to these Terms. Where the
            two conflict for a specific event, the event's own terms control matters of conduct, refunds, and
            admission for that event.
          </p>
        </section>

        <section id="payments" style={{ scrollMarginTop: 80 }}>
          <h2>4. Payments</h2>
          <p>
            Where an event offers paid tickets, you pay either online through Stripe or in person to event staff.
            Online payments are made on Stripe's secure hosted checkout page and charged by <strong>{entity}</strong>.
            PawPass itself never receives, processes or stores your card details. See the{' '}
            <Link to="/legal/privacy#payments">privacy policy</Link> for exactly what is shared with Stripe.
          </p>
          <p>
            Choosing a paid ticket holds your spot for a limited time while you pay. If payment isn't completed in
            that time, the hold ends and the spot is released. Your ticket is confirmed only once Stripe confirms the
            payment. Prices are shown in the currency the organizers set, and your card issuer may add its own fees
            for foreign currencies.
          </p>
          <p>
            Refund and cancellation policies are set by each event's organizers, not by PawPass. Cancelling a
            registration does not refund it automatically; contact the organizers. If a payment is fully refunded,
            the ticket it paid for is cancelled.
          </p>
        </section>

        <section>
          <h2>5. Acceptable use</h2>
          <p>
            You agree not to misuse the platform  including attempting to access another attendee's ticket or
            account, submitting fraudulent registrations, or interfering with check-in or badge printing at an
            event. We may suspend or cancel a registration or account that violates these Terms.
          </p>
        </section>

        <section>
          <h2>6. Availability and liability</h2>
          <p>
            The platform is provided "as is," without warranty of any kind. We are not liable for indirect,
            incidental, or consequential damages arising from your use of the platform, to the maximum extent
            permitted by law. Nothing here limits liability that cannot be limited under applicable law.
          </p>
        </section>

        <section>
          <h2>7. Changes to these Terms</h2>
          <p>
            We may update these Terms from time to time. Continuing to use the platform after a change means you
            accept the updated Terms. Material changes will be reflected in the "Last updated" date above.
          </p>
        </section>

        <section>
          <h2>8. Contact</h2>
          <p>
            Questions about these Terms can be sent to{' '}
            {contact ? <a href={`mailto:${contact}`}>{contact}</a> : 'the event organizers'}.
          </p>
        </section>
      </div>
    </article>
  );
}
