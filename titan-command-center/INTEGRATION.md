# Putting the Command Center into TITAN

This folder holds four drop-in modules plus a demo page. They were built and tested in a cloud
copy with invented data. **Nothing here has touched the real TITAN yet.** The steps below are
for the Claude session that runs on the TITAN computer (see `LOCAL-PROMPT.md`), or for a person
doing it by hand.

| File                | What it does                                                                                                                                                                    |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `nova-command.js`   | The Command Center screen: the Command page, the AI Agents page with the **AI Agent TITAN** card in the centre, the chat dock, the mobile tab bar, and the Classic view switch. |
| `nova-autonomy.js`  | Decides whether a change runs on its own, waits for a tap, or is never allowed. It also keeps the Activity journal, with Undo and the evening review.                           |
| `nova-proof.js`     | The proof rule. TITAN may only say "done" (or تم / حذفت / ألغيت …) when the app confirmed the change in that turn. Otherwise the reply becomes "Nothing was changed".           |
| `nova-knowledge.js` | TITAN's local, searchable copy of the user's **claude.ai data export**. It hides secrets before saving, searches in Arabic and English, and hands quoted excerpts to the model. |
| `demo/harness.html` | A stand-in TITAN page with invented data, used for testing. Open it through a local web server.                                                                                 |
| `tests/*.test.js`   | 53 automated tests. Run them with `node --test tests/*.test.js`.                                                                                                                |

---

## 0. Ground rules (from the owner, keep them all)

