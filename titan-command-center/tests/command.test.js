"use strict";
// Tests for nova-command.js: the pure compute() step and the HTML renderers.
// All data below is invented test data — no personal values.
const test = require("node:test");
const assert = require("node:assert/strict");
const C = require("../nova-command.js");

// Wednesday 7 Oct 2026, 15:00 in Riyadh (UTC+3). Week (Sun start) = 4–10 Oct.
const NOW = Date.parse("2026-10-07T12:00:00Z");

test("empty snapshot gives empty states, never sample numbers", () => {
  const D = C.compute({}, NOW);
  assert.equal(D.job.ratio, null);
  assert.equal(D.netWorth, null);
  assert.equal(D.income, null);
  assert.equal(D.savingsRate, null);
  assert.equal(D.wealthProgress, null);
  assert.deepEqual(D.history, []);
  assert.equal(D.mood, null);
  assert.equal(D.habitConsistency, null);
  assert.equal(D.runsThisWeek, null);
  assert.equal(D.healthSource, null);
  assert.equal(D.streak, 0);
  assert.equal(D.heat.length, 84);
  assert.deepEqual(D.alerts, []);
  const html = C._internal.renderCommandPage(D);
  // The design's demo figures must never appear when there is no data.
  for (const sample of ["82%", "1.24M", "45,000", "7.2h", "8,432"]) {
    assert.ok(!html.includes(sample), `sample value ${sample} leaked`);
  }
  assert.match(html, /Connect a health source/);
});

test("the date line is live, not hard-coded", () => {
  const wed = C.compute({}, NOW);
  assert.match(wed.dateLine, /Wednesday/);
  assert.match(wed.dateLine, /2026/);
  const thu = C.compute({}, NOW + 24 * 36e5);
  assert.match(thu.dateLine, /Thursday/);
  assert.equal(wed.weekStart, "2026-10-04");
  assert.equal(wed.weekEnd, "2026-10-10");
});

test("Job Tasks = work done this week ÷ (done + open and due this week)", () => {
  const D = C.compute(
    {
      tasks: [
        {
          id: 1,
          title: "A",
          area: "work",
          status: "done",
          doneAt: "2026-10-05",
        },
        {
          id: 2,
          title: "B",
          area: "work",
          status: "done",
          doneAt: "2026-10-01",
        }, // last week
        { id: 3, title: "C", area: "work", status: "open", due: "2026-10-09" }, // due this week
        { id: 4, title: "D", area: "work", status: "open", due: "2026-10-20" }, // later
        {
          id: 5,
          title: "E",
          area: "home",
          status: "done",
          doneAt: "2026-10-05",
        }, // not work
        { id: 6, title: "F", area: "عمل", status: "open", due: "2026-10-02" }, // overdue work (Arabic area)
      ],
    },
    NOW,
  );
  assert.equal(D.job.done, 1);
  assert.equal(D.job.openDue, 1);
  assert.equal(D.job.ratio, 0.5);
  assert.equal(D.job.overdue, 1);
  assert.equal(D.overdue.length, 1);
  assert.equal(D.alerts[0].tag, "Overdue");
  assert.equal(D.alerts[0].t, "F");
});

test("money: savings rate accepts 23 or 0.23; wealth ring = net worth ÷ target; 8 bars", () => {
  const months = [];
  for (let m = 1; m <= 10; m++)
    months.push({
      month: `2026-${String(m).padStart(2, "0")}`,
      netWorth: m * 1000,
    });
  months.push({ month: "2026-10", netWorth: 99999 }); // duplicate month — last one wins
  const D = C.compute(
    {
      money: {
        metrics: {
          netWorth: 50000,
          income: 9000,
          savingsRate: 23,
          emergencyMonths: 2,
        },
        wealthTarget: 200000,
        history: months,
        budgets: [
          { name: "Food", spent: 1200, limit: 1000 },
          { name: "Fuel", spent: 100, limit: 400 },
        ],
      },
    },
    NOW,
  );
  assert.equal(D.savingsRate, 0.23);
  assert.equal(
    C.compute({ money: { metrics: { savingsRate: 0.23 } } }, NOW).savingsRate,
    0.23,
  );
  assert.equal(D.wealthProgress, 0.25);
  assert.equal(D.history.length, 8);
  assert.equal(D.history[0].month, "2026-03");
  assert.equal(D.history[7].month, "2026-10");
  assert.equal(D.history[7].value, 99999);
  assert.equal(D.budgetsOver.length, 1);
  const tags = D.alerts.map((a) => a.tag);
  assert.ok(tags.includes("Budget"));
  assert.ok(tags.includes("Emergency fund"));
});

