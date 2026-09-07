# DoReMi v2

Changes:
- YIN-style fundamental pitch detection
- confidence estimate and low-confidence rejection
- octave-independent circular pitch display
- actual note/octave, frequency and cents readout
- whistling range extended to 2200 Hz
- short persistence filter to reject isolated octave errors

## Windowing strategy

The analyser uses a 4096-sample window. At 48 kHz that spans about 85 ms.
A new analysis is attempted every 45 ms, so consecutive windows overlap.

This separates analysis-window length from update rate:
- longer windows provide more periodic cycles and improve low-note stability
- shorter hop intervals keep the UI responsive
- large pitch jumps must persist for two analyses before being accepted

This is intentionally tuned for musical training rather than ultra-fast pitch tracking.