1. **Back up first.** Copy `voice-agent.html` and every file you will change to
   `%TEMP%\titan-pre-cc\` before editing anything.
2. **Don't download anything, send anything, or enter keys.**
3. **Do not restart the server on port 8765.** A restart would switch on code that is still
   awaiting review. Page changes load on refresh. If something truly needs a restart, stop and
   tell the owner.
4. `data\nova-data.json` contains API keys. **Never print, log or copy its values.** Build the
   snapshot from the named fields below, never from the whole data object.
5. **Test on port 8766** with a _copy_ of the data folder that leaves out `phone-tokens.json`.
   Take screenshots, then delete the test folder.

## 1. Add the modules

Copy the four `.js` files next to `voice-agent.html`, then load them in this order, after
TITAN's own scripts:

```html
<script src="nova-autonomy.js"></script>
<script src="nova-proof.js"></script>
<script src="nova-knowledge.js"></script>
<script src="nova-command.js"></script>
```

Each one sets a global: `NovaAutonomy`, `NovaProof`, `NovaKnowledge`, `NovaCommand`. None of
them makes network calls.

## 2. Mark the classic layout

The Command Center hides the old screen while it is showing. Choose one way to mark it:

- add the attribute `data-ncc-classic` to the old top-level sections in `voice-agent.html`, or
- pass them in: `classicElements: document.querySelectorAll(".old-header, .old-panels")`.

TITAN's chat and voice element is passed as `chat`. The Command Center moves it into its dock
and puts it back exactly where it was when the owner chooses Classic view.

## 3. Build the snapshot

`getSnapshot()` returns plain numbers and short text. Every field is optional: a missing field
shows an empty state, never a sample number. Use the existing helpers named in the brief.

| Snapshot field                               | Where it comes from in TITAN                                                                        |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `now`, `tz`, `weekStartsOn`                  | `Date.now()`, the owner's time zone, `0` (week starts Sunday)                                       |
| `titan.state`, `titan.workingOn`             | the voice pipeline: `idle`, `listening`, `thinking`, `speaking`, `working`                          |
| `titan.mic`                                  | `"ready"`, `"unavailable"` (no microphone or no speech support), or `"blocked"` (permission denied) |
| `titan.autonomous`                           | TITAN's setting (default **on**)                                                                    |
| `titan.changesThisWeek`, `titan.corrections` | `journal.countSince(weekStart)`, `journal.correctionsSince(weekStart)`                              |
| `titan.tools`                                | `[{ name, connected }]`: names and true/false only, **never tokens**                                |
| `titan.pendingTaps`                          | `[{ id, text }]` of changes waiting for a tap                                                       |
| `activity`                                   | `journal.list()` mapped to `{ id, at, summary, before, after, type, undone, undoable }`             |
| `tasks`                                      | TITAN's tasks: `{ id, title, area, status, due, doneAt }`                                           |
| `money.metrics`                              | `moneyMetrics()`: `{ netWorth, income, savingsRate, emergencyMonths, currency }`                    |
| `money.history`                              | `money.history` as `[{ month: "YYYY-MM", netWorth }]`                                               |
| `money.budgets`, `money.wealthTarget`        | the owner's budgets and target, if set                                                              |
| `health`                                     | moods, habits, runs, and `source` only if a health source is connected                              |
| `reminders`                                  | `{ id, text, at }`                                                                                  |
| `importantDates`                             | `upcomingDates()` as `{ name, date }`                                                               |
| `daybook.activity`                           | `nova-daybook` item counts per day: `{ "YYYY-MM-DD": n }`                                           |
| `knowledge`                                  | `NovaKnowledge.toSnapshot(index.stats(), Date.now())`: counts and dates only                        |

## 4. Mount it

```js
const journal = NovaAutonomy.createJournal({
  load,
  save,
  timeZone: "Asia/Riyadh",
});
const cc = NovaCommand.mount({
  chat: document.getElementById("<TITAN chat element>"),
  getSnapshot: buildSnapshot,
  hooks: {
    ask: (text) => sendToTitan(text), // the "Ask TITAN" buttons
    openChat: () => focusTitanInput(),
    mic: () => toggleTitanMic(), // every mic button calls this; treat it as a toggle
    undo: (id) => journal.undo(id, applyInverse),
    setAutonomous: (on) => saveSetting("autonomous", on),
    setClassic: (on) => {}, // optional; the choice is remembered automatically
    importKnowledge: () => pickClaudeExportFiles(),
    clearKnowledge: () => forgetClaudeHistory(),
  },
  // roster: the 10 planned agents (see step 9)
});
```

- Call `cc.refresh()` after **every** action. The screen also refreshes itself every 60 seconds.
- Call `cc.setState("listening" | "thinking" | "speaking" | "working" | "idle", workingOn)`
  from the voice pipeline. TITAN's face, the dock and the mic buttons all follow it.

## 5. Put the autonomy gate in front of every change

```js
function dispatch(action) {
  // action = { type, params, source, summary, untrustedContent }
  const d = NovaAutonomy.classify(action, { autonomous: settings.autonomous });
  if (d.tier === "never") return refuse(d.reason);
  if (d.tier === "tap") return showTapCard(action, d.reason);
  const res = runAction(action); // must return { ok, change } or { ok: false, reason }
  if (res.ok)
    return {
      ok: true,
      entry: journal.record({ type: action.type, ...res.change }),
    };
  return { ok: false, reason: res.reason };
}
```

- `source` is where the request came from: `voice`, `typed`, or `user`. Text found inside an email,
  web page, document, news item, tool result, or the **Claude history** is never obeyed.
- **New rule for the Claude history:** once any excerpt from the Claude export has been in the
  model's prompt, or quoted in one of TITAN's replies, set `untrustedContent: true` on every action
  for as long as that text is still in the conversation the model sees. Clear the flag only when
  the chat is cleared or the text drops out of the model's context. Changes that would normally
  run on their own then wait for a tap. Any truthy value counts, so passing a count of excerpts is
  safe.

## 6. Undo and the evening review

- `applyInverse(entry)` must really reverse the change and return `true` only when it did.
  If it returns `false` or throws, the owner sees "Nothing was changed".
- `journal.eveningReview(date)` lists the day's changes as before → after, ready for TITAN to read
  out in the evening.

## 7. The proof rule

Pass every TITAN reply through `NovaProof.enforce(reply, { confirmed, failures, lang, quoted })` before
it is spoken or shown. Set `confirmed` to the journal entries the app actually recorded in that
turn. When TITAN quotes the Claude history (where Claude once wrote "I've updated your plan"),
pass those exact passages as `quoted`, so Claude's old words are not mistaken for TITAN claiming
a change. To keep TITAN's existing patterns, merge them in:
`NovaProof.mergeRegex(TITAN.DID_CLAIM, NovaProof.DID_CLAIM_AR)`, and do the same for
`SAVE_INTENT` and `NovaProof.SAVE_INTENT_AR`.

## 8. The AI Agent TITAN card and the Claude account

The card in the centre of AI Agents shows TITAN's face, live state, mic button, and how much he
knows from the owner's Claude account. The profile under it has a large mic button and a
"What TITAN knows" panel.

**Why it uses an export.** Claude has no live API that another app can use to read an account's
projects and chats. The owner downloads their own data and TITAN reads that copy:

1. On claude.ai: **Settings → Privacy → Export data**. Claude emails a download link.
2. Unzip the file.
3. In TITAN: **AI Agents → TITAN → Teach TITAN my Claude account**, then choose the `.json`
   files from the unzipped folder.

Wiring:

```js
const store = NovaKnowledge.idbStore(); // saves the index on this computer only
let index =
  NovaKnowledge.loadIndex(await store.load()) || NovaKnowledge.createIndex();

