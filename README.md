# DoReMi Pitch Prototype

A tiny dependency-free browser prototype for detecting sung or whistled pitch.

## Files

- `index.html`
- `style.css`
- `app.js`

## Important: microphone security

Browsers normally allow microphone access only from a **secure context**:

- `https://...`
- or `localhost`

Opening `index.html` directly as a `file://` URL may not allow microphone access.

## Easiest phone workflow

1. Put these files in a GitHub repository.
2. Enable GitHub Pages for the repository.
3. Open the resulting HTTPS page in Chrome on the Samsung phone.
4. Tap **Start microphone** and grant permission.

## First prototype features

- microphone input
- pitch detection via autocorrelation
- frequency in Hz
- nearest musical note
- cents sharp/flat
- vertical pitch display from C3 to C6

The next milestone is to add a scrolling target path and score how closely the live pitch follows it.
