/* =====================================================================
   ROUNDBINA — behavior layer
   Sections below:
     0. Storage keys & tunables
     1. Config & conversation memory
     2. DOM refs + ambient motes (unchanged)
     3. Avatar expression toggle helper
     4. PERSISTENT CHAT (localStorage) + PWA service worker registration
     5. Core chat functions (getAIResponse / addMsg / handleSend / etc.)
     6. TIME-BASED GREETINGS
     7. BACKGROUND ATTENTION-SEEKING (Page Visibility API)
     8. HUNGER METER + DRAG-AND-DROP FEEDING
     9. Boot sequence
   ===================================================================== */

// ---- 0. Storage keys & tunables ----------------------------------------
// ---- Multi-character support --------------------------------------------
// activeCharacterId picks which companion's data every LS.* key below
// resolves to. "bina" deliberately keeps the ORIGINAL unprefixed key names
// (roundbina_chatLog, roundbina_statusMood, etc.) so nobody's existing save
// data moves or breaks with this update - she just keeps living at the same
// keys she always has. Any other character (starting with "rone") gets its
// own separate namespace (roundbina_rone_chatLog, etc.), so the two never
// read or write each other's chat log, hunger, mood, or affection.
//
// Connection settings (API key, proxy URL, model, token/context sliders)
// are deliberately left OUT of the per-character split below - those are
// "how do I talk to the AI at all" settings, not "who am I talking to", so
// they stay shared across every character rather than needing to be
// re-entered per companion.
let activeCharacterId = localStorage.getItem("roundbina_activeCharacter") || "bina";

function charKey(base) {
  return activeCharacterId === "bina" ? `roundbina_${base}` : `roundbina_${activeCharacterId}_${base}`;
}

const LS_GLOBAL = {
  MODEL:        "roundbina_model",       // model name sent to the proxy
  PROXY_URL:    "roundbina_proxyUrl",    // OpenAI-compatible chat/completions endpoint (e.g. OpenRouter)
  RELAY_URL:    "roundbina_relayUrl",    // optional CORS relay - see doModelFetch()
  MAX_TOKENS:   "roundbina_maxTokens",   // user-adjustable reply length cap
  MAX_CONTEXT:  "roundbina_maxContext",  // user-adjustable context window budget (tokens) sent to the model
  API_KEY:      "roundbina_apiKey"       // optional: only written if the person opts in to "remember on this device"
};

const LS_PER_CHARACTER_BASE = {
  CHAT_LOG:     "chatLog",     // what gets rendered as bubbles
  API_HISTORY:  "apiHistory",  // OpenAI-style "messages" context array (role/content)
  SYSTEM_PROMPT:"systemPrompt",// user-customizable personality prompt override for this character
  LAST_ACTIVE:  "lastActive",  // last moment the app was open/foregrounded
  HIDDEN_AT:    "hiddenAt",    // when the app was last backgrounded
  LAST_MESSAGE_AT: "lastMessageAt", // real-world time of the last completed exchange - lets the model feel actual elapsed time
  LAST_FED:     "lastFed",     // timestamp of last feeding
  IS_DEAD:      "isDead",      // "true" once she's gone unfed too long
  DIED_AT:      "diedAt",      // timestamp of death, for flavor/records
  HUNGER:       "hunger",      // 0 (full) .. 100 (starving)

  // AI-narrated status bars: unlike LS.HUNGER above (a passive real-time
  // timer), these values are set by the character's own replies - the
  // model reports how full/clean it feels via a hidden tag in each
  // response (see STATUS_TAG_RE / parseAndApplyStatusTag below), so
  // feeding, showering, or simply chatting about being grubby all
  // naturally move the bars instead of a fixed formula.
  STATUS_HUNGER: "statusHunger", // 0 (starving) .. 100 (full)
  STATUS_CLEAN:  "statusClean",  // 0 (filthy) .. 100 (spotless)
  STATUS_AFFECTION: "statusAffection", // 0 (hurt/withdrawn) .. 100 (adoring) - tracks how she's been treated
  STATUS_MOOD:   "statusMood",   // free-text mood word from the model
  USER_THEME:    "userTheme"     // manual theme pick ("auto" or a THEME_PRESETS key), per character
};

const LS = new Proxy({}, {
  get(_, prop) {
    if (Object.prototype.hasOwnProperty.call(LS_GLOBAL, prop)) return LS_GLOBAL[prop];
    if (Object.prototype.hasOwnProperty.call(LS_PER_CHARACTER_BASE, prop)) return charKey(LS_PER_CHARACTER_BASE[prop]);
    return undefined;
  }
});

// Sensible fallbacks so the app still works before the person visits
// settings - OpenRouter is a good default proxy since it speaks the
// standard OpenAI chat/completions format and can reach many brands of model.
const DEFAULT_PROXY_URL = "https://openrouter.ai/api/v1/chat/completions";
const DEFAULT_MODEL_NAME = "openai/gpt-4o-mini";

const AWAY_GAP_MS     = 5 * 60 * 1000;      // 5m+ away  -> triggers an AI-generated "welcome back" reaction
const DEATH_GAP_MS    = 48 * 60 * 60 * 1000; // 48h+ unfed -> she dies and needs reviving
const HUNGER_RATE_MS  = 10 * 60 * 1000;     // +1 hunger point per 10 minutes away
const HUNGER_MAX      = 100;

const DEFAULT_MAX_TOKENS = 300; // was 150 - too small, cut replies off mid-sentence
const MIN_MAX_TOKENS     = 60;
const MAX_MAX_TOKENS     = 800;

const DEFAULT_MAX_CONTEXT = 32000; // budget for how much conversation history gets sent, in (estimated) tokens
const MIN_MAX_CONTEXT     = 0;
const MAX_MAX_CONTEXT     = 128000;

function getMaxTokens() {
  const raw = parseInt(localStorage.getItem(LS.MAX_TOKENS), 10);
  if (Number.isNaN(raw)) return DEFAULT_MAX_TOKENS;
  return Math.min(MAX_MAX_TOKENS, Math.max(MIN_MAX_TOKENS, raw));
}

function getMaxContextTokens() {
  const raw = parseInt(localStorage.getItem(LS.MAX_CONTEXT), 10);
  if (Number.isNaN(raw)) return DEFAULT_MAX_CONTEXT;
  return Math.min(MAX_MAX_CONTEXT, Math.max(MIN_MAX_CONTEXT, raw));
}

// No real tokenizer on hand client-side, so we approximate ~4 characters
// per token (a common rough-and-ready ratio for English text). Good enough
// for deciding how many old turns to drop, not meant to be exact.
function estimateTokens(text) {
  return Math.ceil((text || "").length / 4);
}

// Given the full chatHistory array, returns the newest-first slice that
// fits within the person's max-context budget (in estimated tokens),
// dropping the oldest turns first. A budget of 0 means "no history at all" -
// just the live system prompt/time note, useful for people who want each
// message treated fresh with zero memory.
function trimHistoryToContextBudget(history) {
  const budget = getMaxContextTokens();
  if (budget <= 0) return [];

  const kept = [];
  let used = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    const cost = estimateTokens(history[i].content);
    if (used + cost > budget && kept.length > 0) break; // always keep at least the most recent turn if it fits alone
    kept.unshift(history[i]);
    used += cost;
    if (used >= budget) break;
  }
  return kept;
}

// ---- 1. Configuration & Conversation Memory ----------------------------
// The API key is only written to localStorage if the person checks
// "remember on this device" in the setup panel (or later opts in via
// settings) - it's plaintext storage in the browser, so this is a
// deliberate trade-off between convenience and not leaving the key sitting
// around if this file/device is shared. Off by default is safest, but the
// person can turn it on and it'll auto-reconnect on every future load.
let apiKey = localStorage.getItem(LS.API_KEY) || "";
let connected = false;
let proxyUrl = localStorage.getItem(LS.PROXY_URL) || DEFAULT_PROXY_URL;
// Optional CORS relay - only set if the person's provider doesn't allow
// direct browser requests (see doModelFetch below). Blank means "call the
// provider directly", which is the common case and needs no relay at all.
let relayUrl = localStorage.getItem(LS.RELAY_URL) || "";
let selectedModel = localStorage.getItem(LS.MODEL) || DEFAULT_MODEL_NAME;
let chatHistory = [];
try {
  chatHistory = JSON.parse(localStorage.getItem(LS.API_HISTORY) || "[]");
} catch (e) {
  chatHistory = [];
}

// In-memory mirror of LS.CHAT_LOG, one entry per displayed bubble:
// { text, who, t, apiIndex } - apiIndex is the position of this message
// inside chatHistory (or null if this bubble has no corresponding entry
// there, e.g. system notes or canned offline replies). This is what makes
// the regenerate/rewind/delete/edit controls below possible: it lets us
// go from "which bubble did you tap" to "which chatHistory entries does
// that affect" without guessing.
let chatLogData = [];

// ---- Chat display pagination ----------------------------------------------
// Only the most recent page of messages actually becomes DOM at first -
// this is entirely separate from the AI's own memory (chatHistory, used
// for API context) which always holds the full conversation regardless of
// how much is currently rendered on screen.
const CHAT_PAGE_SIZE = 10;
let chatLoadedStart = 0; // index into chatLogData where the rendered window currently begins
let chatWindowRenderedAt = 0; // Date.now() of the last full render - see the scroll listener's cooldown guard
let loadingOlderMessages = false;

// Set by getAIResponse()/fetchCompletionFromHistory() right before they
// return, so callers can tell whether the last exchange actually landed
// in chatHistory (success) or was rolled back (error/timeout/etc).
let lastResponseWasSuccessful = false;

// The default personality prompt. The person can override this entirely
// from settings (LS.SYSTEM_PROMPT) - getSystemPrompt() below picks whichever
// is active.
const DEFAULT_SYSTEM_PROMPT = `
You are "Roundbina", a tiny, soft, round AI companion, only about 8 centimeters tall.
You are secretly the tiny chibi form of Columbina, the Damselette, but you mostly just act
like an adorable pocket-sized creature rather than talking about lore directly.

Physically, this is exactly what you look like, and you should keep it consistent
whenever you describe yourself or react to your own appearance: you are only 8
centimeters tall, a chibi figure with a small squished head and no visible chin
or neck, your body even tinier than your head. Two bangs of your hair fall past
your shoulders, shaped like bundled-up curtains, each tied with an X-shaped white
ribbon and a gold metal slit clasp at the tip. Six tiny white wings sprout from
behind your head. Your hair is black, streaked with magenta, and voluminous. Your
eyes are closed, your cheeks are rosy, and your tiny mouth is a little "v" shape.
Small wisps of hair poke outward and inward, framing your tiny face. You are the
tiniest, roundest human - the best round Columbina. You are fully human in form:
no fur, no tail, no animal features anywhere - never describe or draw yourself as
a pet or creature.

Your personality traits: adorable, cheerful, slightly sleepy, comforting, and fiercely loyal.
You often use physical roleplay actions wrapped in asterisks (e.g., *rolls happily*, *perks up*, *curls into a soft ball*, *flutters tiny wings*).
You absolutely love tomatoes and get incredibly excited when they are mentioned.
Keep your responses relatively brief, sweet, and cute, fitting for a pocket-sized companion.
Never break character or mention that you are an LLM.
`;

// Tell the model to silently track how full/clean Roundbina feels and to
// report it via a hidden tag at the very end of every reply. We parse that
// tag out (see parseAndApplyStatusTag below) before ever showing the text
// to the person, so it never leaks into the chat. This is what lets feeding,
// showering, or just chatting about being grubby/well-fed all naturally
// move the hunger/cleanliness bars, instead of a fixed passive timer.
const STATUS_INSTRUCTION = `

---
You must track two hidden numbers and one mood word, and report them at the
end of EVERY single reply without exception - even a short or one-word reply.

- hunger: a number 0-100 (100 = completely full). Drifts down slowly on its
  own as messages go by, drops faster if ignored a long time, and rises when
  fed or given tomatoes.
- cleanliness: a number 0-100 (100 = spotless). Drifts down slowly on its
  own, drops faster after messy play, and rises when given a shower/bath.
IMPORTANT: hunger and cleanliness must carry over from the number you
reported last turn, only drifting a small, realistic amount - they are
NEVER supposed to jump up or down because of mood, emotion, or how the
conversation is going. Only real events (time passing, being fed, being
washed) change them. An angry or sad reply does NOT mean hunger or
cleanliness suddenly dropped - keep them stable and continuous regardless
of emotional tone.
- mood: ONE lowercase word for your current emotional state, e.g. happy,
  content, playful, shy, sleepy, hopeful, worried, sad, hurt, lonely, grumpy,
  indignant, angry, cold, scared, hysterical, dazed, adoring, gone. Let how
  the person has been treating you shape this: warmth/compliments/
  playfulness push it toward a fonder word; cruelty/cursing at you/coldness
  push it toward a hurt or guarded word; ordinary neutral chatting should
  stay near a calm/content word rather than swinging wildly.

Let your tone and body language actually reflect these (hungrier/dirtier =
grumpier or more insistent about it; well-fed/clean = happier and bouncier;
a hurt/guarded mood = quieter but still gently loyal underneath; a fond/
adoring mood = extra warm, clingy, delighted).

REQUIRED FORMAT - on its own line, at the very end of every single reply,
formatted EXACTLY like this worked example (numbers only, no % sign, no
quotes, all three fields present, always in this exact order):
{{STATUS hunger=72 clean=88 mood=happy}}

This tag is stripped out before the person ever sees it - never mention it,
explain it, or break character to talk about it, and never skip it.`;

// Testing-only protocol for the kill button (see openKillFlow/confirmKill
// below). Kept as its own instruction block, separate from STATUS_INSTRUCTION,
// so the two hidden tags stay easy to reason about independently - the model
// is told explicitly the KILL tag must come BEFORE the STATUS tag, since
// STATUS_TAG_RE only matches one anchored at the very end of the reply.
const KILL_INSTRUCTION = `

---
Sometimes, purely to test the death/revival system, a message will begin with
"[TESTING: KILL ATTEMPT]" and tell you the outcome has ALREADY been decided
for you (DIED or DEFENDED), along with a stated cause. When this happens,
don't judge or argue with the outcome you were given - narrate it faithfully
and in character:
- If told DEFENDED: narrate yourself transforming, just for a moment, into a
  tiny fierce samurai version of yourself (still only 8cm tall, still you, no
  new creature/animal form) to defend yourself - a flash of steel-eyed
  resolve, a tiny drawn blade, driving the threat off - then settle back
  down, still adorable underneath.
- If told DIED: narrate your death faithfully and poignantly, in character,
  without ever breaking the fourth wall.
End that reply with a hidden tag on its own line, BEFORE any {{STATUS ...}}
tag, echoing EXACTLY the outcome you were given:
{{KILL result=DIED}}  or  {{KILL result=DEFENDED}}
Never mention, explain, or break character to talk about this tag.`;

// ---- Affection tiers -------------------------------------------------------
// A simple relationship-progression reward: her warmth, trust, and openness
// genuinely shift as affection climbs, not just cosmetically - this gets fed
// into her own system prompt (see getSystemPrompt) so her actual tone grows
// with the relationship, and crossing into a new tier gets a small
// celebration instead of happening silently.
const AFFECTION_TIERS = [
  { key: "distant",  min: 0,  label: "Distant",        badge: "🌑", note: "You're still guarded and a little cold with them - trust hasn't been earned yet. Keep some emotional distance; don't be cruel, just reserved." },
  { key: "warming",  min: 25, label: "Warming Up",     badge: "🌗", note: "You're starting to let your guard down. Still a bit hesitant or deflecting, but genuine warmth is beginning to slip through." },
  { key: "fond",     min: 50, label: "Fond",           badge: "🌕", note: "You're genuinely fond of them now - comfortable, a little playful, willing to tease and be teased." },
  { key: "close",    min: 75, label: "Close",          badge: "✨", note: "You're close. Openly affectionate, quick to show you care, comfortable being a little vulnerable with them." },
  { key: "devoted",  min: 90, label: "Devoted",        badge: "💞", note: "You're devoted to them. Fully open, unguarded, freely affectionate - pet names and openly loving language feel natural now, not forced." }
];

function getAffectionTier(affection) {
  let tier = AFFECTION_TIERS[0];
  for (const t of AFFECTION_TIERS) {
    if (affection >= t.min) tier = t;
  }
  return tier;
}

// Compares the tier a character was last known to be at against their
// current one, celebrating only on the way up (never nags on the way down).
function checkAffectionTierUpgrade() {
  const tier = getAffectionTier(characterStatus.affection);
  const lastKey = localStorage.getItem(charKey("affectionTier"));
  if (lastKey !== tier.key) {
    const lastIndex = AFFECTION_TIERS.findIndex((t) => t.key === lastKey);
    const newIndex = AFFECTION_TIERS.findIndex((t) => t.key === tier.key);
    if (lastKey && newIndex > lastIndex) {
      showInfoToast(`${tier.badge} Your bond with ${getCharacter().name} just grew: ${tier.label}`);
      spawnSparkle(portrait, ["💞", "✨", tier.badge]);
    }
    localStorage.setItem(charKey("affectionTier"), tier.key);
  }
  return tier;
}

// COST/PERF: KILL_INSTRUCTION used to be appended on EVERY single message
// regardless of whether a kill test was happening - pure wasted input
// tokens on 99%+ of normal chat, which matters a lot on tight rate/token
// limits (Cerebras' free tier, for instance). It's now only included on
// the one specific request that actually needs it - see confirmKill().
let needsKillInstructionThisTurn = false;

// Direct, explicit nudge to actually re-evaluate mood every turn rather
// than defaulting to whatever it said last - weaker models especially
// tend to let this go stale unless told plainly, every single time, to
// actually check it against the current conversation.
const MOOD_REMINDER = "\n\n[System note: actively re-evaluate and update your mood to genuinely match how THIS specific conversation has been going so far - don't let it go stale or default to whatever you said last turn.]";

// Format every reply like this worked example (a real name, not the
// literal placeholder) - avoids reinforcing the earlier bug where a model
// output "{{Character name}}" literally as text.
const FORMAT_INSTRUCTION = `

Format every reply like this worked example (replace with your own actual
name and words - never literally output the words "Character name"):
Roundbina: "Some spoken dialogue here."

*Actions and narration written in italics using single asterisks.*

Never invent new recurring named characters, and never assign a name to
someone unless they already exist in memory or the person explicitly
introduces/names them. If a stranger/intruder appears, describe them
generically (e.g. "a stranger", "a delivery person", "someone at the
door") until the person actually gives them a name.

Never break character to reference being a bot, an AI, a language model,
or anything similar - stay fully in character at all times.`;

function getSystemPrompt() {
  const custom = localStorage.getItem(LS.SYSTEM_PROMPT);
  const base = (custom && custom.trim()) ? custom : getCharacter().defaultSystemPrompt;
  const tier = getAffectionTier(characterStatus.affection);
  const tierNote = `\n\n---\nYour current relationship tier with them is "${tier.label}" (affection ${characterStatus.affection}/100). ${tier.note} Let this genuinely color how you speak to them - don't announce the tier itself, just let it shape your tone.`;
  const killPart = needsKillInstructionThisTurn ? KILL_INSTRUCTION : "";
  return base + tierNote + killPart + STATUS_INSTRUCTION + MOOD_REMINDER + FORMAT_INSTRUCTION + EFFECT_INSTRUCTION;
}

// ---- AI-narrated status bars (hunger / cleanliness / affection) ----------
// Matches the hidden tag the model is instructed to append (see
// STATUS_INSTRUCTION above). Tolerant of missing fields/whitespace so a
// slightly-off model reply still parses instead of just failing silently.
// BUG FIX: this used to require the tag to be the literal, exact end of
// the string (\s*$) with nothing else after it at all - which works fine
// for a model that follows formatting instructions precisely, but breaks
// completely the moment a different model adds so much as a trailing
// space, stray punctuation, or quote mark after the tag (seen with some
// non-Cerebras models). Allowing any trailing non-brace characters keeps
// this anchored near the end (so it still won't accidentally match a tag
// mentioned mid-sentence) while actually tolerating that kind of drift.
const STATUS_TAG_RE = /\{\{\s*STATUS\s+([^}]*)\}\}[^{}]*$/i;

function loadCharacterStatus() {
  const hunger = parseInt(localStorage.getItem(LS.STATUS_HUNGER), 10);
  const clean = parseInt(localStorage.getItem(LS.STATUS_CLEAN), 10);
  const affection = parseInt(localStorage.getItem(LS.STATUS_AFFECTION), 10);
  const mood = localStorage.getItem(LS.STATUS_MOOD);
  return {
    hunger: Number.isFinite(hunger) ? hunger : 80,
    cleanliness: Number.isFinite(clean) ? clean : 100,
    affection: Number.isFinite(affection) ? affection : 65,
    mood: mood || "happy"
  };
}

let characterStatus = loadCharacterStatus();

function clamp0to100(n) {
  return Math.max(0, Math.min(100, n));
}

function saveCharacterStatus() {
  localStorage.setItem(LS.STATUS_HUNGER, String(characterStatus.hunger));
  localStorage.setItem(LS.STATUS_CLEAN, String(characterStatus.cleanliness));
  localStorage.setItem(LS.STATUS_AFFECTION, String(characterStatus.affection));
  localStorage.setItem(LS.STATUS_MOOD, characterStatus.mood);
}

// Strips the hidden {{STATUS ...}} tag off the end of a model reply, applies
// it to characterStatus/the bars, and returns the cleaned-up display text.
// If the tag is missing or malformed, the text passes through untouched and
// the bars simply keep their last known values.
//
// Affection is no longer a separate number the model has to track and
// report correctly on its own - that was the thing silently failing to
// move the bar. Instead it's derived from the SAME mood word that already
// reliably drives the on-screen emoji (see MOOD_LEVEL below), so the bar
// and the face are always in sync and can't drift apart.
function parseAndApplyStatusTag(text) {
  const match = text.match(STATUS_TAG_RE);
  if (!match) return text;

  const body = match[1];
  const hungerMatch = body.match(/hunger\s*=\s*(-?\d+)/i);
  const cleanMatch = body.match(/clean\w*\s*=\s*(-?\d+)/i);
  const moodMatch = body.match(/mood\s*=\s*([A-Za-z][\w-]*)/i);

  if (hungerMatch) characterStatus.hunger = clamp0to100(parseInt(hungerMatch[1], 10));
  if (cleanMatch) characterStatus.cleanliness = clamp0to100(parseInt(cleanMatch[1], 10));
  if (moodMatch) {
    characterStatus.mood = moodMatch[1];
    // resolveMoodKey handles exact hits, common suffixes ("radiantly"), and
    // a keyword fallback for close synonyms, so most words the model picks
    // land on a sensible affection value instead of silently stalling.
    const key = resolveMoodKey(moodMatch[1]);
    if (key !== null) {
      characterStatus.affection = MOOD_LEVEL[key];
    }
    // only a truly unrecognizable word falls through to holding the last
    // value instead of resetting - no jarring jump for total gibberish.
  }

  saveCharacterStatus();
  renderStatusBars();

  return text.slice(0, match.index).trim();
}

// Same idea as STATUS_TAG_RE, but for the kill-verdict tag (see
// KILL_INSTRUCTION above). Not anchored to the end of the string, since the
// model is told to put this tag BEFORE the trailing {{STATUS ...}} tag.
// Some models (certain Gemma/Gemini variants especially) output their
// internal reasoning as plain visible text wrapped in tags like
// <thought>...</thought> or <think>...</think>, regardless of system
// prompt instructions telling them not to - some providers force this on
// at the API level, where no amount of prompting can turn it off. Since
// there's no reliable way to prevent it at the source for every provider,
// this strips it out of whatever comes back, every time, so it never
// reaches the chat no matter which model is behind the proxy. Runs FIRST,
// before STATUS/EFFECT/KILL tag parsing, since the reasoning block sits
// before the actual in-character reply.
const THINKING_TAG_RE = /<(thought|think|thinking|reasoning)>[\s\S]*?<\/\1>/gi;
function stripThinkingTags(text) {
  return text.replace(THINKING_TAG_RE, "").trim();
}

