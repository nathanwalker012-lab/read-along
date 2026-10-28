# Read-Along

A web app for making read-along lessons on a phone.

1. Paste the text you will read.
2. Record yourself reading it, or choose a recording you already have.
3. The app finds when each word was spoken, on the device (Whisper speech model, no upload).
4. Cut mistakes, repeats and long pauses by tapping words.
5. Play it full screen, with each word or sentence highlighted as it is read.

Lessons are stored in the browser on the device you made them on. Use **Save lesson file** to move a lesson to another computer, and **Open lesson file** there.

## Running it

It is a static site with no build step. GitHub Pages serves it straight from the `main` branch.
To try it on a computer: `python3 -m http.server` in this folder, then open http://localhost:8000.

## Files

- `index.html`, `css/app.css` – the page
- `js/app.js` – screens: lessons, new lesson, word timing, editor, player
- `js/align.js` – lines up the text with the heard words; cut math
- `js/audio.js` – recording, decoding, playback that skips cuts, WAV export
- `js/asr-worker.js` – runs the Whisper model in the background ([Transformers.js](https://huggingface.co/docs/transformers.js))
- `js/db.js` – saving lessons on the device, lesson files
- `sw.js`, `manifest.webmanifest` – install to home screen, offline use

## Big Moment Writer (`narrative/`)

A separate page for students writing a 7th-grade narrative (CCSS W.7.3): plan, then write one plot part at a time (beginning, rising action, climax, resolution) with guiding questions, sentence starters and a word bank, then self-check against a student-friendly rubric. Help level (full / some / light) fades the supports.

Work autosaves in the browser. **Save my work** downloads a `.txt` file (readable story on top, restore data at the bottom) that students attach to Classroom; **Open saved work** loads it back. Nothing is sent anywhere.