test("health: 7-day mood, health-habit consistency, runs this week", () => {
  const D = C.compute(
    {
      health: {
        moods: [
          { date: "2026-10-07", score: 4 },
          { date: "2026-10-05", score: 2 },
          { date: "2026-09-20", score: 1 }, // older than 7 days — ignored
        ],
        habits: [
          {
            name: "Walk",
            health: true,
            log: ["2026-10-06", "2026-10-07"],
            target: 4,
          },
          { name: "Read", cat: "learning", log: ["2026-10-07"] }, // not a health habit
        ],
        runs: [
          { date: "2026-10-05" },
          { date: "2026-10-06" },
          { date: "2026-09-28" },
        ],
      },
    },
    NOW,
  );
  assert.equal(D.mood.avg, 3);
  assert.equal(D.mood.days, 2);
  assert.equal(D.healthHabitCount, 1);
  assert.equal(D.habitConsistency, 0.5);
  assert.equal(D.runsThisWeek, 2);
  assert.equal(D.healthSource, null);
});

test("Daybook heatmap covers 84 days and the streak counts back from today", () => {
  const D = C.compute(
    {
      daybook: {
        activity: {
          "2026-10-07": 3,
          "2026-10-06": 1,
          "2026-10-05": 7,
          "2026-10-03": 2,
        },
      },
    },
    NOW,
  );
  assert.equal(D.heat.length, 84);
  assert.equal(D.heat[83].ds, "2026-10-07");
  assert.equal(D.heat[83].lvl, 2);
  assert.equal(D.streak, 3);
  assert.equal(D.activeDays84, 4);
  assert.equal(D.lastActive, "2026-10-07");
});

test("alerts: reminders within 24h and important dates within 7 days only", () => {
  const D = C.compute(
    {
      reminders: [
        { id: "r1", text: "Call the garage", at: NOW + 5 * 36e5 },
        { id: "r2", text: "Too far", at: NOW + 30 * 36e5 },
        { id: "r3", text: "Already past", at: NOW - 36e5 },
      ],
      importantDates: [
        { name: "Anniversary", date: "10-09" }, // repeats yearly → in 2 days
        { name: "Later", date: "10-20" },
        { name: "Passed this year", date: "01-02" }, // next is Jan 2027
      ],
    },
    NOW,
  );
  const texts = D.alerts.map((a) => a.t);
  assert.deepEqual(texts, ["Call the garage", "Anniversary"]);
  assert.match(D.alerts[1].s, /In 2 days/);
});

test("TITAN counters fall back to the activity list", () => {
  const D = C.compute(
    {
      titan: {
        state: "thinking",
        tools: ["Daybook", { name: "Gmail", connected: false }],
      },
      activity: [
        { id: "a1", at: NOW - 36e5, summary: "Added run", type: "daybook.add" },
        { id: "a2", at: NOW - 2 * 36e5, summary: "Undid", type: "undo" },
        { id: "a3", at: NOW - 20 * 864e5, summary: "Old", type: "note.add" },
      ],
    },
    NOW,
  );
  assert.equal(D.titan.state, "thinking");
  assert.equal(D.titan.changesThisWeek, 1);
  assert.equal(D.titan.corrections, 1);
  assert.equal(D.titan.toolsConnected, 1);
  assert.equal(D.titan.autonomous, true); // ON by default
  assert.equal(D.activity[0].id, "a1");
  assert.equal(D.activity[1].undoable, false); // an undo record cannot be undone
});

test("all data text is HTML-escaped and marked dir=auto", () => {
  assert.equal(
    C.esc(`<img src=x onerror="alert(1)">&'`),
    "&lt;img src=x onerror=&quot;alert(1)&quot;&gt;&amp;&#39;",
  );
  const evil = `<script>alert(1)</script>`;
  const D = C.compute(
    {
      tasks: [{ title: evil, area: "work", status: "open", due: "2026-10-01" }],
      activity: [
        { id: "x", at: NOW, summary: evil, before: evil, after: "موعد الجري" },
      ],
      reminders: [{ text: evil, at: NOW + 36e5 }],
    },
    NOW,
  );
  const page = C._internal.renderCommandPage(D);
  const dir = C._internal.renderDirectorProfile(D, {});
  for (const html of [page, dir]) {
    assert.ok(!html.includes("<script>"), "raw script tag leaked");
    assert.ok(html.includes("&lt;script&gt;"));
  }
  assert.match(page, /dir="auto"/);
  assert.ok(page.includes("موعد الجري"));
});