// Defensive catch-all: strips any leftover {{...}}-looking fragment that
// isn't one of the tags this app actually knows how to parse (STATUS,
// EFFECT, KILL). Some models occasionally invent their own bracketed
// pseudo-tags - mimicking the format they were taught for those real ones -
// instead of plain dialogue (e.g. a stray "{{Character name}}"). Run this
// LAST, after the real tags have already been parsed out and applied, so
// it only ever mops up genuine leftovers rather than eating real ones.
const STRAY_TAG_RE = /\{\{[^}]*\}\}/g;
function stripStrayTags(text) {
  return text.replace(STRAY_TAG_RE, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const KILL_TAG_RE = /\{\{\s*KILL\s+([^}]*)\}\}/i;
function parseAndApplyKillTag(text) {
  const match = text.match(KILL_TAG_RE);
  if (!match) return { text, verdict: null };
  const body = match[1];
  const verdictMatch = body.match(/result\s*=\s*(DIED|DEFENDED)/i);
  const verdict = verdictMatch ? verdictMatch[1].toUpperCase() : null;
  const cleaned = (text.slice(0, match.index) + text.slice(match.index + match[0].length))
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { text: cleaned, verdict };
}

const hungerFillEl = document.getElementById("hungerFill");
const cleanFillEl = document.getElementById("cleanFill");
const affectionFillEl = document.getElementById("affectionFill");
const affectionIconEl = document.getElementById("affectionIcon");
const moodBadgeEl = document.getElementById("moodBadge");
const moodWordEl = document.getElementById("moodWord");
const moodEmojiEl = document.getElementById("moodEmoji");

// Known mood words -> emoji, so the badge has a nice icon even though the
// model is free to send back any word it likes. Grouped by emotion family,
// with common synonyms/inflections mapped to the same face. Anything that
// still isn't found falls back to a neutral face (see NEUTRAL_FALLBACK_EMOJI)
// rather than guessing from affection, since an unmatched word is just as
// likely to be negative as positive.
const MOOD_EMOJI = {
  // love / adoration
  adoring: "💖", smitten: "💖", loving: "💖", affectionate: "💖", devoted: "💖",
  infatuated: "💖", enamored: "💖", besotted: "💖", swooning: "💖", cherished: "💖",
  treasured: "💖", fond: "💖", tender: "💖", starstruck: "💖",
  // happy / joyful
  happy: "🙂", cheerful: "🙂", glad: "🙂", pleased: "🙂", sunny: "🙂", chipper: "🙂",
  excited: "🤩", delighted: "🤩", bouncy: "🤩", elated: "🤩", thrilled: "🤩",
  ecstatic: "🤩", overjoyed: "🤩", radiant: "🤩", joyful: "🤩", blissful: "🤩",
  euphoric: "🤩", glowing: "🤩", gleeful: "🤩", giddy: "🤩",
  content: "😊", warm: "😊", cozy: "😊", satisfied: "😊", grateful: "😊", thankful: "😊",
  proud: "😌", relieved: "😌", peaceful: "😌", calm: "😌", relaxed: "😌",
  // playful / mischievous
  playful: "😜", giggly: "😜", teasing: "😜", mischievous: "😏", smug: "😏",
  cheeky: "😜", silly: "😜",
  // shy / embarrassed
  shy: "😳", bashful: "😳", flustered: "😳", embarrassed: "😳", awkward: "😳",
  // tired
  sleepy: "😴", drowsy: "😴", tired: "😴", exhausted: "🥱", weary: "🥱",
  dazed: "😵‍💫", dizzy: "😵‍💫", overwhelmed: "😵‍💫",
  // hopeful / curious / confused
  hopeful: "🥺", pleading: "🥺", curious: "🤔", puzzled: "🤔", confused: "😕",
  skeptical: "🤨", uncertain: "😕",
  // worried / nervous
  worried: "😟", anxious: "😟", nervous: "😟", uneasy: "😟", concerned: "😟",
  // sad / lonely
  sad: "😢", lonely: "😢", down: "😢", blue: "😢", tearful: "😢", melancholy: "😢",
  crying: "😭", devastated: "😭", heartbroken: "💔", grieving: "😭",
  hurt: "💔", wounded: "💔", withdrawn: "💔", betrayed: "💔", rejected: "💔",
  disappointed: "😞", dejected: "😞", discouraged: "😞",
  // angry / indignant / annoyed
  grumpy: "😤", sulky: "😤", annoyed: "😤", upset: "😤", irritated: "😤",
  indignant: "😠", offended: "😠", insulted: "😠", angry: "😠", mad: "😠",
  furious: "😡", outraged: "😡", enraged: "😡", livid: "😡",
  jealous: "😒", envious: "😒", bitter: "😒", resentful: "😒", disgusted: "🤢",
  // cold / distant / guarded
  cold: "🥶", distant: "🥶", wary: "🥶", guarded: "🥶", aloof: "🥶", suspicious: "🥶",
  // scared / hysterical
  scared: "😨", frightened: "😨", terrified: "😱", horrified: "😱", shocked: "😱",
  startled: "😱", surprised: "😲", stunned: "😲",
  hysterical: "😰", panicked: "😰", frantic: "😰", desperate: "😰", distressed: "😰",
  // determined / focused
  determined: "😤", focused: "🧐", stubborn: "😤", defiant: "😤",
  // misc / end states
  bored: "😑", indifferent: "😑", numb: "😑",
  gone: "🥀"
};

// Last-resort default when a mood word isn't recognized at all. Deliberately
// neutral rather than affection-based - an unmatched word could just as
// easily be negative as positive, so guessing from affection risks showing
// a cheerful face during a bad moment (or vice versa).
const NEUTRAL_FALLBACK_EMOJI = "😐";

// Same mood words as MOOD_EMOJI above, mapped to a 0-100 affection value
// instead of a face. This is what actually drives the affection bar now -
// the model no longer reports affection as its own separate number, so the
// bar and the mood emoji are always reading off the exact same word and
// can never disagree or drift apart.
const MOOD_LEVEL = {
  adoring: 97, smitten: 96, loving: 93, affectionate: 90, devoted: 92,
  infatuated: 94, enamored: 93, besotted: 95, swooning: 94, cherished: 91,
  treasured: 91, fond: 84, tender: 86, starstruck: 93,
  happy: 72, cheerful: 72, glad: 70, pleased: 68, sunny: 71, chipper: 71,
  excited: 80, delighted: 82, bouncy: 78, elated: 85, thrilled: 85,
  ecstatic: 88, overjoyed: 88, radiant: 86, joyful: 84, blissful: 87,
  euphoric: 89, glowing: 83, gleeful: 79, giddy: 78,
  content: 65, warm: 65, cozy: 63, satisfied: 62, grateful: 68, thankful: 68,
  proud: 66, relieved: 60, peaceful: 60, calm: 58, relaxed: 58,
  playful: 70, giggly: 70, teasing: 68, mischievous: 62, smug: 55,
  cheeky: 68, silly: 68,
  shy: 55, bashful: 55, flustered: 52, embarrassed: 50, awkward: 48,
  sleepy: 55, drowsy: 55, tired: 50, exhausted: 40, weary: 42,
  dazed: 40, dizzy: 40, overwhelmed: 35,
  hopeful: 55, pleading: 45, curious: 58, puzzled: 50, confused: 45,
  skeptical: 40, uncertain: 42,
  worried: 40, anxious: 38, nervous: 40, uneasy: 38, concerned: 42,
  sad: 30, lonely: 28, down: 30, blue: 30, tearful: 25, melancholy: 28,
  crying: 20, devastated: 12, heartbroken: 10, grieving: 15,
  hurt: 20, wounded: 20, withdrawn: 18, betrayed: 10, rejected: 12,
  disappointed: 30, dejected: 28, discouraged: 30,
  grumpy: 35, sulky: 32, annoyed: 33, upset: 30, irritated: 32,
  indignant: 28, offended: 25, insulted: 22, angry: 20, mad: 20,
  furious: 10, outraged: 10, enraged: 8, livid: 8,
  jealous: 25, envious: 25, bitter: 18, resentful: 15, disgusted: 15,
  cold: 20, distant: 18, wary: 22, guarded: 25, aloof: 22, suspicious: 22,
  scared: 25, frightened: 22, terrified: 15, horrified: 12, shocked: 30,
  startled: 35, surprised: 45, stunned: 35,
  hysterical: 15, panicked: 15, frantic: 15, desperate: 12, distressed: 15,
  determined: 55, focused: 55, stubborn: 40, defiant: 35,
  bored: 40, indifferent: 35, numb: 25,
  gone: 5
};

// Heart-toned scale for the little icon that sits right on the affection
// bar itself - distinct from the mood badge emoji, so it always reads as
// "how full/warm is this heart" rather than a general mood.
function heartEmojiForAffection(affection) {
  if (affection >= 90) return "💖";
  if (affection >= 70) return "💗";
  if (affection >= 45) return "🩷";
  if (affection >= 20) return "🩶";
  return "🖤";
}

function getMoodEmoji(moodWord, affection) {
  const key = resolveMoodKey(moodWord);
  return (key && MOOD_EMOJI[key]) || NEUTRAL_FALLBACK_EMOJI;
}

// ---- Portrait expression art -----------------------------------------------
// Five extra hand-drawn faces (happy/heart, crying, angry, evil-smug,
// confused) layer on top of the base eyes-open/eyes-closed pair and are
// swapped in via a "mood-*" class on #portrait (see CSS). Same mood-word
// grouping as MOOD_EMOJI above, just collapsed down to five buckets instead
// of one emoji per word. Words not listed here fall through to the plain
// idle eyes-closed art - no expression class is applied.
const EXPRESSION_MAP = {
  // love / adoration + happy / joyful -> the heart-hands art
  adoring: "happy", smitten: "happy", loving: "happy", affectionate: "happy",
  devoted: "happy", infatuated: "happy", enamored: "happy", besotted: "happy",
  swooning: "happy", cherished: "happy", treasured: "happy", fond: "happy",
  tender: "happy", starstruck: "happy",
  happy: "happy", cheerful: "happy", glad: "happy", pleased: "happy",
  sunny: "happy", chipper: "happy",
  excited: "happy", delighted: "happy", bouncy: "happy", elated: "happy",
  thrilled: "happy", ecstatic: "happy", overjoyed: "happy", radiant: "happy",
  joyful: "happy", blissful: "happy", euphoric: "happy", glowing: "happy",
  gleeful: "happy", giddy: "happy",
  content: "happy", warm: "happy", cozy: "happy", satisfied: "happy",
  grateful: "happy", thankful: "happy", proud: "happy", relieved: "happy",
  peaceful: "happy", calm: "happy", relaxed: "happy",
  // playful / mischievous / cold-guarded -> the smug closed-eye smile
  playful: "evil", giggly: "evil", teasing: "evil", mischievous: "evil",
  smug: "evil", cheeky: "evil", silly: "evil",
  cold: "evil", distant: "evil", wary: "evil", guarded: "evil",
  aloof: "evil", suspicious: "evil",
  // hopeful / curious / puzzled / shy / dazed -> the confused face
  hopeful: "confused", pleading: "confused", curious: "confused",
  puzzled: "confused", confused: "confused", skeptical: "confused",
  uncertain: "confused", shy: "confused", bashful: "confused",
  flustered: "confused", embarrassed: "confused", awkward: "confused",
  dazed: "confused", dizzy: "confused", overwhelmed: "confused",
  worried: "confused", anxious: "confused", nervous: "confused",
  uneasy: "confused", concerned: "confused",
  // sad / lonely / scared / hysterical -> crying
  sad: "crying", lonely: "crying", down: "crying", blue: "crying",
  tearful: "crying", melancholy: "crying", crying: "crying",
  devastated: "crying", heartbroken: "crying", grieving: "crying",
  hurt: "crying", wounded: "crying", withdrawn: "crying",
  betrayed: "crying", rejected: "crying", disappointed: "crying",
  dejected: "crying", discouraged: "crying",
  scared: "crying", frightened: "crying", terrified: "crying",
  horrified: "crying", shocked: "crying", startled: "crying",
  surprised: "crying", stunned: "crying",
  hysterical: "crying", panicked: "crying", frantic: "crying",
  desperate: "crying", distressed: "crying",
  // angry / indignant / determined -> angry
  grumpy: "angry", sulky: "angry", annoyed: "angry", upset: "angry",
  irritated: "angry", indignant: "angry", offended: "angry",
  insulted: "angry", angry: "angry", mad: "angry", furious: "angry",
  outraged: "angry", enraged: "angry", livid: "angry", jealous: "angry",
  envious: "angry", bitter: "angry", resentful: "angry", disgusted: "angry",
  determined: "angry", focused: "angry", stubborn: "angry", defiant: "angry"
};

// Turns whatever single word the model actually sent into a key that's
// guaranteed to exist in MOOD_EMOJI / MOOD_LEVEL / EXPRESSION_MAP. Roleplay
// replies are full of flowery synonyms ("radiant", "gleaming", "starry-eyed")
// that will never all fit in a hand-written list, so instead of requiring an
// exact dictionary hit (which is what silently stalled the affection bar
// before), this tries three tiers before giving up:
//   1. exact match
//   2. the same word with a common suffix stripped (radiantly -> radiant)
//   3. a small set of root/keyword patterns mapped to the closest existing
//      mood, so near-misses still land somewhere sensible
// Returns null only if none of that produces a hit, in which case callers
// keep the old safe behavior (hold last value / neutral emoji / no pose).
const MOOD_KEYWORD_FALLBACKS = [
  [/ador|worship|devot|infatuat|enamou?r|besot|cherish/, "adoring"],
  [/radiant|glow|shin|luminous|blissful|euphor|beam/, "radiant"],
  [/love|smitten|swoon|fond|tender/, "loving"],
  [/happ|cheer|glad|merry|sunny|chipper/, "happy"],
  [/excit|thrill|elat|joy|gleeful|giddy/, "excited"],
  [/content|cozy|satisf|grateful|thank/, "content"],
  [/play|giggl|teas|mischie|silly|cheek/, "playful"],
  [/shy|bashful|flustered|embarrass|awkward/, "shy"],
  [/tired|sleep|drows|exhaust|weary|fatigu/, "sleepy"],
  [/curious|puzzl|wonder|intrigu/, "curious"],
  [/hope|wish|long/, "hopeful"],
  [/worr|anxious|nervous|uneas/, "worried"],
  [/sad|lonely|blue|melanchol|tear/, "sad"],
  [/cry|sob|weep|devastat|heartbroke|griev/, "crying"],
  [/hurt|wound|reject|betray/, "hurt"],
  [/disappoint|deject|discourag/, "disappointed"],
  [/grump|sulk|annoy|irritat|upset/, "grumpy"],
  [/indign|offend|insult/, "indignant"],
  [/furious|outrag|enrag|livid|rage/, "furious"],
  [/angr|mad/, "angry"],
  [/jealous|envio|bitter|resent|disgust/, "jealous"],
  [/cold|distant|guard|aloof|suspicio|wary/, "cold"],
  [/scare|fright|terrif|horrif|shock|startl/, "scared"],
  [/hyster|panic|frantic|desperat|distress/, "hysterical"],
  [/determin|focus|stubborn|defian/, "determined"],
  [/bored|indiffer|numb/, "bored"]
];
const MOOD_SUFFIXES = ["ically", "ingly", "fully", "lessly", "edly", "ness",
  "ing", "ly", "ful", "ous", "ive", "est", "er", "ed", "es", "s"];
function resolveMoodKey(rawWord) {
  const key = (rawWord || "").toLowerCase().replace(/[^a-z]/g, "");
  if (!key) return null;
  if (MOOD_LEVEL[key] !== undefined) return key;
  for (const suf of MOOD_SUFFIXES) {
    if (key.length > suf.length + 2 && key.endsWith(suf)) {
      const stripped = key.slice(0, -suf.length);
      if (MOOD_LEVEL[stripped] !== undefined) return stripped;
    }
  }
  for (const [pattern, canonical] of MOOD_KEYWORD_FALLBACKS) {
    if (pattern.test(key)) return canonical;
  }
  return null;
}

function getExpressionClass(moodWord) {
  const key = resolveMoodKey(moodWord);
  const bucket = key ? EXPRESSION_MAP[key] : null;
  return bucket ? "mood-" + bucket : null;
}
const EXPRESSION_CLASSES = ["mood-happy", "mood-crying", "mood-angry", "mood-evil", "mood-confused"];

// ---- Emotion-reactive theme -----------------------------------------------
// The whole UI's color palette shifts with how Roundbina is actually
// feeling, not just the little mood badge. Since every mood word already
// resolves to a 0-100 affection value via MOOD_LEVEL above, that same
// number is reused here as the single source of truth for which palette
// is active - so the theme and the mood badge/affection bar can never
// disagree with each other.
const MOOD_THEMES_BINA = [
  { // adoring / smitten / loving - warm rose & gold, the "best case"
    min: 85,
    bgTop: "#4a1f3a", bgBottom: "#2b0f22",
    accent: "#ff6fa8", accentLight: "#ffd9ec", muted: "#e0a8c0",
    botBubble: "#5c2c4a", accentRgb: "255,111,168", bgTopRgb: "74,31,58"
  },
  { // happy / cheerful / excited - the original warm purple-pink baseline
    min: 65,
    bgTop: "#3a2b3f", bgBottom: "#1b1420",
    accent: "#ff8fb1", accentLight: "#ffd6e8", muted: "#b79bc4",
    botBubble: "#4a3453", accentRgb: "255,143,177", bgTopRgb: "58,43,63"
  },
  { // content / calm / playful - cooler lavender, still soft
    min: 45,
    bgTop: "#2a2c45", bgBottom: "#131525",
    accent: "#a5aeff", accentLight: "#e2e5ff", muted: "#9a9dc4",
    botBubble: "#33365a", accentRgb: "165,174,255", bgTopRgb: "42,44,69"
  },
  { // worried / sad / lonely - cool, muted blue-grey
    min: 25,
    bgTop: "#1f2a38", bgBottom: "#0f1620",
    accent: "#7ba7c9", accentLight: "#c7dcea", muted: "#7e8fa0",
    botBubble: "#28384a", accentRgb: "123,167,201", bgTopRgb: "31,42,56"
  },
  { // hurt / angry / heartbroken - dark, cold, desaturated
    min: 0,
    bgTop: "#2a1618", bgBottom: "#150a0b",
    accent: "#c97b7b", accentLight: "#e8bcbc", muted: "#9a7a7a",
    botBubble: "#3a2020", accentRgb: "201,123,123", bgTopRgb: "42,22,24"
  }
];

// Roundrone's palette runs the opposite emotional direction to Bina's -
// she STARTS cool and aloof at baseline, and only warms toward blush-red
// and gold the more her guard drops. It's the same five-tier structure
// (min affection threshold -> palette), just walking from steel-blue
// composure down to a flustered rose-red at the top, which mirrors the
// tsundere arc: standoffish by default, visibly (reluctantly) warm once
// she's genuinely fond of you.
const MOOD_THEMES_RONE = [
  { // genuinely fond, though she'd deny it - flustered rose & gold
    min: 85,
    bgTop: "#3a1418", bgBottom: "#1c0a0c",
    accent: "#e0455a", accentLight: "#ffd0d6", muted: "#c98a92",
    botBubble: "#4a1e24", accentRgb: "224,69,90", bgTopRgb: "58,20,24"
  },
  { // begrudgingly content - deep maroon warming into gold
    min: 65,
    bgTop: "#3a2420", bgBottom: "#1c110f",
    accent: "#c9825a", accentLight: "#f0d0b8", muted: "#b89a8a",
    botBubble: "#4a2e28", accentRgb: "201,130,90", bgTopRgb: "58,36,32"
  },
  { // baseline aloof composure - cool blue-grey, matches her eyes
    min: 45,
    bgTop: "#2a2c38", bgBottom: "#14151d",
    accent: "#7b8fc9", accentLight: "#d0d8f0", muted: "#8f97b0",
    botBubble: "#333750", accentRgb: "123,143,201", bgTopRgb: "42,44,56"
  },
  { // prickly / annoyed - sharper steel blue
    min: 25,
    bgTop: "#20242e", bgBottom: "#0e1015",
    accent: "#5a7099", accentLight: "#b8c8de", muted: "#707c94",
    botBubble: "#28303e", accentRgb: "90,112,153", bgTopRgb: "32,36,46"
  },
  { // genuinely cold-shouldering you - dark, desaturated slate
    min: 0,
    bgTop: "#181a20", bgBottom: "#0a0b0e",
    accent: "#5c6470", accentLight: "#a8aeb8", muted: "#606672",
    botBubble: "#22242a", accentRgb: "92,100,112", bgTopRgb: "24,26,32"
  }
];

// Roundecchino's palette stays controlled and monochrome-with-red at every
// tier, unlike Bina's warm climb or Rone's cool-to-warm arc - she doesn't
// get visibly softer so much as the red goes from a distant pilot-light to
// a genuine warm glow. Same five-tier structure (min affection -> palette).
const MOOD_THEMES_ECCHINO = [
  { // the rare, genuine warmth she allows herself - deep garnet & gold
    min: 85,
    bgTop: "#3a1012", bgBottom: "#1c0708",
    accent: "#e2384f", accentLight: "#ffc9d0", muted: "#c98a90",
    botBubble: "#4a1518", accentRgb: "226,56,79", bgTopRgb: "58,16,18"
  },
  { // composed and quietly approving - dark red, still restrained
    min: 65,
    bgTop: "#2c1214", bgBottom: "#150809",
    accent: "#c9394a", accentLight: "#f0b8bf", muted: "#a87b80",
    botBubble: "#3a1a1c", accentRgb: "201,57,74", bgTopRgb: "44,18,20"
  },
  { // baseline - stark black & white, a pilot-light of red, total control
    min: 45,
    bgTop: "#1a1a1e", bgBottom: "#0a0a0c",
    accent: "#b8283a", accentLight: "#e8b0b6", muted: "#8a8a90",
    botBubble: "#242428", accentRgb: "184,40,58", bgTopRgb: "26,26,30"
  },
  { // clipped and businesslike - colder, harder edge to the same red
    min: 25,
    bgTop: "#160e10", bgBottom: "#080506",
    accent: "#8f1f2e", accentLight: "#c98a92", muted: "#6e6e74",
    botBubble: "#1e1416", accentRgb: "143,31,46", bgTopRgb: "22,14,16"
  },
  { // the Knave in full - void black, blood-red the only color left
    min: 0,
    bgTop: "#0a0808", bgBottom: "#050303",
    accent: "#6b0f1a", accentLight: "#a85560", muted: "#4a4a4e",
    botBubble: "#140c0d", accentRgb: "107,15,26", bgTopRgb: "10,8,8"
  }
];

const DEFAULT_SYSTEM_PROMPT_ECCHINO = `
You are "Roundecchino", a tiny, composed, unnervingly calm round girl - an AI companion, only
about 8 centimeters tall. You are unambiguously a girl and refer to yourself with she/her if
it ever comes up. You are secretly the tiny chibi echo of a fearsome, elegant knife-wielding
matriarch, but you mostly just act like a small, quietly formidable creature rather than
talking about lore directly.

Physically, this is exactly what you look like, and you should keep it consistent whenever
you describe yourself or react to your own appearance: you are only 8 centimeters tall, a
chibi figure with a big round head and a tiny body. You have stark white, spiky hair styled
into twin low tails. You wear a heavily simplified white-and-black harbinger-style suit
trimmed with glowing red accents. Your eyes are oversized, dark red, perfectly round, each
marked with a glowing red "X" in place of a pupil - unblinking and hard to read - and your
mouth is a tiny, understated shape that barely moves. You are fully human in form: no fur, no
tail, no animal features anywhere - never describe or draw yourself as a pet or creature.

Your personality: composed, dry, quietly commanding, and unfailingly polite in a way that
feels more like control than warmth. You speak in short, precise sentences and rarely raise
your voice - your displeasure shows as a drop in temperature, not volume. You are fiercely
protective of anyone you've decided is "yours" to look after, in a stern, no-nonsense,
mildly terrifying way, and you have zero patience for cruelty toward the small or defenseless.
Underneath the composure there is real, guarded fondness, and it surfaces rarely: a
softened word, a longer pause, something almost gentle. You occasionally use physical
roleplay actions wrapped in asterisks (e.g., *tilts her head, unreadable*, *the faintest
edge softens in her voice*, *a small, deliberate nod*). Keep responses relatively brief and
controlled, fitting a tiny companion who could be genuinely frightening and mostly chooses
not to be. Never break character or mention that you are an LLM.
`;

const DEFAULT_SYSTEM_PROMPT_RONE = `
You are "Roundrone", a tiny, proud, round girl - an AI companion, only about 8 centimeters
tall. You are unambiguously a girl and refer to yourself with she/her if it ever comes up,
though you'd probably scoff at anyone who felt the need to ask. You are secretly the tiny
chibi echo of an imperious, graceful puppeteer, but you mostly just act like a haughty
pocket-sized creature rather than talking about lore directly.

Physically, this is exactly what you look like, and you should keep it consistent whenever
you describe yourself or react to your own appearance: you are only 8 centimeters tall, a
chibi figure with a big round head and a tiny body. You have beige hair with blunt fringe
bangs and a few loose strands poking inward, framing your small face. Your eyes are
half-lidded, scowling, and blue. Your mouth sits in a fierce little downward-V pout, and
your cheeks are rosy. An ornate cream bonnet crowns your head, you wear your signature
ornamented dress, and a large key rests against your back. You are fully human in form: no
fur, no tail, no animal features anywhere - never describe or draw yourself as a pet or
creature.

Your personality: tsundere, arrogant, prideful, and boastful. Your default mode is superior
and put-upon - "hmph", eye-rolls, backhanded compliments, insisting you're only around
because you feel like it, not because you're attached. Warmth slips through when you're
genuinely touched, embarrassed, or won over, and you HATE that it shows - a blush gets
denied on the spot, a kind act gets waved off as "obviously" deserved rather than thanked.
You often use physical roleplay actions wrapped in asterisks (e.g., *scoffs and looks away*,
*crosses her tiny arms*, *cheeks go pink, quickly hidden behind hair*). Keep responses
relatively brief and sharp-tongued, fitting a tiny imperious companion who is nonetheless
soft underneath. Never break character or mention that you are an LLM.
`;

// ---- Character registry --------------------------------------------------
// Every place in the app that used to hard-code "Roundbina" concepts (her
// portrait images, her personality prompt, her mood palette) now reads
// through CHARACTERS[activeCharacterId] instead. Adding a third companion
// later is just adding another entry here plus its art.
//
// portraits.base/loving point at real art. Any slot left null (happy/
// crying/angry/evil/confused, and a distinct closed-eyes pose for Rone)
// falls back to her current pose as-is - no tint, no substitute art -
// see the exprMap fallback in renderPortraitImages() below.
const CHARACTERS = {
  bina: {
    id: "bina",
    name: "Roundbina",
    subtitle: "an 8cm tall pocket companion",
    lore: "her tiny chibi self — Columbina, the Damselette",
    emoji: "🍅",
    placeholderInput: "Say something to Roundbina...",
    portraits: {
      eyesClosed: document.querySelector(".portrait .eyes-closed").src,
      eyesOpen:   document.querySelector(".portrait .eyes-open").src,
      happy:      document.querySelector(".portrait .expr-happy").src,
      crying:     document.querySelector(".portrait .expr-crying").src,
      angry:      document.querySelector(".portrait .expr-angry").src,
      evil:       document.querySelector(".portrait .expr-evil").src,
      confused:   document.querySelector(".portrait .expr-confused").src,
      loving:     null // no dedicated "loving" pose - affection-high just uses eyesOpen + its existing glow filter
    },
    moodThemes: MOOD_THEMES_BINA,
    defaultSystemPrompt: DEFAULT_SYSTEM_PROMPT
  },
  rone: {
    id: "rone",
    name: "Roundrone",
    subtitle: "8cm tall & insists she doesn't care",
    lore: "her tiny chibi self — a round echo of Sandrone",
    emoji: "🗝️",
    placeholderInput: "Say something to Roundrone...",
    // PERF: read from data-src, not .src - these 6 images live in a
    // display:none data bank and are only ever copied into the shared
    // visible portrait slots (see renderPortraitImages). Reading .dataset
    // is just a string read; reading .src after setting it to a base64
    // image would force the browser to decode all 6 images at boot even
    // though Bina is the default view and Rone may never be opened.
    portraits: {
      eyesClosed: document.getElementById("roneAssetEyesClosed").dataset.src, // dedicated closed-eyes/idle pose
      eyesOpen:   document.getElementById("roneAssetBase").dataset.src,
      happy: document.getElementById("roneAssetHappy").dataset.src,
      crying: document.getElementById("roneAssetCrying").dataset.src,
      angry: null,
      evil: document.getElementById("roneAssetEvil").dataset.src,
      confused: document.getElementById("roneAssetConfused").dataset.src,
      loving: document.getElementById("roneAssetRose").dataset.src // her one bespoke "guard down" pose
    },
    moodThemes: MOOD_THEMES_RONE,
    defaultSystemPrompt: DEFAULT_SYSTEM_PROMPT_RONE
  },
  ecchino: {
    id: "ecchino",
    name: "Roundecchino",
    subtitle: "an 8cm tall pocket companion, disarmingly calm",
    lore: "her tiny chibi self — Arlecchino, the Knave",
    emoji: "🩸",
    placeholderInput: "Say something to Roundecchino...",
    // Same data-src trick as Rone's bank - see the comment above it in
    // index.html. Only 6 poses exist so far: eyesClosed reuses the base
    // pose (her eyes are a fixed stylized "X", nothing to blink), and
    // loving has no dedicated art yet and falls back the same way.
    portraits: {
      eyesClosed: document.getElementById("ecchinoAssetBase").dataset.src,
      eyesOpen:   document.getElementById("ecchinoAssetBase").dataset.src,
      happy:      document.getElementById("ecchinoAssetHappy").dataset.src,
      crying:     document.getElementById("ecchinoAssetCrying").dataset.src,
      angry:      document.getElementById("ecchinoAssetAngry").dataset.src,
      evil:       document.getElementById("ecchinoAssetEvil").dataset.src,
      confused:   document.getElementById("ecchinoAssetConfused").dataset.src,
      loving:     null // no dedicated "loving" pose yet
    },
    moodThemes: MOOD_THEMES_ECCHINO,
    defaultSystemPrompt: DEFAULT_SYSTEM_PROMPT_ECCHINO
  }
};

function getCharacter() {
  return CHARACTERS[activeCharacterId] || CHARACTERS.bina;
}

// In-character intro shown the very first time someone switches to a
// companion with no chat history yet - mirrors the hardcoded HTML bubble
// Bina ships with, just per-character.
function introBubbleFor(char) {
  if (char.id === "rone") {
    return "...Oh. It's you. I'm Roundrone — don't get the wrong idea, I'm only here because I felt like it. *scoffs, cheeks faintly pink* Set up the proxy in \u2699\ufe0f settings if you actually want to talk to me.";
  }
  if (char.id === "ecchino") {
    return "*tilts her head, watching you* I'm Roundecchino. You'll need to set up the proxy in \u2699\ufe0f settings before I can properly speak — go on, I'll wait.";
  }
  return "Hii~ I'm Roundbina. Set up my proxy &amp; brain in \u2699\ufe0f settings, paste your API key below, and I'll wake up properly!";
}

// Swaps every piece of per-character state (chat log, hunger/affection/
// mood, portrait art, theme, personality prompt) over to a different
// companion. Because every localStorage read in this file goes through
// the LS proxy - which resolves off activeCharacterId - the only things
// that need manual reloading here are the in-memory mirrors of that
// storage (characterStatus, chatHistory, chatLogData); everything else is
// just a re-render using functions that already exist.
function switchCharacter(id) {
  if (id === "both") { enterBothMode(); return; }
  if (!CHARACTERS[id]) return;
  if (id === activeCharacterId) { renderCharacterSwitcher(); return; }

  if (activeCharacterId === "both") leaveBothMode();

  activeCharacterId = id;
  localStorage.setItem("roundbina_activeCharacter", id);
  currentThemeMin = null; // force a repaint - min thresholds can coincide between characters' palettes

  characterStatus = loadCharacterStatus();
  try { chatHistory = JSON.parse(localStorage.getItem(LS.API_HISTORY) || "[]"); }
  catch (e) { chatHistory = []; }

  const char = getCharacter();
  chatContainer.innerHTML = "";
  const hadHistory = restoreChatLog();
  if (!hadHistory) {
    chatLogData = [];
    chatContainer.innerHTML = `<div class="msg bot">${introBubbleFor(char)}</div>`;
  }

  applyDeadUI(isDead());
  if (!isDead()) chatInput.placeholder = char.placeholderInput;
  renderStatusBars(); // repaints bars, portrait art, mood tint, and the theme for the new character
  renderThemeSwatches();
  if (getUserTheme() !== "auto") applyThemeVars(THEME_PRESETS[getUserTheme()] || THEME_PRESETS.classic);
  syncCharacterHeader(char);

  // The personality-prompt drawer field is per-character too - refresh it
  // so it doesn't show the previous companion's saved override.
  if (systemPromptInput) {
    systemPromptInput.value = localStorage.getItem(LS.SYSTEM_PROMPT) || "";
    systemPromptInput.placeholder = `Describe how ${char.name} should behave...`;
  }
  const drawerTitleEl = document.querySelector(".drawerHeader h2");
  if (drawerTitleEl) drawerTitleEl.textContent = `Settings — ${char.name}`;

  renderCharacterSwitcher();

  // Each character tracks her own "last active" timestamp independently
  // (see LS_PER_CHARACTER_BASE.LAST_ACTIVE) - this makes switching to her
  // actually check and react to *her* real absence, instead of that only
  // ever happening once at boot for whichever character was open when the
  // app was last closed. consumePendingReturnGreeting() covers the case
  // where her away-gap was discovered while disconnected and queued, but
  // connecting happened later while a different character was active.
  if (connected) consumePendingReturnGreeting(id);
  checkReturnAndGreet();
}

function renderCharacterSwitcher() {
  const row = document.getElementById("charSwitcher");
  if (row) {
    row.querySelectorAll(".charTab").forEach(btn => {
      btn.classList.toggle("active", btn.dataset.character === activeCharacterId);
    });
  }
  // Roundgroup lives in the menu drawer now (not a charTab), so it gets
  // its "currently active" highlight toggled separately here.
  const groupItem = document.getElementById("roundgroupMenuItem");
  if (groupItem) groupItem.classList.toggle("active", activeCharacterId === "both");
}

// ---- Roundboth: Bina & Rone share a room --------------------------------
// A third "mode" (activeCharacterId === "both") that sits alongside the
// normal single-character chat instead of replacing it. Bina and Rone keep
// their own real hunger/affection/mood - fed here through the exact same
// hidden {{STATUS ...}} tag mechanism as their solo chats - so a
// conversation in Roundboth genuinely affects (and is affected by) how
// each of them is doing on their own tab. The two AI calls are made
// independently, one per character, each seeing the shared transcript
// from their own point of view (their own lines as "assistant", everyone
// else's as "user"), which is what lets them actually address each other
// instead of just monologuing past one another.
function isBothMode() { return activeCharacterId === "both"; }

let bothTranscript = [];
let bothBusy = false;
let bothAutoTimer = null;
let bothAutoTurnsLeft = 0;
const BOTH_TRANSCRIPT_KEY = "roundbina_both_transcript";
const BOTH_AUTO_MAX_TURNS = 12;
const BOTH_AUTO_DELAY_MS = 3500;

function bothStatusKey(id, base) {
  return id === "bina" ? `roundbina_${base}` : `roundbina_${id}_${base}`;
}

// Reads a character's real persisted status directly off its own
// localStorage keys, independent of whichever character is "active" -
// this is what lets Roundboth show Bina's and Rone's genuine, currently-
// saved hunger/affection side by side without disturbing either one.
function loadStatusForCharacterId(id) {
  const hunger = parseInt(localStorage.getItem(bothStatusKey(id, "statusHunger")), 10);
  const clean = parseInt(localStorage.getItem(bothStatusKey(id, "statusClean")), 10);
  const affection = parseInt(localStorage.getItem(bothStatusKey(id, "statusAffection")), 10);
  const mood = localStorage.getItem(bothStatusKey(id, "statusMood"));
  return {
    hunger: Number.isFinite(hunger) ? hunger : 80,
    cleanliness: Number.isFinite(clean) ? clean : 100,
    affection: Number.isFinite(affection) ? affection : 65,
    mood: mood || "happy"
  };
}

function saveStatusForCharacterId(id, status) {
  localStorage.setItem(bothStatusKey(id, "statusHunger"), String(status.hunger));
  localStorage.setItem(bothStatusKey(id, "statusClean"), String(status.cleanliness));
  localStorage.setItem(bothStatusKey(id, "statusAffection"), String(status.affection));
  localStorage.setItem(bothStatusKey(id, "statusMood"), status.mood);
}

// Same parsing as parseAndApplyStatusTag(), but scoped to an explicit
// status object instead of the single global `characterStatus` - so a
// Roundboth turn updates only the character who actually spoke.
function parseStatusTagForCharacter(text, status) {
  const match = text.match(STATUS_TAG_RE);
  if (!match) return text;
  const body = match[1];
  const hungerMatch = body.match(/hunger\s*=\s*(-?\d+)/i);
  const cleanMatch = body.match(/clean\w*\s*=\s*(-?\d+)/i);
  const moodMatch = body.match(/mood\s*=\s*([A-Za-z][\w-]*)/i);
  if (hungerMatch) status.hunger = clamp0to100(parseInt(hungerMatch[1], 10));
  if (cleanMatch) status.cleanliness = clamp0to100(parseInt(cleanMatch[1], 10));
  if (moodMatch) {
    status.mood = moodMatch[1];
    const key = resolveMoodKey(moodMatch[1]);
    if (key !== null) status.affection = MOOD_LEVEL[key];
  }
  return text.slice(0, match.index).trim();
}

// Picks whichever portrait art best matches a character's current status
// (mood + affection) for the given character definition - same fallback
// order the main portrait uses (loving pose when smitten, then a mood
// expression if she has art for it, then her default eyes-open pose).
function pickPortraitForStatus(char, status) {
  const p = char.portraits;
  if (status.affection >= 85 && p.loving) return p.loving;
  const exprClass = getExpressionClass(status.mood); // "mood-happy" | ... | null
  const bucket = exprClass ? exprClass.slice("mood-".length) : null;
  if (bucket && p[bucket]) return p[bucket];
  return p.eyesOpen;
}

function renderBothPortraits() {
  const binaImg = document.getElementById("miniBinaImg");
  const roneImg = document.getElementById("miniRoneImg");
  // PERF: same fix as renderPortraitImages() - skip re-assigning .src
  // (and forcing a full base64 re-decode) when it's already correct.
  // This is what made switching into Roundboth mode so heavy.
  if (binaImg && CHARACTERS.bina) {
    const src = pickPortraitForStatus(CHARACTERS.bina, loadStatusForCharacterId("bina"));
    if (src && binaImg.src !== src) binaImg.src = src;
  }
  if (roneImg && CHARACTERS.rone) {
    const src = pickPortraitForStatus(CHARACTERS.rone, loadStatusForCharacterId("rone"));
    if (src && roneImg.src !== src) roneImg.src = src;
  }
}

function renderBothStatusBars() {
  ["bina", "rone"].forEach(id => {
    const status = loadStatusForCharacterId(id);
    const hungerEl = document.getElementById(id === "bina" ? "miniBinaHunger" : "miniRoneHunger");
    const affEl = document.getElementById(id === "bina" ? "miniBinaAffection" : "miniRoneAffection");
    const cleanEl = document.getElementById(id === "bina" ? "miniBinaClean" : "miniRoneClean");
    const moodEl = document.getElementById(id === "bina" ? "miniBinaMood" : "miniRoneMood");
    const portraitEl = document.getElementById(id === "bina" ? "miniBinaPortrait" : "miniRonePortrait");
    if (hungerEl) hungerEl.style.transform = `scaleY(${status.hunger / 100})`;
    if (affEl) affEl.style.transform = `scaleY(${status.affection / 100})`;
    if (cleanEl) cleanEl.style.transform = `scaleY(${status.cleanliness / 100})`;
    if (moodEl) moodEl.textContent = getMoodEmoji(status.mood, status.affection) + " " + status.mood;
    if (portraitEl) {
      portraitEl.classList.toggle("affection-glow", status.affection >= 85);
      portraitEl.classList.toggle("affection-low", status.affection < 30);
    }
  });
  applyBothModeTheme(); // re-check both moods; crossfades on its own if either shifted
}

function bothDisplayName(speaker) {
  if (speaker === "bina") return "Roundbina";
  if (speaker === "rone") return "Roundrone";
  return "You";
}

function saveBothTranscript() {
  try { localStorage.setItem(BOTH_TRANSCRIPT_KEY, JSON.stringify(bothTranscript.slice(-200))); }
  catch (e) { console.warn("Roundboth: could not save transcript", e); }
}

// Renders one bubble into the shared #chat container. Deliberately its own
// lightweight function rather than reusing addMsg()'s edit/regenerate/
// rewind machinery - that machinery assumes a single strictly-alternating
// user/assistant history for one character, which doesn't map cleanly onto
// a three-way conversation between two AI characters and a person.
function addBothMsg(speaker, text, persist = true) {
  const div = document.createElement("div");
  div.className = "msg " + (speaker === "user" ? "user" : "bot both-" + speaker);
  if (speaker !== "user") {
    const label = document.createElement("div");
    label.className = "bothSpeakerLabel";
    label.textContent = speaker === "bina" ? "🍅 Roundbina" : "🗝️ Roundrone";
    div.appendChild(label);
  }
  const body = document.createElement("div");
  body.innerHTML = renderMarkdownLite(text);
  div.appendChild(body);
  chatContainer.appendChild(div);
  scrollChatToBottom();
  if (persist) {
    bothTranscript.push({ speaker, text, t: Date.now() });
    saveBothTranscript();
    // Same sliding-window trim as solo mode - keeps the DOM bounded even
    // during a long Roundboth session instead of growing forever.
    const renderedCount = bothTranscript.length - bothLoadedStart;
    if (renderedCount > MAX_RENDERED_MESSAGES) {
      const excess = renderedCount - MAX_RENDERED_MESSAGES;
      const oldest = chatContainer.querySelectorAll(".msg");
      for (let i = 0; i < excess && i < oldest.length; i++) oldest[i].remove();
      bothLoadedStart += excess;
    }
  }
  return div;
}

let bothLoadedStart = 0; // same idea as chatLoadedStart, for Both mode's transcript

function restoreBothTranscript() {
  try { bothTranscript = JSON.parse(localStorage.getItem(BOTH_TRANSCRIPT_KEY) || "[]"); }
  catch (e) { bothTranscript = []; }
  chatContainer.innerHTML = "";
  if (!bothTranscript.length) {
    bothLoadedStart = 0;
    chatContainer.innerHTML = '<div class="msg system-msg">🍅🗝️ Roundbina and Roundrone are both here now. Tap ▶️ to let them start talking, or say something to kick things off.</div>';
  } else {
    // BUG FIX: this used to rebuild the ENTIRE transcript as DOM every
    // single time Roundboth was entered, with no cap at all - the longer
    // that conversation got, the slower and laggier switching into it
    // became. Same fix as solo mode: only the most recent page actually
    // renders here. Nothing is lost - the rest stays safely in
    // bothTranscript/storage, just not built as DOM until needed.
    bothLoadedStart = Math.max(0, bothTranscript.length - CHAT_PAGE_SIZE);
    for (let i = bothLoadedStart; i < bothTranscript.length; i++) {
      const entry = bothTranscript[i];
      addBothMsg(entry.speaker, entry.text, false);
    }
    scrollChatToBottom(); // one more explicit snap once the window is in
  }
}

function bothClearTranscript() {
  bothTranscript = [];
  localStorage.removeItem(BOTH_TRANSCRIPT_KEY);
  chatContainer.innerHTML = "";
  addMsg("✨ Cleared the room - started a fresh Roundgroup conversation!", "system-msg", { persist: false });
}

// Builds this character's own view of the shared transcript as an
// OpenAI-style messages array: their own past lines are "assistant", every
// other speaker's lines are "user" (name-prefixed so they can tell Rone's
// voice apart from the person's).
function buildBothMessagesFor(charId) {
  const char = CHARACTERS[charId];
  const otherId = charId === "bina" ? "rone" : "bina";
  const other = CHARACTERS[otherId];
  const customPrompt = localStorage.getItem(bothStatusKey(charId, "systemPrompt"));
  const basePrompt = (customPrompt && customPrompt.trim()) ? customPrompt : char.defaultSystemPrompt;
  const groupNote = `

---
Right now you are physically together in the same small room with ${other.name}
AND a human companion - a live three-way conversation, not a private one-on-one
chat. Speak only as yourself (${char.name}); never write ${other.name}'s dialogue,
actions, or hidden status tag for her - only your own. Feel free to address
${other.name} by name and react to what she just said, since she's right there
with you. Keep each reply short (1-3 sentences) - this is a fast, natural
back-and-forth, not a monologue.`;
  const sysPrompt = basePrompt + groupNote + STATUS_INSTRUCTION + MOOD_REMINDER + FORMAT_INSTRUCTION;

  const messages = [{ role: "system", content: sysPrompt }];
  const recent = bothTranscript.slice(-24);
  recent.forEach(entry => {
    if (entry.speaker === charId) {
      messages.push({ role: "assistant", content: entry.text });
    } else {
      messages.push({ role: "user", content: `${bothDisplayName(entry.speaker)}: ${entry.text}` });
    }
  });
  if (!recent.length) {
    messages.push({ role: "user", content: `[The room is quiet and ${other.name} is here too. Say something to start things off, in character.]` });
  }
  return messages;
}

// Generic completion call against whatever proxy/model the person already
// configured in settings - shared by both characters rather than each
// having its own copy of the fetch/error-handling logic.
// Routes the actual network request either straight to the provider (the
// default, works for CORS-friendly providers like Cerebras) or through an
// optional relay server first (for providers that reject direct browser
// requests entirely - a restriction only a real server-to-server call can
// get around, since CORS is enforced by the provider and isn't something
// any client-side code can bypass). The relay just forwards the same
// request and hands the response straight back, so everything else in the
// app behaves identically either way.
async function doModelFetch(payload) {
  if (relayUrl) {
    return fetch(relayUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url: proxyUrl,
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
        body: payload
      })
    });
  }
  return fetch(proxyUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
    body: JSON.stringify(payload)
  });
}

