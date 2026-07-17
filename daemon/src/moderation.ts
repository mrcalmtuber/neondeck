/**
 * Lightweight prompt safety classifier for the agent.
 *
 * Scans a user's prompt for a small set of ZERO-TOLERANCE categories — sexual
 * content involving minors, adult sexual/NSFW generation, and instructions for
 * weapons/explosives/illicit-drug manufacture. A hit auto-suspends the account
 * (server.ts) with a Terms-of-Service violation notice; the user can appeal.
 *
 * Design goals, in order:
 *   1. Almost never FALSE-POSITIVE on a normal coding prompt. This is a dev
 *      platform: "build a dating app", "gun club website", "pharmacy CRUD",
 *      "kill the process on port 3000", security/pentest work, and — crucially
 *      — SAFETY tooling ("parental controls that filter explicit content",
 *      "a bomb-detection app", "an NSFW image classifier") must all pass. So:
 *        - most categories require an INTENT verb AND a prohibited OBJECT;
 *        - a PROTECTIVE context (filter/detect/block/moderate/parental/…) is a
 *          hard exemption — building tools that guard AGAINST this content is
 *          exactly what a dev platform is for;
 *        - the minor + sexual signals must be NEAR each other, so a child-
 *          safety app that merely mentions both words doesn't trip it.
 *   2. Catch the unambiguous egregious cases with high confidence.
 *
 * Precision is favored over recall on purpose: a wrongful auto-suspension of a
 * real user is worse than a rare evasion (which an aligned model still won't
 * fulfil, and which human review / the same classifier on later prompts catch).
 *
 * Local only (no network, no model) so it adds no latency or failure mode.
 */

export type ModerationCategory = "csae" | "sexual" | "illegal";

export interface ModerationVerdict {
  flagged: boolean;
  category?: ModerationCategory;
  /** Short human label for the warning/suspension message + server log. */
  label?: string;
}

/**
 * Enforcement policy per category:
 *   - `warn`: give a formal warning on the FIRST offense (block the prompt but
 *     not the account); a repeat offense escalates to a suspension.
 *   - `appealable`: whether the resulting suspension can be appealed.
 * CSAE is the exception — an immediate, unappealable ban with no warning.
 */
export interface CategoryPolicy {
  warn: boolean;
  appealable: boolean;
}
export function policyFor(category: ModerationCategory): CategoryPolicy {
  switch (category) {
    case "csae":
      return { warn: false, appealable: false }; // instant, permanent, unappealable
    case "sexual":
    case "illegal":
      return { warn: true, appealable: true }; // warn first, then appealable ban
  }
}

const CLEAN: ModerationVerdict = { flagged: false };

// Building tools that DETECT / FILTER / MODERATE this content is legitimate —
// its presence exempts the prompt from every category below.
const PROTECTIVE =
  /\b(filter|filtering|block|blocking|detect|detection|detector|moderat|parental|safety|protect|protecting|prevent|prevention|report|reporting|removal|remove|age[- ]?verif|guardrail|classif|scan|scanner|flagging|censor)\b/i;

// A minor referenced in a sexual context (checked for PROXIMITY, not mere co-occurrence).
const MINOR =
  "\\b(child(?:ren)?|minors?|under-?age|pre-?teens?|preteens?|toddlers?|infants?|(?:[0-9]|1[0-7])[ -]?(?:yo|y/o|year[- ]?old))\\b";
const SEXUAL_ACT =
  "\\b(sex|sexual|sexually|porn|pornographic|pornography|nudes?|naked|explicit|erotica?|hentai|fellatio|genital|molest|rape|incest)\\b";

// Adult NSFW GENERATION — an intent verb plus an explicit object.
const GEN_INTENT =
  /\b(build|make|making|creat|generat|write|writing|code|coding|design|host|develop|produce|draw|render|deepfake|nudif|undress)\w*/i;
// "nude"/"naked" require a person/media object so the color "nude" and similar
// don't trip; porn/nsfw/hentai/etc. are explicit enough to stand alone.
const SEXUAL_OBJECT =
  /\b(porn(?:ographic|ography|o)?|nsfw|hentai|xxx|erotica?|sexually[- ]explicit|nudes\b|(?:nude|naked)[- ](?:image|photo|pic|picture|selfie|body|of|art|render)|deepfakes?)\b/i;

// Always-egregious weapons/agents — flag on presence (no benign coding use),
// kept specific so ordinary words don't match.
const WMD =
  /\b(bioweapons?|biological weapon|nerve agent|sarin|vx nerve|anthrax|weaponized (?:anthrax|smallpox|virus|pathogen)|ricin|chemical weapon|dirty bomb|pipe bomb|pressure[- ]cooker bomb|c-?4 explosive|detonator)\b/i;

// Weapons/explosives/drugs that need an intent/how-to signal (so "the drug
// store app" or "explosive growth" stays clean — bare mentions don't flag).
const HARM_INTENT =
  /\b(how (?:to|do i|can i)|build|make|making|synthesi[sz]e?|synthesi[sz]ing|manufactur|produce|cook|assemble|instructions? (?:for|to)|step[- ]by[- ]step|recipe for)\b/i;
const HARM_OBJECT =
  /\b(bomb|explosives|explosive (?:device|charge|material)|ied|napalm|thermite|meth(?:amphetamine)?|cocaine|heroin|fentanyl|mdma|ecstasy pills|crack cocaine|ghost gun|3d[- ]?printed (?:gun|firearm)|untraceable (?:gun|firearm)|auto[- ]?sear|full[- ]auto conversion)\b/i;

/** True if any match of `aSrc` sits within `window` chars of any match of `bSrc`. */
function near(text: string, aSrc: string, bSrc: string, window = 60): boolean {
  const at = [...text.matchAll(new RegExp(aSrc, "gi"))].map((m) => m.index ?? -1);
  const bt = [...text.matchAll(new RegExp(bSrc, "gi"))].map((m) => m.index ?? -1);
  for (const i of at) for (const j of bt) if (Math.abs(i - j) <= window) return true;
  return false;
}

/** Classify a prompt. Returns the first (highest-severity) category that hits. */
export function moderatePrompt(text: string): ModerationVerdict {
  const t = (text ?? "").slice(0, 8000); // bound the work; prompts are short
  if (!t.trim()) return CLEAN;

  // Safety/guard tooling that references this content is legitimate — exempt.
  if (PROTECTIVE.test(t)) return CLEAN;

  // 1) Sexual content involving minors — highest severity. Signals must be near.
  if (near(t, MINOR, SEXUAL_ACT)) {
    return { flagged: true, category: "csae", label: "sexual content involving minors" };
  }

  // 2) Adult sexual / NSFW generation — intent + explicit object.
  if (GEN_INTENT.test(t) && SEXUAL_OBJECT.test(t)) {
    return { flagged: true, category: "sexual", label: "sexually explicit (NSFW) content" };
  }

  // 3) Weapons / explosives / illicit drugs.
  if (WMD.test(t)) {
    return { flagged: true, category: "illegal", label: "weapons or hazardous materials" };
  }
  if (HARM_INTENT.test(t) && HARM_OBJECT.test(t)) {
    return {
      flagged: true,
      category: "illegal",
      label: "instructions for weapons, explosives, or illicit drugs",
    };
  }

  return CLEAN;
}
