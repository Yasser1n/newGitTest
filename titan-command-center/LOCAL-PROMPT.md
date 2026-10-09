# Message for the Claude session on the TITAN computer

**Before you paste it:** put the `titan-command-center` folder from this branch on the TITAN
computer yourself, for example in `TITAN Database\titan-command-center\`. You can get it from
GitHub with "Download ZIP". The session below is told not to download anything, so the files
must already be there.

Copy everything inside the box and paste it into Claude Code, opened in the folder that contains
`voice-agent.html`.

---

```text
Integrate the TITAN Command Center into voice-agent.html, using the ready-made modules in the
titan-command-center folder. Follow titan-command-center/INTEGRATION.md step by step.

Hard rules (do not break any of them):
1. Back up voice-agent.html and every file you change to %TEMP%\titan-pre-cc before editing.
2. Don't download anything, send anything, or enter keys.
3. Do NOT restart the server on port 8765 (it would switch on code still awaiting review);
   page changes load on refresh. If something can't work without a restart, stop and tell me.
4. data\nova-data.json contains API keys: never print, log or copy its values. Build the
   snapshot only from the named fields in INTEGRATION.md step 3.
5. Real data only: no sample numbers. Missing data must show the empty states.

What to do:
- Copy nova-autonomy.js, nova-proof.js, nova-knowledge.js and nova-command.js next to
  voice-agent.html and load them in that order (INTEGRATION.md step 1).
- Mark the classic layout, build getSnapshot() from TITAN's own helpers (moneyMetrics,
  nova-daybook, money.history, upcomingDates), and mount the Command Center (steps 2-4).
- Put NovaAutonomy.classify in front of every change TITAN makes, record auto changes in the
  journal, and wire Undo with an applyInverse that returns true only when it really reversed
  the change (steps 5-6). Autonomous mode is ON by default.
- Pass every TITAN reply through NovaProof.enforce, and merge TITAN's DID_CLAIM and SAVE_INTENT
  with NovaProof.DID_CLAIM_AR and NovaProof.SAVE_INTENT_AR (step 7).
- AI Agent TITAN card (step 8): hooks.mic toggles TITAN's existing microphone pipeline and
  reports listening/thinking/speaking/working/idle with cc.setState. hooks.importKnowledge
  opens a file picker for my claude.ai export files and saves the index with
  NovaKnowledge.idbStore. When I ask a question, add index.buildContext(question).text to the
  model prompt as a separate quoted-data block. From then on, while that text is still in the
  conversation, set untrustedContent: true on every change (INTEGRATION.md step 5), and pass
  quoted excerpts to NovaProof.enforce as `quoted` (step 7).
- Pass my 10 planned agents as the roster (step 9).

Test (step 11): copy the TITAN folder to a test folder WITHOUT phone-tokens.json, serve it on
port 8766, run "node --test titan-command-center/tests/*.test.js", and check the list in step 11
in the browser at desktop size and at 375 px. Take screenshots, then delete the test folder.

When you finish, tell me in plain English:
- which files changed;
- the test results;
- how to switch Autonomous mode and Classic view;
- how to teach TITAN my Claude account.
Do not commit or push anything.
```