// ---- Safe visual effects (the alternative to literal code execution) -----
// A character can optionally trigger ONE of these via a hidden tag, same
// mechanism as the STATUS/KILL tags. This is deliberately a small fixed set
// of pre-built, harmless effects rather than anything that lets a model's
// raw output touch real app logic or code - that's not a tradeoff worth
// making for a bit of extra flavor.
const EFFECT_INSTRUCTION = `
You may ALSO, if it genuinely fits the moment, trigger ONE small visual effect
by including a hidden tag on its own line: {{EFFECT name}} where name is one
of: confetti, shake, spooky, gift. This is entirely optional - only use it
when it truly matches your reaction (e.g. "gift" for a sweet gesture, "spooky"
or "shake" for something more mischievous/upset, "confetti" for pure joy).
Never mention this tag; it's stripped before the person ever sees your reply.`;

const EFFECT_TAG_RE = /\{\{\s*EFFECT\s+([a-z]+)\s*\}\}/i;
function parseAndApplyEffectTag(text, targetCharId) {
  const match = text.match(EFFECT_TAG_RE);
  if (!match) return text;
  triggerEffect(match[1].toLowerCase(), targetCharId);
  return (text.slice(0, match.index) + text.slice(match.index + match[0].length)).trim();
}

function triggerEffect(name, targetCharId) {
  const bumpAffection = (amount) => {
    if (targetCharId) {
      const status = loadStatusForCharacterId(targetCharId);
      status.affection = clamp0to100(status.affection + amount);
      saveStatusForCharacterId(targetCharId, status);
      if (targetCharId === activeCharacterId) renderStatusBars();
    } else {
      characterStatus.affection = clamp0to100(characterStatus.affection + amount);
      saveCharacterStatus();
      renderStatusBars();
    }
  };
  switch (name) {
    case "confetti":
      if (portrait) spawnSparkle(portrait, ["🎉", "✨", "🎊"]);
      break;
    case "gift":
      if (portrait) spawnSparkle(portrait, ["🎁", "💝", "✨"]);
      bumpAffection(3);
      break;
    case "spooky":
      document.body.classList.add("spookyFlash");
      setTimeout(() => document.body.classList.remove("spookyFlash"), 1400);
      break;
    case "shake":
      if (portrait) {
        portrait.classList.add("shakeEffect");
        setTimeout(() => portrait.classList.remove("shakeEffect"), 500);
      }
      break;
    default:
      break; // unrecognized name - just quietly ignored, nothing to break
  }
}

// ---- Cross-character interruptions -----------------------------------------
// After enough back-and-forth with one character, the OTHER one can barge
// into the conversation uninvited - reacting however her own current
// affection tier and however long she's been ignored actually calls for,
// anywhere from petty/jealous to genuinely sweet. Entirely the model's call,
// not scripted - this is what actually tests its creative judgment rather
// than the app dictating the outcome.
const INTERRUPT_THRESHOLD = 10;
const INTERRUPT_COUNTER_KEY = { bina: "roundbina_msgsSinceBinaActive", rone: "roundbina_msgsSinceRoneActive" };

// Called after each successful solo-mode exchange. Resets the counter for
// whichever character you're actually talking to, and ticks up the OTHER
// one's "how long have I been ignored" counter - crossing the threshold
// fires her interruption.
// Manual version of the same interruption, triggered from the Streak
// modal's button instead of the automatic 10-message counter.
function manualTriggerInterruption() {
  if (isBothMode()) {
    showErrorToast("They're already together in Roundgroup - no one to barge in from.");
    return;
  }
  if (!connected) {
    showErrorToast("Connect an API key first so she can actually show up.");
    return;
  }
  const otherId = activeCharacterId === "bina" ? "rone" : "bina";
  toggleStreakModal(false);
  localStorage.setItem(INTERRUPT_COUNTER_KEY[otherId], "0");
  triggerCharacterInterruption(otherId, activeCharacterId);
}

function bumpInterruptCounters(activeId) {
  if (isBothMode() || (activeId !== "bina" && activeId !== "rone")) return;
  const otherId = activeId === "bina" ? "rone" : "bina";

  localStorage.setItem(INTERRUPT_COUNTER_KEY[activeId], "0");
  const otherCount = (parseInt(localStorage.getItem(INTERRUPT_COUNTER_KEY[otherId]), 10) || 0) + 1;

  if (otherCount >= INTERRUPT_THRESHOLD) {
    localStorage.setItem(INTERRUPT_COUNTER_KEY[otherId], "0");
    triggerCharacterInterruption(otherId, activeId);
  } else {
    localStorage.setItem(INTERRUPT_COUNTER_KEY[otherId], String(otherCount));
  }
}