test("TITAN's rules text matches the agreed autonomy rules", () => {
  const all = JSON.stringify(C.RULES_FALLBACK);
  assert.ok(!/5,?000|Banking API|payment reminder/i.test(all));
  assert.match(all, /Payments, transfers, trades or purchases/);
  const html = C._internal.renderDirectorProfile(C.compute({}, NOW), {});
  assert.ok(!/5,?000|Banking API|payment reminder/i.test(html));
});

test("planned agents show '—' for every KPI", () => {
  const D = C.compute({}, NOW);
  const html = C._internal.renderPlannedProfile(C.ROSTER[0], D, {});
  assert.match(html, /—/);
  assert.match(html, /planned/i);
  assert.ok(
    !/\d+%/.test(html.replace(/style="[^"]*"/g, "")),
    "a planned agent shows a percentage",
  );
});

test("AI Agent TITAN replaces the Director: face, mic and live state", () => {
  const html = C._internal.renderTitanProfile(C.compute({}, NOW), {});
  assert.match(html, /AI Agent TITAN/);
  assert.ok(!/DIRECTOR/.test(html), "the old Director label is gone");
  assert.match(html, /class="ncc-face" data-face="idle"[^>]*aria-hidden="true"/);
  assert.match(html, /data-ncc="mic-profile"[^>]*>.*Talk to TITAN/);
  for (const st of ["listening", "thinking", "speaking", "working"]) {
    const h = C._internal.renderTitanProfile(C.compute({ titan: { state: st } }, NOW), {});
    assert.match(h, new RegExp('data-face="' + st + '"'));
  }
  const listening = C._internal.renderTitanProfile(C.compute({ titan: { state: "listening" } }, NOW), {});
  assert.match(listening, /ncc-titan-mic on/);
  assert.match(listening, /Listening… tap to stop/);
  const noMic = C._internal.renderTitanProfile(C.compute({ titan: { mic: "unavailable" } }, NOW), {});
  assert.match(noMic, /No microphone here/);
  // the typing fallback keeps its own unique key, so focus can find it again after a re-render
  assert.match(noMic, /class="ncc-titan-mic off" data-ncc="mic-profile"/);
  // an unknown state falls back to idle instead of breaking the face
  assert.match(C._internal.renderFace("bogus", 40), /data-face="idle"/);
});

test("'What TITAN knows' explains the Claude export when nothing is linked", () => {
  const D = C.compute({}, NOW);
  assert.deepEqual(D.knowledge, { connected: false });
  const html = C._internal.renderKnowledge(D, {});
  assert.match(html, /Settings → Privacy → Export data/);
  assert.match(html, /data-ncc="knowledge-import"/);
  assert.match(html, /can't load the files yet/);
  const withHook = C._internal.renderKnowledge(D, { hooks: { importKnowledge() {} } });
  assert.ok(!/can't load the files yet/.test(withHook));
  assert.equal(C._internal.knowLine(D.knowledge).text, "Not linked to your Claude account yet");
});

test("'What TITAN knows' shows real counts, staleness, and only safe dates", () => {
  const D = C.compute(
    {
      knowledge: {
        connected: true, projects: 12, docs: 40, conversations: 1340, messages: 9001,
        memories: 1, redactions: 3, importedAt: "2026-08-01T09:00:00Z",
        newest: "<img src=x onerror=alert(1)>", stale: true, truncated: true,
      },
    },
    NOW,
  );
  const html = C._internal.renderKnowledge(D, { hooks: { clearKnowledge() {} } });
  assert.match(html, /1,340/);
  assert.match(html, /Loaded 2026-08-01/);
  assert.match(html, /3 secrets hidden/);
  assert.match(html, /over a month old/);
  assert.match(html, /oldest items were left out/);
  assert.match(html, /data-ncc="knowledge-clear"/);
  assert.ok(!html.includes("<img"), "a bad date cannot inject markup");
  const line = C._internal.knowLine(D.knowledge);
  assert.equal(line.warn, true);
  assert.match(line.text, /Knows 12 projects · 1,340 chats/);
});

test("knowledge dates are shown in the user's time zone", () => {
  const D = C.compute(
    { tz: "Asia/Riyadh", knowledge: { connected: true, projects: 1, conversations: 1, importedAt: "2026-10-07T21:30:00.000Z", newest: "2026-10-06T22:10:00.000Z" } },
    Date.parse("2026-10-07T21:31:00Z"),
  );
  assert.equal(D.knowledge.importedAt, "2026-10-08");
  assert.equal(D.knowledge.newest, "2026-10-07");
  assert.match(C._internal.renderKnowledge(D, {}), /Loaded 2026-10-08 · newest item 2026-10-07/);
});