async function pickClaudeExportFiles() {
  // hooks.importKnowledge
  const files = await chooseFiles(".json"); // an <input type="file" multiple>
  const list = await Promise.all(
    files.map(async (f) => ({ name: f.name, text: await f.text() })),
  );
  const parsed = NovaKnowledge.parseExport(list); // skips users.json; hides secrets
  index.clear();
  index.addExport(parsed, {
    now: Date.now(),
    exclude: [
      /* project names to leave out */
    ],
  });
  await store.save(index.toJSON());
  cc.refresh();
}
async function forgetClaudeHistory() {
  index.clear();
  await store.clear();
  cc.refresh();
}
```

When the owner asks something, add the matching excerpts to the model's prompt:

```js
const ctx = index.buildContext(userText); // { text, sources, used, untrusted }
if (ctx.text) {
  messages.push({ role: "user", content: ctx.text }); // a quoted-data block, never the system prompt
  conversation.historyInContext = true; // step 5: changes wait for a tap while this text is in context
}
```

The excerpts arrive framed as quoted data, with numbered sources such as
`[1] Project "X" › chat "Y" · 2026-09-01`, so TITAN can say where each answer came from.

**Privacy, in plain words:**

- The index lives only in this browser's storage on the TITAN computer.
- Passwords, keys, tokens, card numbers and IBANs are replaced with `[hidden …]` before saving.
- The few excerpts that match a question go to the same AI model TITAN already uses.
  Nothing else is sent anywhere.
- "Remove from this device" deletes the copy. The Claude account itself is not touched.

## 9. The planned agents

`NovaCommand.ROSTER` holds the 8 agents from the design artifact. The local design has **10**.
Pass those 10 as `roster: [{ id, name, role, icon, mission, tools }]`. They appear with dashed
outlines and "—" for every KPI until they are built. Keep out the "5,000 SAR", "Banking API" and
"payment reminders" items.

## 10. Switching the views

- **Autonomous mode:** the switch on the TITAN profile (AI Agents), or Settings → Autonomous mode.
  On means everyday changes happen right away and appear in Activity with Undo. Off ("Ask first")
  means TITAN asks before every change.
- **Classic view:** Settings → Classic view, which brings back the original screen. To return,
  turn on "Show the Command Center" in TITAN's Settings, or call `cc.setClassic(false)`. The
  choice is remembered in `localStorage` under `titan.cc.view`.

## 11. Test on port 8766 (the real computer)

1. Copy the TITAN folder to a test folder, **without** `phone-tokens.json`.
2. Serve the test folder on **8766**. Leave the 8765 server alone.
3. Run `node --test tests/*.test.js` (expect 53 passing).
4. In the browser, check:
   - there are zero console errors;
   - add, move and remove in the Daybook run on their own, with Undo;
   - a WhatsApp or send action waits for a tap;
   - a fake email triggers nothing;
   - a failed change says "Nothing was changed";
   - the Classic view switch works in both directions;
   - TITAN's face, mic and knowledge panel all work;
   - the layout holds at desktop size and at 375 px wide.
5. Take screenshots, then delete the test folder.

## Run the demo here

```bash
cd titan-command-center
python3 -m http.server 8766    # then open http://127.0.0.1:8766/demo/harness.html
node --test tests/*.test.js
```

The demo uses only invented data, records no audio, and sends nothing.