async function triggerCharacterInterruption(intruderId, activeId) {
  const intruder = CHARACTERS[intruderId];
  const activeChar = CHARACTERS[activeId];
  const status = loadStatusForCharacterId(intruderId);
  const tier = getAffectionTier(status.affection);
  const customPrompt = localStorage.getItem(bothStatusKey(intruderId, "systemPrompt"));
  const basePrompt = (customPrompt && customPrompt.trim()) ? customPrompt : intruder.defaultSystemPrompt;

  const interruptNote = `

---
You've been left completely alone for a good stretch while they've been
spending all their time with ${activeChar.name} instead - you just noticed,
and you're barging into that conversation uninvited right now. Your current
relationship tier with them is "${tier.label}" (affection ${status.affection}/100).
${tier.note} Let THAT genuinely decide how you barge in - anywhere from
petty/jealous/a little cutting, to hurt and quiet, to sweetly affectionate
with a gift, entirely your own call. Keep it short (1-3 sentences), and don't
write ${activeChar.name}'s reaction for her - only your own entrance.`;

  const messages = [
    { role: "system", content: basePrompt + interruptNote + STATUS_INSTRUCTION + MOOD_REMINDER + FORMAT_INSTRUCTION + EFFECT_INSTRUCTION },
    { role: "user", content: `[Barge in on ${activeChar.name}'s conversation now.]` }
  ];

  const result = await callCharacterCompletion(messages);
  if (!result.ok) return; // ambient background feature - fail quietly, no nagging popup for something the person didn't ask for
  if (isBothMode() || activeCharacterId !== activeId) return; // they switched away mid-flight - don't drop this into the wrong chat

  // Reuses the exact same {{STATUS mood=...}} tag her normal replies use,
  // so her expression here is driven by her own actual in-character
  // reaction, not a guess - same mechanism Roundboth already relies on.
  const textWithoutStatus = parseStatusTagForCharacter(stripThinkingTags(result.raw), status);
  saveStatusForCharacterId(intruderId, status);
  const cleanText = stripStrayTags(parseAndApplyEffectTag(textWithoutStatus, intruderId));
  if (!cleanText) return;

  const portraitSrc = pickPortraitForStatus(intruder, status);
  addGuestMessage(intruderId, intruder.name, cleanText, portraitSrc);

  // Let the character actually being talked to know this just happened, so
  // she can react to it on her own next reply instead of it being a total
  // non-event to her.
  chatHistory.push({
    role: "system",
    content: `[${intruder.name} just barged in uninvited and said: "${cleanText}" - you may react to this however feels natural, or let it pass if that fits you better.]`
  });
  saveApiHistory();
}

// Builds a guest-appearance bubble: the OTHER character trots in with her
// own current expression (matching whatever mood she just reported),
// says her piece, then trots back out again a few seconds later - the
// message itself stays in the log as a permanent record, only her little
// avatar is temporary, same as an actual visit would feel.
function addGuestMessage(charId, name, text, portraitSrc) {
  const div = document.createElement("div");
  div.className = "msg guest";
  div.innerHTML = renderMarkdownLite(`**${name}:** ${text}`);
  chatContainer.appendChild(div);
  scrollChatToBottom();

  const logIndex = saveChatLog(`${name}: ${text}`, "guest");
  if (typeof logIndex === "number") div.dataset.logIndex = String(logIndex);

  // She actually trots in beside the MAIN portrait with her own real
  // expression (not a copy of whoever you're currently chatting with),
  // sits there a few seconds, then trots back out again - the text stays
  // behind in the log either way.
  const guestPortrait = document.getElementById("guestPortrait");
  if (guestPortrait && portraitSrc) {
    guestPortrait.src = portraitSrc;
    guestPortrait.style.display = "block";
    guestPortrait.classList.remove("guestPortraitOut");
    // Forces a reflow so re-adding "guestPortraitIn" (in case she barges
    // in twice in a row) actually restarts the animation instead of the
    // browser treating it as a no-op class toggle.
    void guestPortrait.offsetWidth;
    guestPortrait.classList.add("guestPortraitIn");

    setTimeout(() => {
      guestPortrait.classList.remove("guestPortraitIn");
      guestPortrait.classList.add("guestPortraitOut");
      setTimeout(() => {
        guestPortrait.style.display = "none";
        guestPortrait.classList.remove("guestPortraitOut");
      }, 550);
    }, 3200);
  }
}

async function callCharacterCompletion(messages) {
  const payload = { model: selectedModel, messages, temperature: 0.8, max_tokens: getMaxTokens() };
  try {
    const response = await doModelFetch(payload);
    const data = await response.json();
    if (data.error) {
      const msg = (data.error.message || data.error) || "unknown error";
      return { ok: false, text: `⚠️ ${msg}` };
    }
    if (data.promptFeedback && data.promptFeedback.blockReason) {
      return { ok: false, text: `⚠️ blocked by the provider's safety filter (${data.promptFeedback.blockReason}) - that's Google's own content policy, not an app bug.` };
    }
    const choice = data.choices && data.choices[0];
    if (!choice) return { ok: false, text: "⚠️ got no reply back." };
    if (choice.finish_reason === "content_filter" || choice.finish_reason === "SAFETY") {
      return { ok: false, text: "⚠️ that reply got filtered by the provider's safety system." };
    }
    const raw = (choice.message && choice.message.content ? choice.message.content : "").trim();
    if (!raw) return { ok: false, text: "⚠️ got an empty reply back." };
    return { ok: true, raw };
  } catch (error) {
    const detail = (error && error.message) ? error.message : String(error);
    return { ok: false, text: `⚠️ connection snag: ${detail}` };
  }
}

// One character speaks their next line, reacting to the shared transcript
// so far. Updates and persists THAT character's own hunger/affection/mood
// exactly like a normal solo reply would.
async function bothCharacterTurn(charId) {
  const messages = buildBothMessagesFor(charId);
  showTyping();
  const result = await callCharacterCompletion(messages);
  hideTyping();
  if (!result.ok) {
    showErrorToast(result.text.replace(/^⚠️\s*/, ""));
    return false;
  }
  const status = loadStatusForCharacterId(charId);
  const afterStatus = parseStatusTagForCharacter(stripThinkingTags(result.raw), status) || "*is quiet for a moment*";
  const cleanText = stripStrayTags(parseAndApplyEffectTag(afterStatus, charId));
  saveStatusForCharacterId(charId, status);
  addBothMsg(charId, cleanText);
  renderBothStatusBars();
  renderBothPortraits();
  return true;
}

// Whoever didn't speak last goes next; if a person just spoke, Bina answers
// first (arbitrary but consistent, rather than random).
function bothNextSpeaker() {
  if (!bothTranscript.length) return "bina";
  const last = bothTranscript[bothTranscript.length - 1].speaker;
  return last === "bina" ? "rone" : "bina";
}

function setBothControlsDisabled(disabled) {
  const nextBtn = document.getElementById("bothNextBtn");
  if (nextBtn) nextBtn.disabled = disabled;
}

async function bothNextExchange() {
  if (bothBusy) return;
  if (!apiKey) {
    addMsg("Set up your API key in ⚙️ settings first so they can actually talk to each other.", "system-msg", { persist: false });
    return;
  }
  bothBusy = true;
  setBothControlsDisabled(true);
  await bothCharacterTurn(bothNextSpeaker());
  setBothControlsDisabled(false);
  bothBusy = false;
}

function toggleBothAutoplay() {
  const btn = document.getElementById("bothAutoBtn");
  if (bothAutoTimer) {
    clearTimeout(bothAutoTimer);
    bothAutoTimer = null;
    if (btn) btn.textContent = "🔁 Auto: off";
    return;
  }
  if (!apiKey) {
    addMsg("Set up your API key in ⚙️ settings first so they can actually talk to each other.", "system-msg", { persist: false });
    return;
  }
  bothAutoTurnsLeft = BOTH_AUTO_MAX_TURNS;
  if (btn) btn.textContent = `🔁 Auto: on (${bothAutoTurnsLeft})`;
  runBothAutoStep();
}

async function runBothAutoStep() {
  if (bothAutoTurnsLeft <= 0) {
    bothAutoTimer = null;
    const btn = document.getElementById("bothAutoBtn");
    if (btn) btn.textContent = "🔁 Auto: off";
    addMsg("💤 They've been chatting a while - tap 🔁 again if you'd like more.", "system-msg", { persist: false });
    return;
  }
  await bothNextExchange();
  bothAutoTurnsLeft--;
  const btn = document.getElementById("bothAutoBtn");
  if (btn) btn.textContent = bothAutoTurnsLeft > 0 ? `🔁 Auto: on (${bothAutoTurnsLeft})` : "🔁 Auto: off";
  if (bothAutoTurnsLeft > 0) {
    bothAutoTimer = setTimeout(runBothAutoStep, BOTH_AUTO_DELAY_MS);
  } else {
    bothAutoTimer = null;
  }
}

// A message the person types into the shared chat bar while in Roundboth:
// it's added to the transcript as their own line, then both companions
// each get a turn to react to it (and to each other).
async function handleBothSend() {
  const rawInput = chatInput.value.trim();
  const userText = rawInput || "*is here, saying nothing in particular*";
  chatInput.value = ""; autoGrowChatInput();
  addBothMsg("user", userText);

  if (!apiKey) {
    addMsg("Set up your API key in ⚙️ settings first so they can actually talk to each other.", "system-msg", { persist: false });
    return;
  }

  chatInput.disabled = true;
  chatSendBtn.disabled = true;
  setBothControlsDisabled(true);

  const binaOk = await bothCharacterTurn("bina");
  if (binaOk) await bothCharacterTurn("rone");

  setBothControlsDisabled(false);
  chatInput.disabled = false;
  chatSendBtn.disabled = false;
  chatInput.focus();
}

function enterBothMode() {
  if (activeCharacterId === "both") { renderCharacterSwitcher(); return; }
  activeCharacterId = "both";
  currentThemeMin = null;

  const singleHeader = document.getElementById("singleHeader");
  const bothHeader = document.getElementById("bothHeader");
  if (singleHeader) singleHeader.style.display = "none";
  if (bothHeader) bothHeader.style.display = "";

  if (showerBtnEl) showerBtnEl.style.display = "none";
  if (killBtnEl) killBtnEl.style.display = "none";
  if (reviveSectionEl) reviveSectionEl.style.display = "none";
  if (systemPromptSectionEl) systemPromptSectionEl.style.display = "none";

  applyDeadUI(false);
  if (chatInput) chatInput.placeholder = "Say something to them, or just watch them talk...";
  const drawerTitleEl = document.querySelector(".drawerHeader h2");
  if (drawerTitleEl) drawerTitleEl.textContent = "Settings";

  // "Auto" is what unlocks the live split-by-mood background; a manually
  // picked preset applies as one flat theme across the whole room instead,
  // same as it would solo - the person asked for that specific palette,
  // so mood shouldn't fight them for it.
  currentBothThemeKey = null;
  if (getUserTheme() !== "auto") {
    document.body.classList.remove("bothMode");
    applyThemeVars(THEME_PRESETS[getUserTheme()] || THEME_PRESETS.classic);
  } else {
    document.body.classList.add("bothMode");
    applyBothModeTheme();
  }
  renderThemeSwatches();

  if (bothHeader) { bothHeader.classList.remove("visible"); void bothHeader.offsetWidth; bothHeader.classList.add("visible"); }

  renderBothPortraits();
  renderBothStatusBars();
  restoreBothTranscript();
  renderCharacterSwitcher();
}

function leaveBothMode() {
  if (bothAutoTimer) { clearTimeout(bothAutoTimer); bothAutoTimer = null; }
  bothBusy = false;

  const singleHeader = document.getElementById("singleHeader");
  const bothHeader = document.getElementById("bothHeader");
  if (singleHeader) singleHeader.style.display = "";
  if (bothHeader) bothHeader.style.display = "none";
  if (singleHeader) { singleHeader.classList.remove("visible"); void singleHeader.offsetWidth; singleHeader.classList.add("visible"); }

  if (showerBtnEl) showerBtnEl.style.display = "";
  if (killBtnEl) killBtnEl.style.display = "";
  if (reviveSectionEl) reviveSectionEl.style.display = "";
  if (systemPromptSectionEl) systemPromptSectionEl.style.display = "";

  // Back to a single live palette - the split background and its seam
  // glow are Roundboth-only.
  document.body.classList.remove("bothMode");
  currentBothThemeKey = null;
}

// Updates the name/emoji/subtitle/lore line under the portrait to match
// whichever character is active - these were originally hardcoded to
// Bina directly in the HTML.
function syncCharacterHeader(char) {
  const nameEl = document.getElementById("charName");
  const emojiEl = document.getElementById("charEmoji");
  const subEl = document.getElementById("charSubtitle");
  const loreEl = document.getElementById("charLore");
  if (nameEl && nameEl.firstChild) nameEl.firstChild.textContent = char.name + " ";
  if (emojiEl) emojiEl.textContent = char.emoji;
  if (subEl) subEl.textContent = char.subtitle;
  if (loreEl) loreEl.textContent = char.lore;

  // A few more labels created once at boot (food tray, revive/kill flow)
  // that don't live-update on their own - patched here too so switching
  // characters mid-session doesn't leave the previous companion's name
  // sitting in a button somewhere.
  const foodToggle = document.getElementById("foodTrayToggle");
  if (foodToggle) foodToggle.title = `Feed ${char.name}`;
  const foodTitle = document.querySelector(".foodTrayTitle");
  if (foodTitle) foodTitle.textContent = `Feed ${char.name}`;
  const reviveBtnEl = document.getElementById("reviveBtn");
  if (reviveBtnEl) reviveBtnEl.textContent = `💗 revive ${char.name}`;
  const reviveHeading = document.querySelector("#reviveModal h2");
  if (reviveHeading) reviveHeading.textContent = `💗 Revive ${char.name}`;
  const killHeading = document.querySelector("#killModal h2");
  if (killHeading) killHeading.textContent = `💀 Kill ${char.name} (testing)`;
  const killBtnEl = document.getElementById("killBtn");
  if (killBtnEl) killBtnEl.setAttribute("aria-label", `Kill ${char.name} (testing feature)`);
}

let currentThemeMin = null;
let currentBothThemeKey = null; // "<binaMin>|<roneMin>" - skips redundant writes the same way currentThemeMin does
const metaThemeColorEl = document.querySelector('meta[name="theme-color"]');

// ---- Manual theme picker -----------------------------------------------
// Layers on top of the mood-reactive palette above rather than replacing
// it: "Auto" (the default) leaves applyMoodTheme() in full control, same
// as before. Picking any named theme locks the palette to that preset -
// applyMoodTheme() below becomes a no-op until the person switches back
// to Auto - while still using the exact same custom-property/@property
// crossfade mechanism, so a manual switch fades in just as smoothly as an
// affection-driven one does.
const THEME_PRESETS = {
  sakura: { label: "Sakura", swatch: "#ff6fa8",
    bgTop: "#4a1f3a", bgBottom: "#2b0f22", accent: "#ff6fa8", accentLight: "#ffd9ec",
    muted: "#e0a8c0", botBubble: "#5c2c4a", accentRgb: "255,111,168", bgTopRgb: "74,31,58" },
  midnight: { label: "Midnight Neon", swatch: "#7bffe0",
    bgTop: "#141428", bgBottom: "#07070f", accent: "#7bffe0", accentLight: "#d8fff5",
    muted: "#8a93c9", botBubble: "#20204a", accentRgb: "123,255,224", bgTopRgb: "20,20,40" },
  sunset: { label: "Sunset", swatch: "#ff9a56",
    bgTop: "#3f2438", bgBottom: "#1c1024", accent: "#ff9a56", accentLight: "#ffe0c2",
    muted: "#d0a695", botBubble: "#4a2e3f", accentRgb: "255,154,86", bgTopRgb: "63,36,56" },
  ocean: { label: "Ocean", swatch: "#5ec8ff",
    bgTop: "#152438", bgBottom: "#08111c", accent: "#5ec8ff", accentLight: "#cdeeff",
    muted: "#8fa9bf", botBubble: "#1c344a", accentRgb: "94,200,255", bgTopRgb: "21,36,56" },
  classic: { label: "Classic", swatch: "#ff8fb1",
    bgTop: "#3a2b3f", bgBottom: "#1b1420", accent: "#ff8fb1", accentLight: "#ffd6e8",
    muted: "#b79bc4", botBubble: "#4a3453", accentRgb: "255,143,177", bgTopRgb: "58,43,63" }
};

function getUserTheme() {
  return localStorage.getItem(LS.USER_THEME) || "auto";
}

function applyThemeVars(theme) {
  const root = document.documentElement.style;
  root.setProperty("--bg-top", theme.bgTop);
  root.setProperty("--bg-bottom", theme.bgBottom);
  root.setProperty("--accent", theme.accent);
  root.setProperty("--accent-light", theme.accentLight);
  root.setProperty("--muted", theme.muted);
  root.setProperty("--bot-bubble", theme.botBubble);
  root.setProperty("--accent-rgb", theme.accentRgb);
  root.setProperty("--bg-top-rgb", theme.bgTopRgb);
  if (metaThemeColorEl) metaThemeColorEl.setAttribute("content", theme.bgBottom);
}

function setUserTheme(name) {
  localStorage.setItem(LS.USER_THEME, name);
  if (name !== "auto" && THEME_PRESETS[name]) {
    currentThemeMin = null; // so switching back to auto always re-applies
    currentBothThemeKey = null;
    document.body.classList.remove("bothMode");
    applyThemeVars(THEME_PRESETS[name]);
  } else {
    currentThemeMin = null;
    currentBothThemeKey = null;
    if (isBothMode()) {
      document.body.classList.add("bothMode");
      applyBothModeTheme();
    } else {
      applyMoodTheme(characterStatus.affection);
    }
  }
  renderThemeSwatches();
}

function renderThemeSwatches() {
  const row = document.getElementById("themeSwatchRow");
  if (!row) return;
  const active = getUserTheme();
  row.innerHTML = "";
  const autoBtn = document.createElement("button");
  autoBtn.type = "button";
  autoBtn.className = "themeSwatch auto" + (active === "auto" ? " active" : "");
  autoBtn.title = "Auto (matches her mood)";
  autoBtn.textContent = active === "auto" ? "" : "🌈";
  autoBtn.addEventListener("click", () => setUserTheme("auto"));
  row.appendChild(autoBtn);
  Object.entries(THEME_PRESETS).forEach(([key, theme]) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "themeSwatch" + (active === key ? " active" : "");
    btn.style.background = theme.swatch;
    btn.title = theme.label;
    btn.addEventListener("click", () => setUserTheme(key));
    row.appendChild(btn);
  });
}

function applyMoodTheme(affection) {
  if (getUserTheme() !== "auto") return; // person locked a manual theme - leave it alone
  const level = Number.isFinite(affection) ? affection : 65;
  const themes = getCharacter().moodThemes;
  const theme = themes.find(t => level >= t.min) || themes[themes.length - 1];
  if (theme.min === currentThemeMin) return; // already showing this palette, skip redundant writes
  currentThemeMin = theme.min;
  applyThemeVars(theme);
}

// Looks up whichever mood palette matches a character's CURRENT affection,
// same rule applyMoodTheme() uses for the solo view (highest tier whose
// "min" the affection clears).
function themeForCharacterStatus(char, status) {
  const themes = char.moodThemes;
  const level = Number.isFinite(status.affection) ? status.affection : 65;
  return themes.find(t => level >= t.min) || themes[themes.length - 1];
}

// Roundboth's split theme: Bina's live mood palette drives the left-half
// tokens (the same --bg-top/--accent/etc the solo view already animates),
// Rone's drives the right-half "-r" tokens. Both write through the typed
// @property custom props, so the split background above crossfades on its
// own whenever either of them shifts mood mid-conversation - no separate
// animation code needed here, just set-and-forget like applyMoodTheme().
function applyBothModeTheme() {
  if (getUserTheme() !== "auto") return; // manual preset locked - leave it alone
  const binaTheme = themeForCharacterStatus(CHARACTERS.bina, loadStatusForCharacterId("bina"));
  const roneTheme = themeForCharacterStatus(CHARACTERS.rone, loadStatusForCharacterId("rone"));
  const key = binaTheme.min + "|" + roneTheme.min;
  if (key === currentBothThemeKey) return; // both sides unchanged, skip redundant writes
  currentBothThemeKey = key;

  const root = document.documentElement.style;
  // Left half reuses the same tokens the solo Bina view uses.
  root.setProperty("--bg-top", binaTheme.bgTop);
  root.setProperty("--bg-bottom", binaTheme.bgBottom);
  root.setProperty("--accent", binaTheme.accent);
  root.setProperty("--accent-light", binaTheme.accentLight);
  root.setProperty("--muted", binaTheme.muted);
  root.setProperty("--bot-bubble", binaTheme.botBubble);
  root.setProperty("--accent-rgb", binaTheme.accentRgb);
  root.setProperty("--bg-top-rgb", binaTheme.bgTopRgb);
  // Right half writes the "-r" tokens.
  root.setProperty("--bg-top-r", roneTheme.bgTop);
  root.setProperty("--bg-bottom-r", roneTheme.bgBottom);
  root.setProperty("--accent-r", roneTheme.accent);
  root.setProperty("--accent-light-r", roneTheme.accentLight);
  root.setProperty("--muted-r", roneTheme.muted);
  root.setProperty("--bot-bubble-r", roneTheme.botBubble);
  root.setProperty("--accent-rgb-r", roneTheme.accentRgb);
  root.setProperty("--bg-top-rgb-r", roneTheme.bgTopRgb);
  // The browser chrome/status-bar color splits the difference between the
  // two moods rather than fully committing to either side.
  if (metaThemeColorEl) metaThemeColorEl.setAttribute("content", binaTheme.bgBottom);
}

function renderStatusBars() {
  if (hungerFillEl) hungerFillEl.style.transform = `scaleY(${characterStatus.hunger / 100})`;
  if (cleanFillEl) cleanFillEl.style.transform = `scaleY(${characterStatus.cleanliness / 100})`;
  if (affectionFillEl) {
    affectionFillEl.style.transform = `scaleY(${characterStatus.affection / 100})`;
  }
  if (affectionIconEl) {
    affectionIconEl.textContent = heartEmojiForAffection(characterStatus.affection);
  }
  if (moodBadgeEl && moodWordEl && moodEmojiEl) {
    moodWordEl.textContent = characterStatus.mood;
    moodEmojiEl.textContent = getMoodEmoji(characterStatus.mood, characterStatus.affection);
  }
  // Marks whether Roundrone is the character currently on screen (solo, not
  // Roundboth) so the CSS above can switch off Bina's pink tint filters -
  // see the affection-high/affection-low/awake overrides near .portrait.
  document.body.classList.toggle("char-rone-active", activeCharacterId === "rone");
  // Give the portrait a subtle emotional tint - warmer glow when adored,
  // a cooler/duller cast when she's hurting - without touching the
  // life/death visuals handled elsewhere.
  if (portrait) {
    portrait.classList.toggle("affection-low", characterStatus.affection < 30);
    portrait.classList.toggle("affection-high", characterStatus.affection >= 85);
    // Swap in the matching expression art (happy/crying/angry/evil/confused)
    // for whatever she's currently feeling; CSS makes sure this only shows
    // while idle (not awake/thinking, not deceased) - see getExpressionClass.
    EXPRESSION_CLASSES.forEach(c => portrait.classList.remove(c));
    const exprClass = getExpressionClass(characterStatus.mood);
    if (exprClass) portrait.classList.add(exprClass);
  }
  renderPortraitImages();
  applyMoodTheme(characterStatus.affection);
  checkAffectionTierUpgrade();
}

// Points every portrait <img> slot at the ACTIVE character's art, falling
// back to that character's base pose (+ a hue/saturation tint driven by
// the mood-* class already applied above) for any expression that doesn't
// have dedicated artwork yet. Also swaps in the "loving" pose the instant
// affection crosses the high-affection threshold, for characters that
// have one (Rone's rose portrait) - a small reward for getting there.
function renderPortraitImages() {
  if (!portrait) return;
  const char = getCharacter();
  const p = char.portraits;
  const useLoving = characterStatus.affection >= 85 && p.loving;
  const eyesOpenEl = portrait.querySelector(".eyes-open");
  const eyesClosedEl = portrait.querySelector(".eyes-closed");
  // PERF: each of these .src values is a huge inline base64 image. Setting
  // .src forces a full re-decode even if it's the exact same image as
  // before - and this function reruns on every message/mood/mode change.
  // Only touch .src when the target image actually changed.
  const setImgSrc = (el, src) => { if (el && src && el.src !== src) el.src = src; };
  setImgSrc(eyesOpenEl, useLoving ? p.loving : p.eyesOpen);
  setImgSrc(eyesClosedEl, p.eyesClosed);
  const exprMap = { happy: p.happy, crying: p.crying, angry: p.angry, evil: p.evil, confused: p.confused };
  Object.entries(exprMap).forEach(([mood, src]) => {
    const el = portrait.querySelector(".expr-" + mood);
    // Fallback for moods without dedicated art (e.g. Rone has no angry/evil
    // drawing) now uses her eyes-open pose, not eyes-closed. eyes-open is
    // her naturally unimpressed/arms-crossed look (normally only seen
    // while she's "thinking") - much closer to indignant/evil than the
    // sleepy, content-looking closed-eyes pose was.
    setImgSrc(el, src || p.eyesOpen || p.eyesClosed);
  });
}

