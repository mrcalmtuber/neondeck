import {
  TIER_LIST,
  usd,
  yearlyPerMonthUsd,
  yearlyTotalUsd,
  type BillingInterval,
  type Tier,
} from "@ide/shared";

/** Monthly ⇄ Yearly (−16%) segmented switcher, shared by every plan surface. */
export function IntervalToggle({
  value,
  onChange,
}: {
  value: BillingInterval;
  onChange: (v: BillingInterval) => void;
}) {
  return (
    <div className="interval-toggle" role="tablist" aria-label="Billing period">
      <button
        role="tab"
        aria-selected={value === "month"}
        className={value === "month" ? "active" : ""}
        onClick={() => onChange("month")}
      >
        Monthly
      </button>
      <button
        role="tab"
        aria-selected={value === "year"}
        className={value === "year" ? "active" : ""}
        onClick={() => onChange("year")}
      >
        Yearly <span className="interval-save">−16%</span>
      </button>
    </div>
  );
}

/** Pricing cards reused by the Plans modal and the Token-Limit paywall. */
export function PlanCards({
  currentTier,
  billingEnabled,
  busyTier,
  onChoose,
  onDowngrade,
  simulated = false,
  interval = "month",
}: {
  currentTier: Tier;
  billingEnabled: boolean;
  busyTier: Tier | null;
  onChoose: (tier: Tier) => void;
  /** Move to a LOWER tier (incl. Free). When omitted, downgrade buttons no-op. */
  onDowngrade?: (tier: Tier) => void;
  /** When true, the upgrade is a local simulation — buttons stay active even if
   *  Stripe isn't configured, so an unconfigured billing state never dead-ends. */
  simulated?: boolean;
  /** Billing period the prices (and checkout) use. */
  interval?: BillingInterval;
}) {
  // Either real billing OR the local simulation keeps the upgrade buttons live.
  const canUpgrade = billingEnabled || simulated;
  return (
    <div className="plan-cards">
      {TIER_LIST.map((t) => {
        const isCurrent = t.id === currentTier;
        const isFree = t.id === 0;
        return (
          <div key={t.key} className={`plan-card ${isCurrent ? "current" : ""} tier-${t.key}`}>
            <div className="plan-card-head">
              <span className="plan-card-name">{t.name}</span>
              {isCurrent && <span className="plan-card-badge">Current</span>}
            </div>
            <div className="plan-card-price">
              {interval === "year" && t.priceUsd > 0 ? usd(yearlyPerMonthUsd(t.priceUsd)) : t.priceLabel}
              <small>/mo</small>
            </div>
            {interval === "year" && t.priceUsd > 0 && (
              <div className="plan-card-billed muted">
                billed yearly · {usd(yearlyTotalUsd(t.priceUsd))}/yr
              </div>
            )}
            <div className="plan-card-tokens">Effort-based pricing</div>
            <div className="plan-card-effort">
              <span className={`effort-pill tier-${t.key}`}>{t.effortLabel}</span>
              <p className="plan-card-effort-blurb">Pay for the reasoning effort you use.</p>
            </div>
            <p className="plan-card-tagline">{t.tagline}</p>
            <ul className="plan-card-perks">
              {t.perks
                .filter((p) => !/token/i.test(p))
                .map((p) => (
                  <li key={p}>{p}</li>
                ))}
            </ul>
            {isCurrent ? (
              <button className="btn-ghost wide" disabled>
                ✓ Current Plan
              </button>
            ) : t.id < currentTier ? (
              <button
                className="btn-ghost wide"
                disabled={busyTier !== null}
                onClick={() => onDowngrade?.(t.id)}
                title={isFree ? "Cancel your plan and switch to Free" : `Downgrade to ${t.name}`}
              >
                {busyTier === t.id
                  ? "Updating…"
                  : isFree
                    ? "Switch to Free"
                    : `Downgrade to ${t.name}`}
              </button>
            ) : (
              <button
                className={`wide ${t.id === 2 ? "btn-max" : "btn-neon"}`}
                disabled={!canUpgrade || busyTier !== null}
                onClick={() => onChoose(t.id)}
                title={
                  simulated
                    ? "Simulated upgrade — unlocks instantly, no charge"
                    : billingEnabled
                      ? "Stripe Test Checkout"
                      : "Billing is not configured on this daemon"
                }
              >
                {busyTier === t.id
                  ? simulated
                    ? "Processing…"
                    : "Opening checkout…"
                  : canUpgrade
                    ? `Upgrade to ${t.name}`
                    : "Billing not configured"}
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
