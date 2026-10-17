# RCA: intermittent silent lesson narration

## Symptoms and scope

Two client playback races could leave a lesson silent despite Read Aloud being on:

1. Turn Read Aloud off, return home or change chapters, then turn it back on.
2. Open a saved lesson from the homepage while its chapter recording loads asynchronously.

The second case was reproduced with `/topic/rainbow-formation`. Its intro narration endpoint returned `ready` with an existing Max recording. The failure was in frontend playback state, rather than missing lesson audio.

## Root causes

### Enabling Read Aloud used the previous render's state

`toggleVoice` updated React state and immediately called `voiceStart`. At that point, `waitingRef` could still describe the muted render, which did not wait for narration. The player could therefore start browser speech before the selected recording had been requested or loaded. Starting browser speech also locked the visit to that source, preventing the selected recording from taking over.

The video playback effect did not depend on the Read Aloud or waiting state, so those transitions did not reliably reinstall the playback frame. Cancelled browser speech state also remained available to the next chapter's clock and retry logic.

### A frame could use a stale clip after the recording arrived

React updated `waitingRef` and the latest clip reference during render, while the existing animation frame callback still captured the previous clip. Before the playback effect replaced that callback, a frame could observe that waiting had ended but still see no recording in its closure. It would start browser speech and lock out the newly available recording. If browser speech failed to sound, the lesson could continue silently.

This explains why valid narration responses alone did not prevent the issue.

## Solution

- Start narration after the Read Aloud state is rendered, through the playback effect, instead of immediately from the toggle handler.
- Include Read Aloud and waiting transitions in that effect's dependencies so playback resumes when narration becomes available or falls back.
- Reset browser speech clock state when stopping narration, and stop both narration sources when replacing the playback frame.
- Skip an old animation frame when its captured clip differs from the latest clip. The replacement frame then starts the selected recording without accidentally locking in browser speech.

The changes are in `src/player/LessonPlayer.tsx`. No backend or saved recording changes are required. Existing browser autoplay restrictions still apply; blocked audio presents the Play with sound button.

## Verification

`src/player/LessonPlayer.test.tsx` uses mocked audio and browser speech with a DOM environment to cover:

1. A frame ticking between a recording becoming available and the playback effect being replaced.
2. Opening another lesson with Read Aloud off, changing chapters, and enabling narration while the recording is pending.
3. Browser speech starting after narration preparation falls back.
4. Resuming a cached recording after changing chapters with Read Aloud off.
5. Browser speech resuming in the new chapter after an off/on cycle.

The off/on regression fails against the original implementation. The recording-arrival regression fails when the new stale-frame guard is removed. Both pass with the fix.

Validation completed:

- `npm test`: all 24 tests pass.
- `npm run build`: TypeScript checks and production build pass.
- `npm run lint`: completes with existing warnings in the project.
- Browser check: reopened Rainbow Formation from the homepage, observed Max remain the active voice and the narration clock and captions advance. This verifies playback state; the automated tests mock audio output rather than measuring audible sound.

## Follow-up: ElevenLabs to browser voice handoff

A further report identified silence when switching from an ElevenLabs voice to Browser voice, while the browser voice sample still worked.

The narration loader cleared clips and chapter states in a passive effect after the voice changed. The newly mounted player could therefore receive the previous voice's clips during its first render. In addition, an outstanding ElevenLabs request could finish after that reset and repopulate clips and state for the newly selected browser voice. Playback could use recorded-audio timing or wait on the old provider during a browser voice selection.

The loader now associates clips and chapter states with a specific lesson and voice selection token. Previous selections are hidden immediately during render, and responses from superseded selections are ignored. Returning to the same voice creates a fresh token as well. Browser voice bypasses narration requests and preparation waits. The player also explicitly ignores recorded clips when Browser voice is selected.

Four additional regressions cover stale ready/preparing player props, the first render after switching, and a recorded narration response finishing after the switch. The two loader regressions failed before this fix. The complete frontend suite now has 28 passing tests. Browser checks verify the picker and active voice label switch from Max to Browser voice; automated speech assertions use mocked browser speech rather than measuring audible output.