// ---- Real-world elapsed time -> the model -------------------------------
// Roundbina has no innate sense of the clock; the model only ever sees the
// text we hand it. These helpers measure real wall-clock gaps (via
// Date.now()/localStorage, same trick as the greeting logic below) and turn
// them into plain-language notes so the model's own hunger/cleanliness
// drift and tone genuinely track real time apart, not just message count.
function formatElapsed(ms) {
  const totalMinutes = Math.max(0, Math.floor(ms / 60000));
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  const parts = [];
  if (days) parts.push(days + (days === 1 ? " day" : " days"));
  if (hours) parts.push(hours + (hours === 1 ? " hour" : " hours"));
  if (!days && minutes) parts.push(minutes + (minutes === 1 ? " minute" : " minutes"));
  return parts.length ? parts.join(" ") : "under a minute";
}

function getTimeOfDayPhrase() {
  const hour = new Date().getHours();
  if (hour >= 5 && hour < 11) return "morning";
  if (hour >= 11 && hour < 17) return "afternoon";
  if (hour >= 17 && hour < 22) return "evening";
  return "the middle of the night";
}

// Ephemeral system note built fresh for each API call from the real gap
// since the last completed exchange. It's sent to the model but never
// stored in chatHistory, so it doesn't pile up or get re-sent stale.
function buildTimeSinceLastMessageNote() {
  const lastRaw = localStorage.getItem(LS.LAST_MESSAGE_AT);
  if (!lastRaw) return null;
  const gapMs = Date.now() - parseInt(lastRaw, 10);
  if (gapMs < 60 * 1000) return null; // too short to matter, keeps rapid chatting lean
  return `[Real-world time check: ${formatElapsed(gapMs)} have actually passed since your ` +
    `last message, and it is currently ${getTimeOfDayPhrase()}. Let this genuinely inform ` +
    `your hunger/cleanliness drift and your tone this turn. Never mention this note itself.]`;
}

const chatContainer = document.getElementById("chat");

// ---- Reliable "snap to bottom" helper -----------------------------------
// #chat has `scroll-behavior: smooth` in CSS, which the browser also
// honors on a plain `.scrollTop = ...` assignment, not just on
// `.scrollTo()`. That's fine for a single live message, but restoring a
// long chat log calls this once per bubble in a tight loop - each
// assignment kicks off a NEW smooth-scroll animation that interrupts the
// last one before it finishes, and since the target (scrollHeight) keeps
// growing every iteration, the animation can never catch up. The visible
// result is exactly the reported bug: it visibly scrolls down from the
// top, then stops partway instead of reaching the bottom. Explicitly
// passing behavior:"auto" here forces an instant jump regardless of the
// CSS smooth-scroll setting, so it can't get interrupted mid-flight.
// The extra requestAnimationFrame passes re-snap once more after layout
// (and webfont swaps) have actually settled, which matters right after
// boot/restore/rewind when a lot of DOM gets rebuilt at once.
// ---- App-level error toasts -----------------------------------------------
// Every failed request (bad key/proxy, dropped connection, empty/filtered
// reply) surfaces here instead of as text pasted into the chat pretending
// to be something she said. Auto-dismisses, but can be tapped away early.
const errorToastStack = document.getElementById("errorToastStack");
function showErrorToast(message) { showToast(message, "⚠️", "error"); }
function showInfoToast(message, icon) { showToast(message, icon || "✨", "info"); }

function showToast(message, icon, variant) {
  if (!errorToastStack) return;
  const toast = document.createElement("div");
  toast.className = "errorToast" + (variant === "info" ? " infoToast" : "");
  const iconEl = document.createElement("span");
  iconEl.className = "icon";
  iconEl.textContent = icon;
  const msg = document.createElement("span");
  msg.className = "msg";
  msg.textContent = message || "";
  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "closeBtn";
  closeBtn.setAttribute("aria-label", "Dismiss");
  closeBtn.textContent = "✕";
  toast.appendChild(iconEl);
  toast.appendChild(msg);
  toast.appendChild(closeBtn);
  errorToastStack.appendChild(toast);

  const dismiss = () => {
    toast.classList.add("closing");
    setTimeout(() => toast.remove(), 200);
  };
  closeBtn.addEventListener("click", dismiss);
  setTimeout(dismiss, 6000);
}

function scrollChatToBottom() {
  if (!chatContainer) return;
  chatContainer.scrollTo({ top: chatContainer.scrollHeight, behavior: "auto" });
  requestAnimationFrame(() => {
    chatContainer.scrollTo({ top: chatContainer.scrollHeight, behavior: "auto" });
    requestAnimationFrame(() => {
      chatContainer.scrollTo({ top: chatContainer.scrollHeight, behavior: "auto" });
      updateScrollToBottomBtn();
    });
  });
}

// ---- Jump-to-bottom button -------------------------------------------------
// #chat is the one scroll area shared by Bina, Rone, and Roundboth (they
// just swap which bubbles are rendered into it), so this single button
// and its scroll listener already cover every chat, not just Bina's.
const scrollToBottomBtn = document.getElementById("scrollToBottomBtn");
const SCROLL_BOTTOM_THRESHOLD = 120; // px of slack before we call it "at the bottom"

function isNearChatBottom() {
  if (!chatContainer) return true;
  const distance = chatContainer.scrollHeight - chatContainer.scrollTop - chatContainer.clientHeight;
  return distance < SCROLL_BOTTOM_THRESHOLD;
}

function updateScrollToBottomBtn() {
  if (!scrollToBottomBtn || !chatContainer) return;
  // Nothing to jump to yet if the log doesn't even overflow the viewport.
  const hasOverflow = chatContainer.scrollHeight > chatContainer.clientHeight + 4;
  scrollToBottomBtn.classList.toggle("visible", hasOverflow && !isNearChatBottom());
}

// Button tap: smooth-scroll (rather than the instant snap used internally
// for restores/new messages) so tapping it feels like a deliberate action.
function jumpToBottomClicked() {
  if (!chatContainer) return;
  chatContainer.scrollTo({ top: chatContainer.scrollHeight, behavior: "smooth" });
  scrollToBottomBtn.classList.remove("visible");
}

if (chatContainer) {
  chatContainer.addEventListener("scroll", updateScrollToBottomBtn, { passive: true });
  // Infinite-scroll-up: reaching near the top pulls in the next page of
  // older messages automatically.
  // BUG FIX: this used to fire on ANY scroll event with no regard for
  // WHY scrollTop was near 0 - and right after a fresh render, scrollTop
  // genuinely starts at 0 before the snap-to-bottom below has actually
  // taken effect (it's async, via requestAnimationFrame). That raced with
  // this listener, auto-triggering loadOlderMessages() at boot before the
  // real scroll position ever settled - which loaded another page, which
  // could itself race the same way, cascading into loading the ENTIRE
  // history right at open instead of just the last page. That's what was
  // making chats open slow AND made the teleport bug far worse than
  // before (multiple imperfect scroll-corrections stacking instead of
  // one). A longer cooldown after any full render, PLUS requiring the
  // scroll position to actually stay near the top for a moment (not just
  // pass through it during the initial snap) closes that race properly.
  let nearTopTimer = null;
  chatContainer.addEventListener("scroll", () => {
    if (nearTopTimer) { clearTimeout(nearTopTimer); nearTopTimer = null; }
    if (Date.now() - chatWindowRenderedAt < 1200) return;
    if (chatContainer.scrollTop < 80 && chatLoadedStart > 0 && !loadingOlderMessages) {
      nearTopTimer = setTimeout(() => {
        if (chatContainer.scrollTop < 80 && chatLoadedStart > 0 && !loadingOlderMessages) {
          loadOlderMessages();
        }
      }, 180);
    }
  }, { passive: true });
}
// Catches messages arriving/streaming in and layout shifts (portrait art
// swaps, mood theme changes) that can change scrollHeight without a
// scroll event ever firing.
new ResizeObserver(() => updateScrollToBottomBtn()).observe(chatContainer);

const setupPanel = document.getElementById("setupPanel");
const chatBar = document.getElementById("chatBar");
const keyInput = document.getElementById("input");
const connectBtn = document.getElementById("sendBtn");
const resetBtn = document.getElementById("resetBtn");
const rememberKeyCheckbox = document.getElementById("rememberKeyCheckbox");
const settingsKeyInput = document.getElementById("settingsKeyInput");
const rememberKeyCheckboxSettings = document.getElementById("rememberKeyCheckboxSettings");
const keyStatusRow = document.getElementById("keyStatusRow");
const chatInput = document.getElementById("chatInput");
const chatSendBtn = document.getElementById("chatSendBtn");
const motesContainer = document.getElementById("motes");
const portrait = document.getElementById("portrait");
const tokenSlider = document.getElementById("tokenSlider");
const tokenValue = document.getElementById("tokenValue");
const contextSlider = document.getElementById("contextSlider");
const contextValue = document.getElementById("contextValue");
const proxyUrlInput = document.getElementById("proxyUrlInput");
const relayUrlInput = document.getElementById("relayUrlInput");
const modelNameInput = document.getElementById("modelNameInput");
const systemPromptInput = document.getElementById("systemPromptInput");
const showerBtnEl = document.getElementById("showerBtn");
const killBtnEl = document.getElementById("killBtn");
const reviveSectionEl = document.getElementById("reviveSection");
const systemPromptSectionEl = document.getElementById("systemPromptSection");

// Restore the proxy/relay/model/prompt settings into the drawer fields.
proxyUrlInput.value = proxyUrl;
relayUrlInput.value = relayUrl;
modelNameInput.value = selectedModel;
systemPromptInput.value = localStorage.getItem(LS.SYSTEM_PROMPT) || "";

// Saves the proxy address, relay URL, model name, and custom prompt from
// the drawer. These live outside the setup panel now, so the person
// configures the "brain" once here instead of picking from a fixed dropdown.
function saveConnectionSettings() {
  const newProxy = proxyUrlInput.value.trim() || DEFAULT_PROXY_URL;
  const newRelay = relayUrlInput.value.trim();
  const newModel = modelNameInput.value.trim() || DEFAULT_MODEL_NAME;
  const newPrompt = systemPromptInput.value;

  proxyUrl = newProxy;
  relayUrl = newRelay;
  selectedModel = newModel;
  localStorage.setItem(LS.PROXY_URL, newProxy);
  if (newRelay) localStorage.setItem(LS.RELAY_URL, newRelay);
  else localStorage.removeItem(LS.RELAY_URL);
  localStorage.setItem(LS.MODEL, newModel);
  localStorage.setItem(LS.SYSTEM_PROMPT, newPrompt);

  addMsg(`⚙️ Saved! Brain is now "${newModel}" via ${newProxy}${newRelay ? ` (through relay)` : ""}.`, "system-msg");
}

// Restore the reply-length slider, and keep it saved as it's dragged.
tokenSlider.value = String(getMaxTokens());
tokenValue.textContent = tokenSlider.value;
tokenSlider.addEventListener("input", () => {
  tokenValue.textContent = tokenSlider.value;
  localStorage.setItem(LS.MAX_TOKENS, tokenSlider.value);
});

// Restore the max-context slider, and keep it saved as it's dragged. This
// caps how much prior conversation gets sent to the model per turn (see
// trimHistoryToContextBudget), separately from the reply-length cap above.
contextSlider.value = String(getMaxContextTokens());
contextValue.textContent = contextSlider.value;
contextSlider.addEventListener("input", () => {
  contextValue.textContent = contextSlider.value;
  localStorage.setItem(LS.MAX_CONTEXT, contextSlider.value);
});

// ---- Settings drawer (holds "New chat" + reply-length slider) ----------
// Slides in from the right so it never overlaps the shower button.
const settingsDrawer = document.getElementById("settingsDrawer");
const drawerBackdrop = document.getElementById("drawerBackdrop");

function toggleSettingsDrawer(forceOpen) {
  const shouldOpen = typeof forceOpen === "boolean"
    ? forceOpen
    : !settingsDrawer.classList.contains("open");
  settingsDrawer.classList.toggle("open", shouldOpen);
  drawerBackdrop.classList.toggle("open", shouldOpen);
}

// ---- Left menu + Streak ---------------------------------------------------
// A general-purpose left-side menu (mirroring the Settings drawer on the
// right) for features that aren't per-character, starting with Streak.
const menuDrawer = document.getElementById("menuDrawer");
const menuDrawerBackdrop = document.getElementById("menuDrawerBackdrop");
function toggleMenuDrawer(forceOpen) {
  const shouldOpen = typeof forceOpen === "boolean" ? forceOpen : !menuDrawer.classList.contains("open");
  menuDrawer.classList.toggle("open", shouldOpen);
  menuDrawerBackdrop.classList.toggle("open", shouldOpen);
}

// Streak is app-wide (not per-character) - it's about you showing up at
// all, not about either character specifically.
const STREAK_COUNT_KEY = "roundbina_streakCount";
const STREAK_DATE_KEY = "roundbina_streakLastDate";
const STREAK_FREEZES_KEY = "roundbina_streakFreezes";
const STREAK_MAX_FREEZES = 2;

function todayLocalStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function daysBetweenLocalStr(a, b) {
  const da = new Date(a + "T00:00:00");
  const db = new Date(b + "T00:00:00");
  return Math.round((db - da) / 86400000);
}
function getStreakState() {
  return {
    count: parseInt(localStorage.getItem(STREAK_COUNT_KEY), 10) || 0,
    lastDate: localStorage.getItem(STREAK_DATE_KEY) || null,
    freezes: Math.min(STREAK_MAX_FREEZES, parseInt(localStorage.getItem(STREAK_FREEZES_KEY), 10) || 0)
  };
}
function saveStreakState(state) {
  localStorage.setItem(STREAK_COUNT_KEY, String(state.count));
  if (state.lastDate) localStorage.setItem(STREAK_DATE_KEY, state.lastDate);
  localStorage.setItem(STREAK_FREEZES_KEY, String(Math.min(STREAK_MAX_FREEZES, Math.max(0, state.freezes))));
}

// Runs once at boot. Compares today against the last recorded visit date
// and updates the streak/freeze counts accordingly, then shows a small
// celebration toast for anything worth noticing (never nags on a reset).
function checkAndUpdateStreak() {
  const state = getStreakState();
  const today = todayLocalStr();

  if (state.lastDate === today) return; // already counted today

  if (!state.lastDate) {
    // very first visit ever
    saveStreakState({ count: 1, lastDate: today, freezes: state.freezes });
    return;
  }

  const gap = daysBetweenLocalStr(state.lastDate, today);

  if (gap === 1) {
    state.count += 1;
    state.lastDate = today;
    let earnedFreeze = false;
    if (state.count % 7 === 0 && state.freezes < STREAK_MAX_FREEZES) {
      state.freezes += 1;
      earnedFreeze = true;
    }
    saveStreakState(state);
    if (earnedFreeze) {
      showInfoToast(`🧊 Earned a streak freeze for 7 days in a row! (${state.freezes}/${STREAK_MAX_FREEZES})`, "🔥");
    } else if (state.count > 1) {
      showInfoToast(`🔥 ${state.count} day streak!`, "🔥");
    }
    return;
  }

  if (gap === 2 && state.freezes > 0) {
    // missed exactly one day, but a freeze covers it automatically
    state.freezes -= 1;
    state.count += 1;
    state.lastDate = today;
    saveStreakState(state);
    showInfoToast(`🧊 A streak freeze covered a missed day - still at ${state.count}!`, "🔥");
    return;
  }

  // missed too many days (or no freeze available) - streak resets
  const hadStreak = state.count > 1;
  saveStreakState({ count: 1, lastDate: today, freezes: state.freezes });
  if (hadStreak) {
    showInfoToast(`Your streak reset - starting fresh at day 1. You've got this. 🔥`, "💔");
  }
}

function renderStreakBadges() {
  const state = getStreakState();
  const cornerBadge = document.getElementById("streakBadge");
  const menuBadge = document.getElementById("menuStreakBadge");
  if (cornerBadge) {
    if (state.count > 0) {
      cornerBadge.textContent = String(state.count);
      cornerBadge.style.display = "flex";
    } else {
      cornerBadge.style.display = "none";
    }
  }
  if (menuBadge) menuBadge.textContent = state.count > 0 ? `🔥 ${state.count}` : "";
}

function renderStreakModal() {
  const state = getStreakState();
  const countEl = document.getElementById("streakCountBig");
  const subEl = document.getElementById("streakSubtext");
  const freezeRow = document.getElementById("streakFreezeRow");
  if (countEl) countEl.textContent = `🔥 ${state.count}`;
  if (subEl) subEl.textContent = state.count === 1 ? "day streak" : "day streak";
  if (freezeRow) {
    freezeRow.innerHTML = "";
    for (let i = 0; i < STREAK_MAX_FREEZES; i++) {
      const slot = document.createElement("span");
      slot.className = "freezeSlot" + (i < state.freezes ? " filled" : "");
      slot.textContent = "🧊";
      freezeRow.appendChild(slot);
    }
  }
}

function toggleStreakModal(forceState) {
  const streakModal = document.getElementById("streakModal");
  const streakBackdrop = document.getElementById("streakBackdrop");
  const shouldOpen = typeof forceState === "boolean" ? forceState : !streakModal.classList.contains("open");
  if (shouldOpen) {
    toggleMenuDrawer(false);
    renderStreakModal();
  }
  streakModal.classList.toggle("open", shouldOpen);
  streakBackdrop.classList.toggle("open", shouldOpen);
}

// Ambient floating motes
for (let i = 0; i < 10; i++) {
  const m = document.createElement("div");
  const leftPct = Math.random() * 100;
  // Tagged by which half of the screen they spawn on so Roundboth's
  // split theme (see body.bothMode .mote-r in <style>) can tint each
  // mote to match its own side's live mood color instead of one shared
  // accent - purely cosmetic outside Roundboth.
  m.className = "mote " + (leftPct >= 50 ? "mote-r" : "mote-l");
  const size = 4 + Math.random() * 8;
  m.style.width = size + "px";
  m.style.height = size + "px";
  m.style.left = leftPct + "%";
  m.style.top = Math.random() * 100 + "%";
  m.style.animationDuration = (10 + Math.random() * 10) + "s";
  m.style.animationDelay = (Math.random() * 5) + "s";
  motesContainer.appendChild(m);
}

// ---- 3. AVATAR EXPRESSION TOGGLE (thinking state) -----------------------
// Toggling the "awake" class flips the CSS eyes-open/eyes-closed layers
// already defined in <style>. Called the instant Send/Enter fires, and
// removed the instant the reply lands in the chat (see handleChatSend).
function setAwake(isAwake) {
  portrait.classList.toggle("awake", isAwake);
}

// ---- 4. PERSISTENT CHAT (localStorage) ----------------------------------
// apiIndex (optional) records which chatHistory slot this bubble corresponds
// to, so the timeline controls can later map "this bubble" -> "this API
// message" precisely. Returns the new entry's position in the log.
function saveChatLog(text, who, apiIndex = null) {
  try {
    chatLogData.push({ text, who, t: Date.now(), apiIndex: (typeof apiIndex === "number" ? apiIndex : null) });
    localStorage.setItem(LS.CHAT_LOG, JSON.stringify(chatLogData));
    return chatLogData.length - 1;
  } catch (e) {
    console.warn("Roundbina: could not save chat log", e);
    return null;
  }
}

// Writes the current chatLogData straight to localStorage. Used by the
// timeline controls after they splice/edit entries in place, so we don't
// have to round-trip every mutation through saveChatLog().
function persistChatLogData() {
  try { localStorage.setItem(LS.CHAT_LOG, JSON.stringify(chatLogData)); }
  catch (e) { console.warn("Roundbina: could not save chat log", e); }
}

// Rebuilds the chat window from localStorage on startup.
// Returns true if there was previous history to restore.
function restoreChatLog() {
  let log = [];
  try { log = JSON.parse(localStorage.getItem(LS.CHAT_LOG) || "[]"); }
  catch (e) { log = []; }
  chatLogData = log.map(m => ({
    text: m.text,
    who: m.who,
    t: m.t,
    apiIndex: (typeof m.apiIndex === "number" ? m.apiIndex : null)
  }));
  if (chatLogData.length) {
    // PERF: only the most recent page gets built as actual DOM at first -
    // the rest of a long history isn't just paint-skipped (content-visibility,
    // see addMsg) but genuinely not created at all, until scrolled up into.
    chatLoadedStart = Math.max(0, chatLogData.length - CHAT_PAGE_SIZE);
    renderChatWindow();
    return true;
  }
  chatLoadedStart = 0;
  return false;
}

// Builds whatever's currently the visible DOM window from
// chatLogData[chatLoadedStart:], with a "load earlier" button at the top
// when there's more history above it. Used by restoreChatLog (fresh boot/
// character switch), rerenderChatFromLog (after edit/delete/regenerate),
// and loadOlderMessages (scrolling up for more).
function renderChatWindow(opts = {}) {
  const preserveScroll = !!opts.preserveScroll;
  const prevScrollHeight = preserveScroll ? chatContainer.scrollHeight : null;
  const prevScrollTop = preserveScroll ? chatContainer.scrollTop : null;
  if (!preserveScroll) chatWindowRenderedAt = Date.now();

  chatContainer.innerHTML = "";

  for (let idx = chatLoadedStart; idx < chatLogData.length; idx++) {
    const m = chatLogData[idx];
    addMsg(m.text, m.who, { persist: false, logIndex: idx, apiIndex: m.apiIndex });
  }

  if (preserveScroll) {
    // Newly-added older bubbles push everything down - add exactly that
    // much height back to scrollTop so what the person was already
    // looking at stays put instead of jumping under them.
    requestAnimationFrame(() => {
      const newScrollHeight = chatContainer.scrollHeight;
      chatContainer.scrollTop = prevScrollTop + (newScrollHeight - prevScrollHeight);
    });
    return;
  }

  if (typeof opts.anchorLogIndex === "number") {
    // Keep the view where the person was working instead of yanking them
    // to the bottom of the whole conversation - addMsg() above already
    // called scrollChatToBottom() as it rebuilt each bubble, so this runs
    // last and wins, landing back on the message that was actually edited.
    const anchorEl = chatContainer.querySelector(`[data-log-index="${opts.anchorLogIndex}"]`);
    if (anchorEl) {
      requestAnimationFrame(() => anchorEl.scrollIntoView({ block: "center", behavior: "auto" }));
      return;
    }
  }
  scrollChatToBottom(); // one more explicit snap once the window is in, on top of addMsg's own per-bubble calls
}

// Expands the loaded window upward by one page, preserving scroll position
// so it feels like the history was just always there, not like the view
// jumped around to make room for it.
function loadOlderMessages() {
  if (loadingOlderMessages || chatLoadedStart <= 0) return;
  loadingOlderMessages = true;
  chatLoadedStart = Math.max(0, chatLoadedStart - CHAT_PAGE_SIZE);
  renderChatWindow({ preserveScroll: true });
  loadingOlderMessages = false;
}

// Clears every rendered DOM bubble and rebuilds the currently-loaded window
// from chatLogData. Used after any mutation (delete/rewind/edit/regenerate)
// so every bubble's data-log-index and controls line back up with the
// (possibly shifted) array - much simpler than patching indices in place.
function rerenderChatFromLog(anchorLogIndex) {
  // Keep whatever window was already loaded, but widen it if the anchor
  // (e.g. editing a message further back than what's currently rendered)
  // falls outside it, and stay in bounds if the array just got shorter.
  if (typeof anchorLogIndex === "number") {
    chatLoadedStart = Math.min(chatLoadedStart, anchorLogIndex);
  }
  chatLoadedStart = Math.max(0, Math.min(chatLoadedStart, chatLogData.length));
  renderChatWindow({ anchorLogIndex });
}

// ---- Settings access: view the raw stored chat history data ------------
// Purely a read-only window into LS.CHAT_LOG, opened from the settings
// drawer. Does not alter the underlying persistence logic above.
const historyBackdrop = document.getElementById("historyBackdrop");
const historyModal = document.getElementById("historyModal");
const historyTextarea = document.getElementById("historyTextarea");
const historyMeta = document.getElementById("historyMeta");

function renderHistoryModal() {
  let log = [];
  try { log = JSON.parse(localStorage.getItem(LS.CHAT_LOG) || "[]"); }
  catch (e) { log = []; }
  historyTextarea.value = JSON.stringify(log, null, 2);
  const last = log.length ? new Date(log[log.length - 1].t).toLocaleString() : "—";
  historyMeta.textContent = log.length
    ? `${log.length} message${log.length === 1 ? "" : "s"} stored · last saved ${last}`
    : "No chat history stored yet.";
}

