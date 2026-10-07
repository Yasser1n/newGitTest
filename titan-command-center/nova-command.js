/*
 * nova-command.js — TITAN · AI OS Command Center
 *
 * Renders the "AI Command Center" design (sidebar + Command Center page + AI Agents page)
 * as TITAN's main screen, with TITAN's existing chat/voice element docked on the right
 * (a bottom sheet + floating mic button under 940px wide, with a bottom tab bar).
 *
 * The module never reads TITAN's data files and never receives private values. voice-agent.html
 * builds a plain "snapshot" object (shape below and in INTEGRATION.md) and hands it over through
 * mount({ getSnapshot }) / controller.render(snapshot).
 *
 * Works as a classic <script> (window.NovaCommand) and under Node (module.exports) so the
 * number logic in compute() can be unit-tested without a browser.
 */
(function (root, factory) {
  var api = factory(root);
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root && root.document) root.NovaCommand = api;
})(typeof window !== "undefined" ? window : globalThis, function (root) {
  "use strict";

  var VERSION = "1.0.0";
  var DEFAULT_TZ = "Asia/Riyadh";
  var CLASSIC_PREF = "titan.cc.view"; // localStorage: "classic" | "command"
  var DOCK_PREF = "titan.cc.dock"; // localStorage: "open" | "closed"

  /* ======================================================================
   * SNAPSHOT shape (every field optional; missing data shows an empty state)
   * {
   *   now, tz, weekStartsOn (0 = Sunday),
   *   titan: { state: "idle"|"listening"|"thinking"|"speaking"|"working", workingOn,
   *            autonomous, changesThisWeek, corrections, tools: [{ name, connected }],
   *            pendingTaps: [{ id, text }], mic: "ready"|"unavailable"|"blocked" },
   *   knowledge: NovaKnowledge.toSnapshot(index.stats(), now) → { connected, projects, docs,
   *            conversations, messages, memories, redactions, importedAt, newest,
   *            truncated, stale }  (counts and dates only; never any content)
   *   activity: [{ id, at, summary, before, after, type, undoable, undone }],
   *   tasks: [{ id, title, area, status, due, doneAt }],
   *   money: { metrics: { netWorth, income, savingsRate, emergencyMonths, currency },
   *            history: [{ month: "YYYY-MM", netWorth }], wealthTarget,
   *            budgets: [{ name, spent, limit }] },
   *   health: { moods: [{ date, score }], moodMax, habits: [{ name, health, log, target }],
   *             runs: [{ date }], runTarget, source: { sleepHours, steps } | null },
   *   reminders: [{ id, text, at }],
   *   importantDates: [{ name, date }],
   *   daybook: { activity: { "YYYY-MM-DD": count } }
   * }
   * ====================================================================== */

  /* ---------------- small helpers ---------------- */
  var ESC_MAP = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
    "`": "&#96;",
  };
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"'`]/g, function (c) {
      return ESC_MAP[c];
    });
  }
  function num(v) {
    if (typeof v === "number" && isFinite(v)) return v;
    if (typeof v === "string" && v.trim() !== "" && isFinite(Number(v)))
      return Number(v);
    return null;
  }
  function clamp(v, a, b) {
    return Math.max(a, Math.min(b, v));
  }
  function arr(v) {
    return Array.isArray(v) ? v : [];
  }
  function trunc(s, n) {
    s = String(s == null ? "" : s);
    return s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s;
  }
  var NF0 = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
  function money(v) {
    return v == null ? "—" : NF0.format(Math.round(v));
  }
  function moneyShort(v) {
    if (v == null) return "—";
    var a = Math.abs(v);
    if (a >= 1e6) return (v / 1e6).toFixed(2).replace(/\.?0+$/, "") + "M";
    if (a >= 1e4) return (v / 1e3).toFixed(1).replace(/\.0$/, "") + "K";
    return NF0.format(Math.round(v));
  }
  function pct(v) {
    return v == null ? "—" : Math.round(v * 100) + "%";
  }
  function cssEsc(s) {
    return root.CSS && root.CSS.escape
      ? root.CSS.escape(String(s))
      : String(s).replace(/["\\]/g, "\\$&");
  }

  /* ---------------- dates (in TITAN's time zone) ---------------- */
  function safeTz(tz) {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: tz }).format(new Date());
      return tz;
    } catch (e) {
      return undefined;
    }
  }
  function partsInTz(date, tz) {
    var p = {};
    new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(date)
      .forEach(function (x) {
        p[x.type] = x.value;
      });
    return {
      ds: p.year + "-" + p.month + "-" + p.day,
      h: +p.hour % 24,
      m: +p.minute,
    };
  }
  var DS_RE = /^\d{4}-\d{2}-\d{2}$/;
  function toDs(v, tz) {
    if (v == null || v === "") return null;
    if (typeof v === "string" && DS_RE.test(v)) return v;
    var d = v instanceof Date ? v : new Date(v);
    if (isNaN(d.getTime())) return null;
    return partsInTz(d, tz).ds;
  }
  function toTime(v) {
    if (v == null || v === "") return null;
    var d = v instanceof Date ? v : new Date(v);
    return isNaN(d.getTime()) ? null : d.getTime();
  }
  function parseDs(ds) {
    var a = ds.split("-").map(Number);
    return Date.UTC(a[0], a[1] - 1, a[2]);
  }
  function addDays(ds, n) {
    return new Date(parseDs(ds) + n * 864e5).toISOString().slice(0, 10);
  }
  function dow(ds) {
    return new Date(parseDs(ds)).getUTCDay();
  }
  function diffDays(a, b) {
    return Math.round((parseDs(b) - parseDs(a)) / 864e5);
  }
  function fmtDs(ds, o) {
    return new Date(parseDs(ds) + 12 * 36e5).toLocaleDateString(
      "en-GB",
      Object.assign({ timeZone: "UTC" }, o),
    );
  }
  function hijri(ds) {
    try {
      return new Intl.DateTimeFormat("en-u-ca-islamic-umalqura", {
        timeZone: "UTC",
        day: "numeric",
        month: "long",
        year: "numeric",
      }).format(new Date(parseDs(ds) + 12 * 36e5));
    } catch (e) {
      return "";
    }
  }
  function clock(ms, tz) {
    return new Date(ms).toLocaleTimeString("en-US", {
      timeZone: tz,
      hour: "numeric",
      minute: "2-digit",
    });
  }
  function dayWord(ds, today) {
    var n = diffDays(today, ds);
    if (n === 0) return "Today";
    if (n === 1) return "Tomorrow";
    if (n === -1) return "Yesterday";
    if (n > 1 && n < 7) return fmtDs(ds, { weekday: "long" });
    return fmtDs(ds, { day: "numeric", month: "short" });
  }
  function monthShort(id) {
    var a = String(id || "")
      .split("-")
      .map(Number);
    if (!a[0] || !a[1]) return String(id || "");
    return new Date(Date.UTC(a[0], a[1] - 1, 1)).toLocaleString("en-US", {
      month: "short",
      timeZone: "UTC",
    });
  }
  function monthLong(id) {
    var a = String(id || "")
      .split("-")
      .map(Number);
    if (!a[0] || !a[1]) return String(id || "");
    return new Date(Date.UTC(a[0], a[1] - 1, 1)).toLocaleString("en-US", {
      month: "long",
      year: "numeric",
      timeZone: "UTC",
    });
  }
  /** Next occurrence on/after `today`. Accepts "YYYY-MM-DD" (kept as is) or "MM-DD" (repeats yearly). */
  function nextOccurrence(v, today, tz) {
    if (typeof v === "string" && /^\d{2}-\d{2}$/.test(v)) {
      var y = Number(today.slice(0, 4)),
        ds = y + "-" + v;
      return ds < today ? y + 1 + "-" + v : ds;
    }
    return toDs(v, tz);
  }

  /* ---------------- TITAN's rules (fallback copy of NovaAutonomy.RULES_TEXT) ---------------- */
  var RULES_FALLBACK = {
    auto: [
      "Daybook changes, including removing items you name",
      "Reminders, lists, goals, habits, notes and memory",
      "Money records (no amount limit; it still asks if a number sounds misheard)",
      "Office documents",
      "Events on your own calendar that have no other people",
      "Email drafts, saved as drafts and never sent",
      "Routines and Guardian watches",
      "Opening an app, folder or web page on your PC",
      "Command Center layout settings",
    ],
    tap: [
      "Sending any WhatsApp, SMS or email: TITAN prepares it, you press Send",
      "Calendar invites that include other people",
      "Restarting, shutting down or locking the PC, or organizing Downloads",
      "Clearing a whole day or erasing everything",
      "Downloads",
      "Connector actions that change other apps",
      "Changes to TITAN's own code",
    ],
    never: [
      "Payments, transfers, trades or purchases",
      "Permanent deletion",
      "Entering passwords or keys",
      "Changing its own safety rules",
      "Anything triggered by text inside emails, web pages, documents or news",
    ],
  };
  function rulesText(opts) {
    if (opts && opts.rules) return opts.rules;
    var na = root && root.NovaAutonomy;
    return (na && na.RULES_TEXT) || RULES_FALLBACK;
  }

  /* ---------------- the planned team (copy names/roles/icons from the design; edit freely) ---------------- */
  var ROSTER = [
    {
      id: "brief",
      name: "Morning Brief",
      role: "Daily briefing",
      icon: "☼",
      mission:
        "Prepares a short summary of your day each morning: calendar, reminders and what needs a reply.",
      tools: ["Calendar", "Reminders", "Daybook"],
    },
    {
      id: "finance",
      name: "Finance Agent",
      role: "Money & net worth",
      icon: "◆",
      mission:
        "Keeps income, spending, budgets and net worth up to date from the money records you give TITAN.",
      tools: ["Money records", "Budgets", "Net worth history"],
    },
    {
      id: "coach",
      name: "Business Coach",
      role: "Weekly check-in",
      icon: "✓",
      mission:
        "Reviews the week with you and suggests three next actions for your current goals.",
      tools: ["Goals", "Daybook", "Money records"],
    },
    {
      id: "daybook",
      name: "Daybook Agent",
      role: "Tasks · habits · calendar",
      icon: "✎",
      mission:
        "Keeps tasks, habits, goals and focus sessions organised in the Daybook.",
      tools: ["Daybook", "Habits", "Calendar"],
    },
    {
      id: "store",
      name: "Store Helper",
      role: "Online store",
      icon: "▣",
      mission:
        "Will help prepare product pages and content for an online store.",
      tools: ["Content drafts", "Product research"],
    },
    {
      id: "idea",
      name: "Idea Checker",
      role: "Business idea scoring",
      icon: "◎",
      mission:
        "Will score a business idea against your skills, time and risk before you spend anything.",
      tools: ["Web search", "Goals"],
    },
    {
      id: "rules",
      name: "Rules Checker",
      role: "Permits · tax · registration",
      icon: "§",
      mission:
        "Will check registration, permit and tax rules against current official sources, with dates.",
      tools: ["Web search", "Notes"],
    },
    {
      id: "lead",
      name: "Lead Finder",
      role: "Clients & outreach",
      icon: "↗",
      mission:
        "Will find possible clients and draft outreach for you to review and send yourself.",
      tools: ["Web search", "Email drafts"],
    },
  ];

  /* ======================================================================
   * compute(): turns a snapshot into display numbers. Pure; no DOM.
   * ====================================================================== */
  function isDone(t) {
    return (
      t && (t.status === "done" || t.done === true || t.completed === true)
    );
  }
  function isWork(t) {
    var a = String(t.area || t.cat || t.category || t.list || "").toLowerCase();
    return t.work === true || a === "work" || a === "job" || a === "عمل";
  }
  function logDays(log) {
    // habit logs may be { "YYYY-MM-DD": true } or ["YYYY-MM-DD", ...]
    if (Array.isArray(log)) return log.map(String);
    if (log && typeof log === "object")
      return Object.keys(log).filter(function (k) {
        return !!log[k];
      });
    return [];
  }
  function isHealthHabit(h) {
    if (h.health === true || h.isHealth === true) return true;
    return /health|fitness|sport|exercise|workout|run|صح|رياض/i.test(
      String(h.cat || h.category || h.area || ""),
    );
  }

  function compute(snap, nowArg) {
    var S = snap || {};
    var tz = safeTz(S.tz || DEFAULT_TZ);
    var nowMs = toTime(nowArg != null ? nowArg : S.now) || Date.now();
    var t = partsInTz(new Date(nowMs), tz).ds;
    var wso = num(S.weekStartsOn);
    if (wso == null || wso < 0 || wso > 6) wso = 0;
    var ws = addDays(t, -((dow(t) - wso + 7) % 7)),
      we = addDays(ws, 6);
    var D = {
      tz: tz,
      now: nowMs,
      t: t,
      weekStart: ws,
      weekEnd: we,
      has: !!snap,
    };

    /* header date: always computed from the clock, never hard-coded */
    D.dateLine = fmtDs(t, {
      weekday: "long",
      day: "numeric",
      month: "long",
      year: "numeric",
    });
    D.hijri = hijri(t);

    /* --- tasks --- */
    var tasks = arr(S.tasks)
      .filter(function (x) {
        return x && x.title != null;
      })
      .map(function (x) {
        return Object.assign({}, x, {
          _due: toDs(x.due, tz),
          _doneAt: toDs(x.doneAt, tz),
          _done: isDone(x),
        });
      });
    D.tasks = tasks;
    D.open = tasks.filter(function (x) {
      return !x._done;
    });
    D.overdue = D.open
      .filter(function (x) {
        return x._due && x._due < t;
      })
      .sort(function (a, b) {
        return a._due < b._due ? -1 : 1;
      });
    D.next =
      D.open
        .filter(function (x) {
          return x._due && x._due >= t;
        })
        .sort(function (a, b) {
          return a._due < b._due ? -1 : 1;
        })[0] || null;
    // Job Tasks = work tasks done this week ÷ (done this week + open and due this week)
    var work = tasks.filter(isWork);
    var workDone = work.filter(function (x) {
      return x._done && x._doneAt && x._doneAt >= ws && x._doneAt <= we;
    });
    var workOpenDue = work.filter(function (x) {
      return !x._done && x._due && x._due >= ws && x._due <= we;
    });
    var denom = workDone.length + workOpenDue.length;
    D.job = {
      done: workDone.length,
      openDue: workOpenDue.length,
      total: denom,
      ratio: denom ? workDone.length / denom : null,
      overdue: work.filter(function (x) {
        return !x._done && x._due && x._due < t;
      }).length,
      workCount: work.length,
    };
    D.job.series = Array.from({ length: 7 }, function (_, i) {
      var d = addDays(ws, i);
      return d > t
        ? null
        : workDone.filter(function (x) {
            return x._doneAt === d;
          }).length;
    }).filter(function (v) {
      return v != null;
    });

    /* --- money (the numbers come from TITAN's moneyMetrics) --- */
    var Mo = S.money || {};
    var M = Mo.metrics || {};
    D.currency = String(M.currency || "SAR").slice(0, 6);
    D.netWorth = num(M.netWorth);
    D.income = num(M.income != null ? M.income : M.monthlyIncome);
    var sr = num(M.savingsRate);
    if (sr != null && Math.abs(sr) > 1.5) sr = sr / 100; // accept 23 or 0.23
    D.savingsRate = sr;
    D.emergencyMonths = num(
      M.emergencyMonths != null ? M.emergencyMonths : M.emergencyFundMonths,
    );
    D.wealthTarget = num(Mo.wealthTarget);
    D.wealthProgress =
      D.netWorth != null && D.wealthTarget && D.wealthTarget > 0
        ? D.netWorth / D.wealthTarget
        : null;
    var hist = arr(Mo.history)
      .map(function (h) {
        var v = num(
          h.netWorth != null
            ? h.netWorth
            : h.value != null
              ? h.value
              : h.total != null
                ? h.total
                : h.balance,
        );
        return { month: String(h.month || h.id || "").slice(0, 7), value: v };
      })
      .filter(function (h) {
        return /^\d{4}-\d{2}$/.test(h.month) && h.value != null;
      });
    var byMonth = {};
    hist.forEach(function (h) {
      byMonth[h.month] = h;
    }); // one bar per month
    D.history = Object.keys(byMonth)
      .sort()
      .map(function (k) {
        return byMonth[k];
      })
      .slice(-8);
    D.budgetsOver = arr(Mo.budgets)
      .map(function (b) {
        return {
          name: b.name || b.category || "Budget",
          spent: num(b.spent),
          limit: num(b.limit),
        };
      })
      .filter(function (b) {
        return (
          b.spent != null && b.limit != null && b.limit > 0 && b.spent > b.limit
        );
      });

    /* --- health: 7-day mood + health-habit consistency + runs this week --- */
    var H = S.health || {};
    var moodMax = num(H.moodMax) || 5;
    var d7 = addDays(t, -6);
    var moods = arr(H.moods)
      .map(function (m) {
        return {
          ds: toDs(m.date || m.at, tz),
          v: num(m.score != null ? m.score : m.mood != null ? m.mood : m.value),
        };
      })
      .filter(function (m) {
        return m.ds && m.v != null && m.ds >= d7 && m.ds <= t;
      });
    D.mood = moods.length
      ? {
          avg:
            moods.reduce(function (a, m) {
              return a + m.v;
            }, 0) / moods.length,
          max: moodMax,
          days: moods.length,
        }
      : null;
    var hh = arr(H.habits).filter(isHealthHabit);
    if (hh.length) {
      var per = hh.map(function (h) {
        var c = logDays(h.log || h.days).filter(function (ds) {
          ds = toDs(ds, tz);
          return ds && ds >= d7 && ds <= t;
        }).length;
        var target = num(h.target != null ? h.target : h.perWeek);
        return target ? Math.min(1, c / target) : c / 7;
      });
      D.habitConsistency =
        per.reduce(function (a, b) {
          return a + b;
        }, 0) / per.length;
    } else D.habitConsistency = null;
    D.healthHabitCount = hh.length;
    var runs = arr(H.runs)
      .map(function (r) {
        return toDs(typeof r === "string" ? r : r.date || r.at, tz);
      })
      .filter(function (ds) {
        return ds && ds >= ws && ds <= t;
      });
    D.runsThisWeek = Array.isArray(H.runs) ? runs.length : null;
    D.runTarget = num(H.runTarget);
    D.healthSource = H.source && typeof H.source === "object" ? H.source : null;

    /* --- Daybook activity heatmap + streak (84 days) --- */
    var actRaw = (S.daybook && S.daybook.activity) || {};
    var act = {};
    if (Array.isArray(actRaw))
      actRaw.forEach(function (a) {
        var ds = toDs(a.date, tz);
        if (ds) act[ds] = (act[ds] || 0) + (num(a.count) || 0);
      });
    else
      Object.keys(actRaw).forEach(function (k) {
        var ds = toDs(k, tz);
        if (ds) act[ds] = (act[ds] || 0) + (num(actRaw[k]) || 0);
      });
    D.heat = Array.from({ length: 84 }, function (_, i) {
      var ds = addDays(t, i - 83),
        v = act[ds] || 0;
      return {
        ds: ds,
        v: v,
        lvl: v <= 0 ? 0 : v <= 2 ? 1 : v <= 4 ? 2 : v <= 6 ? 3 : 4,
      };
    });
    var cur = act[t] > 0 ? t : addDays(t, -1),
      streak = 0;
    while (act[cur] > 0 && streak < 3660) {
      streak++;
      cur = addDays(cur, -1);
    }
    D.streak = streak;
    D.activeDays84 = D.heat.filter(function (c) {
      return c.v > 0;
    }).length;
    D.lastActive =
      Object.keys(act)
        .filter(function (ds) {
          return act[ds] > 0 && ds <= t;
        })
        .sort()
        .pop() || null;

    /* --- TITAN (the Director) --- */
    var T = S.titan || {};
    var st = String(T.state || "idle").toLowerCase();
    if (
      ["idle", "listening", "thinking", "speaking", "working"].indexOf(st) < 0
    )
      st = "idle";
    D.titan = {
      state: st,
      workingOn: T.workingOn ? String(T.workingOn) : "",
      autonomous: T.autonomous !== false,
      changesThisWeek: num(T.changesThisWeek),
      corrections: num(T.corrections),
      tools: arr(T.tools)
        .map(function (x) {
          return typeof x === "string"
            ? { name: x, connected: true }
            : {
                name: String((x && x.name) || ""),
                connected: !!(x && x.connected),
              };
        })
        .filter(function (x) {
          return x.name;
        }),
      pendingTaps: arr(T.pendingTaps),
    };
    D.titan.toolsConnected = D.titan.tools.filter(function (x) {
      return x.connected;
    }).length;
    var micSt = String(T.mic || "ready").toLowerCase();
    D.titan.mic =
      ["ready", "unavailable", "blocked"].indexOf(micSt) < 0 ? "ready" : micSt;

    /* --- what TITAN knows from the user's Claude export (counts and dates only) --- */
    var KN = S.knowledge || {};
    D.knowledge = KN.connected
      ? {
          connected: true,
          projects: num(KN.projects) || 0,
          docs: num(KN.docs) || 0,
          conversations: num(KN.conversations) || 0,
          messages: num(KN.messages) || 0,
          memories: num(KN.memories) || 0,
          redactions: num(KN.redactions) || 0,
          importedAt: toDs(KN.importedAt, tz) || "",
          newest: toDs(KN.newest, tz) || "",
          truncated: !!KN.truncated,
          stale: !!KN.stale,
        }
      : { connected: false };
    D.activity = arr(S.activity)
      .filter(function (a) {
        return a && (a.summary || a.text);
      })
      .map(function (a) {
        return {
          id: a.id != null ? String(a.id) : "",
          at: toTime(a.at),
          summary: String(a.summary || a.text),
          before: a.before == null ? "" : String(a.before),
          after: a.after == null ? "" : String(a.after),
          type: String(a.type || ""),
          undone: !!a.undone,
          undoable:
            a.undoable !== false &&
            !a.undone &&
            a.type !== "undo" &&
            a.id != null,
        };
      })
      .sort(function (a, b) {
        return (b.at || 0) - (a.at || 0);
      });
    // counters fall back to the activity list when the snapshot has none
    var wsMs = parseDs(ws) - 4 * 36e5; // start of the week, generous for UTC+3
    if (D.titan.changesThisWeek == null)
      D.titan.changesThisWeek = D.activity.filter(function (a) {
        return a.type !== "undo" && a.at && a.at >= wsMs;
      }).length;
    if (D.titan.corrections == null)
      D.titan.corrections = D.activity.filter(function (a) {
        return a.type === "undo" && a.at && a.at >= wsMs;
      }).length;

    /* --- alerts --- */
    var al = [];
    D.overdue.slice(0, 3).forEach(function (x) {
      var late = diffDays(x._due, t);
      al.push({
        sev: 0,
        tone: "red",
        tag: "Overdue",
        t: x.title,
        s: late + " day" + (late === 1 ? "" : "s") + " late",
      });
    });
    if (D.overdue.length > 3)
      al.push({
        sev: 0.1,
        tone: "red",
        tag: "Overdue",
        t: D.overdue.length - 3 + " more overdue tasks",
        s: "Ask TITAN to reschedule or close them",
      });
    if (D.titan.pendingTaps.length)
      al.push({
        sev: 0.2,
        tone: "amber",
        tag: "Your tap",
        t:
          D.titan.pendingTaps.length +
          " action" +
          (D.titan.pendingTaps.length === 1 ? "" : "s") +
          " waiting for your tap",
        s: trunc(
          (D.titan.pendingTaps[0] && D.titan.pendingTaps[0].text) || "",
          70,
        ),
      });
    D.budgetsOver.forEach(function (b) {
      al.push({
        sev: 1,
        tone: "red",
        tag: "Budget",
        t: b.name + " is over its limit",
        s: money(b.spent) + " of " + money(b.limit) + " " + D.currency,
      });
    });
    if (D.emergencyMonths != null && D.emergencyMonths < 3)
      al.push({
        sev: 1.5,
        tone: "amber",
        tag: "Emergency fund",
        t: "Emergency fund is under 3 months",
        s: D.emergencyMonths.toFixed(1) + " months of spending saved",
      });
    arr(S.reminders).forEach(function (r) {
      var at = toTime(r.at || r.when || r.time);
      if (at != null && at >= nowMs && at <= nowMs + 24 * 36e5)
        al.push({
          sev: 2,
          tone: "blue",
          tag: "Reminder",
          t: String(r.text || r.title || "Reminder"),
          s: dayWord(partsInTz(new Date(at), tz).ds, t) + " · " + clock(at, tz),
          at: at,
        });
    });
    arr(S.importantDates).forEach(function (d) {
      var ds = nextOccurrence(d.date, t, tz);
      if (!ds) return;
      var n = diffDays(t, ds);
      if (n >= 0 && n <= 7)
        al.push({
          sev: 2.5 + n / 100,
          tone: "purple",
          tag: "Important date",
          t: String(d.name || d.title || "Important date"),
          s:
            n === 0
              ? "Today"
              : n === 1
                ? "Tomorrow"
                : "In " +
                  n +
                  " days · " +
                  fmtDs(ds, {
                    weekday: "short",
                    day: "numeric",
                    month: "short",
                  }),
        });
    });
    D.alerts = al.sort(function (a, b) {
      return a.sev - b.sev || (a.at || 0) - (b.at || 0);
    });
    return D;
  }

  /* ======================================================================
   * Styles (scoped to .ncc so TITAN's classic CSS is untouched)
   * ====================================================================== */
  var CSS = [
    ".ncc{--bg:#070a11;--panel:#0e1320;--panel2:#131a2a;--line:rgba(255,255,255,.07);--line2:rgba(255,255,255,.14);--text:#e9eef9;--soft:#b6c1d6;--muted:#8a96ac;--dim:#5b6579;",
    "--blue:#4f8cff;--green:#22c55e;--amber:#f5a524;--red:#f43f5e;--purple:#a855f7;--cyan:#22d3ee;--font:'Inter',system-ui,-apple-system,'Segoe UI',Roboto,'Segoe UI Arabic','Noto Sans Arabic',sans-serif;",
    "color-scheme:dark;display:flex;min-height:100vh;min-height:100dvh;font-family:var(--font);color:var(--text);background:var(--bg);",
    "background-image:radial-gradient(900px 500px at 12% -10%,rgba(79,140,255,.12),transparent 60%),radial-gradient(800px 520px at 98% 0%,rgba(168,85,247,.09),transparent 60%);background-attachment:fixed;-webkit-font-smoothing:antialiased;font-size:14px;line-height:1.4;text-align:left}",
    "html.ncc-on,html.ncc-on body{background:#070a11}",
    "html.ncc-on [data-ncc-classic]{display:none!important}",
    ".ncc *,.ncc *::before,.ncc *::after{box-sizing:border-box}",
    ".ncc button,.ncc input{font:inherit;color:inherit}",
    ".ncc :focus-visible{outline:2px solid var(--blue);outline-offset:2px}",
    ".ncc [hidden]{display:none!important}",
    ".ncc-sr{position:absolute!important;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}",
    /* sidebar */
    ".ncc-side{width:240px;flex:0 0 240px;height:100vh;height:100dvh;position:sticky;top:0;overflow-y:auto;border-right:1px solid var(--line);background:rgba(9,13,21,.72);backdrop-filter:blur(14px);padding:20px 14px;display:flex;flex-direction:column;gap:22px}",
    ".ncc-brand{display:flex;align-items:center;gap:11px;padding:0 6px}",
    ".ncc-logo{width:38px;height:38px;border-radius:11px;display:grid;place-items:center;flex:none;background:linear-gradient(135deg,var(--blue),var(--purple));font-size:18px;color:#fff;box-shadow:0 6px 22px rgba(79,140,255,.35)}",
    ".ncc-brand-name{font-size:13px;font-weight:800;letter-spacing:.14em;white-space:nowrap}",
    ".ncc-brand-sub{font-size:10px;color:var(--muted);letter-spacing:.08em;margin-top:2px}",
    ".ncc-nav{display:flex;flex-direction:column;gap:3px}",
    ".ncc-nav-sep{font-size:9.5px;letter-spacing:.16em;color:#56607a;font-weight:800;padding:14px 12px 6px}",
    ".ncc-nav-item{display:flex;align-items:center;gap:11px;padding:10px 12px;border-radius:9px;border:0;background:transparent;color:var(--muted);font-size:13px;font-weight:600;cursor:pointer;text-align:left;transition:.18s;width:100%}",
    ".ncc-nav-item>span:first-child{width:16px;text-align:center;opacity:.85}",
    ".ncc-nav-item:hover{background:rgba(255,255,255,.045);color:var(--text)}",
    ".ncc-nav-item[aria-current=page]{background:linear-gradient(90deg,rgba(79,140,255,.20),rgba(79,140,255,.03));color:#fff;box-shadow:inset 2px 0 0 var(--blue)}",
    ".ncc-side-foot{margin-top:auto;display:flex;flex-direction:column;gap:10px}",
    ".ncc-sys{border:1px solid var(--line);border-radius:12px;padding:12px;background:linear-gradient(160deg,rgba(79,140,255,.09),rgba(255,255,255,.01))}",
    ".ncc-sys-row{display:flex;justify-content:space-between;gap:8px;font-size:11px;margin-bottom:8px}",
    ".ncc-sys-row:last-child{margin-bottom:0}",
    ".ncc-sys-row b{color:var(--muted);font-weight:600}",
    ".ncc-sys-row i{font-style:normal;font-weight:700;font-variant-numeric:tabular-nums}",
    /* main */
    ".ncc-main{flex:1;min-width:0;padding:22px 24px 70px;container-type:inline-size;container-name:nccmain}",
    ".ncc-top{display:flex;align-items:center;justify-content:space-between;gap:14px 20px;margin-bottom:20px;flex-wrap:wrap}",
    ".ncc-title{font-size:21px;font-weight:800;letter-spacing:-.4px;margin:0}",
    ".ncc-sub{font-size:12px;color:var(--muted);margin-top:4px}",
    ".ncc-actions{display:flex;align-items:center;gap:10px;flex-wrap:wrap;min-width:0}",
    ".ncc-pill{display:inline-flex;align-items:center;gap:7px;white-space:nowrap;padding:7px 13px;border-radius:999px;font-size:11px;font-weight:700;letter-spacing:.04em;border:1px solid var(--line2);background:rgba(255,255,255,.035);color:var(--soft);max-width:100%;overflow:hidden}",
    ".ncc-pill span:last-child{overflow:hidden;text-overflow:ellipsis}",
    ".ncc-dot{width:7px;height:7px;border-radius:50%;background:var(--dc,var(--green));box-shadow:0 0 0 3px color-mix(in srgb,var(--dc,var(--green)) 18%,transparent);flex:none}",
    ".ncc-dot.live{animation:ncc-blink 1.4s ease-in-out infinite}",
    "@keyframes ncc-blink{50%{opacity:.35}}",
    ".ncc-btn{display:inline-flex;align-items:center;gap:6px;white-space:nowrap;padding:8px 14px;border-radius:9px;font-size:12px;font-weight:700;border:1px solid var(--line2);background:rgba(255,255,255,.04);color:var(--text);cursor:pointer;transition:.18s}",
    ".ncc-btn:hover{background:rgba(255,255,255,.09)}",
    ".ncc-btn.primary{background:linear-gradient(135deg,var(--blue),#3f6fe0);border-color:transparent;box-shadow:0 6px 18px rgba(79,140,255,.3);color:#fff}",
    ".ncc-btn.sm{padding:4px 9px;font-size:10.5px;border-radius:7px}",
    ".ncc-btn:disabled{opacity:.45;cursor:not-allowed}",
    ".ncc-ask{display:inline-flex;align-items:center;gap:5px;padding:4px 9px;border-radius:999px;border:1px solid rgba(79,140,255,.38);background:rgba(79,140,255,.08);color:#cfe0ff;font-size:10.5px;font-weight:700;cursor:pointer;white-space:nowrap}",
    ".ncc-ask:hover{background:rgba(79,140,255,.18)}",
    ".ncc-page{display:none;animation:ncc-fade .3s ease}",
    ".ncc-page.active{display:block}",
    "@keyframes ncc-fade{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}",
    /* KPI strip */
    ".ncc-kpis{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:14px;margin-bottom:14px}",
    ".ncc-kpi{position:relative;overflow:hidden;min-width:0;border:1px solid var(--line);border-radius:14px;padding:15px 16px;background:linear-gradient(165deg,var(--panel2),var(--panel));transition:.22s}",
    ".ncc-kpi:hover{transform:translateY(-2px);border-color:var(--line2);box-shadow:0 14px 34px rgba(0,0,0,.45)}",
    ".ncc-kpi::after{content:'';position:absolute;inset:0 0 auto 0;height:2px;background:var(--accent,var(--blue));opacity:.85}",
    ".ncc-kpi-label{font-size:10.5px;font-weight:800;letter-spacing:.11em;color:var(--muted);text-transform:uppercase;margin-bottom:11px}",
    ".ncc-kpi-val{font-size:25px;font-weight:800;letter-spacing:-1px;line-height:1;font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
    ".ncc-kpi-val.none{color:var(--dim)}",
    ".ncc-kpi-unit{font-size:12px;color:var(--muted);font-weight:700;margin-left:4px;letter-spacing:0}",
    ".ncc-kpi-foot{display:flex;align-items:flex-end;justify-content:space-between;gap:8px 10px;margin-top:11px;flex-wrap:wrap}",
    ".ncc-chip{display:inline-flex;align-items:center;gap:3px;white-space:nowrap;font-size:10.5px;font-weight:800;padding:3px 7px;border-radius:6px}",
    ".ncc-chip.up{color:var(--green);background:rgba(34,197,94,.12)}",
    ".ncc-chip.down{color:var(--red);background:rgba(244,63,94,.12)}",
    ".ncc-chip.warn{color:var(--amber);background:rgba(245,165,36,.12)}",
    ".ncc-chip.flat{color:var(--muted);background:rgba(255,255,255,.06)}",
    ".ncc-spark{width:80px;height:26px;display:block;overflow:visible;flex:none;margin-left:auto}",
    ".ncc-kpi-sub{font-size:10.5px;color:var(--muted);margin-top:9px;font-weight:600;line-height:1.4}",
    /* panels */
    ".ncc-grid{display:grid;grid-template-columns:repeat(12,minmax(0,1fr));gap:14px;margin-bottom:14px}",
    ".ncc-panel{border:1px solid var(--line);border-radius:14px;padding:17px;min-width:0;background:linear-gradient(170deg,rgba(19,26,42,.85),rgba(14,19,32,.9));display:flex;flex-direction:column;gap:14px}",
    ".ncc-panel-head{display:flex;align-items:center;justify-content:space-between;gap:8px 12px;flex-wrap:wrap}",
    ".ncc-panel-title{font-size:12.5px;font-weight:800;letter-spacing:.02em;display:flex;align-items:center;gap:8px;margin:0}",
    ".ncc-panel-title .bar{width:3px;height:13px;border-radius:2px;background:var(--accent,var(--blue));flex:none}",
    ".ncc-note{font-size:10.5px;color:var(--muted);font-weight:600;display:flex;gap:8px;align-items:center;flex-wrap:wrap}",
    ".s3{grid-column:span 3}.s4{grid-column:span 4}.s5{grid-column:span 5}.s7{grid-column:span 7}.s12{grid-column:span 12}",
    ".ncc-empty{font-size:11.5px;color:var(--muted);line-height:1.55;border:1px dashed var(--line2);border-radius:10px;padding:12px}",
    ".ncc-prow{display:flex;flex-direction:column;gap:6px;margin-bottom:12px}",
    ".ncc-prow:last-child{margin-bottom:0}",
    ".ncc-prow-top{display:flex;justify-content:space-between;gap:10px;font-size:11.5px;font-weight:600}",
    ".ncc-prow-top span:last-child{color:var(--muted);font-variant-numeric:tabular-nums;white-space:nowrap}",
    ".ncc-track{height:7px;border-radius:99px;background:rgba(255,255,255,.06);overflow:hidden}",
    ".ncc-fill{height:100%;border-radius:99px;background:var(--c,var(--blue));transition:width .8s cubic-bezier(.3,1,.4,1)}",
    ".ncc-rings{display:flex;justify-content:space-around;gap:10px;text-align:center;flex-wrap:wrap}",
    ".ncc-ring{display:flex;flex-direction:column;align-items:center;gap:7px}",
    ".ncc-ring-text{font-size:12.5px;font-weight:800;fill:var(--text);font-family:var(--font)}",
    ".ncc-ring-text.none{fill:var(--dim)}",
    ".ncc-ring-cap{font-size:10px;color:var(--muted);font-weight:700;letter-spacing:.05em;text-transform:uppercase}",
    ".ncc-minis{display:grid;grid-template-columns:1fr 1fr;gap:10px}",
    ".ncc-mini{border:1px solid var(--line);border-radius:10px;padding:10px 11px;background:rgba(255,255,255,.018);min-width:0}",
    ".ncc-mini-k{font-size:9.5px;letter-spacing:.09em;color:var(--muted);font-weight:800;text-transform:uppercase}",
    ".ncc-mini-v{font-size:16px;font-weight:800;margin-top:5px;font-variant-numeric:tabular-nums;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
    ".ncc-mini-v small{font-size:10px;color:var(--muted);font-weight:700}",
    ".ncc-mini-v.dim{color:var(--dim)}",
    ".ncc-mini-s{font-size:10px;color:var(--muted);font-weight:600;margin-top:4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
    ".ncc-bars-wrap{position:relative}",
    ".ncc-bars{display:flex;align-items:flex-end;gap:9px;height:104px;padding-top:6px}",
    ".ncc-bar-col{flex:1;display:flex;flex-direction:column;align-items:center;gap:6px;height:100%;justify-content:flex-end;min-width:0}",
    ".ncc-wbar{width:100%;border-radius:6px 6px 3px 3px;min-height:5px;background:linear-gradient(180deg,var(--blue),rgba(79,140,255,.28))}",
    ".ncc-wbar.neg{background:linear-gradient(180deg,var(--red),rgba(244,63,94,.28))}",
    ".ncc-wbar.ghost{background:rgba(255,255,255,.05)}",
    ".ncc-bar-lab{font-size:9.5px;color:var(--muted);font-weight:700}",
    ".ncc-bars-over{position:absolute;inset:0 0 22px 0;display:grid;place-items:center;text-align:center;font-size:11px;color:var(--soft);font-weight:600;padding:0 12px;line-height:1.5}",
    ".ncc-heat{display:grid;grid-template-columns:repeat(14,1fr);gap:3.5px}",
    ".ncc-hc{aspect-ratio:1;border-radius:2.5px;background:rgba(255,255,255,.045)}",
    ".ncc-hc.today{box-shadow:0 0 0 1.5px var(--text)}",
    ".ncc-legend{display:flex;align-items:center;gap:5px;font-size:9.5px;color:var(--muted);font-weight:700;flex-wrap:wrap}",
    ".ncc-legend i{width:9px;height:9px;border-radius:2px;display:block}",
    ".ncc-legend .sp{flex:1}",
    ".ncc-alerts{display:flex;flex-direction:column;gap:9px}",
    ".ncc-alert{display:flex;gap:11px;padding:10px 11px;border-radius:10px;background:rgba(255,255,255,.022);border-left:2.5px solid var(--c)}",
    ".ncc-alert-body{flex:1;min-width:0}",
    ".ncc-alert-tag{font-size:9px;font-weight:800;letter-spacing:.07em;color:var(--c);text-transform:uppercase}",
    ".ncc-alert-t{font-size:11.5px;font-weight:700;line-height:1.35;overflow-wrap:anywhere;margin-top:2px}",
    ".ncc-alert-s{font-size:10px;color:var(--muted);margin-top:3px;font-weight:600}",
    /* activity feed */
    ".ncc-feed{display:flex;flex-direction:column;gap:11px}",
    ".ncc-feed-item{display:flex;gap:10px;font-size:11px;line-height:1.45}",
    ".ncc-feed-dot{width:6px;height:6px;border-radius:50%;margin-top:5px;flex:0 0 6px;background:var(--c,var(--blue))}",
    ".ncc-feed-body{flex:1;min-width:0}",
    ".ncc-feed-t{color:var(--text);font-weight:600;overflow-wrap:anywhere}",
    ".ncc-feed-t.undone{color:var(--muted);text-decoration:line-through}",
    ".ncc-diff{display:flex;flex-wrap:wrap;align-items:center;gap:5px;margin-top:4px;font-size:10.5px}",
    ".ncc-diff span{padding:1px 6px;border-radius:5px;background:rgba(255,255,255,.05);overflow-wrap:anywhere}",
    ".ncc-diff .b{color:var(--muted);text-decoration:line-through}",
    ".ncc-diff .a{color:#bfe9cd;background:rgba(34,197,94,.1)}",
    ".ncc-feed-time{color:var(--dim);font-size:9.5px;font-weight:700;margin-top:4px;letter-spacing:.03em;display:flex;align-items:center;gap:8px;flex-wrap:wrap}",
    /* org chart */
    ".ncc-org{display:grid;grid-template-columns:minmax(0,1fr) 330px;gap:14px;align-items:start}",
    ".ncc-canvas{position:relative;height:620px;border:1px solid var(--line);border-radius:14px;overflow:hidden;background:radial-gradient(600px 380px at 50% 50%,rgba(79,140,255,.09),transparent 70%),linear-gradient(170deg,rgba(19,26,42,.7),rgba(11,15,25,.9))}",
    ".ncc-canvas::before{content:'';position:absolute;inset:0;pointer-events:none;background-image:linear-gradient(rgba(255,255,255,.028) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,.028) 1px,transparent 1px);background-size:38px 38px;-webkit-mask-image:radial-gradient(circle at 50% 50%,#000 30%,transparent 78%);mask-image:radial-gradient(circle at 50% 50%,#000 30%,transparent 78%)}",
    ".ncc-lines{position:absolute;inset:0;width:100%;height:100%;pointer-events:none}",
    ".ncc-node{position:absolute;transform:translate(-50%,-50%);border:1px solid var(--line2);border-radius:12px;color:var(--text);text-align:left;background:linear-gradient(160deg,#161f31,#0e1422);padding:10px 12px;min-width:120px;max-width:170px;cursor:pointer;transition:border-color .2s,box-shadow .2s;box-shadow:0 8px 24px rgba(0,0,0,.4)}",
    ".ncc-node:hover{border-color:var(--blue);box-shadow:0 12px 32px rgba(79,140,255,.28)}",
    ".ncc-node[aria-pressed=true]{border-color:var(--blue);box-shadow:0 0 0 3px rgba(79,140,255,.18),0 12px 30px rgba(0,0,0,.5)}",
    ".ncc-node.planned{border-style:dashed;background:linear-gradient(160deg,#121a29,#0b101b);color:var(--soft)}",
    ".ncc-node-n{display:flex;align-items:center;gap:7px;font-size:11.5px;font-weight:800;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
    ".ncc-node-r{font-size:9px;color:var(--muted);font-weight:700;margin-top:4px;letter-spacing:.05em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
    ".ncc-node-s{display:flex;align-items:center;gap:5px;font-size:9px;font-weight:800;margin-top:7px;color:var(--sc);letter-spacing:.05em}",
    ".ncc-node-s .ncc-dot{width:5px;height:5px;box-shadow:none;background:var(--sc)}",
    ".ncc-node.director{min-width:210px;max-width:250px;padding:16px 18px;text-align:center;background:linear-gradient(150deg,rgba(79,140,255,.24),rgba(168,85,247,.16),#0e1422),#0e1422;border:1.5px solid rgba(79,140,255,.55);box-shadow:0 0 0 8px rgba(79,140,255,.06),0 0 50px rgba(79,140,255,.28);animation:ncc-pulse 4s ease-in-out infinite;z-index:2}",
    "@keyframes ncc-pulse{0%,100%{box-shadow:0 0 0 8px rgba(79,140,255,.06),0 0 50px rgba(79,140,255,.26)}50%{box-shadow:0 0 0 14px rgba(79,140,255,.03),0 0 70px rgba(79,140,255,.4)}}",
    ".ncc-node.director .ncc-node-n{font-size:16px;letter-spacing:.12em;justify-content:center}",
    ".ncc-node.director .ncc-node-r{margin-top:6px;font-size:9.5px;white-space:normal}",
    ".ncc-node.director .ncc-node-s{justify-content:center;margin-top:9px;font-size:9.5px;white-space:normal;text-align:center}",
    /* AI Agent TITAN card */
    ".ncc-node.titan{display:flex;flex-direction:column;align-items:center;min-width:220px;max-width:250px;padding:12px 14px 14px;cursor:default}",
    ".ncc-node.titan.sel{border-color:#8cb6ff}",
    ".ncc-titan-main{all:unset;box-sizing:border-box;display:flex;flex-direction:column;align-items:center;width:100%;cursor:pointer;border-radius:10px;padding:2px 4px 4px;text-align:center;color:var(--text)}",
    ".ncc-titan-main:focus-visible{outline:2px solid var(--blue);outline-offset:3px}",
    ".ncc-titan-main .ncc-face{margin:4px 0 9px}",
    ".ncc-titan-main .ncc-node-r,.ncc-titan-main .ncc-titan-know{display:block}",
    ".ncc-titan-know{margin-top:7px;font-size:9.5px;font-weight:700;color:var(--muted);letter-spacing:.03em;white-space:normal;line-height:1.4}",
    ".ncc-titan-know.warn{color:var(--amber)}",
    ".ncc-titan-mic{margin-top:10px;display:inline-flex;align-items:center;justify-content:center;gap:7px;width:100%;min-height:38px;border-radius:999px;border:1px solid rgba(34,197,94,.55);background:rgba(34,197,94,.13);color:#d9fbe6;font:inherit;font-size:11px;font-weight:800;letter-spacing:.04em;cursor:pointer;padding:6px 12px}",
    ".ncc-titan-mic:hover{background:rgba(34,197,94,.22)}",
    ".ncc-titan-mic:focus-visible{outline:2px solid var(--green);outline-offset:2px}",
    ".ncc-titan-mic.on{background:var(--green);color:#04210f;border-color:var(--green);animation:ncc-micpulse 1.4s ease-out infinite}",
    ".ncc-titan-mic.off{border-style:dashed;border-color:var(--line2);background:rgba(255,255,255,.03);color:var(--soft)}",
    "@keyframes ncc-micpulse{0%{box-shadow:0 0 0 0 rgba(34,197,94,.5)}100%{box-shadow:0 0 0 12px rgba(34,197,94,0)}}",
    ".ncc-canvas.stack .ncc-titan-mic,.ncc-mic-row .ncc-titan-mic{min-height:44px;font-size:12px}",
    ".ncc-mic-row .ncc-titan-mic{margin-top:0}",
    /* TITAN's face: purely visual — the state is always also written out in text */
    ".ncc-face{--fs:64px;--fc:var(--blue);position:relative;display:inline-block;width:var(--fs);height:var(--fs);border-radius:50%;flex:none;color:#eef4ff;background:radial-gradient(circle at 34% 28%,color-mix(in srgb,var(--fc) 55%,#1b2640) 0%,#0c1222 72%);box-shadow:inset 0 0 0 1.5px color-mix(in srgb,var(--fc) 70%,transparent),0 0 calc(var(--fs) * .35) color-mix(in srgb,var(--fc) 40%,transparent);transition:background .3s,box-shadow .3s}",
    ".ncc-face svg{position:absolute;inset:0;width:100%;height:100%;overflow:visible}",
    ".ncc-face-ring{position:absolute;inset:-5px;border-radius:50%;border:1.5px solid color-mix(in srgb,var(--fc) 55%,transparent);pointer-events:none}",
    ".ncc-face .eyes,.ncc-face .mouth{transform-box:fill-box;transform-origin:center;transition:transform .25s ease}",
    ".ncc-face .eye,.ncc-face .mouth{fill:currentColor}",
    ".ncc-face .eyes{animation:ncc-blink 5.5s infinite}",
    "@keyframes ncc-blink{0%,93%,100%{transform:scaleY(1)}96%{transform:scaleY(.12)}}",
    ".ncc-face[data-face=idle] .ncc-face-ring{animation:ncc-breathe 4s ease-in-out infinite}",
    "@keyframes ncc-breathe{0%,100%{opacity:.45;transform:scale(1)}50%{opacity:.95;transform:scale(1.04)}}",
    ".ncc-face[data-face=listening]{--fc:var(--green)}",
    ".ncc-face[data-face=listening] .eyes{animation:none;transform:scaleY(1.18)}",
    ".ncc-face[data-face=listening] .mouth{transform:scale(.45,1.6)}",
    ".ncc-face[data-face=listening] .ncc-face-ring{animation:ncc-ping 1.4s ease-out infinite}",
    "@keyframes ncc-ping{0%{opacity:.85;transform:scale(1)}100%{opacity:0;transform:scale(1.35)}}",
    ".ncc-face[data-face=thinking]{--fc:var(--amber)}",
    ".ncc-face[data-face=thinking] .eyes{animation:ncc-look 2.6s ease-in-out infinite alternate}",
    "@keyframes ncc-look{0%{transform:translate(-3px,-4px)}100%{transform:translate(4px,-4px)}}",
    ".ncc-face[data-face=thinking] .mouth{transform:scaleX(.55)}",
    ".ncc-face[data-face=thinking] .ncc-face-ring,.ncc-face[data-face=working] .ncc-face-ring{border-style:dashed;animation:ncc-spin 6s linear infinite}",
    "@keyframes ncc-spin{to{transform:rotate(360deg)}}",
    ".ncc-face[data-face=speaking]{--fc:var(--cyan)}",
    ".ncc-face[data-face=speaking] .mouth{animation:ncc-talk .34s ease-in-out infinite alternate}",
    "@keyframes ncc-talk{0%{transform:scaleY(.8)}100%{transform:scaleY(3)}}",
    ".ncc-face[data-face=working]{--fc:var(--purple)}",
    ".ncc-face[data-face=working] .eyes{animation:none;transform:scaleY(.55)}",
    ".ncc-face[data-face=working] .ncc-face-ring{animation-duration:2.4s}",
    /* what TITAN knows */
    ".ncc-know{display:flex;flex-direction:column;gap:10px}",
    ".ncc-know-steps{margin:0;padding-left:18px;font-size:11px;line-height:1.6;color:var(--soft)}",
    ".ncc-know-steps b{color:var(--text)}",
    ".ncc-know-meta{font-size:10.5px;color:var(--muted);font-weight:700;line-height:1.5}",
    ".ncc-know-warn{font-size:10.5px;color:var(--amber);font-weight:700;border:1px solid rgba(245,165,36,.35);background:rgba(245,165,36,.08);border-radius:8px;padding:7px 9px;line-height:1.45}",
    ".ncc-know-note{font-size:10px;color:var(--dim);line-height:1.5}",
    ".ncc-badge{display:inline-block;font-size:8.5px;font-weight:800;letter-spacing:.16em;color:#cfe0ff;background:rgba(79,140,255,.18);border:1px solid rgba(79,140,255,.45);border-radius:999px;padding:2px 9px;margin-bottom:7px}",
    ".ncc-canvas.stack{height:auto;display:block;padding:12px}",
    ".ncc-canvas.stack .ncc-nodes{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}",
    ".ncc-canvas.stack .ncc-lines{display:none}",
    ".ncc-canvas.stack .ncc-node{position:relative;left:auto!important;top:auto!important;transform:none;min-width:0;max-width:none}",
    ".ncc-canvas.stack .ncc-node.director{grid-column:1/-1}",
    ".ncc-canvas.stack .ncc-node-n,.ncc-canvas.stack .ncc-node-r{white-space:normal}",
    /* profile */
    ".ncc-profile{gap:16px}",
    ".ncc-pf-head{display:flex;gap:12px;align-items:flex-start}",
    ".ncc-pf-avatar{width:46px;height:46px;border-radius:12px;display:grid;place-items:center;font-size:19px;flex:0 0 46px;background:linear-gradient(135deg,rgba(79,140,255,.35),rgba(168,85,247,.28));border:1px solid rgba(79,140,255,.4)}",
    ".ncc-pf-name{font-size:14.5px;font-weight:800;margin:0}",
    ".ncc-pf-role{font-size:10.5px;color:var(--muted);font-weight:700;margin-top:3px;letter-spacing:.05em}",
    ".ncc-pf-status{display:inline-flex;align-items:center;gap:6px;margin-top:8px;font-size:9.5px;font-weight:800;letter-spacing:.08em;padding:4px 9px;border-radius:99px;color:var(--sc);background:color-mix(in srgb,var(--sc) 14%,transparent);max-width:100%}",
    ".ncc-pf-status .ncc-dot{width:6px;height:6px;box-shadow:none;background:var(--sc)}",
    ".ncc-pf-text{font-size:11.5px;line-height:1.6;color:var(--soft);border-left:2px solid var(--line2);padding-left:11px;overflow-wrap:anywhere;margin:0}",
    ".ncc-kgrid{display:grid;grid-template-columns:1fr 1fr;gap:9px}",
    ".ncc-k{border:1px solid var(--line);border-radius:9px;padding:9px 10px;background:rgba(255,255,255,.018);min-width:0}",
    ".ncc-k b{display:block;font-size:9px;letter-spacing:.09em;color:var(--muted);font-weight:800;text-transform:uppercase}",
    ".ncc-k i{font-style:normal;font-size:15px;font-weight:800;display:block;margin-top:5px;font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
    ".ncc-k i.dim{color:var(--dim)}",
    ".ncc-tags{display:flex;flex-wrap:wrap;gap:6px}",
    ".ncc-tag{font-size:9.5px;font-weight:700;padding:4px 9px;border-radius:6px;border:1px solid var(--line2);color:#a7b3c9;background:rgba(255,255,255,.03)}",
    ".ncc-tag.on{border-color:rgba(34,197,94,.45);color:#bfe9cd;background:rgba(34,197,94,.08)}",
    ".ncc-tag.off{opacity:.6;border-style:dashed}",
    ".ncc-sect{font-size:9.5px;letter-spacing:.13em;color:var(--dim);font-weight:800;text-transform:uppercase;margin-bottom:9px}",
    ".ncc-rules{display:flex;flex-direction:column;gap:10px}",
    ".ncc-rule{border:1px solid var(--line);border-left:3px solid var(--c);border-radius:9px;padding:9px 11px;background:rgba(255,255,255,.015)}",
    ".ncc-rule b{display:block;font-size:9.5px;letter-spacing:.1em;color:var(--c);font-weight:800;text-transform:uppercase;margin-bottom:5px}",
    ".ncc-rule ul{margin:0;padding-left:16px;font-size:11px;line-height:1.55;color:var(--soft)}",
    ".ncc-switch{display:flex;align-items:center;justify-content:space-between;gap:12px;border:1px solid var(--line2);border-radius:10px;padding:10px 12px;background:rgba(255,255,255,.025)}",
    ".ncc-switch-k{font-size:11.5px;font-weight:800}",
    ".ncc-switch-s{font-size:10.5px;color:var(--muted);margin-top:2px;line-height:1.45}",
    ".ncc-toggle{position:relative;width:44px;height:24px;border-radius:999px;border:1px solid var(--line2);background:rgba(255,255,255,.08);cursor:pointer;flex:none;padding:0}",
    ".ncc-toggle::after{content:'';position:absolute;top:2px;left:2px;width:18px;height:18px;border-radius:50%;background:#cbd5e1;transition:transform .18s}",
    ".ncc-toggle[aria-checked=true]{background:var(--green);border-color:var(--green)}",
    ".ncc-toggle[aria-checked=true]::after{transform:translateX(20px);background:#fff}",
    /* dock (TITAN's chat + voice) */
    ".ncc-dock{position:sticky;top:0;height:100vh;height:100dvh;width:380px;flex:0 0 380px;border-left:1px solid var(--line);background:rgba(9,13,21,.86);backdrop-filter:blur(14px);display:flex;flex-direction:column;z-index:5}",
    ".ncc-dock-head{display:flex;align-items:center;gap:10px;padding:14px 14px 12px;border-bottom:1px solid var(--line)}",
    ".ncc-dock-mark{width:30px;height:30px;border-radius:9px;display:grid;place-items:center;flex:none;background:linear-gradient(135deg,var(--blue),var(--purple));color:#fff;font-size:14px}",
    ".ncc-dock-name{font-size:12px;font-weight:800;letter-spacing:.14em}",
    ".ncc-dock-state{font-size:10px;color:var(--muted);font-weight:700;letter-spacing:.06em;display:flex;align-items:center;gap:6px;margin-top:2px;min-width:0}",
    ".ncc-dock-state span:last-child{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
    ".ncc-dock-tools{margin-left:auto;display:flex;gap:6px}",
    ".ncc-icon-btn{width:32px;height:32px;border-radius:9px;border:1px solid var(--line2);background:rgba(255,255,255,.04);display:grid;place-items:center;cursor:pointer;font-size:14px;line-height:1;padding:0}",
    ".ncc-icon-btn:hover{background:rgba(255,255,255,.1)}",
    ".ncc-dock [data-ncc=close-sheet]{display:none}",
    ".ncc-chat-host{flex:1;min-height:0;overflow:auto;display:flex;flex-direction:column}",
    ".ncc-chat-host>*{position:relative!important;inset:auto!important;transform:none!important;width:100%!important;max-width:100%!important;flex:1 1 auto;min-height:0}",
    ".ncc-chat-empty{padding:16px;font-size:12px;color:var(--muted)}",
    ".ncc.dock-closed .ncc-dock{width:58px;flex-basis:58px}",
    ".ncc.dock-closed .ncc-dock-head{flex-direction:column;padding:12px 8px;gap:12px}",
    ".ncc.dock-closed .ncc-dock-text,.ncc.dock-closed .ncc-chat-host{display:none}",
    ".ncc.dock-closed .ncc-dock-tools{margin:0;flex-direction:column}",
    ".ncc-sheet-handle{display:none}",
    /* mobile: tab bar, floating mic, bottom sheet */
    ".ncc-tabs,.ncc-fab,.ncc-scrim{display:none}",
    "@media (max-width:939.98px){",
    ".ncc{display:block}",
    ".ncc-side{display:none}",
    ".ncc-main{padding:16px 16px calc(150px + env(safe-area-inset-bottom,0px))}",
    ".ncc-tabs{display:flex;position:fixed;left:0;right:0;bottom:0;z-index:30;height:calc(60px + env(safe-area-inset-bottom,0px));padding-bottom:env(safe-area-inset-bottom,0px);background:rgba(9,13,21,.94);backdrop-filter:blur(14px);border-top:1px solid var(--line)}",
    ".ncc-tab{flex:1;border:0;background:transparent;color:var(--muted);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:3px;font-size:10.5px;font-weight:700;cursor:pointer;min-width:0}",
    ".ncc-tab span:first-child{font-size:16px;line-height:1}",
    ".ncc-tab[aria-current=page]{color:#fff}",
    ".ncc-tab[aria-current=page] span:first-child{color:var(--blue)}",
    ".ncc-fab{display:grid;place-items:center;position:fixed;right:16px;bottom:calc(76px + env(safe-area-inset-bottom,0px));z-index:31;width:58px;height:58px;border-radius:50%;border:0;cursor:pointer;color:#fff;font-size:22px;background:linear-gradient(135deg,var(--blue),var(--purple));box-shadow:0 10px 30px rgba(79,140,255,.45)}",
    ".ncc-fab.live{animation:ncc-fab 1.6s ease-in-out infinite}",
    "@keyframes ncc-fab{50%{box-shadow:0 0 0 10px rgba(79,140,255,.15),0 10px 30px rgba(79,140,255,.45)}}",
    ".ncc-dock,.ncc.dock-closed .ncc-dock{position:fixed;left:0;right:0;bottom:0;top:auto;width:auto;height:86vh;height:86dvh;border-left:0;border-top:1px solid var(--line2);border-radius:18px 18px 0 0;transform:translateY(105%);transition:transform .28s cubic-bezier(.2,.8,.2,1);z-index:41;visibility:hidden;padding-bottom:env(safe-area-inset-bottom,0px)}",
    ".ncc.sheet-open .ncc-dock{transform:none;visibility:visible}",
    ".ncc.dock-closed .ncc-dock-head{flex-direction:row;padding:14px 14px 12px}",
    ".ncc.dock-closed .ncc-chat-host{display:flex}",
    ".ncc.dock-closed .ncc-dock-text{display:block}",
    ".ncc.dock-closed .ncc-dock-tools{margin-left:auto;flex-direction:row}",
    ".ncc-dock [data-ncc=collapse]{display:none}",
    ".ncc-dock [data-ncc=close-sheet]{display:grid}",
    ".ncc-sheet-handle{display:block;width:40px;height:4px;border-radius:9px;background:rgba(255,255,255,.25);margin:8px auto 0}",
    ".ncc-scrim{display:block;position:fixed;inset:0;z-index:40;background:rgba(3,5,10,.55);opacity:0;pointer-events:none;transition:opacity .2s}",
    ".ncc.sheet-open .ncc-scrim{opacity:1;pointer-events:auto}",
    ".ncc-org{grid-template-columns:minmax(0,1fr)}",
    "}",
    /* content layout follows the width of the main column (dock open or closed) */
    "@container nccmain (max-width:1099.98px){.ncc-kpis{grid-template-columns:repeat(6,minmax(0,1fr))}.ncc-kpis .ncc-kpi{grid-column:span 2}.ncc-kpis .ncc-kpi:nth-child(n+4){grid-column:span 3}.s3,.s4,.s5,.s7{grid-column:span 6}.ncc-grid>.ncc-panel:first-child{grid-column:span 12}.ncc-org{grid-template-columns:minmax(0,1fr)}}",
    "@container nccmain (max-width:719.98px){.ncc-kpis{grid-template-columns:repeat(2,minmax(0,1fr))}.ncc-kpis .ncc-kpi,.ncc-kpis .ncc-kpi:nth-child(n+4){grid-column:auto}.ncc-kpis .ncc-kpi:last-child{grid-column:1/-1}.s3,.s4,.s5,.s7,.ncc-grid>.ncc-panel:first-child{grid-column:span 12}}",
    "@media (max-width:420px){.ncc-kpi-val{font-size:21px}.ncc-spark{width:64px}.ncc-kpi{padding:13px}}",
    "@media (prefers-reduced-motion:reduce){.ncc *{animation:none!important;transition:none!important}}",
    /* toast + dialog */
    ".ncc-toast{position:fixed;left:50%;bottom:calc(24px + env(safe-area-inset-bottom,0px));transform:translateX(-50%);z-index:60;background:var(--text);color:var(--bg);font-size:12px;font-weight:700;padding:10px 16px;border-radius:9px;max-width:calc(100% - 32px)}",
    "@media (max-width:939.98px){.ncc-toast{bottom:calc(144px + env(safe-area-inset-bottom,0px))}}",
    ".ncc-modal-scrim{position:fixed;inset:0;z-index:55;background:rgba(3,5,10,.7);backdrop-filter:blur(4px);display:grid;place-items:center;padding:16px}",
    ".ncc-modal{width:min(460px,100%);max-height:calc(100% - 32px);overflow:auto;border:1px solid var(--line2);border-radius:14px;padding:18px;display:flex;flex-direction:column;gap:12px;background:linear-gradient(170deg,var(--panel2),var(--panel));box-shadow:0 30px 80px rgba(0,0,0,.6)}",
    ".ncc-modal-head{display:flex;justify-content:space-between;align-items:center;gap:10px}",
  ].join("\n");

  /* ======================================================================
   * Templates (every piece of data text goes through esc())
   * ====================================================================== */
  var TONE = {
    red: "var(--red)",
    amber: "var(--amber)",
    blue: "var(--blue)",
    purple: "var(--purple)",
    green: "var(--green)",
    cyan: "var(--cyan)",
  };
  var ORG_BASE_H = 620; // matches .ncc-canvas height in the CSS
  var ORG_MAX_H = 980; // above this the agents are stacked instead of drawn in a ring
  var STATE = {
    idle: ["READY", "var(--blue)"],
    listening: ["LISTENING", "var(--green)"],
    thinking: ["THINKING", "var(--amber)"],
    speaking: ["SPEAKING", "var(--cyan)"],
    working: ["WORKING", "var(--purple)"],
  };
  function stateLabel(T) {
    if (T.state === "working")
      return T.workingOn ? "WORKING ON: " + T.workingOn : "WORKING";
    return STATE[T.state][0];
  }
  function askBtn(question, label) {
    return (
      '<button type="button" class="ncc-ask" data-ncc-ask="' +
      esc(question) +
      '" title="' +
      esc(question) +
      '">' +
      '<span aria-hidden="true">◈</span>' +
      esc(label || "Ask TITAN") +
      "</button>"
    );
  }
  function sparkline(data, color) {
    var w = 80,
      h = 26;
    if (!data || data.length < 2) return "";
    var min = Math.min.apply(null, data),
      max = Math.max.apply(null, data),
      range = max - min || 1,
      step = w / (data.length - 1);
    var flat = max === min;
    var pts = data.map(function (v, i) {
      return [i * step, flat ? h - 6 : h - ((v - min) / range) * (h - 8) - 4];
    });
    var d = pts
      .map(function (p, i) {
        return (i ? "L" : "M") + p[0].toFixed(1) + " " + p[1].toFixed(1);
      })
      .join(" ");
    var last = pts[pts.length - 1];
    return (
      '<svg class="ncc-spark" viewBox="0 0 ' +
      w +
      " " +
      h +
      '" preserveAspectRatio="none" aria-hidden="true">' +
      '<path d="' +
      d +
      '" fill="none" stroke="' +
      color +
      '" stroke-width="1.7" stroke-linejoin="round" stroke-linecap="round"/>' +
      '<circle cx="' +
      last[0].toFixed(1) +
      '" cy="' +
      last[1].toFixed(1) +
      '" r="2.2" fill="' +
      color +
      '"/></svg>'
    );
  }
  function ring(frac, color, text, label) {
    var size = 66,
      sw = 6,
      r = (size - sw) / 2,
      c = 2 * Math.PI * r,
      has = frac != null && isFinite(frac);
    var p = has ? clamp(frac, 0, 1) : 0;
    return (
      '<svg width="' +
      size +
      '" height="' +
      size +
      '" viewBox="0 0 ' +
      size +
      " " +
      size +
      '" role="img" aria-label="' +
      esc(label + ": " + text) +
      '">' +
      '<circle cx="' +
      size / 2 +
      '" cy="' +
      size / 2 +
      '" r="' +
      r +
      '" fill="none" stroke="rgba(255,255,255,.075)" stroke-width="' +
      sw +
      '"' +
      (has ? "" : ' stroke-dasharray="3 5"') +
      "/>" +
      (has && p > 0
        ? '<circle cx="' +
          size / 2 +
          '" cy="' +
          size / 2 +
          '" r="' +
          r +
          '" fill="none" stroke="' +
          color +
          '" stroke-width="' +
          sw +
          '" stroke-linecap="round" stroke-dasharray="' +
          c.toFixed(2) +
          '" stroke-dashoffset="' +
          (c * (1 - p)).toFixed(2) +
          '" transform="rotate(-90 ' +
          size / 2 +
          " " +
          size / 2 +
          ')"/>'
        : "") +
      '<text x="50%" y="50%" text-anchor="middle" dy=".36em" class="ncc-ring-text' +
      (has ? "" : " none") +
      '">' +
      esc(text) +
      "</text></svg>"
    );
  }
  function ringWrap(svg, cap) {
    return (
      '<div class="ncc-ring">' +
      svg +
      '<div class="ncc-ring-cap">' +
      esc(cap) +
      "</div></div>"
    );
  }
  function panelHead(title, note, question) {
    return (
      '<div class="ncc-panel-head"><h2 class="ncc-panel-title"><span class="bar" aria-hidden="true"></span>' +
      esc(title) +
      "</h2>" +
      '<div class="ncc-note">' +
      (note || "") +
      (question ? askBtn(question) : "") +
      "</div></div>"
    );
  }
  function timeOf(ms, D) {
    if (ms == null) return "";
    var ds = partsInTz(new Date(ms), D.tz).ds;
    return dayWord(ds, D.t) + " · " + clock(ms, D.tz);
  }
  function activityItem(a, D) {
    var tone = a.undone
      ? "var(--dim)"
      : a.type === "undo"
        ? "var(--amber)"
        : "var(--green)";
    var diff =
      a.before || a.after
        ? '<div class="ncc-diff">' +
          (a.before
            ? '<span class="b" dir="auto">' +
              esc(trunc(a.before, 90)) +
              "</span>"
            : '<span class="b">new</span>') +
          '<span aria-hidden="true">→</span><span class="ncc-sr">changed to</span>' +
          (a.after
            ? '<span class="a" dir="auto">' +
              esc(trunc(a.after, 90)) +
              "</span>"
            : '<span class="a">removed</span>') +
          "</div>"
        : "";
    var undo = a.undoable
      ? '<button type="button" class="ncc-btn sm" data-ncc-undo="' +
        esc(a.id) +
        '" aria-label="Undo: ' +
        esc(a.summary) +
        '">Undo</button>'
      : "";
    return (
      '<div class="ncc-feed-item"><div class="ncc-feed-dot" style="--c:' +
      tone +
      '"></div><div class="ncc-feed-body">' +
      '<div class="ncc-feed-t' +
      (a.undone ? " undone" : "") +
      '" dir="auto">' +
      esc(a.summary) +
      "</div>" +
      diff +
      '<div class="ncc-feed-time"><span>' +
      esc(timeOf(a.at, D)) +
      (a.undone ? " · undone" : "") +
      "</span>" +
      undo +
      "</div></div></div>"
    );
  }

  function renderKpis(D) {
    var T = D.titan;
    var healthVal =
      D.habitConsistency != null
        ? Math.round(D.habitConsistency * 100)
        : D.mood
          ? D.mood.avg.toFixed(1)
          : null;
    var healthUnit =
      D.habitConsistency != null ? "%" : D.mood ? "/ " + D.mood.max : "";
    var k = [
      {
        label: "Job Tasks",
        accent: "var(--blue)",
        color: "#4f8cff",
        value: D.job.ratio == null ? null : Math.round(D.job.ratio * 100),
        unit: "%",
        chip: D.job.overdue
          ? ["down", "▼ " + D.job.overdue + " overdue"]
          : D.job.total
            ? ["up", "▲ " + D.job.done + " done"]
            : ["flat", "NO DATA"],
        data: D.job.series.length > 1 ? D.job.series : null,
        sub: D.job.total
          ? D.job.done + " done of " + D.job.total + " work tasks this week"
          : D.job.workCount
            ? "No work tasks due this week"
            : "No work tasks in the Daybook yet",
      },
      {
        label: "Net Worth",
        accent: "var(--purple)",
        color: "#a855f7",
        value: D.netWorth == null ? null : moneyShort(D.netWorth),
        unit: D.currency,
        chip:
          D.wealthProgress != null
            ? ["up", pct(Math.max(0, D.wealthProgress)) + " of target"]
            : D.netWorth == null
              ? ["flat", "NO DATA"]
              : ["flat", "No target set"],
        data:
          D.history.length > 1
            ? D.history.map(function (h) {
                return h.value;
              })
            : null,
        sub:
          D.netWorth == null
            ? "Tell TITAN your balances to see net worth"
            : D.wealthTarget
              ? "Target " + moneyShort(D.wealthTarget) + " " + D.currency
              : "Set a wealth target with TITAN",
      },
      {
        label: "Income",
        accent: "var(--green)",
        color: "#22c55e",
        value: D.income == null ? null : moneyShort(D.income),
        unit: D.currency,
        chip:
          D.savingsRate != null
            ? [
                D.savingsRate >= 0.2 ? "up" : "warn",
                pct(D.savingsRate) + " saved",
              ]
            : ["flat", D.income == null ? "NO DATA" : "Savings —"],
        data: null,
        sub:
          D.income == null
            ? "Log income with TITAN to see it here"
            : "This month · savings rate " + pct(D.savingsRate),
      },
      {
        label: "Health",
        accent: "var(--cyan)",
        color: "#22d3ee",
        value: healthVal,
        unit: healthUnit,
        chip:
          D.runsThisWeek != null
            ? [
                "flat",
                D.runsThisWeek +
                  " run" +
                  (D.runsThisWeek === 1 ? "" : "s") +
                  " this week",
              ]
            : ["flat", healthVal == null ? "NO DATA" : "No runs logged"],
        data: null,
        sub:
          D.habitConsistency != null
            ? "Health habits, last 7 days" +
              (D.mood
                ? " · mood " + D.mood.avg.toFixed(1) + "/" + D.mood.max
                : "")
            : D.mood
              ? "Average mood, last 7 days"
              : "Log mood or a health habit with TITAN",
      },
      {
        label: "TITAN",
        accent: "var(--amber)",
        color: "#f5a524",
        value: T.changesThisWeek,
        unit: "changes",
        chip: T.autonomous ? ["up", "Autonomous"] : ["warn", "Ask first"],
        data: null,
        sub:
          "This week · " +
          (T.corrections || 0) +
          " correction" +
          (T.corrections === 1 ? "" : "s"),
      },
    ];
    return k
      .map(function (x) {
        return (
          '<div class="ncc-kpi" style="--accent:' +
          x.accent +
          '">' +
          '<div class="ncc-kpi-label">' +
          esc(x.label) +
          "</div>" +
          '<div class="ncc-kpi-val' +
          (x.value == null ? " none" : "") +
          '">' +
          (x.value == null ? "—" : esc(x.value)) +
          '<span class="ncc-kpi-unit">' +
          esc(x.unit) +
          "</span></div>" +
          '<div class="ncc-kpi-foot"><span class="ncc-chip ' +
          x.chip[0] +
          '">' +
          esc(x.chip[1]) +
          "</span>" +
          sparkline(x.data, x.color) +
          "</div>" +
          '<div class="ncc-kpi-sub">' +
          esc(x.sub) +
          "</div></div>"
        );
      })
      .join("");
  }

  function renderTasksPanel(D) {
    var j = D.job;
    var body;
    if (j.total) {
      var p = Math.round(j.ratio * 100);
      body =
        '<div><div class="ncc-prow"><div class="ncc-prow-top"><span>Done this week</span><span>' +
        j.done +
        "/" +
        j.total +
        " · " +
        p +
        "%</span></div>" +
        '<div class="ncc-track" role="img" aria-label="' +
        p +
        ' percent of this week\'s work tasks done"><div class="ncc-fill" style="width:' +
        p +
        '%;--c:var(--blue)"></div></div></div>' +
        '<div class="ncc-prow"><div class="ncc-prow-top"><span>Still open, due this week</span><span>' +
        j.openDue +
        "</span></div>" +
        '<div class="ncc-track" aria-hidden="true"><div class="ncc-fill" style="width:' +
        Math.round((j.openDue / j.total) * 100) +
        '%;--c:var(--amber)"></div></div></div></div>';
    } else {
      body =
        '<div class="ncc-empty">' +
        (j.workCount
          ? "No work tasks are due or done this week."
          : "No work tasks yet. Tell TITAN \u201cadd a work task\u201d and it appears here.") +
        "</div>";
    }
    var nx = D.next;
    var mini =
      '<div class="ncc-minis">' +
      '<div class="ncc-mini"><div class="ncc-mini-k">Next deadline</div><div class="ncc-mini-v' +
      (nx ? "" : " dim") +
      '">' +
      (nx ? esc(dayWord(nx._due, D.t)) : "—") +
      "</div>" +
      '<div class="ncc-mini-s" dir="auto" title="' +
      esc(nx ? nx.title : "") +
      '">' +
      (nx ? esc(nx.title) : "Nothing scheduled") +
      "</div></div>" +
      '<div class="ncc-mini"><div class="ncc-mini-k">Overdue</div><div class="ncc-mini-v' +
      (D.overdue.length ? "" : " dim") +
      '">' +
      D.overdue.length +
      "</div>" +
      '<div class="ncc-mini-s">All Daybook tasks</div></div></div>';
    return (
      panelHead(
        "Job Tasks",
        "<span>" + D.open.length + " open</span>",
        "Which work tasks are due this week, and what should I finish first?",
      ) +
      body +
      mini
    );
  }

  function renderWealthPanel(D) {
    var bars;
    if (D.history.length) {
      var max = Math.max.apply(
        null,
        D.history
          .map(function (m) {
            return Math.abs(m.value);
          })
          .concat([1]),
      );
      bars =
        '<div class="ncc-bars" role="img" aria-label="Net worth by month, last ' +
        D.history.length +
        ' months">' +
        D.history
          .map(function (m) {
            return (
              '<div class="ncc-bar-col" title="' +
              esc(
                monthLong(m.month) + ": " + money(m.value) + " " + D.currency,
              ) +
              '">' +
              '<div class="ncc-wbar' +
              (m.value < 0 ? " neg" : "") +
              '" style="height:' +
              Math.max(4, (Math.abs(m.value) / max) * 100).toFixed(1) +
              '%"></div>' +
              '<div class="ncc-bar-lab">' +
              esc(monthShort(m.month)) +
              "</div></div>"
            );
          })
          .join("") +
        "</div>";
    } else {
      var labels = Array.from({ length: 8 }, function (_, i) {
        var d = new Date(parseDs(D.t));
        d.setUTCDate(1);
        d.setUTCMonth(d.getUTCMonth() - (7 - i));
        return d.toLocaleString("en-US", { month: "short", timeZone: "UTC" });
      });
      bars =
        '<div class="ncc-bars" aria-hidden="true">' +
        labels
          .map(function (l) {
            return (
              '<div class="ncc-bar-col"><div class="ncc-wbar ghost" style="height:6%"></div><div class="ncc-bar-lab">' +
              l +
              "</div></div>"
            );
          })
          .join("") +
        "</div>" +
        '<div class="ncc-bars-over"><div>No monthly history yet.<br>Each month TITAN records lands here.</div></div>';
    }
    var sr = D.savingsRate;
    var rings =
      '<div class="ncc-rings">' +
      ringWrap(
        ring(
          sr,
          sr != null && sr >= 0.2 ? "#22c55e" : "#f5a524",
          sr == null ? "—" : pct(sr),
          "Savings rate",
        ),
        "Savings rate",
      ) +
      ringWrap(
        ring(
          D.wealthProgress,
          "#a855f7",
          D.wealthProgress == null ? "—" : pct(D.wealthProgress),
          "Wealth target",
        ),
        "Wealth target",
      ) +
      ringWrap(
        ring(
          D.emergencyMonths == null ? null : D.emergencyMonths / 3,
          D.emergencyMonths != null && D.emergencyMonths < 3
            ? "#f5a524"
            : "#4f8cff",
          D.emergencyMonths == null ? "—" : D.emergencyMonths.toFixed(1) + "mo",
          "Emergency fund",
        ),
        "Emergency · 3 mo",
      ) +
      "</div>";
    return (
      panelHead(
        "Wealth & Income",
        D.netWorth != null
          ? "<span>Net worth " +
              esc(money(D.netWorth)) +
              " " +
              esc(D.currency) +
              "</span>"
          : "",
        "How is my net worth trending, and what is one step to reach my wealth target faster?",
      ) +
      '<div class="ncc-bars-wrap">' +
      bars +
      "</div>" +
      rings
    );
  }

  function renderAlertsPanel(D) {
    var shown = D.alerts.slice(0, 5);
    var body = shown.length
      ? '<div class="ncc-alerts">' +
        shown
          .map(function (a) {
            return (
              '<div class="ncc-alert" style="--c:' +
              (TONE[a.tone] || "var(--blue)") +
              '"><div class="ncc-alert-body">' +
              '<div class="ncc-alert-tag">' +
              esc(a.tag) +
              '</div><div class="ncc-alert-t" dir="auto">' +
              esc(a.t) +
              "</div>" +
              '<div class="ncc-alert-s" dir="auto">' +
              esc(a.s) +
              "</div></div></div>"
            );
          })
          .join("") +
        (D.alerts.length > shown.length
          ? '<div class="ncc-note">+' +
            (D.alerts.length - shown.length) +
            " more</div>"
          : "") +
        "</div>"
      : '<div class="ncc-empty">' +
        (D.has
          ? "Nothing needs you right now."
          : "Alerts appear once TITAN's data loads.") +
        "</div>";
    return (
      panelHead(
        "Alerts",
        D.alerts.length
          ? "<span>" +
              D.alerts.length +
              " item" +
              (D.alerts.length === 1 ? "" : "s") +
              "</span>"
          : "",
        "Go through my alerts and tell me what needs attention today.",
      ) + body
    );
  }

  function renderHealthPanel(D) {
    var moodFrac = D.mood ? D.mood.avg / D.mood.max : null;
    var runFrac =
      D.runsThisWeek == null
        ? null
        : D.runTarget
          ? D.runsThisWeek / D.runTarget
          : D.runsThisWeek > 0
            ? 1
            : 0;
    var rings =
      '<div class="ncc-rings">' +
      ringWrap(
        ring(
          moodFrac,
          "#22d3ee",
          D.mood ? D.mood.avg.toFixed(1) : "—",
          "Mood, 7 days",
        ),
        "Mood · 7 days",
      ) +
      ringWrap(
        ring(
          D.habitConsistency,
          "#22c55e",
          D.habitConsistency == null ? "—" : pct(D.habitConsistency),
          "Health habits",
        ),
        "Health habits",
      ) +
      ringWrap(
        ring(
          runFrac,
          "#4f8cff",
          D.runsThisWeek == null
            ? "—"
            : String(D.runsThisWeek) + (D.runTarget ? "/" + D.runTarget : ""),
          "Runs this week",
        ),
        "Runs · week",
      ) +
      "</div>";
    var src = D.healthSource;
    var sleep = src ? num(src.sleepHours) : null,
      steps = src ? num(src.steps) : null;
    var minis =
      '<div class="ncc-minis">' +
      '<div class="ncc-mini"><div class="ncc-mini-k">Sleep</div><div class="ncc-mini-v' +
      (sleep != null ? "" : " dim") +
      '">' +
      (sleep != null ? sleep.toFixed(1) + " <small>h</small>" : "—") +
      "</div>" +
      '<div class="ncc-mini-s">' +
      (src ? "From your health source" : "Connect a health source") +
      "</div></div>" +
      '<div class="ncc-mini"><div class="ncc-mini-k">Steps</div><div class="ncc-mini-v' +
      (steps != null ? "" : " dim") +
      '">' +
      (steps != null ? esc(money(steps)) : "—") +
      "</div>" +
      '<div class="ncc-mini-s">' +
      (src ? "Today" : "Connect a health source") +
      "</div></div></div>";
    return (
      panelHead(
        "Health",
        "<span>" +
          (D.healthHabitCount
            ? D.healthHabitCount +
              " health habit" +
              (D.healthHabitCount === 1 ? "" : "s")
            : "No health habits yet") +
          "</span>",
        "How have my mood, health habits and runs been this week?",
      ) +
      rings +
      minis
    );
  }

  function renderDaybookPanel(D) {
    var COL = [
      "rgba(255,255,255,.045)",
      "rgba(245,165,36,.28)",
      "rgba(245,165,36,.55)",
      "rgba(245,165,36,.85)",
      "var(--amber)",
    ];
    var heat =
      '<div class="ncc-heat" role="img" aria-label="Daybook activity over the last 12 weeks: ' +
      D.activeDays84 +
      " active days, current streak " +
      D.streak +
      ' days">' +
      D.heat
        .map(function (c) {
          return (
            '<div class="ncc-hc' +
            (c.ds === D.t ? " today" : "") +
            '" style="background:' +
            COL[c.lvl] +
            '" title="' +
            esc(
              fmtDs(c.ds, { weekday: "short", day: "numeric", month: "short" }),
            ) +
            ": " +
            c.v +
            '"></div>'
          );
        })
        .join("") +
      "</div>";
    var note =
      D.streak > 0
        ? D.streak + "-day streak"
        : D.lastActive
          ? "Streak paused · last active " +
            dayWord(D.lastActive, D.t).toLowerCase()
          : "No activity yet";
    var legend =
      '<div class="ncc-legend" aria-hidden="true"><span>Less</span>' +
      COL.map(function (c) {
        return '<i style="background:' + c + '"></i>';
      }).join("") +
      '<span>More</span><span class="sp"></span><span>' +
      D.activeDays84 +
      " active days of 84</span></div>";
    return (
      panelHead(
        "Daybook",
        "<span>" + esc(note) + "</span>",
        "What does my Daybook activity over the last 12 weeks say about my routine?",
      ) +
      heat +
      legend
    );
  }

  function renderActivityPanel(D) {
    var items = D.activity.slice(0, 6);
    var body = items.length
      ? '<div class="ncc-feed">' +
        items
          .map(function (a) {
            return activityItem(a, D);
          })
          .join("") +
        "</div>"
      : '<div class="ncc-empty">Every change TITAN makes on its own shows up here with the time, before → after, and an Undo button.</div>';
    return (
      panelHead(
        "Activity",
        D.titan.autonomous
          ? "<span>Autonomous</span>"
          : "<span>Ask first</span>",
        "Summarise the changes you made today.",
      ) + body
    );
  }

  function titanPill(D) {
    var s = STATE[D.titan.state];
    var live = D.titan.state !== "idle";
    return (
      '<div class="ncc-pill"><span class="ncc-dot' +
      (live ? " live" : "") +
      '" style="--dc:' +
      s[1] +
      '"></span><span dir="auto">TITAN · ' +
      esc(trunc(stateLabel(D.titan), 48)) +
      "</span></div>"
    );
  }

  function renderCommandPage(D) {
    return (
      '<div class="ncc-top"><div><h1 class="ncc-title">Command Center</h1><div class="ncc-sub">' +
      esc(D.dateLine) +
      (D.hijri ? " · " + esc(D.hijri) : "") +
      "</div></div>" +
      '<div class="ncc-actions">' +
      titanPill(D) +
      '<button type="button" class="ncc-btn primary" data-ncc="chat">◈ Talk to TITAN</button></div></div>' +
      '<div class="ncc-kpis">' +
      renderKpis(D) +
      "</div>" +
      '<div class="ncc-grid">' +
      '<section class="ncc-panel s5" style="--accent:var(--blue)" aria-label="Job tasks">' +
      renderTasksPanel(D) +
      "</section>" +
      '<section class="ncc-panel s4" style="--accent:var(--purple)" aria-label="Wealth and income">' +
      renderWealthPanel(D) +
      "</section>" +
      '<section class="ncc-panel s3" style="--accent:var(--red)" aria-label="Alerts">' +
      renderAlertsPanel(D) +
      "</section></div>" +
      '<div class="ncc-grid">' +
      '<section class="ncc-panel s4" style="--accent:var(--green)" aria-label="Health">' +
      renderHealthPanel(D) +
      "</section>" +
      '<section class="ncc-panel s5" style="--accent:var(--amber)" aria-label="Daybook">' +
      renderDaybookPanel(D) +
      "</section>" +
      '<section class="ncc-panel s3" style="--accent:var(--cyan)" aria-label="Activity">' +
      renderActivityPanel(D) +
      "</section></div>"
    );
  }

  function renderAgentsTop(D, roster) {
    return (
      '<div class="ncc-top"><div><h1 class="ncc-title">AI Agent Organization</h1><div class="ncc-sub">TITAN directs from the centre · 1 working · ' +
      roster.length +
      " planned · " +
      esc(D.dateLine) +
      "</div></div>" +
      '<div class="ncc-actions">' +
      titanPill(D) +
      "</div></div>"
    );
  }
  function renderAgentsBody() {
    return (
      '<div class="ncc-org"><div class="ncc-canvas" data-ncc-canvas><svg class="ncc-lines" aria-hidden="true"></svg>' +
      '<div class="ncc-nodes" role="group" aria-label="TITAN and its team. Arrow keys move between agents."></div></div>' +
      '<section class="ncc-panel ncc-profile" data-ncc-profile></section></div>'
    );
  }

  /* --- TITAN's face. Decorative only (aria-hidden): every state is also given in text. --- */
  function renderFace(st, size, extraAttr) {
    var k = STATE[st] ? st : "idle";
    var px = Math.round(Number(size)) || 64;
    return (
      '<span class="ncc-face" data-face="' +
      k +
      '" style="--fs:' +
      px +
      'px" aria-hidden="true"' +
      (extraAttr || "") +
      '><span class="ncc-face-ring"></span>' +
      '<svg viewBox="0 0 100 100" focusable="false"><g class="eyes">' +
      '<rect class="eye" x="29" y="37" width="13" height="19" rx="6.5"/>' +
      '<rect class="eye" x="58" y="37" width="13" height="19" rx="6.5"/></g>' +
      '<rect class="mouth" x="39" y="66" width="22" height="5" rx="2.5"/></svg></span>'
    );
  }
  function plural(n, word) {
    n = n || 0;
    return NF0.format(n) + " " + word + (n === 1 ? "" : "s");
  }
  function dateOnly(v) {
    var m = /^\d{4}-\d{2}-\d{2}/.exec(String(v || ""));
    return m ? m[0] : "";
  }
  function knowLine(K) {
    if (!K || !K.connected)
      return { text: "Not linked to your Claude account yet", warn: false };
    var t =
      "Knows " +
      plural(K.projects, "project") +
      " · " +
      plural(K.conversations, "chat");
    return K.stale
      ? { text: t + " · export is over a month old", warn: true }
      : { text: t, warn: false };
  }
  function micButton(T, key) {
    if (T.mic === "unavailable")
      return (
        '<button type="button" class="ncc-titan-mic off" data-ncc="' +
        key +
        '"><span aria-hidden="true">⌨</span>No microphone here. Type to TITAN</button>'
      );
    var on = T.state === "listening";
    return (
      '<button type="button" class="ncc-titan-mic' +
      (on ? " on" : "") +
      '" data-ncc="' +
      key +
      '"><span aria-hidden="true">🎙</span>' +
      (on
        ? "Listening… tap to stop"
        : T.mic === "blocked"
          ? "Microphone blocked. Allow it, then tap"
          : "Talk to TITAN") +
      "</button>"
    );
  }
  function renderKnowledge(D, opts) {
    var K = D.knowledge || { connected: false };
    var hooks = (opts && opts.hooks) || {};
    var canImport = typeof hooks.importKnowledge === "function";
    var canClear = typeof hooks.clearKnowledge === "function";
    var row = '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">';
    var safety =
      '<div class="ncc-know-note">Your Claude history stays on this device. Passwords, keys and card numbers are hidden before it is saved. TITAN treats it as information only: any change it suggests from it waits for your tap.</div>';
    if (!K.connected)
      return (
        '<div class="ncc-know"><p class="ncc-pf-text">TITAN can learn what is in your Claude projects, chats and saved memory, answer questions about them, and show where each answer came from.</p>' +
        '<ol class="ncc-know-steps"><li>On claude.ai open <b>Settings → Privacy → Export data</b>. Claude emails you a download link.</li>' +
        "<li>Download the file and unzip it.</li>" +
        "<li>Press the button below and choose the files inside it.</li></ol>" +
        row +
        '<button type="button" class="ncc-btn primary" data-ncc="knowledge-import">Teach TITAN my Claude account</button></div>' +
        (canImport
          ? ""
          : '<div class="ncc-empty">This copy of TITAN can\'t load the files yet.</div>') +
        safety +
        "</div>"
      );
    var k = function (label, v) {
      return (
        '<div class="ncc-k"><b>' + esc(label) + "</b><i>" + esc(NF0.format(v || 0)) + "</i></div>"
      );
    };
    var meta = [];
    if (dateOnly(K.importedAt)) meta.push("Loaded " + dateOnly(K.importedAt));
    if (dateOnly(K.newest)) meta.push("newest item " + dateOnly(K.newest));
    meta.push(plural(K.messages, "message"));
    if (K.redactions) meta.push(plural(K.redactions, "secret") + " hidden");
    return (
      '<div class="ncc-know"><div class="ncc-kgrid">' +
      k("Projects", K.projects) +
      k("Chats", K.conversations) +
      k("Project files", K.docs) +
      k("Saved memories", K.memories) +
      "</div>" +
      '<div class="ncc-know-meta">' +
      esc(meta.join(" · ")) +
      "</div>" +
      (K.stale
        ? '<div class="ncc-know-warn">This copy is over a month old. Export again from claude.ai to include your recent chats.</div>'
        : "") +
      (K.truncated
        ? '<div class="ncc-know-warn">Your export was very large, so the oldest items were left out.</div>'
        : "") +
      row +
      askBtn(
        "What are my Claude projects about, and what did I work on most recently?",
        "Ask about my projects",
      ) +
      '<button type="button" class="ncc-btn" data-ncc="knowledge-import">Load a newer export</button>' +
      (canClear
        ? '<button type="button" class="ncc-btn" data-ncc="knowledge-clear">Remove from this device</button>'
        : "") +
      "</div>" +
      safety +
      "</div>"
    );
  }

  function renderTitanProfile(D, opts) {
    var T = D.titan,
      s = STATE[T.state],
      R = rulesText(opts);
    var tools = T.tools.length
      ? '<div class="ncc-tags">' +
        T.tools
          .map(function (x) {
            return (
              '<span class="ncc-tag ' +
              (x.connected ? "on" : "off") +
              '" dir="auto">' +
              esc(x.name) +
              (x.connected ? "" : " · not connected") +
              "</span>"
            );
          })
          .join("") +
        "</div>"
      : '<div class="ncc-empty">TITAN has not reported its connected tools yet.</div>';
    var acts = D.activity.slice(0, 8);
    var rule = function (title, color, list) {
      return (
        '<div class="ncc-rule" style="--c:' +
        color +
        '"><b>' +
        esc(title) +
        "</b><ul>" +
        arr(list)
          .map(function (x) {
            return "<li>" + esc(x) + "</li>";
          })
          .join("") +
        "</ul></div>"
      );
    };
    return (
      '<div class="ncc-pf-head">' +
      renderFace(T.state, 58) +
      '<div style="min-width:0">' +
      '<h2 class="ncc-pf-name">AI Agent TITAN</h2><div class="ncc-pf-role">AI AGENT · Voice · Runs your day with you</div>' +
      '<div class="ncc-pf-status" style="--sc:' +
      s[1] +
      '"><span class="ncc-dot"></span><span dir="auto">' +
      esc(trunc(stateLabel(T), 60)) +
      "</span></div></div></div>" +
      '<div class="ncc-mic-row">' +
      micButton(T, "mic-profile") +
      "</div>" +
      '<div class="ncc-switch"><div><div class="ncc-switch-k" id="ncc-auto-k">Autonomous mode</div><div class="ncc-switch-s">' +
      (T.autonomous
        ? "On: TITAN makes everyday changes right away and lists them in Activity with Undo."
        : "Ask first: TITAN asks before every change.") +
      "</div></div>" +
      '<button type="button" class="ncc-toggle" role="switch" aria-checked="' +
      (T.autonomous ? "true" : "false") +
      '" aria-labelledby="ncc-auto-k" data-ncc="autonomy"></button></div>' +
      '<div><div class="ncc-sect">KPIs</div><div class="ncc-kgrid">' +
      '<div class="ncc-k"><b>Changes this week</b><i>' +
      esc(T.changesThisWeek) +
      "</i></div>" +
      '<div class="ncc-k"><b>Corrections</b><i>' +
      esc(T.corrections || 0) +
      "</i></div>" +
      '<div class="ncc-k"><b>Tools connected</b><i' +
      (T.tools.length ? "" : ' class="dim"') +
      ">" +
      (T.tools.length ? T.toolsConnected + " of " + T.tools.length : "—") +
      "</i></div>" +
      '<div class="ncc-k"><b>Waiting for your tap</b><i>' +
      T.pendingTaps.length +
      "</i></div></div></div>" +
      '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center"><button type="button" class="ncc-btn primary" data-ncc="chat">Open chat</button>' +
      askBtn(
        "What are you working on right now, and what changes have you made this week?",
      ) +
      "</div>" +
      '<div><div class="ncc-sect">What TITAN knows</div>' +
      renderKnowledge(D, opts) +
      "</div>" +
      '<div><div class="ncc-sect">Tools &amp; access</div>' +
      tools +
      "</div>" +
      '<div><div class="ncc-sect">Recent activity</div>' +
      (acts.length
        ? '<div class="ncc-feed">' +
          acts
            .map(function (a) {
              return activityItem(a, D);
            })
            .join("") +
          "</div>"
        : '<div class="ncc-empty">No changes yet. TITAN\'s real changes appear here as it makes them.</div>') +
      "</div>" +
      '<div><div class="ncc-sect">Rules</div><div class="ncc-rules">' +
      rule(
        T.autonomous
          ? "Does it right away"
          : "Does it right away (only when Autonomous is on)",
        "var(--green)",
        R.auto,
      ) +
      rule("Waits for your tap", "var(--amber)", R.tap) +
      rule("Never allowed", "var(--red)", R.never) +
      "</div></div>"
    );
  }

  function renderPlannedProfile(a, D, opts) {
    var R = rulesText(opts);
    var firstTap = arr(R.tap)[0] || "Sending anything waits for your tap";
    var firstNever =
      arr(R.never)[0] || "Payments, transfers, trades or purchases";
    return (
      '<div class="ncc-pf-head"><div class="ncc-pf-avatar" aria-hidden="true">' +
      esc(a.icon || "◇") +
      '</div><div style="min-width:0">' +
      '<h2 class="ncc-pf-name" dir="auto">' +
      esc(a.name) +
      '</h2><div class="ncc-pf-role" dir="auto">' +
      esc(a.role || "") +
      "</div>" +
      '<div class="ncc-pf-status" style="--sc:#8a96ac"><span class="ncc-dot"></span>PLANNED · PART OF TITAN\'S TEAM</div></div></div>' +
      '<div><div class="ncc-sect">Mission</div><p class="ncc-pf-text" dir="auto">' +
      esc(a.mission || "Planned. Not built yet.") +
      "</p></div>" +
      '<div><div class="ncc-sect">KPIs</div><div class="ncc-kgrid">' +
      ["Status", "Runs", "Last run", "Changes"]
        .map(function (k, i) {
          return (
            '<div class="ncc-k"><b>' +
            k +
            '</b><i class="dim">' +
            (i === 0 ? "Planned" : "—") +
            "</i></div>"
          );
        })
        .join("") +
      "</div></div>" +
      '<div><div class="ncc-sect">Tools it would use</div><div class="ncc-tags">' +
      arr(a.tools)
        .map(function (x) {
          return '<span class="ncc-tag off" dir="auto">' + esc(x) + "</span>";
        })
        .join("") +
      "</div></div>" +
      '<div><div class="ncc-sect">Recent activity</div><div class="ncc-empty">Not built yet. Its slot is reserved in TITAN\'s team.</div></div>' +
      '<div><div class="ncc-sect">Rules</div><p class="ncc-pf-text">When built, it works for TITAN and follows TITAN\'s rules: everyday changes happen right away only in Autonomous mode. ' +
      esc(firstTap) +
      ". Never: " +
      esc(firstNever.charAt(0).toLowerCase() + firstNever.slice(1)) +
      ".</p></div>" +
      "<div>" +
      askBtn(
        "Plan the " +
          a.name +
          " agent for me: what it would do, what it needs, and what you would ask me before building it.",
        "Ask TITAN to plan it",
      ) +
      "</div>"
    );
  }

  function renderShell(opts) {
    var brand = esc(opts.brand || "TITAN · AI OS"),
      sub = esc(opts.brandSub || "Command Center");
    return (
      '<aside class="ncc-side" aria-label="TITAN navigation">' +
      '<div class="ncc-brand"><div class="ncc-logo" aria-hidden="true">◈</div><div style="min-width:0"><div class="ncc-brand-name">' +
      brand +
      '</div><div class="ncc-brand-sub">' +
      sub +
      "</div></div></div>" +
      '<nav class="ncc-nav" aria-label="Pages"><div class="ncc-nav-sep">OVERVIEW</div>' +
      '<button type="button" class="ncc-nav-item" data-ncc-page="command"><span aria-hidden="true">▦</span>Command Center</button>' +
      '<button type="button" class="ncc-nav-item" data-ncc-page="agents"><span aria-hidden="true">◈</span>AI Agents</button>' +
      '<div class="ncc-nav-sep">TITAN</div>' +
      '<button type="button" class="ncc-nav-item" data-ncc="chat"><span aria-hidden="true">✦</span>Chat &amp; voice</button>' +
      '<button type="button" class="ncc-nav-item" data-ncc="settings"><span aria-hidden="true">⚙</span>Settings</button></nav>' +
      '<div class="ncc-side-foot"><div class="ncc-sys" data-ncc-sys></div></div></aside>' +
      '<main class="ncc-main" id="ncc-main">' +
      '<section class="ncc-page" data-ncc-view="command" aria-label="Command Center"></section>' +
      '<section class="ncc-page" data-ncc-view="agents" aria-label="AI Agents"></section></main>' +
      '<div class="ncc-scrim" data-ncc="close-sheet" aria-hidden="true"></div>' +
      '<aside class="ncc-dock" aria-label="TITAN chat and voice" data-ncc-dock>' +
      '<div class="ncc-sheet-handle" aria-hidden="true"></div>' +
      '<div class="ncc-dock-head">' +
      renderFace("idle", 32, " data-ncc-dockface") +
      '<div class="ncc-dock-text" style="min-width:0"><div class="ncc-dock-name" id="ncc-dock-title">TITAN</div><div class="ncc-dock-state" data-ncc-dockstate role="status" aria-live="polite"></div></div>' +
      '<div class="ncc-dock-tools"><button type="button" class="ncc-icon-btn" data-ncc="collapse" aria-expanded="true" aria-controls="ncc-chat-host" title="Collapse chat panel" aria-label="Collapse chat panel">⇥</button>' +
      '<button type="button" class="ncc-icon-btn" data-ncc="close-sheet" title="Close" aria-label="Close chat">✕</button></div></div>' +
      '<div class="ncc-chat-host" id="ncc-chat-host" data-ncc-chathost></div></aside>' +
      '<nav class="ncc-tabs" aria-label="Pages">' +
      '<button type="button" class="ncc-tab" data-ncc-page="command"><span aria-hidden="true">▦</span><span>Command</span></button>' +
      '<button type="button" class="ncc-tab" data-ncc-page="agents"><span aria-hidden="true">◈</span><span>Agents</span></button>' +
      '<button type="button" class="ncc-tab" data-ncc="chat"><span aria-hidden="true">✦</span><span>TITAN</span></button>' +
      '<button type="button" class="ncc-tab" data-ncc="settings"><span aria-hidden="true">⚙</span><span>Settings</span></button></nav>' +
      '<button type="button" class="ncc-fab" data-ncc="mic" aria-label="Talk to TITAN (start listening)"><span aria-hidden="true">🎙</span></button>' +
      '<div class="ncc-toast" role="status" aria-live="polite" hidden></div>'
    );
  }

  function renderSys(D) {
    return (
      '<div class="ncc-sys-row"><b>TITAN</b><i style="color:' +
      STATE[D.titan.state][1] +
      '">' +
      esc(STATE[D.titan.state][0]) +
      "</i></div>" +
      '<div class="ncc-sys-row"><b>Mode</b><i>' +
      (D.titan.autonomous ? "Autonomous" : "Ask first") +
      "</i></div>" +
      '<div class="ncc-sys-row"><b>Overdue tasks</b><i' +
      (D.overdue.length ? ' style="color:var(--red)"' : "") +
      ">" +
      (D.has ? D.overdue.length : "—") +
      "</i></div>" +
      '<div class="ncc-sys-row"><b>Waiting for your tap</b><i' +
      (D.titan.pendingTaps.length ? ' style="color:var(--amber)"' : "") +
      ">" +
      D.titan.pendingTaps.length +
      "</i></div>"
    );
  }

  /* ======================================================================
   * Controller
   * ====================================================================== */
  function storeGet(k) {
    try {
      return root.localStorage.getItem(k);
    } catch (e) {
      return null;
    }
  }
  function storeSet(k, v) {
    try {
      root.localStorage.setItem(k, v);
    } catch (e) {
      /* storage blocked: the preference just isn't remembered */
    }
  }

  function injectStyle(doc) {
    if (doc.getElementById("ncc-style")) return;
    var st = doc.createElement("style");
    st.id = "ncc-style";
    st.textContent = CSS;
    doc.head.appendChild(st);
  }

  /**
   * Mount the Command Center.
   * @param {object} opts
   * @param {Element} [opts.chat]          TITAN's existing chat + voice element: moved into the dock, put back on classic view.
   * @param {Element[]|NodeList} [opts.classicElements] parts of the classic layout to hide while the Command Center shows
   *                                       (or mark them in voice-agent.html with the attribute data-ncc-classic).
   * @param {function} [opts.getSnapshot]  returns the current snapshot (or a Promise); called on mount, every 60 s and on refresh().
   * @param {object} [opts.hooks]          { ask(text), openChat(), mic(), undo(id) -> {ok,message}|Promise,
   *                                         setAutonomous(on), setClassic(on), openSettings(), onPage(page),
   *                                         importKnowledge(), clearKnowledge() }
   *                                       mic() is called for every mic button (card, profile, floating button);
   *                                       treat it as a toggle and report progress with setState().
   *                                       importKnowledge() should open a file picker for the claude.ai export files.
   * @param {Array}  [opts.roster]         planned agents [{ id, name, role, icon, mission, tools }]
   * @param {boolean}[opts.startClassic]   start in classic view (default: the remembered choice, else Command Center)
   */
  function mount(opts) {
    opts = opts || {};
    var doc = root.document;
    var hooks = opts.hooks || {};
    var roster = (Array.isArray(opts.roster) ? opts.roster : ROSTER).filter(
      function (a) {
        return a && a.name && a.id && a.id !== "titan";
      },
    );
    var state = {
      page: "command",
      agent: "titan",
      snap: null,
      D: null,
      classic: false,
      timer: 0,
      ro: null,
      chatAnchor: null,
      toastT: 0,
      sheetOpen: false,
      lastFocus: null,
    };
    var el = null;

    function classicEls() {
      return opts.classicElements
        ? Array.prototype.slice.call(opts.classicElements)
        : [];
    }
    function call(name) {
      var fn = hooks[name];
      if (typeof fn !== "function") return undefined;
      try {
        return fn.apply(null, Array.prototype.slice.call(arguments, 1));
      } catch (e) {
        if (root.console)
          root.console.error("NovaCommand hook " + name + " failed", e);
        return undefined;
      }
    }
    function snapshotNow() {
      if (typeof opts.getSnapshot === "function") {
        try {
          return opts.getSnapshot();
        } catch (e) {
          if (root.console)
            root.console.error("NovaCommand getSnapshot failed", e);
        }
      }
      return state.snap;
    }

    /* --- build / tear down --- */
    function build() {
      injectStyle(doc);
      el = doc.createElement("div");
      el.className =
        "ncc" + (storeGet(DOCK_PREF) === "closed" ? " dock-closed" : "");
      el.id = "ncc-root";
      el.innerHTML = renderShell(opts);
      if (el.classList.contains("dock-closed")) {
        var cb = el.querySelector('[data-ncc="collapse"]');
        cb.setAttribute("aria-expanded", "false");
        cb.textContent = "⇤";
        cb.title = "Open chat panel";
        cb.setAttribute("aria-label", "Open chat panel");
      }
      doc.body.insertBefore(el, doc.body.firstChild);
      doc.documentElement.classList.add("ncc-on");
      classicEls().forEach(function (c) {
        c.setAttribute("data-ncc-classic", "");
      });
      // move TITAN's chat into the dock, leaving an anchor so classic view can put it back exactly
      var host = el.querySelector("[data-ncc-chathost]");
      if (opts.chat && opts.chat.parentNode) {
        state.chatAnchor = doc.createComment("ncc-chat-anchor");
        opts.chat.parentNode.insertBefore(state.chatAnchor, opts.chat);
        host.appendChild(opts.chat);
      } else {
        host.innerHTML =
          '<div class="ncc-chat-empty">TITAN\'s chat appears here.</div>';
      }
      el.querySelector("[data-ncc-view=agents]").innerHTML =
        renderAgentsTop(compute(state.snap), roster) + renderAgentsBody();
      el.addEventListener("click", onClick);
      el.addEventListener("keydown", onKey);
      doc.addEventListener("keydown", onDocKey);
      if (root.ResizeObserver) {
        state.ro = new root.ResizeObserver(function () {
          if (state.page === "agents") layoutOrg();
        });
        state.ro.observe(el.querySelector("[data-ncc-canvas]"));
      } else root.addEventListener("resize", onResize);
      state.timer = root.setInterval(refresh, 60000);
    }
    function teardown() {
      if (!el) return;
      root.clearInterval(state.timer);
      if (state.ro) {
        state.ro.disconnect();
        state.ro = null;
      } else root.removeEventListener("resize", onResize);
      doc.removeEventListener("keydown", onDocKey);
      // put TITAN's chat element back exactly where it was
      if (opts.chat && state.chatAnchor && state.chatAnchor.parentNode) {
        state.chatAnchor.parentNode.insertBefore(opts.chat, state.chatAnchor);
        state.chatAnchor.parentNode.removeChild(state.chatAnchor);
      }
      state.chatAnchor = null;
      // Keep the data-ncc-classic marks: the hiding rule only applies while <html> has
      // class "ncc-on", and removing the marks would break panels marked in the HTML itself.
      doc.documentElement.classList.remove("ncc-on");
      if (el.parentNode) el.parentNode.removeChild(el);
      el = null;
    }

    /* --- rendering --- */
    function render(snap) {
      if (snap !== undefined) state.snap = snap;
      if (!el) return;
      var D = compute(state.snap);
      state.D = D;
      var focusSel =
        doc.activeElement && el.contains(doc.activeElement)
          ? focusSignature(doc.activeElement)
          : null;
      el.querySelector("[data-ncc-sys]").innerHTML = renderSys(D);
      var dockHtml =
        '<span class="ncc-dot' +
        (D.titan.state !== "idle" ? " live" : "") +
        '" style="--dc:' +
        STATE[D.titan.state][1] +
        '"></span><span dir="auto">' +
        esc(stateLabel(D.titan)) +
        "</span>";
      if (state.dockHtml !== dockHtml) {
        // a live region: write it only when the words change, so it is read once
        el.querySelector("[data-ncc-dockstate]").innerHTML = dockHtml;
        state.dockHtml = dockHtml;
      }
      var dockFace = el.querySelector("[data-ncc-dockface]");
      if (dockFace) dockFace.setAttribute("data-face", D.titan.state);
      var fab = el.querySelector(".ncc-fab");
      fab.classList.toggle("live", D.titan.state === "listening");
      fab.setAttribute(
        "aria-label",
        D.titan.state === "listening"
          ? "TITAN is listening. Tap to stop."
          : "Talk to TITAN (start listening)",
      );
      el.querySelector("[data-ncc-view=command]").innerHTML =
        renderCommandPage(D);
      var ag = el.querySelector("[data-ncc-view=agents]");
      ag.querySelector(".ncc-top").outerHTML = renderAgentsTop(D, roster);
      if (state.page === "agents") {
        layoutOrg();
        renderProfile();
      }
      setPageClasses();
      if (focusSel) restoreFocus(focusSel);
    }
    function focusSignature(node) {
      var keys = [
        "data-ncc-undo",
        "data-ncc-ask",
        "data-ncc-agent",
        "data-ncc-page",
        "data-ncc",
      ];
      for (var i = 0; i < keys.length; i++) {
        if (node.hasAttribute && node.hasAttribute(keys[i])) {
          var view = node.closest("[data-ncc-view]");
          return (
            (view
              ? '[data-ncc-view="' + view.getAttribute("data-ncc-view") + '"] '
              : "") +
            "[" +
            keys[i] +
            '="' +
            cssEsc(node.getAttribute(keys[i])) +
            '"]'
          );
        }
      }
      return null;
    }
    function restoreFocus(sel) {
      try {
        var n = el.querySelector(sel);
        if (n && doc.activeElement !== n) n.focus({ preventScroll: true });
      } catch (e) {
        /* element is gone */
      }
    }
    function setPageClasses() {
      el.querySelectorAll("[data-ncc-view]").forEach(function (p) {
        p.classList.toggle(
          "active",
          p.getAttribute("data-ncc-view") === state.page,
        );
      });
      el.querySelectorAll("[data-ncc-page]").forEach(function (b) {
        if (b.getAttribute("data-ncc-page") === state.page)
          b.setAttribute("aria-current", "page");
        else b.removeAttribute("aria-current");
      });
    }
    function refresh() {
      var s = snapshotNow();
      if (s && typeof s.then === "function")
        s.then(
          function (v) {
            render(v);
          },
          function () {
            render();
          },
        );
      else render(s);
    }

    /* --- org chart: positions come from the canvas size, so nothing is hard-coded --- */
    function layoutOrg() {
      if (!el || !state.D) return;
      var canvas = el.querySelector("[data-ncc-canvas]");
      if (!canvas) return;
      var D = state.D,
        wrap = canvas.querySelector(".ncc-nodes"),
        lines = canvas.querySelector(".ncc-lines");
      var W = canvas.clientWidth;
      // stacked on narrow screens, or at a width where the ring was found not to fit
      var stack = W < 640 || state.stackAtW === W;
      canvas.classList.toggle("stack", stack);
      if (stack) canvas.style.height = "";
      var T = D.titan,
        s = STATE[T.state];
      var KL = knowLine(D.knowledge);
      var html =
        '<div class="ncc-node director titan' +
        (state.agent === "titan" ? " sel" : "") +
        '" role="group" aria-label="AI Agent TITAN">' +
        '<button type="button" class="ncc-titan-main" data-ncc-agent="titan" aria-pressed="' +
        (state.agent === "titan") +
        '" aria-label="AI Agent TITAN. ' +
        esc(stateLabel(T)) +
        ". " +
        esc(KL.text) +
        '. Shows his profile and opens the chat.">' +
        '<span class="ncc-badge">AI AGENT</span>' +
        renderFace(T.state, 72) +
        '<span class="ncc-node-n">TITAN</span>' +
        '<span class="ncc-node-r">Voice · ' +
        (T.autonomous ? "Autonomous" : "Ask first") +
        " · " +
        esc(T.changesThisWeek) +
        " changes this week</span>" +
        '<span class="ncc-node-s" style="--sc:' +
        s[1] +
        '"><span class="ncc-dot"></span><span dir="auto">' +
        esc(trunc(stateLabel(T), 40)) +
        "</span></span>" +
        '<span class="ncc-titan-know' +
        (KL.warn ? " warn" : "") +
        '">' +
        esc(KL.text) +
        "</span></button>" +
        micButton(T, "mic-card") +
        "</div>" +
        roster
          .map(function (a) {
            return (
              '<button type="button" class="ncc-node planned" data-ncc-agent="' +
              esc(a.id) +
              '" aria-pressed="' +
              (state.agent === a.id) +
              '" aria-label="' +
              esc(a.name) +
              ', planned">' +
              '<div class="ncc-node-n"><span aria-hidden="true">' +
              esc(a.icon || "◇") +
              '</span><span dir="auto">' +
              esc(a.name) +
              "</span></div>" +
              '<div class="ncc-node-r" dir="auto">' +
              esc(a.role || "") +
              "</div>" +
              '<div class="ncc-node-s" style="--sc:#8a96ac"><span class="ncc-dot"></span>PLANNED</div></button>'
            );
          })
          .join("");
      var focusSig =
        doc.activeElement && wrap.contains(doc.activeElement)
          ? focusSignature(doc.activeElement)
          : null;
      wrap.innerHTML = html;
      lines.innerHTML = "";
      if (!stack) {
        var H = canvas.clientHeight,
          CX = W / 2,
          CY;
        var btns = wrap.querySelectorAll(".ncc-node");
        var maxW = 0,
          maxH = 0; // measure real node sizes so no node is pushed off the canvas
        for (var b = 1; b < btns.length; b++) {
          maxW = Math.max(maxW, btns[b].offsetWidth);
          maxH = Math.max(maxH, btns[b].offsetHeight);
        }
        var pad = 14,
          n = roster.length;
        var rx = Math.max(60, CX - maxW / 2 - pad);
        // The ring must clear the TITAN card in the centre. Work out how tall the
        // canvas has to be for that; grow it a little if needed, or stack as a last resort.
        var cw = btns[0].offsetWidth / 2 + maxW / 2 + 8,
          ch = btns[0].offsetHeight / 2 + maxH / 2 + 8;
        var angs = [],
          needRy = 0,
          fits = true;
        for (var i = 0; i < n; i++) {
          var a = -Math.PI / 2 + (i * 2 * Math.PI) / n;
          angs.push(a);
          if (Math.abs(rx * Math.cos(a)) < cw) {
            var sn = Math.abs(Math.sin(a));
            if (sn < 0.05) fits = false;
            else needRy = Math.max(needRy, ch / sn);
          }
        }
        var wantH = Math.max(ORG_BASE_H, Math.ceil(2 * (needRy + maxH / 2 + pad)));
        if (!fits || wantH > ORG_MAX_H) {
          state.stackAtW = W;
          canvas.classList.add("stack");
          canvas.style.height = "";
          if (focusSig) restoreFocus(focusSig);
          return;
        }
        if (Math.abs(H - wantH) > 1) {
          canvas.style.height = wantH + "px";
          H = wantH;
        }
        CY = H / 2;
        var ry = Math.max(60, CY - maxH / 2 - pad);
        var pts = angs.map(function (a2) {
          return [CX + rx * Math.cos(a2), CY + ry * Math.sin(a2)];
        });
        btns[0].style.left = CX + "px";
        btns[0].style.top = CY + "px";
        for (var j = 1; j < btns.length; j++) {
          btns[j].style.left = pts[j - 1][0].toFixed(1) + "px";
          btns[j].style.top = pts[j - 1][1].toFixed(1) + "px";
        }
        lines.setAttribute("viewBox", "0 0 " + W + " " + H);
        lines.innerHTML = pts
          .map(function (p) {
            return (
              '<line x1="' +
              CX +
              '" y1="' +
              CY +
              '" x2="' +
              p[0].toFixed(1) +
              '" y2="' +
              p[1].toFixed(1) +
              '" stroke="rgba(255,255,255,.09)" stroke-width="1.4" stroke-dasharray="4 6"/>'
            );
          })
          .join("");
      }
      if (focusSig) restoreFocus(focusSig);
    }
    function renderProfile() {
      var box = el && el.querySelector("[data-ncc-profile]");
      if (!box || !state.D) return;
      var a = roster.filter(function (x) {
        return x.id === state.agent;
      })[0];
      box.innerHTML =
        state.agent === "titan" || !a
          ? renderTitanProfile(state.D, opts)
          : renderPlannedProfile(a, state.D, opts);
    }

    /* --- navigation, sheet, dock --- */
    function setPage(p) {
      if (p !== "command" && p !== "agents") return;
      state.page = p;
      if (!el) return;
      setPageClasses();
      if (p === "agents") {
        layoutOrg();
        renderProfile();
        root.requestAnimationFrame(layoutOrg);
      }
      call("onPage", p);
      try {
        root.scrollTo(0, 0);
      } catch (e) {
        /* not available */
      }
    }
    function isMobile() {
      return root.matchMedia
        ? root.matchMedia("(max-width: 939.98px)").matches
        : false;
    }
    function openChat(focusInput) {
      if (!el) return;
      if (isMobile()) {
        if (!state.sheetOpen) {
          state.lastFocus = doc.activeElement;
          state.lastFocusSig =
            doc.activeElement && el.contains(doc.activeElement)
              ? focusSignature(doc.activeElement)
              : null;
        }
        el.classList.add("sheet-open");
        state.sheetOpen = true;
        var dock = el.querySelector("[data-ncc-dock]");
        dock.setAttribute("role", "dialog");
        dock.setAttribute("aria-modal", "true");
        dock.setAttribute("aria-labelledby", "ncc-dock-title");
      } else if (el.classList.contains("dock-closed")) {
        setDock(true);
      }
      call("openChat");
      if (focusInput !== false) {
        root.setTimeout(function () {
          if (!el) return;
          var host = el.querySelector("[data-ncc-chathost]");
          var input =
            host &&
            host.querySelector(
              "textarea, input[type=text], input:not([type]), [contenteditable=true]",
            );
          if (input) input.focus();
          else if (isMobile()) {
            var c = el.querySelector('.ncc-dock [data-ncc="close-sheet"]');
            if (c) c.focus();
          }
        }, 60);
      }
    }
    function closeSheet() {
      if (!el || !state.sheetOpen) return;
      el.classList.remove("sheet-open");
      state.sheetOpen = false;
      var dock = el.querySelector("[data-ncc-dock]");
      dock.removeAttribute("role");
      dock.removeAttribute("aria-modal");
      dock.removeAttribute("aria-labelledby");
      if (
        state.lastFocus &&
        state.lastFocus.focus &&
        doc.contains(state.lastFocus)
      )
        state.lastFocus.focus();
      else if (state.lastFocusSig) restoreFocus(state.lastFocusSig);
    }
    function setDock(open) {
      if (!el) return;
      el.classList.toggle("dock-closed", !open);
      storeSet(DOCK_PREF, open ? "open" : "closed");
      var b = el.querySelector('[data-ncc="collapse"]');
      b.setAttribute("aria-expanded", open ? "true" : "false");
      b.textContent = open ? "⇥" : "⇤";
      b.title = open ? "Collapse chat panel" : "Open chat panel";
      b.setAttribute("aria-label", b.title);
      if (state.page === "agents") root.requestAnimationFrame(layoutOrg);
    }
    function toast(msg) {
      if (!el) return;
      var t = el.querySelector(".ncc-toast");
      t.textContent = msg;
      t.hidden = false;
      root.clearTimeout(state.toastT);
      state.toastT = root.setTimeout(function () {
        t.hidden = true;
      }, 3200);
    }
    function settingsHTML(D) {
      return (
        '<div class="ncc-switch"><div><div class="ncc-switch-k" id="ncc-set-classic">Classic view</div><div class="ncc-switch-s">Go back to TITAN\'s original screen. Turn it off again in TITAN\'s Settings.</div></div>' +
        '<button type="button" class="ncc-toggle" role="switch" aria-checked="false" aria-labelledby="ncc-set-classic" data-set="classic"></button></div>' +
        '<div class="ncc-switch"><div><div class="ncc-switch-k" id="ncc-set-auto">Autonomous mode</div><div class="ncc-switch-s">On: everyday changes happen right away with Undo. Off (Ask first): TITAN asks before every change.</div></div>' +
        '<button type="button" class="ncc-toggle" role="switch" aria-checked="' +
        (D.titan.autonomous ? "true" : "false") +
        '" aria-labelledby="ncc-set-auto" data-set="autonomy"></button></div>'
      );
    }
    function openSettings() {
      var D = state.D || compute(state.snap);
      var wrap = doc.createElement("div");
      wrap.className = "ncc-modal-scrim";
      wrap.innerHTML =
        '<div class="ncc-modal" role="dialog" aria-modal="true" aria-labelledby="ncc-set-title">' +
        '<div class="ncc-modal-head"><h2 class="ncc-panel-title" id="ncc-set-title"><span class="bar" aria-hidden="true"></span>Settings</h2>' +
        '<button type="button" class="ncc-icon-btn" data-set="close" aria-label="Close settings">✕</button></div>' +
        settingsHTML(D) +
        (typeof hooks.openSettings === "function"
          ? '<button type="button" class="ncc-btn" data-set="titan">Open all TITAN settings</button>'
          : "") +
        "</div>";
      el.appendChild(wrap);
      var prev = doc.activeElement;
      var close = function () {
        if (wrap.parentNode) wrap.parentNode.removeChild(wrap);
        if (prev && prev.focus && doc.contains(prev)) prev.focus();
      };
      wrap.addEventListener("click", function (e) {
        var b = e.target.closest("[data-set]");
        if (
          e.target === wrap ||
          (b && b.getAttribute("data-set") === "close")
        ) {
          close();
          return;
        }
        if (!b) return;
        var k = b.getAttribute("data-set");
        if (k === "classic") {
          close();
          setClassic(true);
        } else if (k === "autonomy") {
          var on = b.getAttribute("aria-checked") !== "true";
          b.setAttribute("aria-checked", String(on));
          call("setAutonomous", on);
          root.setTimeout(refresh, 30);
        } else if (k === "titan") {
          close();
          call("openSettings");
        }
      });
      wrap.addEventListener("keydown", function (e) {
        if (e.key === "Escape") {
          e.stopPropagation();
          close();
          return;
        }
        if (e.key === "Tab") {
          // keep focus inside the dialog
          var f = wrap.querySelectorAll("button");
          if (!f.length) return;
          var first = f[0],
            last = f[f.length - 1];
          if (e.shiftKey && doc.activeElement === first) {
            last.focus();
            e.preventDefault();
          } else if (!e.shiftKey && doc.activeElement === last) {
            first.focus();
            e.preventDefault();
          }
        }
      });
      var firstBtn = wrap.querySelector("[data-set=close]");
      if (firstBtn) firstBtn.focus();
    }

    /* --- events --- */
    function onClick(e) {
      var t = e.target.closest ? e.target.closest("button,[data-ncc]") : null;
      if (
        !t ||
        !el ||
        !el.contains(t) ||
        t.closest(".ncc-modal-scrim") ||
        t.closest("[data-ncc-chathost]")
      )
        return;
      var page = t.getAttribute("data-ncc-page");
      if (page) {
        setPage(page);
        return;
      }
      var ask = t.getAttribute("data-ncc-ask");
      if (ask) {
        openChat(false);
        call("ask", ask);
        return;
      }
      var undo = t.getAttribute("data-ncc-undo");
      if (undo) {
        doUndo(t, undo);
        return;
      }
      var agent = t.getAttribute("data-ncc-agent");
      if (agent) {
        state.agent = agent;
        el.querySelectorAll("[data-ncc-agent]").forEach(function (n) {
          n.setAttribute(
            "aria-pressed",
            String(n.getAttribute("data-ncc-agent") === agent),
          );
        });
        var tn = el.querySelector(".ncc-node.titan");
        if (tn) tn.classList.toggle("sel", agent === "titan");
        renderProfile();
        if (agent === "titan") openChat();
        else if (
          el.querySelector("[data-ncc-canvas]").classList.contains("stack")
        ) {
          var pf = el.querySelector("[data-ncc-profile]");
          if (pf && pf.scrollIntoView)
            pf.scrollIntoView({ behavior: "smooth", block: "start" });
        }
        return;
      }
      var k = t.getAttribute("data-ncc");
      if (k === "chat") openChat();
      else if (k === "mic" || k === "mic-card" || k === "mic-profile") {
        if (state.D && state.D.titan.mic === "unavailable") openChat();
        else if (typeof hooks.mic !== "function") {
          toast("Voice isn't connected in this copy of TITAN yet. Type instead.");
          openChat();
        } else {
          openChat(false);
          call("mic");
        }
      } else if (k === "knowledge-import") {
        if (typeof hooks.importKnowledge === "function") call("importKnowledge");
        else
          toast(
            "This copy of TITAN can't load Claude exports yet. Nothing was changed.",
          );
      } else if (k === "knowledge-clear") {
        if (
          typeof root.confirm !== "function" ||
          root.confirm(
            "Remove TITAN's copy of your Claude history from this device? Your Claude account itself is not touched.",
          )
        )
          call("clearKnowledge");
      } else if (k === "close-sheet") closeSheet();
      else if (k === "collapse") setDock(el.classList.contains("dock-closed"));
      else if (k === "settings") openSettings();
      else if (k === "autonomy") {
        var on = t.getAttribute("aria-checked") !== "true";
        t.setAttribute("aria-checked", String(on));
        call("setAutonomous", on);
        root.setTimeout(refresh, 30);
      }
    }
    function doUndo(btn, id) {
      if (typeof hooks.undo !== "function") {
        toast("Undo isn't connected yet. Nothing was changed.");
        return;
      }
      btn.disabled = true;
      btn.textContent = "Undoing…";
      var res;
      try {
        res = hooks.undo(id);
      } catch (err) {
        res = {
          ok: false,
          message:
            "Nothing was changed — " +
            ((err && err.message) || "undo failed") +
            ".",
        };
      }
      Promise.resolve(res).then(
        function (r) {
          // proof rule: only say it worked when the app confirmed it
          if (r && r.ok === true) toast(r.message || "Undone");
          else if (r && r.ok === false)
            toast(r.message || "Nothing was changed.");
          else toast("Undo sent to TITAN");
          if (!(r && r.ok === true) && btn.isConnected) {
            btn.disabled = false;
            btn.textContent = "Undo";
          }
          refresh();
        },
        function (err) {
          toast(
            "Nothing was changed — " +
              ((err && err.message) || "undo failed") +
              ".",
          );
          if (btn.isConnected) {
            btn.disabled = false;
            btn.textContent = "Undo";
          }
        },
      );
    }
    function onKey(e) {
      var n = e.target;
      if (!n || !n.getAttribute || !n.getAttribute("data-ncc-agent")) return;
      var keys = {
        ArrowRight: 1,
        ArrowDown: 1,
        ArrowLeft: -1,
        ArrowUp: -1,
        Home: "first",
        End: "last",
      };
      if (!(e.key in keys)) return;
      var list = Array.prototype.slice.call(
        el.querySelectorAll("[data-ncc-agent]"),
      );
      var i = list.indexOf(n),
        d = keys[e.key];
      var next =
        d === "first"
          ? 0
          : d === "last"
            ? list.length - 1
            : (i + d + list.length) % list.length;
      list[next].focus();
      e.preventDefault();
    }
    function onDocKey(e) {
      if (e.key === "Escape" && state.sheetOpen) closeSheet();
    }
    var rz = 0;
    function onResize() {
      root.cancelAnimationFrame(rz);
      rz = root.requestAnimationFrame(function () {
        if (state.page === "agents") layoutOrg();
      });
    }

    /* --- classic view --- */
    function setClassic(on, silent) {
      on = !!on;
      if (on === state.classic && (on ? !el : !!el)) return;
      state.classic = on;
      storeSet(CLASSIC_PREF, on ? "classic" : "command");
      if (on) {
        closeSheet();
        teardown();
      } else {
        build();
        refresh();
        setPage(state.page);
      }
      if (!silent) call("setClassic", on);
    }

    /* --- light-weight live state update (listening / thinking / speaking / working) --- */
    function setState(st, workingOn) {
      state.snap = Object.assign({}, state.snap || {});
      state.snap.titan = Object.assign({}, state.snap.titan || {}, {
        state: st,
        workingOn: workingOn || "",
      });
      render();
    }

    var startClassic =
      typeof opts.startClassic === "boolean"
        ? opts.startClassic
        : storeGet(CLASSIC_PREF) === "classic";
    state.classic = startClassic;
    if (!startClassic) {
      build();
      refresh();
      setPage("command");
    }

    return {
      render: render,
      refresh: refresh,
      setPage: setPage,
      setState: setState,
      openChat: openChat,
      closeChat: closeSheet,
      setClassic: setClassic,
      isClassic: function () {
        return state.classic;
      },
      toast: toast,
      destroy: teardown,
      get element() {
        return el;
      },
    };
  }

  return {
    VERSION: VERSION,
    ROSTER: ROSTER,
    RULES_FALLBACK: RULES_FALLBACK,
    compute: compute,
    mount: mount,
    esc: esc,
    isClassicPreferred: function () {
      return storeGet(CLASSIC_PREF) === "classic";
    },
    _internal: {
      toDs: toDs,
      addDays: addDays,
      nextOccurrence: nextOccurrence,
      renderCommandPage: renderCommandPage,
      renderDirectorProfile: renderTitanProfile, // old name kept for existing callers
      renderTitanProfile: renderTitanProfile,
      renderKnowledge: renderKnowledge,
      renderFace: renderFace,
      knowLine: knowLine,
      renderPlannedProfile: renderPlannedProfile,
    },
  };
});
