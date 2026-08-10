import { useEffect, useRef, useState } from "react";
import "./LandingPage.css";

const FEATURES = [
  {
    title: "Professional charting",
    description:
      "Explore multiple markets, timeframes, session overlays and a complete set of persistent drawing tools.",
  },
  {
    title: "Paper trading workflow",
    description:
      "Open market and limit orders, manage positions, add or reduce exposure and test protection tools using demo funds.",
  },
  {
    title: "Built for focus",
    description:
      "A compact terminal interface with symbol tabs, keyboard shortcuts and configurable panels—without exchange-account risk.",
  },
] as const;

function FyxtezMark() {
  return (
    <span className="landing-mark" aria-hidden="true">
      F
    </span>
  );
}

function LandingPage() {
  const [isContactOpen, setIsContactOpen] = useState(false);
  const contactRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isContactOpen) return;

    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (!contactRef.current?.contains(event.target as Node)) {
        setIsContactOpen(false);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setIsContactOpen(false);
    };

    document.addEventListener("pointerdown", closeOnOutsidePointer);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [isContactOpen]);

  return (
    <main className="landing-page">
      <div className="landing-grid" aria-hidden="true" />
      <div className="landing-glow landing-glow-primary" aria-hidden="true" />
      <div className="landing-glow landing-glow-secondary" aria-hidden="true" />

      <nav className="landing-nav" aria-label="Main navigation">
        <a className="landing-brand" href="/" aria-label="Fyxtez Terminal home">
          <FyxtezMark />
          <span>
            FYXTEZ <b>TERMINAL</b>
          </span>
        </a>

        <div className="landing-nav-status">
          <span className="landing-status-dot" />
          Demo environment
        </div>
      </nav>

      <section className="landing-hero">
        <div className="landing-eyebrow">
          <span>TRADING WORKSPACE</span>
          <span className="landing-eyebrow-divider" />
          <span>PUBLIC DEMO</span>
        </div>

        <h1>
          Chart. Plan. Execute.
          <span>Without risking funds.</span>
        </h1>

        <p className="landing-intro">
          A hands-on demonstration of the Fyxtez trading terminal—built for
          chart analysis, order planning and simulated position management in
          one focused workspace.
        </p>

        <div className="landing-actions">
          <a className="landing-primary-action" href="/BTC">
            Open demo terminal
            <svg viewBox="0 0 20 20" aria-hidden="true">
              <path d="M4 10h11m-4-4 4 4-4 4" />
            </svg>
          </a>
          <a className="landing-tutorial-action" href="/BTC?tutorial=1">
            How it works
          </a>
          <span className="landing-action-note">No sign-up required</span>
        </div>
      </section>

      <section className="landing-features" aria-label="Terminal features">
        {FEATURES.map((feature) => (
          <article className="landing-feature" key={feature.title}>
            <span className="landing-feature-accent" aria-hidden="true" />
            <h2>{feature.title}</h2>
            <p>{feature.description}</p>
          </article>
        ))}
      </section>

      <aside className="landing-demo-notice">
        <div className="landing-notice-icon" aria-hidden="true">
          i
        </div>
        <div>
          <strong>Demo mode only</strong>
          <p>
            Balances, orders, trades and positions are simulated. No real funds
            are used, and no exchange account is connected. This project is a
            product demonstration—not financial advice.
          </p>
          <p className="landing-preview-disclaimer">
            <span>Public preview — provided as-is.</span> This demo is not
            actively maintained as a production service. Some features are
            simplified or incomplete, and bugs, inaccurate simulations or
            temporary interruptions may occur. Functionality may change without
            notice.
          </p>
          <div className="landing-live-contact-copy">
            For live trading and in-app execution on Binance,{
            " "
            }<div
              ref={contactRef}
              className={`landing-contact ${isContactOpen ? "is-open" : ""}`}
            >
              <button
                type="button"
                aria-expanded={isContactOpen}
                aria-haspopup="dialog"
                onClick={() => setIsContactOpen((current) => !current)}
              >
                contact Fyxtez
              </button>
              <div className="landing-contact-popup" role="dialog" aria-label="Contact Fyxtez">
                <div className="landing-contact-header">
                  <span className="landing-contact-avatar">F</span>
                  <span>
                    <strong>Fyxtez</strong>
                    <small>Live execution inquiries</small>
                  </span>
                </div>
                <div className="landing-contact-links">
                  <a href="https://t.me/fyxtez" target="_blank" rel="noreferrer">
                    <span className="landing-contact-channel-icon telegram" aria-hidden="true">
                      <svg viewBox="0 0 24 24"><path d="m20.4 4.1-3 15.2c-.2 1.1-.9 1.3-1.8.8l-4.6-3.4-2.2 2.1c-.2.2-.5.5-.9.5l.3-4.7 8.6-7.8c.4-.3-.1-.5-.6-.2L5.6 13.3 1 11.8c-1-.3-1-1 .2-1.5L19.1 3.4c.8-.3 1.6.2 1.3.7Z" /></svg>
                    </span>
                    <span><small>Telegram</small><b>@fyxtez</b></span>
                    <span className="landing-contact-arrow">↗</span>
                  </a>
                  <a href="mailto:fyxtez@gmail.com">
                    <span className="landing-contact-channel-icon mail" aria-hidden="true">
                      <svg viewBox="0 0 24 24"><path d="M3.5 6.5h17v11h-17zM4 7l8 6 8-6" /></svg>
                    </span>
                    <span><small>Email</small><b>fyxtez@gmail.com</b></span>
                    <span className="landing-contact-arrow">↗</span>
                  </a>
                </div>
              </div>
            </div>
            .
          </div>
        </div>
      </aside>

      <footer className="landing-footer">
        <span>© {new Date().getFullYear()} Fyxtez</span>
        <span>Designed and engineered by Fyxtez</span>
      </footer>
    </main>
  );
}

export default LandingPage;