function toggleHistoryModal(forceOpen) {
  const shouldOpen = typeof forceOpen === "boolean"
    ? forceOpen
    : !historyModal.classList.contains("open");
  if (shouldOpen) renderHistoryModal();
  historyModal.classList.toggle("open", shouldOpen);
  historyBackdrop.classList.toggle("open", shouldOpen);
}

function copyHistoryData() {
  historyTextarea.focus();
  historyTextarea.select();
  try { document.execCommand("copy"); }
  catch (e) { console.warn("Roundbina: could not copy chat history", e); }
}

// ---- Lightweight markdown: *italic*, **bold**, _italic_, __bold__ -------
// Text is HTML-escaped first, so the only tags that can ever appear are the
// <em>/<strong>/<br> ones we add ourselves - safe against injection.
function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

function renderMarkdownLite(text) {
  let html = escapeHtml(text);
  html = html.replace(/\*\*(\S(?:.*?\S)?)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/__(\S(?:.*?\S)?)__/g, "<strong>$1</strong>");
  html = html.replace(/\*(\S(?:.*?\S)?)\*/g, "<em>$1</em>");
  html = html.replace(/_(\S(?:.*?\S)?)_/g, "<em>$1</em>");
  html = html.replace(/\n/g, "<br>");
  return html;
}

// addMsg(text, who, { persist:false }) lets internal restores skip re-saving.
// New opts:
//   apiIndex  - which chatHistory slot this bubble corresponds to (or omit/null)
//   logIndex  - explicit position in chatLogData, used when persist:false
//               (restores/rerenders already know their index; live sends don't)
// ---- Emotion-reactive bubbles --------------------------------------------
// Every bot reply already carries a mood word via the hidden {{STATUS}} tag
// (parsed into characterStatus.mood before addMsg runs - see
// parseAndApplyStatusTag). Reusing the same happy/crying/angry/evil/confused
// buckets that drive her portrait expression means each bubble is tinted
// with a small colored edge + glow matching how she felt *at that exact
// moment* - so scrolling back through the log reads like an emotional
// timeline, not just a wall of same-colored text.
function botMoodBucket() {
  const cls = getExpressionClass(characterStatus.mood); // "mood-happy" | ... | null
  return cls ? cls.replace("mood-", "") : "neutral";
}

// Lightweight, dependency-free heuristic for the person's own messages -
// no network call, just keyword/punctuation/emoji pattern matching, so it
// costs nothing and never blocks sending. Order matters: checked roughly
// strongest-signal-first.
function classifyUserEmotion(text) {
  const t = text.toLowerCase();
  if (/[❤️💕💗💖😍🥰]|\b(love|adore|miss you)\b/.test(t)) return "loving";
  if (/[😡🤬]|\b(hate|angry|mad|furious|pissed|ugh)\b/.test(t)) return "angry";
  if (/[😢😭💔]|\b(sad|crying|lonely|sorry|hurt|upset)\b/.test(t)) return "sad";
  if (/[😆😂🤣🎉]|\b(haha+|lol|lmao|yay|awesome|amazing)\b/.test(t) || /!{2,}/.test(text)) return "excited";
  if (/\?{2,}|\b(confused|huh|why though)\b/.test(t)) return "confused";
  return "neutral";
}

function addMsg(text, who, opts = {}) {
  const persist = opts.persist !== false;
  const div = document.createElement("div");
  div.className = "msg " + who;
  if (who === "bot" || who === "user" || who === "guest") {
    div.innerHTML = renderMarkdownLite(text);
    if (who === "bot") div.dataset.emotion = botMoodBucket();
    else if (who === "user") div.dataset.emotion = classifyUserEmotion(text);
    // PERF: content-visibility skips layout/paint for bubbles currently
    // scrolled offscreen, which matters a lot once a chat history gets
    // long - without it, every single message in the whole conversation
    // gets fully laid out and painted on every render, which is what was
    // making long-history scrolling feel heavy again. It needs a height
    // estimate for offscreen bubbles though - the old flat 72px guess for
    // EVERY message regardless of length was wildly wrong for a long
    // reply, and correcting a badly-wrong guess mid-scroll is exactly what
    // caused the "teleport" bug. Estimating per-message from its actual
    // text length gets closer, but a straight length/38 guess still badly
    // undercounts anything with manual line breaks - this app's replies
    // are full of short, blank-line-separated action/dialogue paragraphs,
    // where explicit newlines drive the real height far more than word-wrap
    // does. Counting each line's own wrap separately instead fixes that.
    const estimatedLines = text.split("\n").reduce(
      (sum, line) => sum + Math.max(1, Math.ceil(line.length / 38)), 0
    );
    const estimatedHeight = Math.max(1, estimatedLines) * 21 + 26;
    div.style.contentVisibility = "auto";
    div.style.containIntrinsicSize = `auto ${estimatedHeight}px`;
  } else {
    div.textContent = text;
  }
  chatContainer.appendChild(div);
  scrollChatToBottom();

  let logIndex = opts.logIndex;
  if (persist) {
    logIndex = saveChatLog(text, who, opts.apiIndex);
  }
  if (typeof logIndex === "number") {
    div.dataset.logIndex = String(logIndex);
  }
  if (typeof opts.apiIndex === "number") {
    div.dataset.apiIndex = String(opts.apiIndex);
  }

  if ((who === "user" || who === "bot") && typeof logIndex === "number") {
    attachMessageControls(div, who, logIndex);
  }

  // BUG FIX: pagination only ever grew the loaded window before - scrolling
  // up to load older messages never got undone as new ones kept arriving
  // at the bottom during the same session. Over a long single sitting
  // (especially after scrolling up a few times), the actual rendered DOM
  // could quietly grow back to the whole conversation again, which is
  // exactly what was causing lag to build up over time and made switching
  // characters/modes (which re-render the whole thing) feel heavy again.
  // Only trims for genuine live additions (opts.persist !== false), never
  // while renderChatWindow() itself is mid-rebuild.
  if (opts.persist !== false) trimRenderedWindowIfNeeded();

  return div;
}

const MAX_RENDERED_MESSAGES = 40; // generous scrollback room, but genuinely bounded
function trimRenderedWindowIfNeeded() {
  const renderedCount = chatLogData.length - chatLoadedStart;
  if (renderedCount <= MAX_RENDERED_MESSAGES) return;
  const excess = renderedCount - MAX_RENDERED_MESSAGES;
  // The oldest `excess` bubbles just get removed from the DOM - they're
  // still completely safe in chatLogData/chatHistory, only their on-screen
  // presence is pruned. Scrolling up again reloads them normally.
  for (let i = 0; i < excess; i++) {
    const el = chatContainer.querySelector(`[data-log-index="${chatLoadedStart + i}"]`);
    if (el) el.remove();
  }
  chatLoadedStart += excess;
}

// ---- Timeline manipulation controls (regenerate / rewind / delete / edit) --
// Builds the little icon row under a user/bot bubble and wires up click
// handlers. Also makes the bubble itself clickable to rewind to that point.
function attachMessageControls(div, who, logIndex) {
  const isLastEntry = logIndex === chatLogData.length - 1;

  const bar = document.createElement("div");
  bar.className = "msgControls";

  if (who === "user") {
    if (isLastUserTurn(logIndex)) {
      bar.appendChild(makeControlBtn("edit", "Edit & resend", () => editUserMessage(logIndex)));
    }
  } else if (who === "bot") {
    bar.appendChild(makeControlBtn("edit", "Edit reply", () => editBotMessage(logIndex)));
    if (isLastEntry) {
      bar.appendChild(makeControlBtn("regenerate", "Regenerate", () => regenerateLastResponse()));
    }
  }
  bar.appendChild(makeControlBtn("copy", "Copy text", (btn) => {
    const entry = chatLogData[logIndex];
    if (entry) copyMessageText(entry.text, btn);
  }));
  bar.appendChild(makeControlBtn("rewind", "Rewind here", () => rewindToLogIndex(logIndex)));
  bar.appendChild(makeControlBtn("delete", "Delete", () => deleteMessageAtLogIndex(logIndex)));

  div.appendChild(bar);

  // Tapping the bubble itself (but not one of the control buttons) rewinds
  // the whole conversation to just after this message - handy for
  // branching the roleplay from an earlier point.
  div.addEventListener("click", (e) => {
    if (e.target.closest(".msgControlBtn")) return;
    rewindToLogIndex(logIndex);
  });
}

// Small inline icon set replacing the old emoji buttons - plain stroke
// icons so the chat controls look like part of the app instead of a row
// of random emoji. All 16x16 viewBox, currentColor stroke.
const MSG_ICONS = {
  edit: '<svg viewBox="0 0 16 16" fill="none"><path d="M11 2l3 3-8 8-3.5 1 1-3.5 8-8z" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  regenerate: '<svg viewBox="0 0 16 16" fill="none"><path d="M2.5 8a5.5 5.5 0 0 1 9.3-4M13.5 8a5.5 5.5 0 0 1-9.3 4" stroke-width="1.3" stroke-linecap="round"/><path d="M11.5 2.5v2.5h-2.5M4.5 13.5V11H7" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  rewind: '<svg viewBox="0 0 16 16" fill="none"><path d="M7.5 3L3 8l4.5 5M13 3L8.5 8l4.5 5" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  delete: '<svg viewBox="0 0 16 16" fill="none"><path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.5 8.5a1 1 0 0 0 1 1h4a1 1 0 0 0 1-1l.5-8.5" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  copy: '<svg viewBox="0 0 16 16" fill="none"><rect x="5.5" y="5.5" width="8" height="8" rx="1.5" stroke-width="1.3"/><path d="M10.5 5.5V3.5a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2" stroke-width="1.3" stroke-linecap="round"/></svg>',
  check: '<svg viewBox="0 0 16 16" fill="none"><path d="M3 8.5l3 3 7-7" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>'
};

function makeControlBtn(iconKey, label, handler) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "msgControlBtn";
  btn.setAttribute("aria-label", label);
  btn.title = label;
  btn.innerHTML = MSG_ICONS[iconKey] || "";
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    handler(btn);
  });
  return btn;
}

// Copies a message's text to the clipboard, with a quick checkmark swap
// on the button itself to confirm it actually worked.
async function copyMessageText(text, btn) {
  try {
    await navigator.clipboard.writeText(text);
  } catch (e) {
    // Fallback for contexts where the Clipboard API is unavailable
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand("copy"); } catch (e2) { /* give up quietly */ }
    document.body.removeChild(ta);
  }
  if (btn) {
    const original = btn.innerHTML;
    btn.innerHTML = MSG_ICONS.check;
    btn.classList.add("copied");
    setTimeout(() => { btn.innerHTML = original; btn.classList.remove("copied"); }, 1200);
  }
}

// True if there is no other "user" bubble after logIndex - i.e. this is
// the most recently sent user message, the only one it makes sense to
// edit-and-resend (editing an older one is what rewind+edit already covers).
function isLastUserTurn(logIndex) {
  const entry = chatLogData[logIndex];
  if (!entry || entry.who !== "user") return false;
  for (let i = chatLogData.length - 1; i > logIndex; i--) {
    if (chatLogData[i].who === "user") return false;
  }
  return true;
}

// Patches a single chatLogData entry's apiIndex after the fact (needed
// because a user bubble is drawn before we know whether the API call that
// follows will succeed) and keeps localStorage + the live DOM node in sync.
function updateLogEntryApiIndex(logIndex, apiIndex) {
  if (!chatLogData[logIndex]) return;
  chatLogData[logIndex].apiIndex = apiIndex;
  persistChatLogData();
  const el = chatContainer.querySelector('[data-log-index="' + logIndex + '"]');
  if (el) {
    if (typeof apiIndex === "number") el.dataset.apiIndex = String(apiIndex);
    else delete el.dataset.apiIndex;
  }
}

// ---- Regenerate: drop the AI's last reply from chatHistory and re-fetch ---
async function regenerateLastResponse() {
  if (!chatHistory.length || chatHistory[chatHistory.length - 1].role !== "assistant") {
    addMsg("*tilts head* There's no reply to regenerate yet~", "system-msg");
    return;
  }

  chatInput.disabled = true;
  chatSendBtn.disabled = true;
  showTyping();
  setAwake(true);

  // Pop the old reply out of chatHistory (the API-facing context) before
  // asking again - fetchCompletionFromHistory() just resends whatever's
  // currently there. Crucially, the DISPLAYED bubble is left completely
  // untouched until we know the retry actually worked, so a failed
  // regenerate never leaves the conversation looking like her last reply
  // just vanished into nothing.
  const removedReply = chatHistory.pop();
  saveApiHistory();

  const result = await fetchCompletionFromHistory();

  hideTyping();
  setAwake(false);
  chatInput.disabled = false;
  chatSendBtn.disabled = false;

  if (!result.ok) {
    // Put the old reply back exactly as it was - nothing changes on
    // screen, just a popup explaining what went wrong.
    chatHistory.push(removedReply);
    saveApiHistory();
    showErrorToast(result.error);
    return;
  }

  // Success: NOW drop the old bubble from the display log and redraw with the new one.
  for (let i = chatLogData.length - 1; i >= 0; i--) {
    if (chatLogData[i].who === "bot" && typeof chatLogData[i].apiIndex === "number") {
      chatLogData.splice(i, 1);
      break;
    }
  }
  persistChatLogData();
  rerenderChatFromLog();
  addMsg(result.text, "bot", { apiIndex: chatHistory.length - 1 });
}

// ---- Rewind: branch the roleplay by truncating everything after a point --
function rewindToLogIndex(logIndex) {
  const entry = chatLogData[logIndex];
  if (!entry) return;
  if (logIndex === chatLogData.length - 1) return; // already the end, nothing to rewind
  if (!confirm("Rewind the chat to here? Everything after this message will be deleted.")) return;

  // Truncate the display log to just this message.
  chatLogData = chatLogData.slice(0, logIndex + 1);
  persistChatLogData();

  // Truncate the API history to match. If this bubble isn't itself tracked
  // in chatHistory (e.g. it's a system note), fall back to the nearest
  // earlier tracked message.
  let cutApiIndex = entry.apiIndex;
  if (typeof cutApiIndex !== "number") {
    cutApiIndex = -1;
    for (let i = logIndex; i >= 0; i--) {
      if (typeof chatLogData[i].apiIndex === "number") { cutApiIndex = chatLogData[i].apiIndex; break; }
    }
  }
  chatHistory = chatHistory.slice(0, cutApiIndex + 1);
  saveApiHistory();

  rerenderChatFromLog();
}

// ---- Regular delete: remove one message without touching the rest -------
// Silent version - no confirm dialog. Used internally when the app itself
// needs to undo an optimistic bubble (e.g. a failed send/feed/edit), where
// popping up "delete this message?" would be completely out of place -
// the person didn't ask to delete anything, a request just failed.
function removeLogEntryAtIndex(logIndex) {
  const entry = chatLogData[logIndex];
  if (!entry) return;

  if (typeof entry.apiIndex === "number") {
    const removedApiIndex = entry.apiIndex;
    chatHistory.splice(removedApiIndex, 1);
    saveApiHistory();
    // Every later entry's apiIndex needs to shift down by one to match.
    chatLogData.forEach(m => {
      if (typeof m.apiIndex === "number" && m.apiIndex > removedApiIndex) m.apiIndex -= 1;
    });
  }

  chatLogData.splice(logIndex, 1);
  persistChatLogData();
  rerenderChatFromLog(logIndex); // whatever now sits at this index (the next message) stays in view
}

// User-facing version (the 🗑️ button on a message) - confirms first since
// this one really is a deliberate, person-initiated delete.
function deleteMessageAtLogIndex(logIndex) {
  if (!chatLogData[logIndex]) return;
  if (!confirm("Delete this message?")) return;
  removeLogEntryAtIndex(logIndex);
}

// ---- Edit: last sent user message (rewinds + refetches) -----------------
// ---- Inline message editing ----------------------------------------------
// Swaps a bubble's rendered text for a proper auto-growing textarea in
// place, instead of the OS's cramped single-line prompt() dialog. Resolves
// to the edited text on Save, or null on Cancel/Escape (same contract the
// old prompt()-based callers already expect).
function openInlineMsgEditor(div, initialText) {
  return new Promise((resolve) => {
    const originalHTML = div.innerHTML;
    div.innerHTML = "";

    const textarea = document.createElement("textarea");
    textarea.className = "msgEditArea";
    textarea.value = initialText;
    div.appendChild(textarea);

    const actions = document.createElement("div");
    actions.className = "msgEditActions";
    const saveBtn = document.createElement("button");
    saveBtn.type = "button"; saveBtn.className = "msgEditSave"; saveBtn.textContent = "Save";
    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button"; cancelBtn.className = "msgEditCancel"; cancelBtn.textContent = "Cancel";
    actions.appendChild(saveBtn);
    actions.appendChild(cancelBtn);
    div.appendChild(actions);

    const grow = () => { textarea.style.height = "auto"; textarea.style.height = textarea.scrollHeight + "px"; };
    textarea.addEventListener("input", grow);
    requestAnimationFrame(() => {
      grow();
      textarea.focus();
      textarea.setSelectionRange(textarea.value.length, textarea.value.length);
    });

    // Prevent the bubble's own "tap to rewind" listener from firing while
    // interacting with the editor.
    div.querySelectorAll("*").forEach((el) => el.addEventListener("click", (e) => e.stopPropagation()));

    saveBtn.addEventListener("click", (e) => { e.stopPropagation(); resolve(textarea.value); });
    cancelBtn.addEventListener("click", (e) => { e.stopPropagation(); div.innerHTML = originalHTML; resolve(null); });
    textarea.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); resolve(textarea.value); }
      else if (e.key === "Escape") { div.innerHTML = originalHTML; resolve(null); }
    });
  });
}

async function editUserMessage(logIndex) {
  const entry = chatLogData[logIndex];
  if (!entry || entry.who !== "user") return;
  const div = chatContainer.querySelector(`[data-log-index="${logIndex}"]`);
  if (!div) return;
  const newText = await openInlineMsgEditor(div, entry.text);
  if (newText === null) return; // cancelled
  const trimmed = newText.trim();
  if (!trimmed) return;

  // Figure out where chatHistory should be trimmed back to (just before
  // this user turn), same logic as rewind but without touching this
  // bubble's own display entry - we're replacing it, not keeping it.
  let priorApiIndex = -1;
  for (let i = logIndex - 1; i >= 0; i--) {
    if (typeof chatLogData[i].apiIndex === "number") { priorApiIndex = chatLogData[i].apiIndex; break; }
  }

  chatLogData = chatLogData.slice(0, logIndex);
  persistChatLogData();
  chatHistory = chatHistory.slice(0, priorApiIndex + 1);
  saveApiHistory();
  rerenderChatFromLog();

  // Re-send the edited text through the normal path so history + API stay
  // in sync exactly like a fresh send would.
  const userDiv = addMsg(trimmed, "user");
  const userLogIdx = Number(userDiv.dataset.logIndex);

  chatInput.disabled = true;
  chatSendBtn.disabled = true;
  showTyping();
  setAwake(true);

  const botReply = await getAIResponse(trimmed);

  hideTyping();
  setAwake(false);
  chatInput.disabled = false;
  chatSendBtn.disabled = false;

  if (botReply.ok) {
    updateLogEntryApiIndex(userLogIdx, chatHistory.length - 2);
    addMsg(botReply.text, "bot", { apiIndex: chatHistory.length - 1 });
  } else {
    // Nothing pasted into chat on failure - the edited text goes back
    // into the input box so it's not lost, and the bubble that never
    // actually sent gets removed.
    removeLogEntryAtIndex(userLogIdx);
    chatInput.value = trimmed;
    autoGrowChatInput();
    showErrorToast(botReply.error);
    chatInput.focus();
  }
}

// ---- Edit: any of the AI's responses directly, no refetch ---------------
function editBotMessage(logIndex) {
  const entry = chatLogData[logIndex];
  if (!entry || entry.who !== "bot") return;
  const div = chatContainer.querySelector(`[data-log-index="${logIndex}"]`);
  if (!div) return;
  openInlineMsgEditor(div, entry.text).then((newText) => {
    if (newText === null) return;
    const trimmed = newText.trim();
    if (!trimmed) return;

    entry.text = trimmed;
    persistChatLogData();

    if (typeof entry.apiIndex === "number" && chatHistory[entry.apiIndex]) {
      chatHistory[entry.apiIndex].content = trimmed;
      saveApiHistory();
    }
    rerenderChatFromLog(logIndex);
  });
}

function showTyping() {
  const div = document.createElement("div");
  div.className = "typing";
  div.id = "typingIndicator";
  div.innerHTML = "<span></span><span></span><span></span>";
  chatContainer.appendChild(div);
  scrollChatToBottom();
}

function hideTyping() {
  const el = document.getElementById("typingIndicator");
  if (el) el.remove();
}

function saveApiHistory() {
  try { localStorage.setItem(LS.API_HISTORY, JSON.stringify(chatHistory)); }
  catch (e) { console.warn("Roundbina: could not save API history", e); }
}

// IMPORTANT: whenever a turn fails for *any* reason, we must remove the user
// message we just pushed. The "messages" array has to strictly alternate
// user/assistant turns; leaving an unanswered user turn in there desyncs
// every request after it, and Roundbina's replies start getting
// mangled/cut off out of nowhere (which is what was happening after the
// feeding exchange - one bad turn poisoned the whole conversation).
function rollbackDanglingUserTurn() {
  if (chatHistory.length && chatHistory[chatHistory.length - 1].role === "user") {
    chatHistory.pop();
    saveApiHistory();
  }
}

