"use strict";
// Tests for nova-proof.js: TITAN may only say "done" (or تم / حذفت / ألغيت …)
// when the app confirmed the change in the same turn.
const test = require("node:test");
const assert = require("node:assert/strict");
const P = require("../nova-proof.js");

test("Arabic text is normalised (diacritics, alef forms, tatweel)", () => {
  assert.equal(P.normalizeArabic("أَضَفْتُ"), "اضفت");
  assert.equal(P.normalizeArabic("عـــدّلت"), "عدلت");
  assert.equal(P.normalizeArabic("مستشفى"), "مستشفي");
});

test("requests to change something are recognised in English and Arabic", () => {
  for (const s of [
    "delete my جري appointment",
    "احذف موعد الجري",
    "شيل موعد الجري",
    "add milk to my list",
    "أضف حليب للقائمة",
  ])
    assert.equal(P.detectIntent(s), true, s);
  assert.equal(P.detectIntent("what is the weather"), false);
});

test("claims of a finished change are detected, including the new Arabic words", () => {
  for (const s of [
    "Done! I deleted your جري appointment.",
    "I have removed the appointment.",
    "تم حذف موعد الجري",
    "حذفت موعد الجري",
    "ألغيت الموعد",
    "مسحت التذكير",
    "أضفت الحليب",
    "عدّلت الوقت",
    "نقلت الموعد إلى السابعة",
    "وحذفت الموعد",
  ])
    assert.equal(P.detectClaim(s).claimed, true, s);
});

test("look-alike words and negations are not claims", () => {
  for (const s of [
    "تمام، فهمت",
    "التمرين غدا",
    "I did not delete it.",
    "لم أحذف الموعد",
    "سأحذف الموعد",
    "Should I delete it?",
  ])
    assert.equal(P.detectClaim(s).claimed, false, s);
});

test("an unconfirmed 'done' becomes 'Nothing was changed' (English)", () => {
  const r = P.enforce("Done, I deleted your جري appointment.", {
    confirmed: [],
  });
  assert.equal(r.blocked, true);
  assert.match(r.text, /^Nothing was changed — /);
});

test("an unconfirmed 'حذفت' becomes the Arabic notice, which is not itself a claim", () => {
  const r = P.enforce("حذفت موعد الجري", {});
  assert.equal(r.blocked, true);
  assert.match(r.text, /^لم يتغيّر شيء — /);
  assert.equal(P.detectClaim(r.text).claimed, false);
});

test("a failure reason is passed on to the user", () => {
  const r = P.enforce("Done.", {
    failures: [{ reason: "no appointment called جري was found" }],
  });
  assert.equal(
    r.text,
    "Nothing was changed — no appointment called جري was found.",
  );
});

test("a confirmed change is allowed to say done", () => {
  for (const confirmed of [[{ summary: "Removed 'جري'" }], true, 1]) {
    const r = P.enforce("Done, I deleted it.", { confirmed });
    assert.equal(r.blocked, false);
    assert.equal(r.text, "Done, I deleted it.");
  }
});

test("enforce is idempotent and leaves ordinary replies alone", () => {
  const once = P.enforce("Done, I deleted it.", {});
  const twice = P.enforce(once.text, {});
  assert.equal(twice.text, once.text);
  assert.equal(twice.blocked, false);
  assert.equal(P.enforce("Your next run is at 6 PM.", {}).blocked, false);
});

test("mergeRegex adds the Arabic words to TITAN's existing patterns", () => {
  const DID_CLAIM = /\b(done|deleted|added)\b/i; // stand-in for voice-agent.html's own regex
  const merged = P.mergeRegex(DID_CLAIM, P.DID_CLAIM_AR);
  assert.ok(merged.test("deleted"));
  assert.ok(merged.test(P.normalizeArabic("حذفت الموعد")));
  assert.ok(merged.test(P.normalizeArabic("ألغيت الموعد")));
  const intent = P.mergeRegex(/\b(delete|add)\b/i, P.SAVE_INTENT_AR);
  assert.ok(intent.test(P.normalizeArabic("احذف الموعد")));
});

test("quoted history is not read as TITAN claiming a change", () => {
  const P = require("../nova-proof.js");
  const q = "Claude: I've updated your marathon plan and added an extra rest day.";
  assert.equal(P.enforce("From your history: " + q, { lang: "en" }).blocked, true);
  assert.equal(P.enforce("From your history: " + q, { lang: "en", quoted: [q] }).blocked, false);
  assert.equal(P.enforce("Done, I deleted it. " + q, { quoted: [q] }).blocked, true, "TITAN's own claim is still checked");
});
