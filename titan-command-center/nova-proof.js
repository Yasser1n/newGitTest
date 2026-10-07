/**
 * nova-proof.js — TITAN's "proof rule".
 *
 * TITAN may say a change happened ("Done", "Deleted…", "تم", "حذفت", "ألغيت"…)
 * ONLY when the app confirmed that change in the same turn. Otherwise the reply
 * must say "Nothing was changed" and why. This module provides:
 *
 *   normalizeArabic(text)     Arabic spelling normalization used by all Arabic matching
 *   detectClaim(reply)        does a reply claim that a change was made?
 *   detectIntent(userText)    does the user ask TITAN to change something?
 *   enforce(reply, turn)      replace an unproven claim with an honest notice
 *   DID_CLAIM_AR, SAVE_INTENT_AR, mergeRegex
 *                             raw Arabic patterns for voice-agent.html's regexes
 *
 * Loads as a classic <script> (sets window.NovaProof) or via require() in Node.
 * No dependencies, no build step, ES2020 (uses regex lookbehind and \p{…}).
 */
(function (factory) {
  "use strict";
  const NovaProof = factory();
  if (typeof module === "object" && module !== null && module.exports) {
    module.exports = NovaProof;
  }
  if (typeof window !== "undefined") {
    window.NovaProof = NovaProof;
  }
})(function () {
  "use strict";

  // ---------------------------------------------------------------------------
  // Arabic normalization
  // ---------------------------------------------------------------------------

  const DIACRITICS_RE = /[ً-ٰٟـ]/g; // tashkeel, superscript alef, tatweel
  const LETTER_VARIANTS_RE = /[آأإٱىؤئ]/g;
  const LETTER_VARIANTS = {
    آ: "ا", // آ → ا
    أ: "ا", // أ → ا
    إ: "ا", // إ → ا
    ٱ: "ا", // ٱ → ا
    ى: "ي", // ى → ي
    ؤ: "و", // ؤ → و
    ئ: "ي", // ئ → ي
  };

  /**
   * Normalize Arabic spelling so one pattern matches every common way of
   * writing a word: removes tashkeel (U+064B–U+065F), superscript alef (U+0670)
   * and tatweel (U+0640); maps أ إ آ ٱ → ا, ى → ي, ؤ → و, ئ → ي.
   * Everything else (English, digits, punctuation) is returned unchanged.
   *
   * @example normalizeArabic("عدّلت") === "عدلت"; normalizeArabic("ألغيت") === "الغيت"
   * @param {*} text Any value; null/undefined become "".
   * @returns {string} The normalized text.
   */
  function normalizeArabic(text) {
    if (text === null || text === undefined) return "";
    return String(text)
      .replace(DIACRITICS_RE, "")
      .replace(LETTER_VARIANTS_RE, (letter) => LETTER_VARIANTS[letter]);
  }

  // ---------------------------------------------------------------------------
  // Pattern building blocks
  // ---------------------------------------------------------------------------

  // \b only knows ASCII, so Arabic word edges use Unicode letter lookarounds.
  const WORD_CHAR = String.raw`[\p{L}\p{M}\p{N}_]`;
  const WORD_START = String.raw`(?<!${WORD_CHAR})`;
  const WORD_END = String.raw`(?!${WORD_CHAR})`;

  function either(alternatives) {
    return alternatives.join("|");
  }

  // ---------------------------------------------------------------------------
  // Arabic claim pattern (all spellings are NORMALIZED: ا not أ/إ, ي not ى, no tashkeel)
  // ---------------------------------------------------------------------------

  const AR_CLAIM_PHRASES = [
    String.raw`تمت\s+الاضافة`, // تمت الإضافة
    String.raw`تم\s+الحذف`,
    String.raw`تم\s+التعديل`,
    String.raw`تم\s+الحفظ`,
    "تمت",
    "تم",
  ];

  // First-person past verbs ("I deleted…"); they may carry an object suffix.
  const AR_CLAIM_VERBS = [
    "حذفت",
    "الغيت",
    "مسحت",
    "اضفت",
    "ضفت",
    "عدلت",
    "نقلت",
    "سجلت",
    "حفظت",
    "غيرت",
    "انشات",
    "جدولت",
    "ارسلت",
    "ضبطت",
    "اجلت",
    "رتبت",
    "خلصت",
    "حجزت",
    "كنسلت",
    "حطيت",
    "بعثت",
  ];

  // Gulf passives ("it got deleted"); they never take an object suffix.
  const AR_CLAIM_PASSIVES = [
    "انحذفت",
    "انحذف",
    "انلغت",
    "انلغي",
    "انلغا",
    "انضافت",
    "انضاف",
    "اتسجلت",
    "اتسجل",
    "انمسحت",
    "انمسح",
    "اتعدلت",
    "اتعدل",
    "انحفظت",
    "انحفظ",
  ];

  const AR_OBJECT_SUFFIX = "(?:ها|هم|هن|كم|ه|ك)?";
  const AR_FOR_YOU_SUFFIX = "(?:ل(?:كم|ها|هم|ه|ك))?"; // Gulf "حذفتهالك" = deleted it for you

  // "ما" after these words is a conjunction ("بعد ما حذفته" = after I deleted it), not "not".
  const AR_NEGATOR = String.raw`(?:لم|لن|ماني|مو|مب|ماقدرت|(?<!(?:بعد|قبل|كل|مثل|زي|حسب|لين|عند|اول)\s+)ما)`;

  const AR_CLAIM_SOURCE =
    // Not a claim when a negator sits up to two words before it ("ما حذفت شي").
    String.raw`(?<!${WORD_START}[وف]?${AR_NEGATOR}\s+(?:${WORD_CHAR}+\s+)?)` +
    WORD_START +
    "(?!فشل)" + // "فشلت" (it failed) must not read as ف + شلت
    "[وف]?(?:" +
    either(AR_CLAIM_PHRASES) +
    "|(?:" +
    either(AR_CLAIM_VERBS) +
    ")" +
    AR_OBJECT_SUFFIX +
    AR_FOR_YOU_SUFFIX +
    "|شلت(?:ها|هم|هن|ه)?" +
    AR_FOR_YOU_SUFFIX + // no ك: "شلتك" usually means "your friends"
    "|" +
    either(AR_CLAIM_PASSIVES) +
    ")" +
    WORD_END;

  /**
   * Arabic "a change was made" claim words (Gulf + MSA) for merging into
   * voice-agent.html's DID_CLAIM. Built for NORMALIZED text, flags "u", not
   * global (so .test() keeps no state). Covers تم/تمت, حذفت, ألغيت, مسحت, أضفت,
   * ضفت, عدّلت, نقلت, سجلت, حفظت, غيرت, أنشأت, جدولت, أرسلت, ضبطت, شلت, أجلت,
   * رتبت, خلصت, انحذف, انلغى, انضاف, اتسجل … with an optional leading و/ف and
   * object suffix (وحذفته, مسحتها). A negator up to two words before
   * (لم, لن, ما, ماني, مو, مب, ما قدرت) cancels the match.
   *
   * detectClaim() applies further rules this single regex cannot (questions,
   * conditionals, second person, English), so prefer detectClaim()/enforce().
   *
   * @type {RegExp}
   * @example NovaProof.DID_CLAIM_AR.test(NovaProof.normalizeArabic(reply))
   */
  const DID_CLAIM_AR = new RegExp(AR_CLAIM_SOURCE, "u");
  const AR_CLAIM_RE = new RegExp(AR_CLAIM_SOURCE, "gu");

  // ---------------------------------------------------------------------------
  // English claim pattern
  // ---------------------------------------------------------------------------

  const EN_CLAIM_WORDS = [
    "done",
    "deleted",
    "removed",
    "cancelled",
    "canceled",
    "cleared",
    "erased",
    "added",
    "saved",
    "stored",
    "logged",
    "recorded",
    "updated",
    "changed",
    "edited",
    "moved",
    "rescheduled",
    "scheduled",
    "created",
    "booked",
    "completed",
    "marked",
    "sent",
    "renamed",
    "archived",
  ];
  const APOSTROPHE = "['’]";
  const EN_CLAIM_RE = new RegExp(
    String.raw`(?<![\p{L}\p{N}])(?:` +
      // "it's in" counts only when it ends the clause ("Okay, it's in."), not "it's in Riyadh".
      String.raw`(?<phrase>all\s+set|taken\s+care\s+of|it(?:${APOSTROPHE}s|\s+is)\s+now\s+in|it(?:${APOSTROPHE}s|\s+is)\s+in(?:\s+there)?(?:\s+now)?(?=\s*(?:[.!,;:]|$)))` +
      // Bare "set" is too common ("a set of weights"), so only these shapes count.
      String.raw`|(?<setPhrase>(?:i|we)(?:${APOSTROPHE}ve|\s+have)\s+(?:just\s+|now\s+|already\s+|also\s+)?set` +
      String.raw`|set\s+(?:up\s+)?(?:a|an|the|your)\s+(?:[\p{L}\p{N}:.]+\s+){0,2}?(?:reminder|alarm|timer)s?` +
      String.raw`|(?:reminder|alarm|timer)s?\s+(?:is\s+|has\s+been\s+|${APOSTROPHE}s\s+)?set)` +
      `|(?<word>${either(EN_CLAIM_WORDS)})` +
      String.raw`)(?![\p{L}\p{N}])`,
    "giu",
  );

  // ---------------------------------------------------------------------------
  // Context word lists used to discard claim-looking words that are not claims
  // ---------------------------------------------------------------------------

  const EN_NEGATIONS = new Set([
    "not",
    "never",
    "cannot",
    "nor",
    "neither",
    "didnt",
    "couldnt",
    "wasnt",
    "werent",
    "havent",
    "hasnt",
    "hadnt",
    "dont",
    "doesnt",
    "cant",
    "wont",
    "isnt",
    "arent",
    "wouldnt",
    "shouldnt",
  ]);
  const EN_AFTER_NOTHING = new Set([
    "was",
    "were",
    "is",
    "has",
    "had",
    "have",
    "got",
    "been",
    "will",
  ]);
  const EN_MODALS = new Set([
    "will",
    "would",
    "can",
    "could",
    "should",
    "shall",
    "may",
    "might",
    "must",
    "to",
    "gonna",
    "wanna",
    "want",
    "wants",
    "let",
    "lets",
    "let's",
  ]);
  const EN_HYPOTHETICALS = new Set([
    "if",
    "unless",
    "when",
    "whenever",
    "once",
    "until",
    "till",
    "whether",
  ]);
  const EN_SECOND_PERSON = new Set([
    "you",
    "you're",
    "youre",
    "you've",
    "youve",
    "you'd",
    "you'll",
  ]);
  const EN_DETERMINERS = new Set([
    "a",
    "an",
    "the",
    "my",
    "your",
    "our",
    "their",
    "his",
    "her",
    "its",
    "this",
    "these",
    "those",
    "any",
    "some",
    "every",
    "no",
    "next",
    "upcoming",
    "previous",
    "many",
    "several",
    "few",
  ]);
  const EN_QUESTION_OPENERS = new Set([
    "should",
    "shall",
    "do",
    "does",
    "did",
    "would",
    "could",
    "can",
    "will",
    "want",
    "wanna",
    "may",
    "might",
    "is",
    "are",
    "was",
    "were",
    "has",
    "have",
    "had",
    "what",
    "what's",
    "whats",
    "which",
    "when",
    "where",
    "who",
    "how",
    "why",
    "any",
    "anything",
    "need",
  ]);
  const EN_FILLERS = new Set([
    "ok",
    "okay",
    "so",
    "alright",
    "sure",
    "and",
    "but",
    "then",
    "well",
    "hey",
    "also",
    "now",
    "great",
    "perfect",
    "um",
    "uh",
    "oh",
    "yes",
    "yeah",
    "titan",
  ]);

  const AR_QUESTION_OPENERS = new Set([
    "هل",
    "تبي",
    "تبيني",
    "تبغي",
    "تبغاني",
    "ودك",
    "وش",
    "ايش",
    "شو",
    "شنو",
    "متى",
    "كيف",
    "ليش",
    "وين",
    "منو",
    "كم",
  ]);
  const AR_FILLERS = new Set([
    "طيب",
    "اوكي",
    "يعني",
    "بس",
    "حسنا",
    "تمام",
    "و",
  ]);
  const AR_HYPOTHETICALS = new Set(["اذا", "لو"]);
  const AR_SECOND_PERSON = new Set(["انت", "انتي", "انتم", "انتو"]);

  // ---------------------------------------------------------------------------
  // Text helpers
  // ---------------------------------------------------------------------------

  const SENTENCE_SPLIT_RE = /(?<=[.!?؟\n])\s*/u;
  const CLAUSE_BREAK_RE = /[,،;؛:—–]|\s-\s/gu;
  const QUESTION_END_RE = /[?؟]["'”’)\]\s]*$/u;

  function splitSentences(text) {
    return text
      .split(SENTENCE_SPLIT_RE)
      .filter((sentence) => sentence.trim() !== "");
  }

  /** The part of the clause (comma/colon/dash delimited) that comes before `index`. */
  function clauseBefore(sentence, index) {
    const before = sentence.slice(0, index);
    let start = 0;
    for (const found of before.matchAll(CLAUSE_BREAK_RE))
      start = found.index + found[0].length;
    return before.slice(start);
  }

  function tokenize(text) {
    return text
      .toLowerCase()
      .replace(/’/g, "'")
      .split(/\s+/)
      .map((token) => token.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ""))
      .filter(Boolean);
  }

  /** Set lookup that also accepts an Arabic word with a leading و/ف ("ولو", "وش"). */
  function isWordIn(set, token) {
    return set.has(token) || (/^[وف]/u.test(token) && set.has(token.slice(1)));
  }

  function isNegatedEnglish(tokens) {
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];
      const next = tokens[i + 1];
      if (token === "not" && next === "only") continue; // "not only … but also"
      if (EN_NEGATIONS.has(token) || token.endsWith("n't")) return true;
      if (token === "no" && next === "longer") return true;
      if (token === "nothing's") return true;
      if (
        token === "nothing" &&
        (next === undefined || EN_AFTER_NOTHING.has(next))
      )
        return true;
    }
    return false;
  }

  function isEnglishModal(token) {
    return EN_MODALS.has(token) || token.endsWith("'ll");
  }

  function startsWithOpener(tokens, openers, fillers) {
    const first = tokens.find((token) => !isWordIn(fillers, token));
    return first !== undefined && isWordIn(openers, first);
  }

  function isMostlyArabic(text) {
    const arabic = (text.match(/(?=\p{L})\p{Script=Arabic}/gu) || []).length;
    const latin = (text.match(/(?=\p{L})\p{Script=Latin}/gu) || []).length;
    return arabic > latin;
  }

  // ---------------------------------------------------------------------------
  // detectClaim
  // ---------------------------------------------------------------------------

  const NOTICE_EN = "Nothing was changed";
  const NOTICE_AR = "لم يتغيّر شيء";
  const NOTICE_SEPARATOR = " — ";

  /** enforce()'s own notice is a denial by construction, whatever reason it quotes. */
  function isProofNotice(normalizedText) {
    const lower = normalizedText.toLowerCase();
    return (
      lower.startsWith(NOTICE_EN.toLowerCase() + NOTICE_SEPARATOR.trimEnd()) ||
      lower.startsWith(normalizeArabic(NOTICE_AR) + NOTICE_SEPARATOR.trimEnd())
    );
  }

  function isEnglishClaimCounted(context) {
    const { tokens, groups } = context;
    if (
      context.inQuestion &&
      startsWithOpener(context.clauseTokens, EN_QUESTION_OPENERS, EN_FILLERS)
    )
      return false;
    if (tokens.some((token) => EN_HYPOTHETICALS.has(token))) return false; // "if you want it moved"
    if (isNegatedEnglish(tokens.slice(-3))) return false; // "Nothing was deleted"
    if (tokens.slice(-2).some(isEnglishModal)) return false; // "to be deleted", "I'll set a timer"
    if (groups.word) {
      const word = groups.word.toLowerCase();
      const previous = tokens.slice(-2);
      if (previous.some((token) => EN_SECOND_PERSON.has(token))) return false; // the user's action: "You logged 5 km"
      if (word === "done" && previous[previous.length - 1] === "well")
        return false; // praise: "Well done!"
      if (word !== "done" && isAttributive(tokens, context.after)) return false; // "your scheduled run"
    }
    return true;
  }

  /** A participle used as an adjective before a noun: "your scheduled run", "3 completed tasks". */
  function isAttributive(tokens, textAfter) {
    const previous = tokens[tokens.length - 1];
    if (previous === undefined) return false;
    const determiner = EN_DETERMINERS.has(previous) || /^\d/u.test(previous);
    return determiner && /^\s+[\p{L}\p{N}]/u.test(textAfter);
  }

  function isArabicClaimCounted(context) {
    const { tokens } = context;
    if (
      context.inQuestion &&
      startsWithOpener(context.clauseTokens, AR_QUESTION_OPENERS, AR_FILLERS)
    )
      return false;
    if (tokens.some((token) => isWordIn(AR_HYPOTHETICALS, token))) return false; // "لو حذفته…"
    if (tokens.slice(-2).some((token) => isWordIn(AR_SECOND_PERSON, token)))
      return false; // "انت سجلت…"
    return true; // negation is already part of the pattern (AR_NEGATOR)
  }

  function collectClaims(sentence, pattern, isCounted, words) {
    const inQuestion = QUESTION_END_RE.test(sentence);
    for (const found of sentence.matchAll(pattern)) {
      const tokens = tokenize(clauseBefore(sentence, found.index));
      const context = {
        tokens,
        clauseTokens: tokens.length > 0 ? tokens : tokenize(found[0]),
        groups: found.groups || {},
        after: sentence.slice(found.index + found[0].length),
        inQuestion,
      };
      if (isCounted(context))
        words.push(
          found[0].toLowerCase().replace(/’/g, "'").replace(/\s+/g, " "),
        );
    }
  }

  /**
   * Does this reply claim that a change was made ("Done", "Deleted your run",
   * "تم", "حذفته", "عدّلت الموعد")? English and Arabic (Gulf + MSA) are both checked.
   * Not counted as claims: negated words ("I couldn't delete it", "Nothing was
   * deleted", "ما حذفت شي"), questions ("Should I set a reminder?"), base forms
   * ("add", "أحذف"), conditionals ("if you want it moved"), the user's own actions
   * ("You logged 5 km"), adjectives ("your scheduled run"), and enforce()'s notice.
   *
   * @param {*} reply TITAN's reply text.
   * @returns {{claimed: boolean, words: string[]}} `words` lists each counted
   *   claim as found (English lower-cased, Arabic normalized), e.g. ["deleted"].
   */
  function detectClaim(reply) {
    const text = normalizeArabic(reply).trim();
    const words = [];
    if (text !== "" && !isProofNotice(text)) {
      for (const sentence of splitSentences(text)) {
        collectClaims(sentence, EN_CLAIM_RE, isEnglishClaimCounted, words);
        collectClaims(sentence, AR_CLAIM_RE, isArabicClaimCounted, words);
      }
    }
    return { claimed: words.length > 0, words };
  }

  // ---------------------------------------------------------------------------
  // Arabic intent pattern (NORMALIZED spellings)
  // ---------------------------------------------------------------------------

  // Imperatives that are only ever commands, so they count anywhere.
  const AR_IMPERATIVES = [
    "احذف",
    "امسح",
    "شيل",
    "الغي",
    "الغ",
    "اضف",
    "حط",
    "احفظ",
    "انقل",
    "ذكرني",
    "احجز",
    "اضبط",
    "كنسل",
  ];
  const AR_IMPERATIVE_SUFFIX = "(?:ها|هم|هن|ه|ني|ي)?(?:لي|لنا)?";

  // These double as nouns or particles (ضيف guest, سجل log, جدول table, غير other
  // than, اجل so/yes), so they count only at the start of a clause outside a question.
  const AR_CLAUSE_START_IMPERATIVES = [
    "ضيف",
    "سجل",
    "عدل",
    "غير",
    "رتب",
    "جدول",
  ];
  const AR_CLAUSE_START_SUFFIX = "(?:ها|هم|هن|ه)?(?:لي|لنا)?";
  const AR_SET_IT_TO = ["خليها", "خليه", "خلهم", "خلها", "خله"]; // "خله الساعة ٧"
  const AR_CLAUSE_LEAD = String.raw`(?:(?:يا\s+)?(?:تيتان|[Tt][Ii][Tt][Aa][Nn])|لو\s+سمحت|طيب|يلا|الحين|بعدين)[\s،,!]+`;
  const AR_CLAUSE_START = String.raw`(?:^|[.!?؟،,؛;:\n])\s*(?:${AR_CLAUSE_LEAD}){0,2}`;
  const AR_NOT_IN_QUESTION = String.raw`(?![^.!?؟\n]*[?؟])`;

  // "ابيك تحذف…", "ممكن تضيف…", "ابغى اسجل…"
  const AR_REQUEST_LEADS = [
    "ابيك",
    "ابغاك",
    "ابغيك",
    "بغيتك",
    "ابي",
    "ابغي",
    "ابغا",
    "ودي",
    "ودك",
    "ممكن",
    "تقدر",
    "تكفي",
    String.raw`لو\s+سمحت`,
    "ياليت",
    "ياريت",
    "ليتك",
    "اريدك",
    "اريد",
  ];
  const AR_REQUESTED_VERBS = [
    "تحذف",
    "تمسح",
    "تشيل",
    "تلغي",
    "تضيف",
    "تحط",
    "تسجل",
    "تحفظ",
    "تنقل",
    "تعدل",
    "تغير",
    "تاجل",
    "تذكرني",
    "ترتب",
    "تجدول",
    "تضبط",
    "تحجز",
    "تكنسل",
    "احذف",
    "امسح",
    "اشيل",
    "الغي",
    "اضيف",
    "احط",
    "اسجل",
    "احفظ",
    "انقل",
    "اعدل",
    "اغير",
    "ارتب",
    "اجدول",
    "اضبط",
    "احجز",
    "اكنسل",
  ];
  const AR_NEGATOR_WORD = "(?:لا|ما|مو|مب)";
  const AR_NO_NEGATOR_BEFORE = String.raw`(?<!${WORD_START}${AR_NEGATOR_WORD}\s+)`; // "ما ابيك تحذفه"
  const AR_OPTIONAL_WORD = String.raw`(?:(?!${AR_NEGATOR_WORD}${WORD_END})${WORD_CHAR}+\s+)?`;

  /**
   * Arabic/Gulf "please change something" requests for merging into
   * voice-agent.html's SAVE_INTENT. Built for NORMALIZED text, flags "u", not
   * global. Matches imperatives (احذف, امسح, شيل, الغ/الغي/ألغِ, اضف/أضف, حط,
   * احفظ, انقل, ذكرني … anywhere; ضيف, سجل, عدل, غير, اجل/أجّل, رتب, جدول,
   * خله … at the start of a clause, outside questions) and requests such as
   * "أبيك/ابغاك/أبغى تحذف|تضيف|تنقل|تعدل|تلغي|تسجل" or "ممكن تحذف".
   *
   * @type {RegExp}
   * @example NovaProof.SAVE_INTENT_AR.test(NovaProof.normalizeArabic(userText))
   */
  const SAVE_INTENT_AR = new RegExp(
    [
      String.raw`${WORD_START}[وف]?(?:${either(AR_IMPERATIVES)})${AR_IMPERATIVE_SUFFIX}${WORD_END}`,
      String.raw`${AR_CLAUSE_START}[وف]?(?:(?:${either(AR_CLAUSE_START_IMPERATIVES)})${AR_CLAUSE_START_SUFFIX}` +
        String.raw`|اجل(?:(?:ها|هم|هن|ه)(?:لي|لنا)?|(?=\s+(?:ال|موعد)))` + // "اجل الموعد", not "اجل" = so/yes
        `|${either(AR_SET_IT_TO)})${WORD_END}${AR_NOT_IN_QUESTION}`,
      String.raw`${AR_NO_NEGATOR_BEFORE}${WORD_START}[وف]?(?:${either(AR_REQUEST_LEADS)})[\s،,]+${AR_OPTIONAL_WORD}` +
        `(?:${either(AR_REQUESTED_VERBS)})${AR_IMPERATIVE_SUFFIX}${WORD_END}`,
    ].join("|"),
    "u",
  );

  // ---------------------------------------------------------------------------
  // English intent
  // ---------------------------------------------------------------------------

  const EN_INTENT_VERBS = [
    "add",
    "put",
    "create",
    "schedule",
    "book",
    "set",
    "remind",
    "delete",
    "remove",
    "cancel",
    "clear",
    "erase",
    "move",
    "reschedule",
    "change",
    "edit",
    "update",
    "rename",
    "mark",
    "log",
    "record",
    "save",
    "note",
  ];
  const EN_INTENT_VERB = `(?:${either(EN_INTENT_VERBS)})`;
  const EN_LEADING_FILLER_RE =
    /^(?:(?:hey|hi|hello|ok|okay|alright|so|and|also|now|then|please|pls|plz|kindly|just|titan|تيتان)(?![\p{L}\p{N}])[\s,.!:;]*)+/iu;
  const EN_REQUEST_LEAD_RE = new RegExp(
    String.raw`^(?:(?:can|could|would|will)\s+you|i\s+(?:want|need|would\s+like)(?:\s+you)?\s+to|i'd\s+(?:like|love)(?:\s+you)?\s+to` +
      String.raw`|let's|lets|let\s+us|go\s+ahead\s+and|help\s+me|make\s+sure(?:\s+you)?(?:\s+to)?|don't\s+forget\s+to|remember\s+to)(?![\p{L}\p{N}])\s*`,
    "iu",
  );
  // "Update on my balance?" / "Change of plans" use the word as a noun.
  const EN_VERB_AT_START_RE = new RegExp(
    String.raw`^${EN_INTENT_VERB}(?![\p{L}\p{N}])(?!\s+(?:of|on)(?![\p{L}\p{N}]))`,
    "iu",
  );
  const EN_VERB_WITH_OBJECT_RE = new RegExp(
    String.raw`(?<![\p{L}\p{N}])${EN_INTENT_VERB}\s+(?:my|the|this|that|it|them|all|a|an|these|those|our|everything|me|some)(?![\p{L}\p{N}])`,
    "giu",
  );
  const EN_INFO_OPENERS = new Set([
    "what",
    "what's",
    "whats",
    "how",
    "why",
    "when",
    "where",
    "which",
    "who",
    "whose",
    "did",
    "does",
    "do",
    "is",
    "are",
    "was",
    "were",
    "should",
    "have",
    "has",
    "had",
    "am",
  ]);

  function stripRequestLeads(text) {
    let current = text;
    for (;;) {
      const next = current
        .replace(EN_LEADING_FILLER_RE, "")
        .replace(EN_REQUEST_LEAD_RE, "");
      if (next === current) return current;
      current = next;
    }
  }

  function isEnglishChangeRequest(sentence) {
    const lower = sentence.toLowerCase().replace(/’/g, "'");
    // 1. A verb opening any clause: "Delete my run", "TITAN, add milk", "Can you move it to 5?"
    const clauses = lower.split(/[,;:،؛—–]|\s-\s/u);
    if (
      clauses.some((clause) =>
        EN_VERB_AT_START_RE.test(stripRequestLeads(clause.trim())),
      )
    )
      return true;
    // 2. A verb with an object anywhere ("I want to cancel my gym session"), unless it is
    //    an information question ("How do I delete my account?") or negated ("don't delete my run").
    const firstWord = tokenize(lower.replace(EN_LEADING_FILLER_RE, ""))[0];
    if (EN_INFO_OPENERS.has(firstWord)) return false;
    for (const found of lower.matchAll(EN_VERB_WITH_OBJECT_RE)) {
      if (!isNegatedEnglish(tokenize(lower.slice(0, found.index)).slice(-4)))
        return true;
    }
    return false;
  }

  /**
   * Does the user ask TITAN to change something (add, delete, move, set a
   * reminder…)? Handles English, Arabic/Gulf and mixed requests such as
   * "delete my جري appointment", "احذف موعد الجري", "شيل موعد الجري من الجدول".
   * Pure questions ("what's my net worth?", "كم رصيدي؟") and negated commands
   * ("don't delete it") return false.
   *
   * @param {*} userText What the user said (speech transcript or typed text).
   * @returns {boolean} true when the text asks for a change.
   */
  function detectIntent(userText) {
    const text = normalizeArabic(userText).trim();
    if (text === "") return false;
    if (SAVE_INTENT_AR.test(text)) return true;
    return splitSentences(text).some(isEnglishChangeRequest);
  }

  // ---------------------------------------------------------------------------
  // enforce
  // ---------------------------------------------------------------------------

  const DEFAULT_WHY_EN =
    "I didn't get confirmation from the app that it worked.";
  // Deliberately avoids "تم", which would itself read as a claim.
  const DEFAULT_WHY_AR = "ما وصلني تأكيد من التطبيق أن التغيير صار فعلاً.";

  function firstFailureReason(failures) {
    if (!Array.isArray(failures)) return "";
    for (const failure of failures) {
      const reason =
        typeof failure === "string" ? failure : failure && failure.reason;
      if (typeof reason === "string" && reason.trim() !== "")
        return reason.trim();
    }
    return "";
  }

  function endWithPeriod(text) {
    return text.replace(/[\s.!?؟،,;؛:…]+$/u, "") + ".";
  }

  /**
   * Apply the proof rule to one reply before TITAN speaks or shows it.
   * If the reply claims a change but the app confirmed nothing this turn, the
   * text is replaced with an honest notice:
   *   English: "Nothing was changed — <why>."
   *   Arabic:  "لم يتغيّر شيء — <why>."  (when turn.lang is "ar" or the reply is mostly Arabic)
   * <why> is the first failure reason, or a default "no confirmation" sentence.
   * Replies without a claim, or with at least one confirmed change, pass unchanged.
   * The notice is never itself a claim, so enforce() is idempotent.
   *
   * @param {*} reply TITAN's reply text.
   * @param {{confirmed?: Array<{summary?: string}>, failures?: Array<{reason: string}>, lang?: ("ar"|"en"), quoted?: string[]}} [turn]
   *   `quoted`: exact passages TITAN is quoting (not checked for claims).
   *   What the app confirmed in THIS turn. A missing turn or a non-array
   *   `confirmed` counts as "nothing confirmed".
   * @returns {{text: string, blocked: boolean, reason?: string}} `reason` (only
   *   when blocked) explains the block for logs.
   */
  function enforce(reply, turn) {
    const text = reply === null || reply === undefined ? "" : String(reply);
    const details = turn !== null && typeof turn === "object" ? turn : {};
    // Text TITAN is quoting (e.g. excerpts from the user's Claude history, where
    // Claude once wrote "I've updated your plan") is not TITAN claiming a change.
    let checked = text;
    (Array.isArray(details.quoted) ? details.quoted : []).forEach((q) => {
      if (typeof q === "string" && q.trim()) checked = checked.split(q).join(" ");
    });
    const claim = detectClaim(checked);
    // `confirmed` is normally the list of changes the app confirmed this turn.
    // `true` or a positive count are accepted too, so a caller passing a flag
    // is not silently treated as "nothing confirmed".
    const c = details.confirmed;
    const confirmedCount = Array.isArray(c)
      ? c.filter(Boolean).length
      : c === true
        ? 1
        : typeof c === "number" && c > 0
          ? c
          : 0;
    if (!claim.claimed || confirmedCount > 0) return { text, blocked: false };

    const arabic = details.lang === "ar" || isMostlyArabic(text);
    const why =
      firstFailureReason(details.failures) ||
      (arabic ? DEFAULT_WHY_AR : DEFAULT_WHY_EN);
    return {
      text:
        (arabic ? NOTICE_AR : NOTICE_EN) +
        NOTICE_SEPARATOR +
        endWithPeriod(why),
      blocked: true,
      reason: `Reply claimed a change (${claim.words.join(", ")}) but the app confirmed none this turn.`,
    };
  }

  // ---------------------------------------------------------------------------
  // mergeRegex
  // ---------------------------------------------------------------------------

  function toRegExp(value, name) {
    if (value instanceof RegExp) return value;
    if (typeof value === "string") return new RegExp(value);
    throw new TypeError(
      `NovaProof.mergeRegex: ${name} must be a RegExp or a pattern string.`,
    );
  }

  /**
   * Combine an existing regex with one of the Arabic patterns into a new RegExp
   * that matches either. Keeps `existing`'s flags and adds "u" (needed for
   * \p{L}); `extra`'s flags are not carried over. Neither input is modified.
   *
   * How to wire this into voice-agent.html (always test NORMALIZED text; the
   * English parts are unaffected by normalization):
   *
   *   const DID_CLAIM_ALL   = NovaProof.mergeRegex(DID_CLAIM, NovaProof.DID_CLAIM_AR);
   *   const SAVE_INTENT_ALL = NovaProof.mergeRegex(SAVE_INTENT, NovaProof.SAVE_INTENT_AR);
   *   const claimed = DID_CLAIM_ALL.test(NovaProof.normalizeArabic(replyText));
   *   const wantsChange = SAVE_INTENT_ALL.test(NovaProof.normalizeArabic(userText));
   *
   * If `existing` has the "g" or "y" flag, .test() is stateful (lastIndex), as
   * with any such RegExp. For the full rule (negation, questions, the honest
   * notice) call NovaProof.enforce(replyText, turn) before speaking.
   *
   * @param {RegExp|string} existing The current pattern (e.g. DID_CLAIM).
   * @param {RegExp|string} extra The pattern to add (e.g. NovaProof.DID_CLAIM_AR).
   * @returns {RegExp} A new RegExp matching either pattern.
   * @throws {SyntaxError} When `existing` is not valid in Unicode ("u") mode,
   *   e.g. it uses a needless escape like \- outside a character class.
   */
  function mergeRegex(existing, extra) {
    const first = toRegExp(existing, "existing");
    const second = toRegExp(extra, "extra");
    // "u" and "v" cannot be combined; "v" already implies Unicode mode.
    const flags = /[uv]/.test(first.flags) ? first.flags : first.flags + "u";
    try {
      return new RegExp(`(?:${first.source})|(?:${second.source})`, flags);
    } catch (error) {
      throw new SyntaxError(
        `NovaProof.mergeRegex: the combined pattern is not valid with flags "${flags}" ` +
          `(${error.message}). Make sure the existing pattern also works in Unicode ("u") mode.`,
      );
    }
  }

  return Object.freeze({
    normalizeArabic,
    detectClaim,
    detectIntent,
    enforce,
    mergeRegex,
    DID_CLAIM_AR,
    SAVE_INTENT_AR,
  });
});