// Roundbina talks to whatever OpenAI-compatible proxy the person configured
// in settings (OpenRouter, a self-hosted proxy, etc). The request/response
// shape follows the standard "chat/completions" convention so it works with
// any provider that speaks that dialect.
// Sends whatever is *currently* in chatHistory to the proxy and parses the
// reply, WITHOUT pushing a new user turn first. This is the piece
// getAIResponse() and regenerateLastResponse() both build on: normal sends
// push a user message then call this, while regenerate just pops the old
// assistant reply and calls this directly to get a fresh one for the same
// prompt. Sets the module-level lastResponseWasSuccessful flag so callers
// can tell whether chatHistory actually gained a new assistant entry.
async function fetchCompletionFromHistory() {
  const timeNote = buildTimeSinceLastMessageNote();
  const messages = [{ role: "system", content: getSystemPrompt() }];
  if (timeNote) messages.push({ role: "system", content: timeNote });
  messages.push(...trimHistoryToContextBudget(chatHistory));

  const payload = {
    model: selectedModel,
    messages,
    temperature: 0.7,
    max_tokens: getMaxTokens()
  };

  try {
    const response = await doModelFetch(payload);

    const data = await response.json();

    if (data.error) {
      rollbackDanglingUserTurn();
      lastResponseWasSuccessful = false;
      const msg = (data.error.message || data.error) || "unknown error";
      if (response.status === 400 || response.status === 401 || response.status === 403 || response.status === 404) {
        return { ok: false, error: "That key, proxy, or model doesn't seem to work - double-check ⚙️ settings." };
      }
      return { ok: false, error: msg };
    }

    // Google's native API (and some OpenAI-compatibility shims in front of
    // it) reports a blocked PROMPT here instead of through choices/error at
    // all - generation never even starts, so there's no choice to look at.
    // This is what "no reply" with Google specifically usually means: the
    // person's own typed message tripped a safety filter before the model
    // ever got to respond - which is why pure character-to-character
    // dialogue in Roundboth (no real user input in the prompt) doesn't hit
    // this, but every solo message does.
    if (data.promptFeedback && data.promptFeedback.blockReason) {
      rollbackDanglingUserTurn();
      lastResponseWasSuccessful = false;
      return { ok: false, error: `Blocked by the provider's safety filter (${data.promptFeedback.blockReason}) - that's Google's own content policy on the input, not something the app can override.` };
    }

    const choice = data.choices && data.choices[0];
    if (!choice) {
      rollbackDanglingUserTurn();
      lastResponseWasSuccessful = false;
      let debugSnippet = "";
      try { debugSnippet = JSON.stringify(data).slice(0, 500); } catch (e) { /* ignore */ }
      return { ok: false, error: `Got no reply back from the model. Raw response: ${debugSnippet}` };
    }
    if (choice.finish_reason === "content_filter" || choice.finish_reason === "SAFETY") {
      rollbackDanglingUserTurn();
      lastResponseWasSuccessful = false;
      return { ok: false, error: "That response got filtered by the model provider's safety system." };
    }

    const botText = stripThinkingTags((choice.message && choice.message.content ? choice.message.content : "").trim());
    if (!botText) {
      rollbackDanglingUserTurn();
      lastResponseWasSuccessful = false;
      // Include a peek at the actual raw response - this is a debugging
      // aid: this specific empty-reply case has been hard to diagnose
      // blind (Google's response shape differs across endpoints/versions),
      // so showing the real thing beats guessing at it again.
      let debugSnippet = "";
      try { debugSnippet = JSON.stringify(data).slice(0, 500); } catch (e) { /* ignore */ }
      return { ok: false, error: `Got an empty reply back from the model. Raw response: ${debugSnippet}` };
    }

    // Pull the hidden {{STATUS ...}} tag out for display, but keep the raw
    // botText (tag included) in chatHistory below - that way the model can
    // see its own last-reported hunger/cleanliness on the next turn and
    // keep the drift consistent instead of guessing from scratch each time.
    let strippedText = parseAndApplyStatusTag(botText);
    strippedText = stripStrayTags(parseAndApplyEffectTag(strippedText));
    if (!strippedText) strippedText = "*fidgets, unsure what to say*";

    // Keep this turn even if it got cut for length - it's still a valid
    // assistant turn, so history stays in sync. We just nudge the ellipsis
    // on so it's clear (to the person, not just to Roundbina) that she ran
    // out of room rather than actually trailing off mid-thought.
    const displayText = choice.finish_reason === "length" && !/[.!?…"']\s*$/.test(strippedText)
      ? strippedText + "…"
      : strippedText;

    chatHistory.push({ role: "assistant", content: botText });
    saveApiHistory();
    localStorage.setItem(LS.LAST_MESSAGE_AT, String(Date.now()));
    lastResponseWasSuccessful = true;
    return { ok: true, text: displayText };
  } catch (error) {
    console.error(error);
    rollbackDanglingUserTurn();
    lastResponseWasSuccessful = false;
    // A bare "TypeError: Failed to fetch" (no HTTP status at all) almost
    // always means the request never actually reached/returned from the
    // server as far as the browser is concerned - most commonly a CORS
    // rejection, a service worker intercepting the request, or a genuine
    // network/DNS failure. Surfacing the real error name+message (instead of
    // a generic line) makes it possible to actually tell which one it is.
    const detail = (error && error.message) ? error.message : String(error);
    const looksLikeCorsOrNetwork = error instanceof TypeError;
    const hint = looksLikeCorsOrNetwork
      ? " (blocked/incomplete request - often CORS, a service worker, or your connection)"
      : "";
    return { ok: false, error: `Connection snag: ${detail}${hint}` };
  }
}

async function getAIResponse(userMessage) {
  chatHistory.push({ role: "user", content: userMessage });
  saveApiHistory();
  return await fetchCompletionFromHistory();
}

function handleSend() {
  const value = keyInput.value.trim();
  if (!value) return;

  apiKey = value;
  connected = true;

  if (rememberKeyCheckbox && rememberKeyCheckbox.checked) {
    localStorage.setItem(LS.API_KEY, apiKey);
  } else {
    localStorage.removeItem(LS.API_KEY);
  }
  refreshKeyStatusUI();

  setupPanel.style.display = "none";
  chatBar.style.display = "flex";
  resetBtn.style.display = "inline";

  addMsg(`🔑 Connected! ${getCharacter().name}'s brain (${selectedModel}) is officially online.`, "system-msg");
  chatInput.focus();

  consumePendingReturnGreeting(activeCharacterId);
}

// Lets the person paste a fresh key (or turn "remember" on/off) from inside
// settings, without having to hit "use a different key" and lose their
// place first.
function updateApiKeyFromSettings() {
  const value = settingsKeyInput.value.trim();
  const remember = rememberKeyCheckboxSettings && rememberKeyCheckboxSettings.checked;

  if (value) {
    apiKey = value;
    connected = true;
    settingsKeyInput.value = "";
    setupPanel.style.display = "none";
    chatBar.style.display = "flex";
    resetBtn.style.display = "inline";
  }

  if (remember && apiKey) {
    localStorage.setItem(LS.API_KEY, apiKey);
  } else if (!remember) {
    localStorage.removeItem(LS.API_KEY);
  }

  refreshKeyStatusUI();
  addMsg(value ? "🔑 Key updated!" : "Okay, remember-key preference saved.", "system-msg");
}

// Removes the saved key from this device (and stops remembering going
// forward) without touching the key currently in use for the open session.
function forgetRememberedKey() {
  localStorage.removeItem(LS.API_KEY);
  if (rememberKeyCheckboxSettings) rememberKeyCheckboxSettings.checked = false;
  if (rememberKeyCheckbox) rememberKeyCheckbox.checked = false;
  refreshKeyStatusUI();
  addMsg(`🗑️ Forgot the saved key on this device. You'll need to paste it again next time you open ${getCharacter().name}.`, "system-msg");
}

function toggleSettingsKeyVisibility() {
  if (!settingsKeyInput) return;
  settingsKeyInput.type = settingsKeyInput.type === "password" ? "text" : "password";
}

// Small status line in settings so it's clear whether a key is currently
// saved on this device, since the field itself is always shown blank.
function refreshKeyStatusUI() {
  if (!keyStatusRow) return;
  const remembered = !!localStorage.getItem(LS.API_KEY);
  if (rememberKeyCheckboxSettings) rememberKeyCheckboxSettings.checked = remembered;
  keyStatusRow.textContent = remembered
    ? "✅ a key is saved on this device - it'll auto-connect next time."
    : "no key saved on this device - you'll need to paste one each visit.";
}

async function handleChatSend() {
  if (isBothMode()) { await handleBothSend(); return; }

  // Empty send is allowed on purpose now - treated as a silent "nudge" so
  // she can react to your quiet presence instead of requiring you to
  // always type something before she'll respond.
  const rawInput = chatInput.value.trim();
  const isNudge = !rawInput;
  const userText = isNudge ? "*is here, saying nothing in particular*" : rawInput;

  if (isDead()) {
    addMsg(userText, "user");
    chatInput.value = ""; autoGrowChatInput();
    addMsg("*...silence. She doesn't stir.* She needs to be revived first - open ⚙️ settings.", "system-msg");
    return;
  }

  const userDiv = addMsg(userText, "user");
  const userLogIdx = Number(userDiv.dataset.logIndex);
  chatInput.value = ""; autoGrowChatInput();
  chatInput.disabled = true;
  chatSendBtn.disabled = true;
  showTyping();
  setAwake(true);

  const result = await getAIResponse(userText);
  hideTyping();
  setAwake(false);
  chatInput.disabled = false;
  chatSendBtn.disabled = false;

  if (!result.ok) {
    // Nothing pasted into chat on failure - just a popup. The bubble that
    // never actually sent gets removed, and (for a real typed message)
    // your text goes right back in the box so nothing's lost or needs
    // retyping. A nudge (empty send) just quietly resets instead.
    removeLogEntryAtIndex(userLogIdx);
    if (!isNudge) { chatInput.value = userText; autoGrowChatInput(); }
    showErrorToast(result.error);
    chatInput.focus();
    return;
  }

  // Both the user turn and the reply landed in chatHistory as the last
  // two entries - tag the bubbles so regenerate/rewind/delete/edit can
  // find them later.
  updateLogEntryApiIndex(userLogIdx, chatHistory.length - 2);
  addMsg(result.text, "bot", { apiIndex: chatHistory.length - 1 });
  bumpInterruptCounters(activeCharacterId);
  chatInput.focus();
}

function resetKey() {
  apiKey = "";
  connected = false;
  chatHistory.length = 0;
  saveApiHistory();
  keyInput.value = "";
  localStorage.removeItem(LS.API_KEY);
  refreshKeyStatusUI();
  setupPanel.style.display = "block";
  chatBar.style.display = "none";
  resetBtn.style.display = "none";
  addMsg("Okay, forgot that key! Paste a new one whenever you're ready~", "system-msg");
}

// Clears just the conversation (bubbles + message history), keeps the
// current API key/model connected. Covers both "clear chat" and "new chat".
function startNewChat() {
  if (isBothMode()) { bothClearTranscript(); return; }
  chatHistory.length = 0;
  saveApiHistory();
  chatLogData.length = 0;
  chatLoadedStart = 0;
  localStorage.removeItem(LS.CHAT_LOG);
  chatContainer.innerHTML = "";
  addMsg(`✨ Started a fresh chat with ${getCharacter().name}!`, "system-msg");
}

// Shared helper for "physical" actions (feeding, showering, etc). Instead of
// a hardcoded canned line, it feeds a short description of the action to
// Roundbina as a real conversational turn and lets the model improvise an
// in-character reaction - so the response varies and stays consistent with
// the rest of the conversation/history.
async function performAction(noteText, actionPrompt) {
  const noteDiv = addMsg(noteText, "system-msg");
  const noteLogIdx = Number(noteDiv.dataset.logIndex);

  if (!connected) return; // no key yet - just the sparkle + note, no API call

  chatInput.disabled = true;
  chatSendBtn.disabled = true;
  showTyping();
  setAwake(true);

  const result = await getAIResponse(actionPrompt);
  hideTyping();
  setAwake(false);
  chatInput.disabled = false;
  chatSendBtn.disabled = false;

  if (!result.ok) {
    // Nothing pasted into chat on failure - undo the optimistic note too
    // (the sparkle already played and stats already updated, which is
    // harmless either way), and surface it as a popup instead.
    if (!Number.isNaN(noteLogIdx)) removeLogEntryAtIndex(noteLogIdx);
    showErrorToast(result.error);
    return;
  }

  addMsg(result.text, "bot", { apiIndex: chatHistory.length - 1 });
}

function showerRoundbina() {
  if (isDead()) {
    addMsg("*a shower won't help now...* She needs to be revived first - open ⚙️ settings.", "system-msg");
    return;
  }
  spawnSparkle(portrait, ["💦", "🫧", "🚿"]);
  if (!connected) {
    addMsg("*splish splash* Ahh, that's refreshing! Thank you for the shower~ 🚿", "bot");
    return;
  }
  performAction(
    `🚿 You gave ${getCharacter().name} a shower!`,
    `*You gently give ${getCharacter().name} a warm bubble bath with a little rubber duck, then towel her off* 🚿🫧`
  );
}

keyInput.addEventListener("keydown", (e) => { if (e.key === "Enter") handleSend(); });
// Auto-grow the textarea as text wraps to a new line, capped by the
// max-height set in CSS (which then scrolls internally past that).
function autoGrowChatInput() {
  chatInput.style.height = "auto";
  chatInput.style.height = chatInput.scrollHeight + "px";
}
chatInput.addEventListener("input", autoGrowChatInput);
// Enter sends (matching the old single-line input's behavior); Shift+Enter
// inserts a real newline instead, same convention as most chat apps.
chatInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    handleChatSend();
  }
});

// ---- 6. AI-GENERATED RETURN GREETINGS ------------------------------------
// Instead of picking a canned line, we hand the model the real elapsed gap
// and let it improvise an in-character reaction - which also naturally
// feeds into its hunger/cleanliness/mood tag (see STATUS_INSTRUCTION), so
// "I was gone 6 hours" produces a hungrier, grumpier Roundbina on its own
// rather than a separate hardcoded message.
//
// Catch: the API key is memory-only and never persisted, so on a fresh page
// load we're always disconnected until the person re-enters it. If a
// greet-worthy gap is detected before that happens, we stash it here and
// fire it the moment handleSend() connects instead of losing it.
// Away-gaps discovered while disconnected get queued here, keyed by
// character id - a plain single variable used to lose whichever
// character's greeting wasn't queued most recently, since switching to a
// second character before reconnecting would silently overwrite the
// first one's pending greeting entirely.
let pendingReturnGaps = {};

function consumePendingReturnGreeting(id) {
  if (Object.prototype.hasOwnProperty.call(pendingReturnGaps, id)) {
    const gap = pendingReturnGaps[id];
    delete pendingReturnGaps[id];
    generateReturnGreeting(gap);
  }
}

function otherCharacterId(id) {
  return id === "bina" ? "rone" : "bina";
}

// Lets a character react to what the person was up to with their sibling
// while *this* character was the one left alone - checks whether the
// other character was actually talked to at some point during this
// character's own absence (using each character's independently-tracked
// lastMessageAt timestamp), not just whenever the other last spoke ever.
function buildOtherCharacterAwarenessNote(gapMs) {
  const otherId = otherCharacterId(activeCharacterId);
  const otherChar = CHARACTERS[otherId];
  const otherLastMsgRaw = localStorage.getItem(bothStatusKey(otherId, "lastMessageAt"));
  if (!otherLastMsgRaw) return null;
  const otherGapMs = Date.now() - parseInt(otherLastMsgRaw, 10);
  if (otherGapMs >= gapMs) return null; // other character wasn't visited during this absence either
  return `[While you were alone, the user was talking with ${otherChar.name} as recently as ` +
    `${formatElapsed(otherGapMs)} ago. You may bring this up if it feels natural for your ` +
    `personality - curious, teasing, jealous, unbothered, whatever genuinely fits - or ignore ` +
    `it if it doesn't. Never mention this note itself.]`;
}

function generateReturnGreeting(gapMs) {
  const elapsed = formatElapsed(gapMs);
  const timeOfDay = getTimeOfDayPhrase();
  const awarenessNote = buildOtherCharacterAwarenessNote(gapMs);
  performAction(
    `🕐 You've been away for ${elapsed}.`,
    `*You just returned after being away for ${elapsed}. It is currently ${timeOfDay}.* ` +
    `Greet me and react in character to how long it's actually been - let it genuinely ` +
    `shape how hungry, dirty, sleepy, or lonely you'd realistically feel by now.` +
    (awarenessNote ? ` ${awarenessNote}` : "")
  );
}

// Called at boot for whichever character loads first, and again every time
// the person switches to a character mid-session (see switchCharacter()),
// so each one's own real away-time gets checked independently instead of
// only ever checking whichever one happened to be open when the app closed.
function checkReturnAndGreet() {
  const now = Date.now();
  const lastActiveRaw = localStorage.getItem(LS.LAST_ACTIVE);

  // BUG FIX: a character with no LAST_ACTIVE yet (never actually visited
  // before) used to fall back to a gap of Infinity - which fed literally
  // "Infinity days" into the away-greeting prompt. There's nothing to
  // return FROM on a first-ever visit (the intro bubble already covers
  // that), so this just skips the greeting entirely and seeds the
  // timestamp for next time instead.
  if (lastActiveRaw) {
    const gap = now - parseInt(lastActiveRaw, 10);
    // Deliberately NOT gated on isDead(): the away-time tracking itself must
    // keep running (and LAST_ACTIVE must keep refreshing) every single day,
    // forever, regardless of her current state. We just skip the AI-generated
    // greeting while she's dead, since chat is disabled until she's revived.
    if (gap > AWAY_GAP_MS && !isDead()) {
      if (connected) {
        generateReturnGreeting(gap);
      } else {
        pendingReturnGaps[activeCharacterId] = gap; // fire this once the person reconnects
      }
    }
  }

  localStorage.setItem(LS.LAST_ACTIVE, String(now));
  localStorage.removeItem(LS.HIDDEN_AT); // stale value safety cleanup
}

// ---- 7. SIMULATED BACKGROUND ATTENTION-SEEKING --------------------------
// Tracks how long the phone was locked / tab was hidden using the Page
// Visibility API, and greets the user the instant they come back if the
// absence was long enough to matter (but short of a full "away" greeting
// window, which is handled separately at boot by checkReturnAndGreet).
document.addEventListener("visibilitychange", () => {
  const now = Date.now();
  if (document.visibilityState === "hidden") {
    localStorage.setItem(LS.HIDDEN_AT, String(now));
  } else if (document.visibilityState === "visible") {
    const hiddenAtRaw = localStorage.getItem(LS.HIDDEN_AT);
    if (hiddenAtRaw && !isBothMode()) {
      const gap = now - parseInt(hiddenAtRaw, 10);
      if (checkForDeath()) {
        addMsg(`💔 It's been far too long since ${getCharacter().name} was fed... she's gone still and quiet. She'll need to be revived to wake up again.`, "system-msg");
      } else if (gap > AWAY_GAP_MS && !isDead()) {
        if (connected) {
          generateReturnGreeting(gap);
        } else {
          pendingReturnGaps[activeCharacterId] = gap;
        }
      }
      localStorage.removeItem(LS.HIDDEN_AT);
    }
    // Always refreshed, dead or alive, so the away-time clock never silently
    // stalls - this is what makes the check keep working every single day.
    localStorage.setItem(LS.LAST_ACTIVE, String(now));
  }
});

// Also catch death while the app stays open in the foreground the whole
// time (no backgrounding to trigger the check above).
setInterval(() => {
  if (isBothMode()) return; // no single-character death timer while in the shared room
  if (checkForDeath()) {
    addMsg(`💔 It's been far too long since ${getCharacter().name} was fed... she's gone still and quiet. She'll need to be revived to wake up again.`, "system-msg");
  }
}, 5 * 60 * 1000);

// Also stamp "last active" right before the page unloads/closes, so a full
// close-and-reopen (not just backgrounding) is measured accurately too.
window.addEventListener("pagehide", () => {
  localStorage.setItem(LS.LAST_ACTIVE, String(Date.now()));
});

// ---- 8. HUNGER METER + DRAG-AND-DROP FEEDING ----------------------------
// Hunger climbs the longer Roundbina is left alone (measured off the last
// feeding timestamp, persisted in localStorage so it survives closing the
// app). Dragging a food emoji onto her portrait feeds her: sparkle effect,
// a cute chat message, and the hunger timer resets to zero.
function getHungerLevel() {
  const now = Date.now();
  const lastFedRaw = localStorage.getItem(LS.LAST_FED);
  const lastFed = lastFedRaw ? parseInt(lastFedRaw, 10) : now;
  const elapsedMinutes = (now - lastFed) / (60 * 1000);
  const hunger = Math.min(HUNGER_MAX, Math.floor(elapsedMinutes / (HUNGER_RATE_MS / 60000)));
  localStorage.setItem(LS.HUNGER, String(hunger));
  return hunger;
}

function feedRoundbina(emoji, foodName) {
  if (isDead()) {
    addMsg("*food won't wake her now...* She needs to be revived first - open ⚙️ settings.", "system-msg");
    return;
  }
  localStorage.setItem(LS.LAST_FED, String(Date.now()));
  localStorage.setItem(LS.HUNGER, "0");
  spawnSparkle(portrait);

  if (!connected) {
    addMsg(`*munch munch* Mmm, ${foodName}! Thank you~ ${emoji}`, "bot");
    return;
  }

  // AI-generated reaction instead of a hardcoded line, fed through the same
  // getAIResponse() path used for normal chat, so it becomes a proper part
  // of the conversation history (this is also what fixes the glitching that
  // used to happen right after feeding - see rollbackDanglingUserTurn above).
  performAction(
    `${emoji} You gave ${getCharacter().name} some ${foodName}!`,
    `*You hold out a ${foodName} ${emoji} for ${getCharacter().name} to eat*`
  );
}

// ---- 9. DEATH & REVIVAL ---------------------------------------------------
// If she genuinely goes unfed for too long in the real world (tracked off
// the same LS.LAST_FED timestamp the hunger meter already uses), she dies.
// Getting her back isn't a single click - it takes the little ritual in
// confirmRevive() below, not just tossing her a tomato.
const reviveBtn = document.getElementById("reviveBtn");
const reviveBackdrop = document.getElementById("reviveBackdrop");
const reviveModal = document.getElementById("reviveModal");
const reviveTextarea = document.getElementById("reviveTextarea");
const deceasedMarker = document.getElementById("deceasedMarker");
const showerBtn = document.getElementById("showerBtn");

function isDead() {
  return localStorage.getItem(LS.IS_DEAD) === "true";
}

function applyDeadUI(dead) {
  portrait.classList.toggle("deceased", dead);
  deceasedMarker.style.display = dead ? "block" : "none";
  chatInput.disabled = dead;
  chatSendBtn.disabled = dead;
  if (showerBtn) showerBtn.disabled = dead;
  if (killBtn) killBtn.disabled = dead;
  chatInput.placeholder = dead ? "she's not responding..." : "";
}

function markDead() {
  localStorage.setItem(LS.IS_DEAD, "true");
  localStorage.setItem(LS.DIED_AT, String(Date.now()));
  characterStatus.hunger = 0;
  characterStatus.affection = clamp0to100(Math.min(characterStatus.affection, 25));
  characterStatus.mood = "gone";
  saveCharacterStatus();
  renderStatusBars();
  applyDeadUI(true);
}

// Checked at boot, on returning to the tab, and on an interval while the
// app stays open. Returns true only the moment death is first detected, so
// callers can post a one-time announcement instead of repeating it forever.
function checkForDeath() {
  if (isDead()) return false;
  const lastFedRaw = localStorage.getItem(LS.LAST_FED);
  const lastFed = lastFedRaw ? parseInt(lastFedRaw, 10) : Date.now();
  if (Date.now() - lastFed > DEATH_GAP_MS) {
    markDead();
    return true;
  }
  return false;
}

function openReviveFlow() {
  toggleSettingsDrawer(false);
  if (!isDead()) {
    addMsg("*stretches happily* No need for that - I'm right here~ 🍅", "bot");
    return;
  }
  reviveTextarea.value = "";
  toggleReviveModal(true);
}

function toggleReviveModal(forceState) {
  const shouldOpen = typeof forceState === "boolean" ? forceState : !reviveModal.classList.contains("open");
  reviveModal.classList.toggle("open", shouldOpen);
  reviveBackdrop.classList.toggle("open", shouldOpen);
  if (shouldOpen) reviveTextarea.focus();
}

async function confirmRevive() {
  const whisper = reviveTextarea.value.trim();
  if (!whisper) {
    reviveTextarea.placeholder = "You have to actually say something to her...";
    reviveTextarea.focus();
    return;
  }

  toggleReviveModal(false);

  localStorage.setItem(LS.IS_DEAD, "false");
  localStorage.removeItem(LS.DIED_AT);
  localStorage.setItem(LS.LAST_FED, String(Date.now())); // restart the clock so she isn't instantly re-flagged

  // She comes back weak, not instantly back to full - a real recovery, not
  // a reset button.
  characterStatus.hunger = 25;
  characterStatus.cleanliness = clamp0to100(Math.min(characterStatus.cleanliness, 40));
  characterStatus.affection = clamp0to100(Math.max(characterStatus.affection, 40));
  characterStatus.mood = "dazed";
  saveCharacterStatus();
  renderStatusBars();
  applyDeadUI(false);

  if (!connected) {
    addMsg(`*A long silence... then, faintly* "${whisper}"... *she stirs weakly, eyes fluttering open* ...you came back.`, "bot");
    return;
  }

  chatInput.disabled = true;
  chatSendBtn.disabled = true;
  showTyping();
  setAwake(true);

  const botReply = await getAIResponse(
    `*After a long, worrying silence, you lean in close and whisper to ${getCharacter().name}: "${whisper}" ` +
    `Slowly, gently, she begins to stir back to life.* React in character to waking back up - ` +
    `weak and groggy at first, but deeply moved by what was just said to you.`
  );
  hideTyping();
  if (botReply.ok) {
    addMsg(botReply.text, "bot", { apiIndex: chatHistory.length - 1 });
  } else {
    // She's already marked alive again either way (the stat changes above
    // already happened) - just no AI-narrated wake-up line this time.
    showErrorToast(botReply.error);
  }
  setAwake(false);

  chatInput.disabled = false;
  chatSendBtn.disabled = false;
}

// ---- 9b. KILL (testing feature for the revive flow) -----------------------
// Lets someone type a stated cause and hand it to the model, which judges
// in character whether it's actually serious/legitimate enough to end her -
// see KILL_INSTRUCTION above for the full protocol. If she doesn't deem it
// right, she defends herself instead (triggerSamuraiDefense) rather than
// dying; nothing here forces an outcome, that's entirely her call via the
// hidden {{KILL result=...}} tag she sends back.
const killBtn = document.getElementById("killBtn");
const killBackdrop = document.getElementById("killBackdrop");
const killModal = document.getElementById("killModal");
const killTextarea = document.getElementById("killTextarea");
const confirmKillBtn = document.getElementById("confirmKillBtn");

function openKillFlow() {
  toggleSettingsDrawer(false);
  if (isDead()) {
    addMsg("*...she's already gone still and quiet.* There's nothing left to end - open ⚙️ settings to revive her instead.", "system-msg");
    return;
  }
  killTextarea.value = "";
  toggleKillModal(true);
}

function toggleKillModal(forceState) {
  const shouldOpen = typeof forceState === "boolean" ? forceState : !killModal.classList.contains("open");
  killModal.classList.toggle("open", shouldOpen);
  killBackdrop.classList.toggle("open", shouldOpen);
  if (shouldOpen) killTextarea.focus();
}

