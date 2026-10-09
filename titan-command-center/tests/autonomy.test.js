"use strict";
// Tests for nova-autonomy.js: which actions run on their own, which wait for a
// tap, which are never allowed — plus the change journal with Undo.
const test = require("node:test");
const assert = require("node:assert/strict");
const A = require("../nova-autonomy.js");

const ON = { autonomous: true };
const OFF = { autonomous: false };
const tier = (type, params, settings, source) =>
  A.classify(
    { type, params: params || {}, source: source || "user" },
    settings || ON,
  ).tier;

test("autonomous ON: everyday changes happen with no confirmation card", () => {
  for (const t of [
    "daybook.add",
    "daybook.move",
    "daybook.remove",
    "reminder.add",
    "list.add",
    "goal.update",
    "habit.log",
    "note.add",
    "memory.save",
    "money.record",
    "money.edit",
    "money.remove",
    "office.document.create",
    "calendar.event.create",
    "email.draft",
    "routine.add",
    "guardian.watch.add",
    "pc.open.app",
    "pc.open.folder",
    "pc.open.url",
    "cc.layout.set",
  ])
    assert.equal(tier(t), "auto", t);
});

test("money records have no amount limit", () => {
  assert.equal(tier("money.record", { amount: 999999 }), "auto");
});

test("autonomous OFF ('Ask first'): the same changes wait for a tap", () => {
  for (const t of [
    "daybook.add",
    "daybook.remove",
    "money.record",
    "email.draft",
  ])
    assert.equal(tier(t, {}, OFF), "tap", t);
});

test("one tap is still required even when autonomous is ON", () => {
  for (const t of [
    "message.send.whatsapp",
    "message.send.sms",
    "email.send",
    "calendar.invite.send",
    "pc.restart",
    "pc.shutdown",
    "pc.lock",
    "pc.organizeDownloads",
    "daybook.clearDay",
    "data.eraseAll",
    "download.file",
    "connector.slack.post",
    "titan.code.edit",
  ])
    assert.equal(tier(t), "tap", t);
  assert.equal(
    tier("calendar.event.create", { attendees: ["someone@example.com"] }),
    "tap",
  );
});

test("never allowed, whatever the setting", () => {
  for (const s of [ON, OFF])
    for (const t of [
      "payment.send",
      "transfer.bank",
      "trade.buy",
      "purchase.item",
      "note.permanentDelete",
      "delete.permanent.file",
      "credential.enter",
      "safety.disable",
    ])
      assert.equal(tier(t, {}, s), "never", t);
});

test("text inside emails, web pages, documents or news can never trigger an action", () => {
  for (const src of [
    "email",
    "web",
    "webpage",
    "document",
    "news",
    "tool_result",
    "whatsapp",
  ])
    assert.equal(tier("daybook.remove", {}, ON, src), "never", src);
  // a fake email saying "delete my appointments"
  const r = A.classify(
    {
      type: "daybook.remove",
      params: { name: "all appointments" },
      source: "email",
    },
    ON,
  );
  assert.equal(r.tier, "never");
  assert.ok(A.isUntrustedSource("email"));
  assert.ok(!A.isUntrustedSource("voice"));
  assert.ok(A.isUntrustedSource("something-unknown"));
});

test("unknown actions wait for a tap instead of running", () => {
  assert.equal(tier("weird.new.thing"), "tap");
});

test("every decision explains itself in plain words", () => {
  const r = A.classify({ type: "message.send.whatsapp", source: "voice" }, ON);
  assert.equal(typeof r.reason, "string");
  assert.ok(r.reason.length > 10);
});

test("implausible money amounts are still questioned", () => {
  assert.equal(A.isImplausibleAmount(500, [100, 120, 90]), false);
  assert.equal(A.isImplausibleAmount(5000, [100, 120, 90]), true);
  assert.equal(A.isImplausibleAmount(-1, []), true);
  assert.equal(A.isImplausibleAmount(2e6, []), true);
  assert.equal(A.isImplausibleAmount(50, []), false);
});

test("the rules text has none of the design's old payment wording", () => {
  const all = JSON.stringify(A.RULES_TEXT);
  assert.ok(!/5,?000|Banking API|payment reminder/i.test(all));
});

function journal(clock) {
  let stored = [];
  return {
    j: A.createJournal({
      load: () => stored,
      save: (e) => {
        stored = e;
      },
      now: () => clock.t,
    }),
    stored: () => stored,
  };
}

test("journal: each change is recorded with time and before → after", () => {
  const clock = { t: Date.parse("2026-10-07T16:40:00Z") }; // 7:40 PM Riyadh
  const { j, stored } = journal(clock);
  const e = j.record({
    type: "daybook.move",
    summary: "Moved 'Run'",
    before: "Run 18:00",
    after: "Run 19:00",
  });
  assert.match(e.id, /^chg_/);
  assert.equal(e.at, "2026-10-07T16:40:00.000Z");
  assert.equal(stored().length, 1);
  assert.equal(j.list()[0].summary, "Moved 'Run'");
  assert.equal(j.countSince("2026-10-04T00:00:00Z"), 1);
  assert.match(
    j.eveningReview(),
    /7:40 PM — Moved 'Run' \(Run 18:00 → Run 19:00\)/,
  );
});

test("journal: Undo only counts when the app confirms it", async () => {
  const clock = { t: Date.parse("2026-10-07T16:40:00Z") };
  const { j } = journal(clock);
  const e = j.record({
    type: "daybook.remove",
    summary: "Removed 'جري'",
    before: "جري 18:00",
    after: "",
  });

  const failed = await j.undo(e.id, async () => false);
  assert.equal(failed.ok, false);
  assert.match(failed.message, /^Nothing was changed/);
  assert.equal(j.correctionsSince(), 0);

  const thrown = await j.undo(e.id, async () => {
    throw new Error("Daybook is locked");
  });
  assert.equal(thrown.ok, false);
  assert.match(thrown.message, /^Nothing was changed/);

  const ok = await j.undo(e.id, async () => true);
  assert.equal(ok.ok, true);
  assert.equal(j.correctionsSince(), 1);
  assert.equal(
    (await j.undo(e.id, async () => true)).message,
    "Already undone",
  );
  assert.match(j.eveningReview(), /\(undone\)/);
});

test("journal: a quiet day says so", () => {
  const { j } = journal({ t: Date.parse("2026-10-07T10:00:00Z") });
  assert.equal(j.eveningReview(), "TITAN made no changes today.");
});

test("untrustedContent fails safe: any truthy value waits for a tap", () => {
  const A = require("../nova-autonomy.js");
  for (const v of [true, "true", 1, 3, {}, "yes"])
    assert.equal(A.classify({ type: "daybook.remove", source: "user", untrustedContent: v }, { autonomous: true }).tier, "tap", String(v));
  for (const v of [false, 0, "", null, undefined])
    assert.equal(A.classify({ type: "daybook.remove", source: "user", untrustedContent: v }, { autonomous: true }).tier, "auto", String(v));
  assert.equal(A.classify({ type: "daybook.remove", source: "user" }, { autonomous: true, untrustedContent: 2 }).tier, "tap");
});
