import { getTier, type Tier } from "@ide/shared";
import { useStore } from "../lib/store";

/**
 * Celebratory "gift" modal shown when an admin gratuity-upgrades the user's plan.
 * Driven by `store.gift` (pushed from the daemon as `account_gift`). Dismissing
 * clears it.
 */
export function GiftModal() {
  const gift = useStore((s) => s.gift);
  const setGift = useStore((s) => s.setGift);
  if (!gift) return null;

  const close = () => setGift(null);
  const planName = getTier(gift.tier as Tier).name;

  return (
    <div className="modal-backdrop gift-backdrop" onClick={close}>
      <div className="modal gift-modal glass" onClick={(e) => e.stopPropagation()}>
        <div className="gift-sparkles" aria-hidden="true">
          ✦ ✧ ✦
        </div>
        <div className="gift-icon">🎁</div>
        <h2 className="gift-title">{gift.title}</h2>
        <div className={`gift-plan tier-${getTier(gift.tier as Tier).key}`}>{planName} · 1 month</div>
        <p className="gift-message">{gift.message}</p>
        <button className="btn-primary wide" onClick={close}>
          Awesome — let’s build ✨
        </button>
      </div>
    </div>
  );
}