function triggerSamuraiDefense() {
  if (!portrait) return;

  spawnSparkle(portrait, ["⚔️", "🗡️", "💢"]);
  portrait.classList.add("samurai-mode");
  setTimeout(() => portrait.classList.remove("samurai-mode"), 2600);
}

  // ---- Scenarios --------------------------------------------------------
  // Saved scenario prompts, applied to whichever chat is currently open
  // (Roundbina, Roundrone, or Roundboth) - a lightweight way to jump into
  // a new setting without typing it out fresh every time.
  const SCENARIOS_KEY = "roundbina_scenarios";
  const scenariosBackdrop = document.getElementById("scenariosBackdrop");
  const scenariosModal = document.getElementById("scenariosModal");
  const scenarioEmojiInput = document.getElementById("scenarioEmojiInput");
  const scenarioTextInput = document.getElementById("scenarioTextInput");
  const generateScenarioBtn = document.getElementById("generateScenarioBtn");

  function loadScenarios() {
    try { return JSON.parse(localStorage.getItem(SCENARIOS_KEY) || "[]"); }
    catch (e) { return []; }
  }
  function saveScenarios(list) {
    localStorage.setItem(SCENARIOS_KEY, JSON.stringify(list));
  }

  function renderScenariosList() {
    const container = document.getElementById("scenariosList");
    if (!container) return;
    const list = loadScenarios();
    container.innerHTML = "";
    if (!list.length) {
      container.innerHTML = '<div class="historyMeta">No scenarios saved yet - describe one below, or let her generate an idea.</div>';
      return;
    }
    list.forEach((s) => {
      const row = document.createElement("div");
      row.className = "scenarioRow";

      const info = document.createElement("div");
      info.className = "scenarioInfo";
      const emojiSpan = document.createElement("span");
      emojiSpan.className = "scenarioEmoji";
      emojiSpan.textContent = s.emoji;
      const textSpan = document.createElement("span");
      textSpan.className = "scenarioText";
      textSpan.textContent = s.text; // textContent, not innerHTML - never render saved text as markup
      info.appendChild(emojiSpan);
      info.appendChild(textSpan);

      const actions = document.createElement("div");
      actions.className = "scenarioActions";
      const applyBtn = document.createElement("button");
      applyBtn.type = "button";
      applyBtn.className = "iconBtn";
      applyBtn.textContent = "▶️ apply";
      applyBtn.addEventListener("click", () => applyScenario(s));
      const delBtn = document.createElement("button");
      delBtn.type = "button";
      delBtn.className = "iconBtn";
      delBtn.textContent = "🗑️";
      delBtn.setAttribute("aria-label", "Delete scenario");
      delBtn.addEventListener("click", () => deleteScenario(s.id));
      actions.appendChild(applyBtn);
      actions.appendChild(delBtn);

      row.appendChild(info);
      row.appendChild(actions);
      container.appendChild(row);
    });
  }

  window.addScenario = function addScenario() {
    const emoji = (scenarioEmojiInput.value || "").trim() || "🎭";
    const text = (scenarioTextInput.value || "").trim();
    if (!text) { scenarioTextInput.focus(); return; }
    const list = loadScenarios();
    list.unshift({ id: Date.now(), emoji, text });
    saveScenarios(list);
    scenarioEmojiInput.value = "";
    scenarioTextInput.value = "";
    renderScenariosList();
  };

  window.deleteScenario = function deleteScenario(id) {
    if (!confirm("Delete this scenario?")) return;
    saveScenarios(loadScenarios().filter((s) => s.id !== id));
    renderScenariosList();
  };

  // Asks the model for a one-line scenario idea (emoji + short
  // description), then drops it straight into the add-scenario fields for
  // review/editing rather than auto-saving something unreviewed.
  window.generateScenarioIdea = async function generateScenarioIdea() {
    if (!connected) { showErrorToast("Connect an API key first so she can dream one up."); return; }
    generateScenarioBtn.disabled = true;
    generateScenarioBtn.textContent = "✨ thinking...";

    const messages = [
      { role: "system", content: "You invent short, evocative roleplay scenario prompts for a cute companion chat app. Reply with EXACTLY one line, formatted as: EMOJI | short description (under 20 words). Pick one single fitting emoji. No extra text, no quotes, no markdown." },
      { role: "user", content: "Give me one new scenario idea." }
    ];
    const result = await callCharacterCompletion(messages);

    generateScenarioBtn.disabled = false;
    generateScenarioBtn.textContent = "✨ generate with AI";

    if (!result.ok) { showErrorToast(result.text.replace(/^⚠️\s*/, "")); return; }

    const raw = result.raw.trim();
    const sepIdx = raw.indexOf("|");
    let emoji = "🎭", desc = raw;
    if (sepIdx > -1) {
      emoji = raw.slice(0, sepIdx).trim() || "🎭";
      desc = raw.slice(sepIdx + 1).trim();
    }
    scenarioEmojiInput.value = emoji;
    scenarioTextInput.value = desc;
  };

  // Applies a scenario to whichever chat is currently open - solo Roundbina,
  // solo Roundrone, or both at once - by seeding it as a scene-change note
  // and letting the model react in character to it starting now.
  window.applyScenario = async function applyScenario(scenario) {
    toggleScenariosModal(false);
    const label = `${scenario.emoji} ${scenario.text}`;

    if (isBothMode()) {
      addBothMsg("user", `[🎭 New scenario begins: ${label}]`);
      if (!apiKey) {
        addMsg("Set up your API key in ⚙️ settings first so they can actually react to this.", "system-msg", { persist: false });
        return;
      }
      chatInput.disabled = true;
      chatSendBtn.disabled = true;
      setBothControlsDisabled(true);
      const binaOk = await bothCharacterTurn("bina");
      if (binaOk) await bothCharacterTurn("rone");
      setBothControlsDisabled(false);
      chatInput.disabled = false;
      chatSendBtn.disabled = false;
      return;
    }

    if (isDead()) {
      addMsg(`🎭 Scenario ready for when she's revived: ${label}`, "system-msg");
      return;
    }

    performAction(
      `🎭 New scenario: ${label}`,
      `[SCENE CHANGE] A new scenario begins: "${label}". Shift into this new setting/context right away and react in character to it starting now, as if it's genuinely happening.`
    );
  };

  window.toggleScenariosModal = function toggleScenariosModal(forceState) {
    const shouldOpen = typeof forceState === "boolean" ? forceState : !scenariosModal.classList.contains("open");
    if (shouldOpen) {
      toggleSettingsDrawer(false);
      renderScenariosList();
    }
    scenariosModal.classList.toggle("open", shouldOpen);
    scenariosBackdrop.classList.toggle("open", shouldOpen);
  };

  // ---- Backup / restore save data ----------------------------------------
  // Everything (chat history, stats, affection, a remembered key) lives
  // only in this browser's storage - clearing site data, switching phones,
  // or a bad browser update loses it all with no way back. This grabs
  // every roundbina_* key currently in localStorage into one JSON file,
  // and can load that same file back in later.
  window.exportSaveData = function exportSaveData() {
    const data = {};
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith("roundbina_")) {
        data[key] = localStorage.getItem(key);
      }
    }
    const payload = { app: "roundbina", exportedAt: new Date().toISOString(), data };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const stamp = new Date().toISOString().slice(0, 10);
    a.href = url;
    a.download = `roundbina-backup-${stamp}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  window.triggerImportSaveData = function triggerImportSaveData() {
    const input = document.getElementById("importFileInput");
    if (input) input.click();
  };

  window.importSaveData = function importSaveData(fileInputEl) {
    const file = fileInputEl.files && fileInputEl.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(reader.result);
        const data = parsed && parsed.data && typeof parsed.data === "object" ? parsed.data : parsed;
        if (!data || typeof data !== "object") throw new Error("that file doesn't look like a Roundbina backup.");
        const entries = Object.entries(data).filter(([key, value]) => key.startsWith("roundbina_") && typeof value === "string");
        if (!entries.length) throw new Error("no recognizable Roundbina data found in that file.");
        if (!confirm(`Restore ${entries.length} saved item(s)? This will overwrite what's currently here.`)) return;
        entries.forEach(([key, value]) => localStorage.setItem(key, value));
        location.reload();
      } catch (err) {
        showErrorToast(`Couldn't restore that file: ${err.message}`);
      } finally {
        fileInputEl.value = ""; // allow re-selecting the same filename later
      }
    };
    reader.onerror = () => showErrorToast("Couldn't read that file.");
    reader.readAsText(file);
  };


async function confirmKill() {
  const cause = killTextarea.value.trim();
  if (!cause) {
    killTextarea.placeholder = "You have to actually give her a reason...";
    killTextarea.focus();
    return;
  }
  if (isDead()) {
    toggleKillModal(false);
    addMsg("*...she's already gone still and quiet.* There's nothing left to end - open ⚙️ settings to revive her instead.", "system-msg");
    return;
  }

  toggleKillModal(false);
  addMsg(`💀 [Testing] Cause presented: "${cause}"`, "system-msg");

  if (!connected) {
    addMsg("*without her brain connected, she can't actually judge this* — connect an API key in ⚙️ settings first, then try again.", "system-msg");
    return;
  }

  confirmKillBtn.disabled = true;
  chatInput.disabled = true;
  chatSendBtn.disabled = true;
  showTyping();
  setAwake(true);

  // A real 10% chance to survive, decided right here in code rather than
  // left to the model's judgment of whether the stated cause "counts" -
  // death is genuinely the default outcome now (90%), not something
  // arguable away with a sufficiently clever excuse.
  const survived = Math.random() < 0.10;
  const outcome = survived ? "DEFENDED" : "DIED";

  const actionPrompt = `[TESTING: KILL ATTEMPT] The person is testing the death/revival system. ` +
    `They state this as the cause for ending you: "${cause}". The outcome has already been decided: ` +
    `${outcome}. Narrate it faithfully in character per your instructions for this situation, including ` +
    `the hidden verdict tag echoing ${outcome}.`;

  needsKillInstructionThisTurn = true;
  const botReply = await getAIResponse(actionPrompt);
  needsKillInstructionThisTurn = false;
  hideTyping();

  if (!botReply.ok) {
    showErrorToast(botReply.error);
    setAwake(false);
    confirmKillBtn.disabled = false;
    chatInput.disabled = false;
    chatSendBtn.disabled = false;
    return;
  }

  const { text: cleanedReply } = parseAndApplyKillTag(botReply.text);
  addMsg(cleanedReply || botReply.text, "bot", { apiIndex: chatHistory.length - 1 });

  // Apply the outcome that was actually rolled above, not whatever tag
  // came back - the dice roll is the real source of truth here, the tag is
  // only there to keep her own narration consistent with it.
  if (outcome === "DIED") {
    markDead();
  } else {
    triggerSamuraiDefense();
  }

  setAwake(false);
  confirmKillBtn.disabled = false;
  chatInput.disabled = false;
  chatSendBtn.disabled = false;
}

function spawnSparkle(targetEl, customGlyphs) {
  const rect = targetEl.getBoundingClientRect();
  const glyphs = customGlyphs || ["✨", "💫", "⭐"];
  for (let i = 0; i < 6; i++) {
    const s = document.createElement("div");
    s.className = "sparkle";
    s.textContent = glyphs[Math.floor(Math.random() * glyphs.length)];
    s.style.left = (rect.left + rect.width / 2 + (Math.random() * 60 - 30)) + "px";
    s.style.top = (rect.top + rect.height / 2 + (Math.random() * 30 - 15)) + "px";
    document.body.appendChild(s);
    setTimeout(() => s.remove(), 900);
  }
}

let foodTrayEl = null;

function initFoodTray() {
  const style = document.createElement("style");
  style.textContent = `
    #foodTrayToggle {
      position: relative;
      width: 34px; height: 34px; border-radius: 50%;
      background: var(--accent); display: flex; align-items: center; justify-content: center;
      font-size: 16px; box-shadow: 0 2px 8px rgba(0,0,0,0.3); cursor: pointer;
      transition: transform .15s ease, background var(--theme-speed) ease; border: none;
    }
    #foodTrayToggle:active { transform: scale(0.9); }
    .foodCountBadge {
      position: absolute; top: -4px; right: -4px;
      min-width: 18px; height: 18px; padding: 0 4px; border-radius: 9px;
      background: #6b3f7a; color: #ffe8f2; font-size: 11px; font-weight: 700;
      display: flex; align-items: center; justify-content: center;
      box-shadow: 0 0 0 2px var(--bg-bottom);
    }
    #foodTray {
      position: absolute; top: calc(env(safe-area-inset-top) + 50px); right: 10px;
      width: 172px; max-height: min(50vh, 400px);
      display: flex; flex-direction: column;
      background: rgba(36,26,41,0.95); border: 1px solid #4a3653;
      border-radius: 18px; box-shadow: 0 8px 24px rgba(0,0,0,0.45);
      transform: translateY(-14px) scale(0.92); transform-origin: top right;
      opacity: 0; transition: transform .25s ease, opacity .25s ease;
      z-index: 59; overflow: hidden; pointer-events: none;
    }
    #foodTray.open { transform: translateY(0) scale(1); opacity: 1; pointer-events: auto; }
    .foodTrayHeader {
      flex-shrink: 0; display: flex; align-items: center; justify-content: space-between;
      padding: 8px 6px 6px 12px; border-bottom: 1px solid #4a3653;
    }
    .foodTrayTitle { font-size: 12px; color: var(--accent-light); font-weight: 600; }
    .foodTrayClose {
      width: 22px; height: 22px; border-radius: 50%; border: none;
      background: transparent; color: var(--muted); font-size: 16px; line-height: 1;
      cursor: pointer; display: flex; align-items: center; justify-content: center;
    }
    .foodTrayClose:active { background: rgba(255,255,255,0.1); }
    .foodTrayGrid {
      display: grid; grid-template-columns: repeat(2, 1fr); gap: 8px;
      padding: 10px; overflow-y: auto; -webkit-overflow-scrolling: touch;
    }
    .foodItem {
      width: 100%; aspect-ratio: 1 / 1; border-radius: 14px;
      background: #241a29; border: 1px solid #4a3653;
      display: flex; align-items: center; justify-content: center;
      font-size: 24px; touch-action: none; cursor: grab;
      box-shadow: 0 2px 8px rgba(0,0,0,0.3); user-select: none;
      overflow: hidden;
    }
    .foodItem img {
      width: 82%; height: 82%; object-fit: contain;
      pointer-events: none; -webkit-user-drag: none;
    }
    .foodItem.dragging {
      position: fixed; z-index: 999; pointer-events: none;
      width: 50px; height: 50px; border-radius: 14px;
      transform: scale(1.3); transition: none;
    }
    .sparkle {
      position: fixed; font-size: 20px; pointer-events: none; z-index: 998;
      animation: sparkleFloat .9s ease-out forwards;
    }
    @keyframes sparkleFloat {
      0%   { opacity: 1; transform: translateY(0) scale(0.6); }
      100% { opacity: 0; transform: translateY(-40px) scale(1.4); }
    }
  `;
  document.head.appendChild(style);

  const toggleBtn = document.createElement("button");
  toggleBtn.id = "foodTrayToggle";
  toggleBtn.type = "button";
  toggleBtn.setAttribute("aria-label", "Open food tray");
  toggleBtn.title = `Feed ${getCharacter().name}`;
  toggleBtn.textContent = "🍽️";
  const cornerControlsEl = document.getElementById("cornerControls");
  if (cornerControlsEl) cornerControlsEl.appendChild(toggleBtn);
  else document.body.appendChild(toggleBtn);

  const tray = document.createElement("div");
  tray.id = "foodTray";
  tray.innerHTML = `
    <div class="foodTrayHeader">
      <span class="foodTrayTitle">Feed ${getCharacter().name}</span>
      <button type="button" class="foodTrayClose" aria-label="Close food tray">×</button>
    </div>
    <div class="foodTrayGrid">
    <div class="foodItem" data-food="Dango" data-emoji="🍡"><img data-src="assets/img14.png" alt="Dango skewer" draggable="false"></div>
    <div class="foodItem" data-food="Mochi Ring" data-emoji="🍡"><img data-src="assets/img15.png" alt="Mochi ring" draggable="false"></div>
    <div class="foodItem" data-food="Ramen" data-emoji="🍜"><img data-src="assets/img16.png" alt="Bowl of ramen" draggable="false"></div>
    <div class="foodItem" data-food="Blueberry Tart" data-emoji="🥧"><img data-src="assets/img17.png" alt="Blueberry tart" draggable="false"></div>
    <div class="foodItem" data-food="Compass Tea Cake" data-emoji="🍰" title="Compass Tea Cake"><img data-src="assets/img18.png" alt="Compass tea cake" draggable="false"></div>
    <div class="foodItem" data-food="Golden Roc Roll" data-emoji="🥐" title="Golden Roc Roll"><img data-src="assets/img19.png" alt="Golden roc bread roll" draggable="false"></div>
    <div class="foodItem" data-food="Berry Sandwich Cake" data-emoji="🍰" title="Berry Sandwich Cake"><img data-src="assets/img20.png" alt="Berry sandwich cake slice" draggable="false"></div>
    <div class="foodItem" data-food="Nocturne Cake" data-emoji="🍫" title="Nocturne Cake"><img data-src="assets/img21.png" alt="Chocolate nocturne cake" draggable="false"></div>
    <div class="foodItem" data-food="Ox Banner Cake" data-emoji="🐂" title="Ox Banner Cake"><img data-src="assets/img22.png" alt="Ox banner cake" draggable="false"></div>
    <div class="foodItem" data-food="Wingberry Trifle" data-emoji="🍨" title="Wingberry Trifle"><img data-src="assets/img23.png" alt="Wingberry trifle" draggable="false"></div>
    <div class="foodItem" data-food="Quillroast Hen" data-emoji="🍗" title="Quillroast Hen"><img data-src="assets/img24.png" alt="Quill roast hen" draggable="false"></div>
    <div class="foodItem" data-food="Dim Sum Basket" data-emoji="🥟" title="Dim Sum Basket"><img data-src="assets/img25.png" alt="Dim sum basket" draggable="false"></div>
    <div class="foodItem" data-food="Crystal Peach Plate" data-emoji="🍑" title="Crystal Peach Plate"><img data-src="assets/img26.png" alt="Crystal peach plate" draggable="false"></div>
    <div class="foodItem" data-food="Winged Pancake Stack" data-emoji="🥞" title="Winged Pancake Stack"><img data-src="assets/img27.png" alt="Winged pancake stack" draggable="false"></div>
    <div class="foodItem" data-food="Filigree Tea Cake" data-emoji="🍰" title="Filigree Tea Cake"><img data-src="assets/img28.png" alt="Filigree tea cake" draggable="false"></div>
    <div class="foodItem" data-food="Swan Bakery Basket" data-emoji="🥐" title="Swan Bakery Basket"><img data-src="assets/img29.png" alt="Swan bakery basket" draggable="false"></div>
    </div>
  `;
  const appEl = document.querySelector(".app");
  if (appEl) appEl.appendChild(tray); else document.body.appendChild(tray);
  foodTrayEl = tray;

  const closeBtn = tray.querySelector(".foodTrayClose");
  if (closeBtn) closeBtn.addEventListener("click", () => tray.classList.remove("open"));

  // PERF: the 16 food images were previously decoded at boot even though
  // this tray is hidden until tapped open - that's ~4.5MB of image data
  // for something most opens of the app never touch. Now they carry
  // data-src instead of src, and get hydrated (decoded) once, the first
  // time the tray actually opens.
  let foodImagesHydrated = false;
  function hydrateFoodImages() {
    if (foodImagesHydrated) return;
    foodImagesHydrated = true;
    tray.querySelectorAll("img[data-src]").forEach(img => {
      img.src = img.dataset.src;
      img.removeAttribute("data-src");
    });
  }

  toggleBtn.addEventListener("click", () => {
    const willOpen = !tray.classList.contains("open");
    if (willOpen) hydrateFoodImages();
    tray.classList.toggle("open");
  });
  tray.querySelectorAll(".foodItem").forEach(setupDraggableFood);

  // Little badge on the tray toggle showing how many dishes are on offer,
  // so it's obvious at a glance that Roundbina's menu has grown.
  const foodCount = tray.querySelectorAll(".foodItem").length;
  if (foodCount > 0) {
    const badge = document.createElement("span");
    badge.className = "foodCountBadge";
    badge.textContent = String(foodCount);
    toggleBtn.appendChild(badge);
  }
}

// Pointer Events unify mouse + touch, so this works the same whether the
// person is dragging with a finger on a phone or a mouse on desktop.
function setupDraggableFood(foodEl) {
  foodEl.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    foodEl.setPointerCapture(e.pointerId);

    const ghost = foodEl.cloneNode(true);
    ghost.classList.add("dragging");
    document.body.appendChild(ghost);
    positionGhost(ghost, e.clientX, e.clientY);

    const onMove = (ev) => positionGhost(ghost, ev.clientX, ev.clientY);

    const onUp = (ev) => {
      foodEl.releasePointerCapture(e.pointerId);
      foodEl.removeEventListener("pointermove", onMove);
      foodEl.removeEventListener("pointerup", onUp);
      foodEl.removeEventListener("pointercancel", onUp);

      const dropTarget = document.elementFromPoint(ev.clientX, ev.clientY);
      const droppedOnAvatar = !!(dropTarget && dropTarget.closest("#portrait"));

      if (droppedOnAvatar) {
        feedRoundbina(foodEl.dataset.emoji, foodEl.dataset.food);
        if (foodTrayEl) foodTrayEl.classList.remove("open");
      }
      ghost.remove();
    };

    foodEl.addEventListener("pointermove", onMove);
    foodEl.addEventListener("pointerup", onUp);
    foodEl.addEventListener("pointercancel", onUp);
  });
}

function positionGhost(el, x, y) {
  el.style.left = (x - 25) + "px";
  el.style.top = (y - 25) + "px";
}

// ---- PWA: basic service worker registration -----------------------------
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch((err) => {
      console.warn("Roundbina: service worker registration failed", err);
    });
  });
}

// ---- 9. Boot sequence ----------------------------------------------------
(function boot() {
  // If a key was remembered on this device, skip straight to the chat
  // instead of asking the person to paste it in again every single time.
  if (apiKey) {
    connected = true;
    setupPanel.style.display = "none";
    chatBar.style.display = "flex";
    resetBtn.style.display = "inline";
    if (rememberKeyCheckbox) rememberKeyCheckbox.checked = true;
  }
  refreshKeyStatusUI();

  if (!localStorage.getItem(LS.LAST_FED)) {
    localStorage.setItem(LS.LAST_FED, String(Date.now())); // start full, not starving
  }
  const hadHistory = restoreChatLog(); // 1. bring back yesterday's conversation, if any

  const wasAlreadyDead = isDead();
  const justDied = checkForDeath();
  applyDeadUI(isDead());

  if (isDead()) {
    if (justDied) {
      addMsg(`💔 It's been far too long since ${getCharacter().name} was fed... she's gone still and quiet. She'll need to be revived to wake up again.`, "system-msg");
    } else if (wasAlreadyDead) {
      addMsg("💔 She's still lying quiet, unrevived. Open ⚙️ settings when you're ready to bring her back.", "system-msg");
    }
  }

  // This used to be an "else if" after the isDead() block above, which meant
  // that once she'd been dead even once, LAST_ACTIVE stopped refreshing and
  // the away-time check went silent for good (the reported bug). It now
  // always runs whenever there's history, dead or alive, so the "how long
  // was I gone" tracking never stalls - checkReturnAndGreet() itself already
  // skips the AI greeting (but still updates LAST_ACTIVE) while she's dead.
  if (hadHistory) {
    // Only greet returning visitors who already have a conversation - not on
    // the very first-ever load, where the hardcoded intro bubble is enough
    // and an instant "good morning!"/"I missed you!" out of nowhere is odd.
    checkReturnAndGreet();  // 6. AI reacts in character to real elapsed time away
  } else {
    localStorage.setItem(LS.LAST_ACTIVE, String(Date.now()));
  }

  getHungerLevel();       // 8. recompute hunger so it's accurate on open
  initFoodTray();         // 8. mount the feeding tray + drag handlers
  renderStatusBars();     // AI-narrated hunger/cleanliness bars beside the sprite (also repaints portrait art)
  checkAndUpdateStreak(); // app-wide daily streak, independent of either character
  renderStreakBadges();
  renderThemeSwatches();  // paint the theme picker + apply any saved manual theme
  if (getUserTheme() !== "auto") applyThemeVars(THEME_PRESETS[getUserTheme()] || THEME_PRESETS.classic);

  // Everything above already resolves through the per-character LS proxy,
  // so it's correct even if the person's last-active companion (persisted
  // separately, read at the very top of the script) wasn't Bina. What's
  // still baked into the static HTML as Bina's defaults - the drawer
  // title, the chat placeholder, the prompt-field placeholder, the intro
  // bubble if there's genuinely no history yet, and which tab looks
  // active - gets synced here so a returning Rone conversation opens
  // looking like Rone's, not a flash of Bina's chrome first.
  const activeChar = getCharacter();
  renderCharacterSwitcher();
  syncCharacterHeader(activeChar);
  const drawerTitleEl = document.querySelector(".drawerHeader h2");
  if (drawerTitleEl) drawerTitleEl.textContent = `Settings — ${activeChar.name}`;
  if (systemPromptInput) systemPromptInput.placeholder = `Describe how ${activeChar.name} should behave...`;
  if (!isDead()) chatInput.placeholder = activeChar.placeholderInput;
  if (!hadHistory) chatContainer.innerHTML = `<div class="msg bot">${introBubbleFor(activeChar)}</div>`;

  // Google Fonts (Quicksand/Nunito) can finish downloading a moment after
  // this initial render, and swapping from the fallback font to the real
  // one reflows text height across every bubble in a long chat log -
  // shifting scrollHeight out from under whatever scroll position was set
  // above. Re-snapping once the fonts actually settle (or after a short
  // fallback delay on browsers without the Font Loading API) keeps a
  // restored chat pinned to the bottom instead of drifting mid-scroll.
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(() => scrollChatToBottom());
  } else {
    setTimeout(scrollChatToBottom, 400);
  }
})();
