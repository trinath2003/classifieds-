# MedConsult — Prototype

A clickable frontend prototype for a Practo-style app: an AI symptom-triage
assistant (multilingual, voice-enabled) and a Human Doctor path (specialization
picker → doctor list → video call), plus a doctor login/prescription dashboard.

**This is a static frontend demo only.** There is no backend, no real database,
no real doctors, and no real video connection between two people — see
"What's real vs simulated" below before showing this to anyone as a working
product.

## Files

```
index.html   — page structure/markup
style.css    — all styling (design tokens as CSS variables at the top)
script.js    — all app logic (triage NLU, navigation, video call, doctor dashboard)
```

No build step, no npm install, no dependencies. It's plain HTML/CSS/JS.

## Running it locally

Because the app uses the browser's microphone (`SpeechRecognition`) and
camera (`getUserMedia`) APIs, it needs to be served over **HTTPS or
localhost** — opening it directly as a `file://` path will usually block
mic/camera permissions.

Easiest local option, from inside this folder:

```bash
python3 -m http.server 8000
# then open http://localhost:8000
```

or with Node:

```bash
npx serve .
```

Use Chrome or Edge — Web Speech API support in Safari/Firefox is limited.

## Deploying

Since it's fully static, any static host works with zero configuration:

- **GitHub Pages**: push this repo, then enable Pages in Settings → Pages →
  set source to the `main` branch, root folder. Your app will be live at
  `https://<username>.github.io/<repo-name>/`.
- **Netlify / Vercel**: connect the GitHub repo, no build command needed,
  publish directory = `/`.
- **Note**: GitHub Pages and most static hosts serve over HTTPS by default,
  so mic/camera permissions will work correctly once deployed — just not
  necessarily on a bare `file://` open.

## What's real vs. simulated in this prototype

| Feature | Status |
|---|---|
| Patient's own camera/mic preview on a video call | **Real** — uses `getUserMedia` |
| Speech-to-text via the mic | **Real** — uses the browser's `SpeechRecognition` API |
| Symptom/entity extraction from speech or text | Simulated — keyword/regex matching, not a real medical NLU/LLM model |
| Multi-turn follow-up questions (age, pain, duration) | Real logic, but a simple slot-filling state machine, not an LLM |
| Doctor's video feed on a call | Simulated — no signaling server or WebRTC provider wired up |
| Doctor list / availability | Hardcoded sample data |
| Doctor login | No real authentication or license verification |
| Prescriptions | Stored only in browser memory for the session — nothing persists, nothing is sent anywhere |

## Before this becomes a real product

1. **Legal**: only a licensed human doctor should ever generate a dosage or
   drug name tied to a specific patient. The AI path in this prototype is
   deliberately restricted to urgency triage + generic self-care info for
   this reason — keep it that way.
2. **Real NLU**: replace the keyword matcher in `script.js`
   (`parseSpeech()`) with a proper medical NER model or an LLM API call.
3. **Real video**: integrate a WebRTC provider (Twilio Video, Agora, or
   100ms) with a signaling server so both sides of a call are real.
4. **Real doctor verification**: check registration numbers against the
   National Medical Register / respective state medical council before
   granting doctor-dashboard access.
5. **A real backend**: patients, doctors, consults, and prescriptions all
   need a database (Postgres recommended) and an API — right now
   everything lives only in the browser tab and disappears on refresh.
