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
