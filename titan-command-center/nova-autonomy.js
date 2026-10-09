/**
 * nova-autonomy.js
 *
 * Decides, for every action TITAN wants to perform, whether it runs right away
 * ("auto"), waits for ONE tap from the user ("tap"), or is refused ("never").
 * Also keeps a journal of autonomous changes (before/after + Undo) and builds
 * the evening-review summary.
 *
 * Works as a classic browser <script> (sets window.NovaAutonomy) and via
 * require() in Node (module.exports). No dependencies, no build step.
 *
 * Typical wiring in voice-agent.html:
 *
 *   const decision = NovaAutonomy.classify(
 *     { type: "daybook.move", params: { ... }, source: "voice" },
 *     { autonomous: settings.autonomous }
 *   );
 *   if (decision.tier === "auto")  runNow();
 *   if (decision.tier === "tap")   showOneTapCard(decision.reason);
 *   if (decision.tier === "never") say(decision.reason);
 *
 *   const journal = NovaAutonomy.createJournal({
 *     load: () => JSON.parse(localStorage.getItem("titan.journal") || "[]"),
 *     save: (entries) => localStorage.setItem("titan.journal", JSON.stringify(entries)),
 *   });
 */
(function (root, factory) {
  "use strict";
  const api = factory();
  if (typeof module === "object" && module !== null && module.exports) {
    module.exports = api;
  } else if (root) {
    root.NovaAutonomy = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  // ---------------------------------------------------------------------------
  // Policy tables
  // ---------------------------------------------------------------------------

  // Each rule: patterns (dotted names; "*" stands for zero or more name
  // segments, so "daybook.*" covers "daybook" and everything under it),
  // a category id, and the one-sentence reason shown to the user.

  const NEVER_RULES = [
    {
      patterns: ["payment.*", "transfer.*", "trade.*", "purchase.*"],
      category: "payments",
      reason:
        "TITAN never makes payments, transfers, trades or purchases, so you'll need to do this yourself.",
    },
    {
      // The last two patterns also catch these words deeper inside a name,
      // e.g. "daybook.permanentDelete.item", which "daybook.*" would otherwise allow.
      patterns: [
        "*.permanentDelete",
        "delete.permanent.*",
        "*.permanentDelete.*",
        "*.delete.permanent.*",
      ],
      category: "permanent-delete",
      reason: "TITAN never deletes anything permanently.",
    },
    {
      patterns: ["credential.*"],
      category: "credentials",
      reason: "TITAN never enters passwords or keys for you.",
    },
    {
      patterns: ["safety.*"],
      category: "safety-rules",
      reason: "TITAN can't change its own safety rules.",
    },
  ];

  const TAP_RULES = [
    {
      patterns: ["message.send.*"],
      category: "messaging",
      reason:
        "TITAN prepares the message, and nothing is sent until you press Send.",
    },
    {
      patterns: ["email.send"],
      category: "messaging",
      reason:
        "TITAN prepares the email, and nothing is sent until you press Send.",
    },
    {
      patterns: ["calendar.invite.*"],
      category: "calendar-invite",
      reason:
        "Invitations reach other people, so TITAN waits for your tap before sending them.",
    },
    {
      patterns: ["pc.restart", "pc.shutdown", "pc.lock"],
      category: "pc-power",
      reason:
        "TITAN waits for your tap before restarting, shutting down or locking your PC.",
    },
    {
      patterns: ["pc.organizeDownloads"],
      category: "pc-files",
      reason:
        "TITAN waits for your tap before moving files around in your Downloads folder.",
    },
    {
      patterns: ["daybook.clearDay"],
      category: "daybook",
      reason: "Clearing a whole day at once waits for your tap.",
    },
    {
      patterns: ["data.eraseAll"],
      category: "data-erase",
      reason: "Erasing all your data waits for your tap.",
    },
    {
      patterns: ["download.*"],
      category: "downloads",
      reason: "TITAN waits for your tap before downloading anything.",
    },
    {
      patterns: ["connector.*"],
      category: "connectors",
      reason:
        "Changes TITAN makes in other apps through connectors wait for your tap.",
    },
    {
      patterns: ["titan.code.*"],
      category: "titan-code",
      reason: "Changes to TITAN's own code wait for your tap.",
    },
  ];

  // "what" completes the Ask-first sentence: "...waits for your tap before <what>."
  const AUTO_RULES = [
    {
      patterns: ["daybook.*"],
      category: "daybook",
      what: "changing your daybook",
      reason:
        "Daybook changes happen right away, and you can undo them from the journal.",
    },
    {
      patterns: ["reminder.*"],
      category: "reminders",
      what: "changing your reminders",
      reason:
        "Reminder changes happen right away, and you can undo them from the journal.",
    },
    {
      patterns: ["list.*"],
      category: "lists",
      what: "changing your lists",
      reason:
        "List changes happen right away, and you can undo them from the journal.",
    },
    {
      patterns: ["goal.*"],
      category: "goals",
      what: "changing your goals",
      reason:
        "Goal changes happen right away, and you can undo them from the journal.",
    },
    {
      patterns: ["habit.*"],
      category: "habits",
      what: "changing your habits",
      reason:
        "Habit changes happen right away, and you can undo them from the journal.",
    },
    {
      patterns: ["note.*"],
      category: "notes",
      what: "changing your notes",
      reason:
        "Note changes happen right away, and you can undo them from the journal.",
    },
    {
      patterns: ["memory.*"],
      category: "memory",
      what: "changing what TITAN remembers",
      reason:
        "Updating what TITAN remembers happens right away, and you can undo it from the journal.",
    },
    {
      patterns: ["money.record", "money.edit", "money.remove"],
      category: "money",
      what: "changing your money records",
      reason:
        "Money records only change TITAN's own notes, so they happen right away for any amount, and you can undo them from the journal.",
    },
    {
      patterns: ["office.document.*"],
      category: "documents",
      what: "changing your documents",
      reason:
        "Document changes happen right away, and you can undo them from the journal.",
    },
    {
      // Only when nobody else is invited; see calendarNeedsTap().
      patterns: ["calendar.event.*"],
      category: "calendar",
      what: "changing your calendar",
      reason:
        "Events on your own calendar that invite nobody else happen right away, and you can undo them from the journal.",
    },
    {
      patterns: ["email.draft"],
      category: "email-draft",
      what: "saving an email draft",
      reason:
        "TITAN saves the email as a draft right away and never sends it on its own.",
    },
    {
      patterns: ["routine.*"],
      category: "routines",
      what: "changing your routines",
      reason:
        "Routine changes happen right away, and you can undo them from the journal.",
    },
    {
      patterns: ["guardian.watch.*"],
      category: "guardian",
      what: "changing your Guardian watches",
      reason:
        "Guardian watch changes happen right away, and you can undo them from the journal.",
    },
    {
      patterns: ["pc.open.app", "pc.open.folder", "pc.open.url"],
      category: "pc-open",
      what: "opening things on your PC",
      reason:
        "Opening an app, folder or link is harmless, so TITAN does it right away.",
    },
    {
      patterns: ["cc.layout.*"],
      category: "layout",
      what: "changing the Command Center layout",
      reason:
        "Command Center layout changes happen right away, and you can change them back any time.",
    },
  ];

  const TRUSTED_SOURCES = ["user", "voice", "typed", "chat"];

  const UNTRUSTED_SOURCES = [
    "email",
    "web",
    "webpage",
    "document",
    "doc",
    "file",
    "news",
    "rss",
    "message",
    "sms",
    "whatsapp",
    "notification",
    "clipboard",
    "tool",
    "tool_result",
    "content",
    "knowledge",
    "claude_history",
  ];

  const UNTRUSTED_REASON =
    "TITAN never acts on text inside emails, web pages, documents or news, only on what you ask it yourself.";
  const UNVERIFIED_SOURCE_REASON =
    "TITAN couldn't confirm this request came from you, and it never acts on text inside emails, web pages, documents or news.";
  const UNTRUSTED_CONTEXT_REASON =
    "Text from your saved Claude history (or other quoted text) is part of this conversation, so this change waits for your tap.";
  const UNKNOWN_ACTION_REASON =
    "TITAN doesn't recognise this action yet, so it waits for your tap to be safe.";
  const CALENDAR_ATTENDEES_REASON =
    "This event invites other people, so TITAN waits for your tap before sending it.";
  const CALENDAR_NOT_OWN_REASON =
    "This event is on a calendar that isn't yours, so TITAN waits for your tap.";

  const RULES_TEXT = {
    auto: [
      "Daybook changes, including removing items you name",
      "Reminders, lists, goals, habits and notes",
      "What TITAN remembers about you",
      "Recording, editing or removing money entries, whatever the amount",
      "Creating and editing your Office documents",
      "Events on your own calendar that don't invite anyone else",
      "Saving email drafts: they are never sent on their own",
      "Routines and Guardian watches",
      "Opening apps, folders and web links on your PC",
      "Command Center layout settings",
      "When Ask first is on, all of these wait for your tap too",
    ],
    tap: [
      "Sending any WhatsApp, SMS or email: TITAN prepares it, you press Send",
      "Calendar events or invitations that include other people",
      "Restarting, shutting down or locking your PC",
      "Tidying your Downloads folder",
      "Clearing a whole day from your daybook",
      "Erasing all your data",
      "Downloading anything",
      "Changes to other apps through connectors",
      "Changes to TITAN's own code",
      "Anything TITAN doesn't recognise yet",
    ],
    never: [
      "Payments, transfers, trades or purchases",
      "Permanently deleting anything",
      "Entering passwords or keys",
      "Changing its own safety rules",
      "Anything triggered by text inside emails, web pages, documents or news",
    ],
  };

  const TIER_LABELS = {
    auto: "Does it right away",
    tap: "Waits for your tap",
    never: "Never allowed",
  };

  const IMPLAUSIBLE_AMOUNT_CEILING = 1000000;
  const IMPLAUSIBLE_MEDIAN_MULTIPLE = 20;
  const IMPLAUSIBLE_MIN_HISTORY = 3;

  const DEFAULT_JOURNAL_MAX = 500;
  const DEFAULT_TIME_ZONE = "Asia/Riyadh";
  const RIYADH_OFFSET_MINUTES = 180; // UTC+3, no daylight saving
  const UNDO_TYPE = "undo";

  // A well-formed action type: dotted names made of letters, digits, "_" or "-".
  const VALID_TYPE = /^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*$/;

  // Pre-split, lower-cased patterns so matching is case-insensitive
  // ("daybook.clearday" must still hit the tap rule, not fall through to auto).
  function compileRules(rules) {
    return rules.map(function (rule) {
      return Object.assign({}, rule, {
        compiled: rule.patterns.map(function (p) {
          return p.toLowerCase().split(".");
        }),
      });
    });
  }

  const COMPILED_NEVER = compileRules(NEVER_RULES);
  const COMPILED_TAP = compileRules(TAP_RULES);
  const COMPILED_AUTO = compileRules(AUTO_RULES);
  const CALENDAR_EVENT_PATTERN = ["calendar", "event", "*"];

  function patternsOf(rules) {
    return rules.reduce(function (all, rule) {
      return all.concat(rule.patterns);
    }, []);
  }

  const CATALOG = {
    auto: patternsOf(AUTO_RULES),
    tap: patternsOf(TAP_RULES),
    never: patternsOf(NEVER_RULES),
  };

  // ---------------------------------------------------------------------------
  // Small helpers
  // ---------------------------------------------------------------------------

  function deepFreeze(value) {
    if (value && typeof value === "object" && !Object.isFrozen(value)) {
      Object.freeze(value);
      Object.keys(value).forEach(function (key) {
        deepFreeze(value[key]);
      });
    }
    return value;
  }

  // "*" matches zero or more segments.
  function segmentsMatch(pattern, segments, pi, si) {
    if (pi === pattern.length) return si === segments.length;
    if (pattern[pi] === "*") {
      for (let k = si; k <= segments.length; k += 1) {
        if (segmentsMatch(pattern, segments, pi + 1, k)) return true;
      }
      return false;
    }
    return (
      si < segments.length &&
      pattern[pi] === segments[si] &&
      segmentsMatch(pattern, segments, pi + 1, si + 1)
    );
  }

  function findRule(rules, segments) {
    for (const rule of rules) {
      for (const pattern of rule.compiled) {
        if (segmentsMatch(pattern, segments, 0, 0)) return rule;
      }
    }
    return null;
  }

  function decision(tier, reason, category) {
    return { tier: tier, reason: reason, category: category };
  }

  function isPositiveFiniteNumber(value) {
    return typeof value === "number" && Number.isFinite(value) && value > 0;
  }

  function median(numbers) {
    const sorted = numbers.slice().sort(function (a, b) {
      return a - b;
    });
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 1
      ? sorted[mid]
      : (sorted[mid - 1] + sorted[mid]) / 2;
  }

  // Missing settings or a missing flag mean autonomous; anything other than
  // exactly true counts as "Ask first" (fail safe).
  function isAutonomous(settings) {
    if (settings === undefined || settings === null) return true;
    if (typeof settings !== "object") return false;
    if (settings.autonomous === undefined) return true;
    return settings.autonomous === true;
  }

  function calendarNeedsTap(params) {
    if (!params || typeof params !== "object") return null;
    const attendees = params.attendees;
    const noAttendees =
      attendees === undefined ||
      attendees === null ||
      (Array.isArray(attendees) && attendees.length === 0);
    if (!noAttendees) return CALENDAR_ATTENDEES_REASON;
    if (params.ownCalendar === false) return CALENDAR_NOT_OWN_REASON;
    return null;
  }

  // ---------------------------------------------------------------------------
  // Public: classification
  // ---------------------------------------------------------------------------

  /**
   * Tells whether an action's source is untrusted content.
   * Only "user", "voice", "typed", "chat" (any case) or a missing source
   * (undefined / null) are trusted. Every other value, including unknown
   * sources and empty strings, is untrusted (fail safe).
   *
   * @param {*} source - action.source as set by the integrator.
   * @returns {boolean} true when TITAN must not act on it.
   */
  function isUntrustedSource(source) {
    if (source === undefined || source === null) return false;
    if (typeof source !== "string") return true;
    return TRUSTED_SOURCES.indexOf(source.trim().toLowerCase()) === -1;
  }

  /**
   * Decides how TITAN may perform an action.
   *
   * Order of checks: untrusted source -> NEVER rules -> TAP rules (including a
   * calendar event that invites anyone) -> AUTO rules -> unknown (tap).
   * AUTO actions become "tap" when settings.autonomous is false ("Ask first").
   * They also become "tap" when the turn that proposed them had quoted,
   * untrusted text in the model's context (for example excerpts from the
   * user's Claude history): pass action.untrustedContent = true or
   * settings.untrustedContent = true (any truthy value counts, so a count of
   * excerpts works too). Text the model read can then never make
   * a change on its own, even though the user started the turn.
   *
   * Calendar: "calendar.event.*" is auto only when params.attendees is missing,
   * null or an empty array; any other value means other people are invited and
   * the action waits for a tap. Pass params.ownCalendar = false for events on a
   * calendar that isn't the user's own; those wait for a tap too.
   *
   * Type matching is case-insensitive. Malformed or unknown types are "tap",
   * never "auto".
   *
   * @param {{type: string, params?: object, source?: string, untrustedContent?: boolean}} action
   * @param {{autonomous?: boolean, untrustedContent?: boolean}} [settings] - defaults to autonomous ON.
   * @returns {{tier: "auto"|"tap"|"never", reason: string, category: string}}
   *   reason is one plain-English sentence for the user.
   */
  function classify(action, settings) {
    const act = action && typeof action === "object" ? action : {};

    if (isUntrustedSource(act.source)) {
      const known =
        typeof act.source === "string" &&
        UNTRUSTED_SOURCES.indexOf(act.source.trim().toLowerCase()) !== -1;
      return decision(
        "never",
        known ? UNTRUSTED_REASON : UNVERIFIED_SOURCE_REASON,
        "untrusted-source",
      );
    }

    const type = typeof act.type === "string" ? act.type.trim() : "";

    // NEVER is checked on a loosely split name, so even a malformed type such
    // as "payment..send" is refused rather than merely asked about.
    const looseSegments = type.toLowerCase().split(".").filter(Boolean);
    const neverRule = findRule(COMPILED_NEVER, looseSegments);
    if (neverRule)
      return decision("never", neverRule.reason, neverRule.category);

    if (!VALID_TYPE.test(type))
      return decision("tap", UNKNOWN_ACTION_REASON, "unknown");
    const segments = type.toLowerCase().split(".");

    const tapRule = findRule(COMPILED_TAP, segments);
    if (tapRule) return decision("tap", tapRule.reason, tapRule.category);

    if (segmentsMatch(CALENDAR_EVENT_PATTERN, segments, 0, 0)) {
      const calendarReason = calendarNeedsTap(act.params);
      if (calendarReason === CALENDAR_ATTENDEES_REASON)
        return decision("tap", calendarReason, "calendar-invite");
      if (calendarReason) return decision("tap", calendarReason, "calendar");
    }

    const autoRule = findRule(COMPILED_AUTO, segments);
    if (autoRule) {
      // Fail safe: any truthy value counts (true, a count of excerpts, "yes"…).
      // Only false, 0, "", null and undefined mean nothing quoted was in context.
      const tainted =
        Boolean(act.untrustedContent) ||
        (settings !== null &&
          typeof settings === "object" &&
          Boolean(settings.untrustedContent));
      if (tainted)
        return decision("tap", UNTRUSTED_CONTEXT_REASON, autoRule.category);
      if (isAutonomous(settings))
        return decision("auto", autoRule.reason, autoRule.category);
      return decision(
        "tap",
        "Ask first is on, so TITAN waits for your tap before " +
          autoRule.what +
          ".",
        autoRule.category,
      );
    }

    return decision("tap", UNKNOWN_ACTION_REASON, "unknown");
  }

  /**
   * Tests one action type against one catalog pattern, the same way
   * classify() does. Handy for checking how TITAN's real action names map.
   *
   * @param {string} type - e.g. "daybook.move".
   * @param {string} pattern - e.g. "daybook.*" or "*.permanentDelete".
   * @returns {boolean}
   */
  function matchesPattern(type, pattern) {
    if (typeof type !== "string" || typeof pattern !== "string") return false;
    const segments = type.trim().toLowerCase().split(".");
    return segmentsMatch(
      pattern.trim().toLowerCase().split("."),
      segments,
      0,
      0,
    );
  }

  /**
   * Short user-facing label for a tier.
   *
   * @param {"auto"|"tap"|"never"} tier
   * @returns {string} "Does it right away", "Waits for your tap",
   *   "Never allowed", or "Unknown" for anything else.
   */
  function describeTier(tier) {
    return Object.prototype.hasOwnProperty.call(TIER_LABELS, tier)
      ? TIER_LABELS[tier]
      : "Unknown";
  }

  // ---------------------------------------------------------------------------
  // Public: money plausibility
  // ---------------------------------------------------------------------------

  /**
   * Mishearing check for spoken money amounts. Returns true when TITAN should
   * ask "Did you mean <amount>?" before recording it.
   *
   * True when the amount is not a finite positive number, when it is
   * 1,000,000 or more, or when there are at least 3 valid recent amounts and
   * it is more than 20 times their median.
   *
   * This only decides whether to ASK. It never blocks by size: there is no
   * amount limit. If TITAN already has its own implausible-number question,
   * keep that one and use this only as a fallback.
   *
   * @param {number} amount - the amount as heard.
   * @param {number[]} [recentAmounts] - recent recorded amounts; invalid
   *   entries are ignored.
   * @returns {boolean}
   */
  function isImplausibleAmount(amount, recentAmounts) {
    if (!isPositiveFiniteNumber(amount)) return true;
    if (amount >= IMPLAUSIBLE_AMOUNT_CEILING) return true;
    const history = Array.isArray(recentAmounts)
      ? recentAmounts.filter(isPositiveFiniteNumber)
      : [];
    return (
      history.length >= IMPLAUSIBLE_MIN_HISTORY &&
      amount > IMPLAUSIBLE_MEDIAN_MULTIPLE * median(history)
    );
  }

  // ---------------------------------------------------------------------------
  // Journal helpers
  // ---------------------------------------------------------------------------

  function asText(value) {
    return value === undefined || value === null ? "" : String(value);
  }

  // Copies plain data so callers can't change journal entries by reference.
  function cloneData(value) {
    if (value === undefined) return null;
    if (value === null || typeof value !== "object") return value;
    try {
      if (typeof structuredClone === "function") return structuredClone(value);
    } catch (err) {
      /* fall through to JSON */
    }
    try {
      return JSON.parse(JSON.stringify(value));
    } catch (err) {
      return value;
    }
  }

  function toTimeMs(dateLike) {
    if (dateLike === undefined || dateLike === null || dateLike === "")
      return null;
    const ms =
      dateLike instanceof Date
        ? dateLike.getTime()
        : new Date(dateLike).getTime();
    return Number.isFinite(ms) ? ms : null;
  }

  function pad2(n) {
    return (n < 10 ? "0" : "") + n;
  }

  // Day keys ("2026-10-07") and clock labels ("7:40 PM") in one time zone.
  function createIntlClock(timeZone) {
    try {
      const dayFormat = new Intl.DateTimeFormat("en-US", {
        timeZone: timeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      });
      const timeFormat = new Intl.DateTimeFormat("en-US", {
        timeZone: timeZone,
        hour: "numeric",
        minute: "2-digit",
        hour12: true,
      });
      dayFormat.format(new Date(0));
      return {
        dayKey: function (date) {
          const parts = {};
          dayFormat.formatToParts(date).forEach(function (p) {
            parts[p.type] = p.value;
          });
          return parts.year + "-" + parts.month + "-" + parts.day;
        },
        // Newer ICU puts a narrow no-break space before "PM"; use a plain space.
        timeLabel: function (date) {
          return timeFormat.format(date).replace(/[  ]/g, " ");
        },
      };
    } catch (err) {
      return null;
    }
  }

  // Used only if Intl time zones are unavailable: Riyadh is a fixed UTC+3.
  function createFixedOffsetClock(offsetMinutes) {
    function shifted(date) {
      return new Date(date.getTime() + offsetMinutes * 60000);
    }
    return {
      dayKey: function (date) {
        const d = shifted(date);
        return (
          d.getUTCFullYear() +
          "-" +
          pad2(d.getUTCMonth() + 1) +
          "-" +
          pad2(d.getUTCDate())
        );
      },
      timeLabel: function (date) {
        const d = shifted(date);
        const hours = d.getUTCHours();
        return (
          (hours % 12 === 0 ? 12 : hours % 12) +
          ":" +
          pad2(d.getUTCMinutes()) +
          (hours < 12 ? " AM" : " PM")
        );
      },
    };
  }

  function normalizeStoredEntry(raw) {
    if (!raw || typeof raw !== "object") return null;
    if (typeof raw.id !== "string" || raw.id === "") return null;
    const atMs = toTimeMs(raw.at);
    if (atMs === null) return null;
    const entry = {
      id: raw.id,
      at: new Date(atMs).toISOString(),
      type: asText(raw.type) || "change",
      summary: asText(raw.summary),
      before: asText(raw.before),
      after: asText(raw.after),
      target: cloneData(raw.target),
      auto: raw.auto !== false,
      undone: raw.undone === true,
    };
    if (typeof raw.undoneAt === "string") entry.undoneAt = raw.undoneAt;
    if (typeof raw.undoOf === "string") entry.undoOf = raw.undoOf;
    return entry;
  }

  function copyEntry(entry) {
    return Object.assign({}, entry, { target: cloneData(entry.target) });
  }

  function errorReason(err) {
    let text = "";
    if (err && typeof err.message === "string") text = err.message.trim();
    else if (typeof err === "string") text = err.trim();
    return text || "something went wrong while reversing it.";
  }

  function oneLine(text) {
    return text.replace(/\s*[\r\n]+\s*/g, " ");
  }

  // ---------------------------------------------------------------------------
  // Public: journal
  // ---------------------------------------------------------------------------

  /**
   * Creates a journal of autonomous changes with before/after and Undo.
   *
   * Storage is optional and never throws to the caller: load() and save() are
   * wrapped in try/catch, and a rejected promise from save() is ignored.
   *
   * @param {object} [options]
   * @param {() => Array} [options.load] - returns previously saved entries
   *   (synchronously; a JSON string is also accepted).
   * @param {(entries: Array) => void} [options.save] - called with a copy of
   *   all entries (oldest first) after every change.
   * @param {() => Date} [options.now] - clock, for tests.
   * @param {number} [options.max=500] - oldest entries are dropped beyond this.
   * @param {string} [options.timeZone="Asia/Riyadh"] - zone for the evening
   *   review's day and times.
   * @returns {{
   *   record: function, list: function, undo: function,
   *   countSince: function, correctionsSince: function, eveningReview: function
   * }}
   */
  function createJournal(options) {
    const opts = options && typeof options === "object" ? options : {};
    const load = typeof opts.load === "function" ? opts.load : null;
    const save = typeof opts.save === "function" ? opts.save : null;
    const nowFn = typeof opts.now === "function" ? opts.now : null;
    const max =
      Number.isInteger(opts.max) && opts.max > 0
        ? opts.max
        : DEFAULT_JOURNAL_MAX;
    const timeZone =
      typeof opts.timeZone === "string" && opts.timeZone
        ? opts.timeZone
        : DEFAULT_TIME_ZONE;
    const clock =
      createIntlClock(timeZone) ||
      createIntlClock(DEFAULT_TIME_ZONE) ||
      createFixedOffsetClock(RIYADH_OFFSET_MINUTES);

    const pendingUndos = new Set();
    let idCounter = 0;
    let entries = loadEntries();

    function currentTime() {
      let value = null;
      try {
        value = nowFn ? nowFn() : new Date();
      } catch (err) {
        value = null;
      }
      const ms = toTimeMs(value);
      return ms === null ? new Date() : new Date(ms);
    }

    function loadEntries() {
      let raw = [];
      try {
        raw = load ? load() : [];
        if (typeof raw === "string") raw = JSON.parse(raw);
      } catch (err) {
        raw = [];
      }
      if (!Array.isArray(raw)) return [];
      const seen = new Set();
      const loaded = [];
      raw.forEach(function (item) {
        const entry = normalizeStoredEntry(item);
        if (entry && !seen.has(entry.id)) {
          seen.add(entry.id);
          loaded.push(entry);
        }
      });
      return loaded.slice(Math.max(0, loaded.length - max));
    }

    function persist() {
      if (!save) return;
      try {
        const result = save(entries.map(copyEntry));
        if (result && typeof result.then === "function")
          result.then(undefined, function () {});
      } catch (err) {
        /* storage failure must not reach the caller */
      }
    }

    function trimToMax() {
      if (entries.length > max) entries = entries.slice(entries.length - max);
    }

    function newId(atDate) {
      let id;
      do {
        idCounter += 1;
        id =
          "chg_" +
          atDate.getTime().toString(36) +
          "_" +
          idCounter.toString(36) +
          Math.random().toString(36).slice(2, 8);
      } while (
        entries.some(function (e) {
          return e.id === id;
        })
      );
      return id;
    }

    function findEntry(id) {
      for (const entry of entries) {
        if (entry.id === id) return entry;
      }
      return null;
    }

    function append(entry) {
      entries.push(entry);
      trimToMax();
      persist();
    }

    /**
     * Records one change. Strings are stored exactly as given (escape them
     * when rendering, not here); undefined/null become "".
     *
     * @param {object} change
     * @param {string} change.type - e.g. "daybook.move".
     * @param {string} change.summary - e.g. "Moved 'Run' to 7:00 PM".
     * @param {string} [change.before] - e.g. "Run 18:00", or "" if nothing existed.
     * @param {string} [change.after] - e.g. "Run 19:00".
     * @param {*} [change.target] - plain data identifying what changed, for Undo.
     * @param {boolean} [change.auto=true] - false when the user tapped to allow it.
     * @returns {object} a copy of the stored entry, with id, at (ISO time) and undone:false.
     */
    function record(change) {
      const input = change && typeof change === "object" ? change : {};
      const at = currentTime();
      const entry = {
        id: newId(at),
        at: at.toISOString(),
        type: asText(input.type) || "change",
        summary: asText(input.summary),
        before: asText(input.before),
        after: asText(input.after),
        target: cloneData(input.target),
        auto: input.auto !== false,
        undone: false,
      };
      append(entry);
      return copyEntry(entry);
    }

    /**
     * Lists entries, newest first.
     *
     * @param {{since?: Date|string}} [query] - only entries at or after this time.
     * @returns {object[]} copies of the entries.
     */
    function list(query) {
      const sinceMs = toTimeMs(
        query && typeof query === "object" ? query.since : undefined,
      );
      return entries
        .map(function (entry, index) {
          return { entry: entry, index: index, ms: Date.parse(entry.at) };
        })
        .filter(function (item) {
          return sinceMs === null || item.ms >= sinceMs;
        })
        .sort(function (a, b) {
          return b.ms - a.ms || b.index - a.index;
        })
        .map(function (item) {
          return copyEntry(item.entry);
        });
    }

    /**
     * Undoes one change. Calls `await applyInverse(entry)`, which must return
     * true only when the app confirmed the reverse change. Then the entry is
     * marked undone and an "undo" entry ("Undid: <summary>", before/after
     * swapped) is recorded. Otherwise nothing in the journal changes.
     *
     * @param {string} id
     * @param {(entry: object) => (boolean|Promise<boolean>)} applyInverse
     * @returns {Promise<{ok: boolean, message: string}>} on failure the message
     *   starts with "Nothing was changed — "; a second undo gives "Already undone".
     */
    async function undo(id, applyInverse) {
      const entry = findEntry(id);
      if (!entry) {
        return {
          ok: false,
          message:
            "Nothing was changed — TITAN couldn't find that change in the journal.",
        };
      }
      if (entry.type === UNDO_TYPE) {
        return {
          ok: false,
          message: "Nothing was changed — this entry is already an undo.",
        };
      }
      if (entry.undone) return { ok: false, message: "Already undone" };
      if (pendingUndos.has(entry.id)) {
        return {
          ok: false,
          message: "Nothing was changed — this change is already being undone.",
        };
      }
      if (typeof applyInverse !== "function") {
        return {
          ok: false,
          message:
            "Nothing was changed — TITAN doesn't know how to reverse this change.",
        };
      }

      pendingUndos.add(entry.id);
      let confirmed = false;
      try {
        confirmed = (await applyInverse(copyEntry(entry))) === true;
      } catch (err) {
        return {
          ok: false,
          message: "Nothing was changed — " + errorReason(err),
        };
      } finally {
        pendingUndos.delete(entry.id);
      }
      if (!confirmed) {
        return {
          ok: false,
          message:
            "Nothing was changed — the app didn't confirm the change was reversed.",
        };
      }

      const at = currentTime();
      entry.undone = true;
      entry.undoneAt = at.toISOString();
      append({
        id: newId(at),
        at: at.toISOString(),
        type: UNDO_TYPE,
        summary: "Undid: " + entry.summary,
        before: entry.after,
        after: entry.before,
        target: cloneData(entry.target),
        auto: false,
        undone: false,
        undoOf: entry.id,
      });
      return { ok: true, message: "Undid: " + entry.summary };
    }

    function countWhere(date, wantUndo) {
      const sinceMs = toTimeMs(date);
      return entries.filter(function (entry) {
        return (
          (entry.type === UNDO_TYPE) === wantUndo &&
          (sinceMs === null || Date.parse(entry.at) >= sinceMs)
        );
      }).length;
    }

    /**
     * Number of changes (non-undo entries) at or after `date`, for the
     * "changes made this week" counter. A missing or invalid date counts all.
     *
     * @param {Date|string} date
     * @returns {number}
     */
    function countSince(date) {
      return countWhere(date, false);
    }

    /**
     * Number of undo entries at or after `date`, for the "corrections" counter.
     * A missing or invalid date counts all.
     *
     * @param {Date|string} date
     * @returns {number}
     */
    function correctionsSince(date) {
      return countWhere(date, true);
    }

    function describeChange(entry) {
      const before = oneLine(entry.before);
      const after = oneLine(entry.after);
      if (before && after) return " (" + before + " → " + after + ")";
      if (after) return " (added: " + after + ")";
      if (before) return " (removed: " + before + ")";
      return "";
    }

    /**
     * Plain-text evening review of one day's autonomous changes (entries with
     * auto !== false, undo entries excluded), oldest first, one per line:
     * "• 7:40 PM — Moved 'Run' (Run 18:00 → Run 19:00)", with "(undone)" added
     * when reversed. The day and times use the journal's time zone
     * (Asia/Riyadh by default). The text is not HTML-escaped.
     *
     * @param {Date|string|number} [dateLike] - any time on the day, or "YYYY-MM-DD";
     *   defaults to today.
     * @returns {string} the lines, or "TITAN made no changes today." when there
     *   are none today ("TITAN made no changes that day." for another day).
     */
    function eveningReview(dateLike) {
      const today = clock.dayKey(currentTime());
      let dayKey = today;
      if (
        typeof dateLike === "string" &&
        /^\d{4}-\d{2}-\d{2}$/.test(dateLike.trim())
      ) {
        dayKey = dateLike.trim();
      } else {
        const ms = toTimeMs(dateLike);
        if (ms !== null) dayKey = clock.dayKey(new Date(ms));
      }

      const lines = entries
        .map(function (entry, index) {
          return { entry: entry, index: index, date: new Date(entry.at) };
        })
        .filter(function (item) {
          return (
            item.entry.type !== UNDO_TYPE &&
            item.entry.auto !== false &&
            clock.dayKey(item.date) === dayKey
          );
        })
        .sort(function (a, b) {
          return a.date - b.date || a.index - b.index;
        })
        .map(function (item) {
          const entry = item.entry;
          return (
            "• " +
            clock.timeLabel(item.date) +
            " — " +
            oneLine(entry.summary) +
            describeChange(entry) +
            (entry.undone ? " (undone)" : "")
          );
        });

      if (lines.length === 0) {
        return dayKey === today
          ? "TITAN made no changes today."
          : "TITAN made no changes that day.";
      }
      return lines.join("\n");
    }

    return Object.freeze({
      record: record,
      list: list,
      undo: undo,
      countSince: countSince,
      correctionsSince: correctionsSince,
      eveningReview: eveningReview,
    });
  }

  // ---------------------------------------------------------------------------
  // Exports (frozen so nothing at runtime can loosen the policy)
  // ---------------------------------------------------------------------------

  return deepFreeze({
    CATALOG: CATALOG,
    TRUSTED_SOURCES: TRUSTED_SOURCES,
    UNTRUSTED_SOURCES: UNTRUSTED_SOURCES,
    RULES_TEXT: RULES_TEXT,
    classify: classify,
    isUntrustedSource: isUntrustedSource,
    matchesPattern: matchesPattern,
    describeTier: describeTier,
    isImplausibleAmount: isImplausibleAmount,
    createJournal: createJournal,
  });
});
