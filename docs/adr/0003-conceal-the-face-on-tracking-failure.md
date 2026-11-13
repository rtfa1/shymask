# Hide the webcam feed on tracking or effect failure

Effects may intentionally reveal the person's face: partial masks, face distortion, and color treatments are allowed. Shymask does not require an avatar-only output or promise anonymity during normal operation.

When face tracking or effect processing fails, Shymask must replace the entire output with an opaque screen saying "Tracking paused", never fall back to the original webcam feed. This applies to both the virtual webcam and the local preview, including startup before tracking is ready and interruptions while switching effects. The decision prioritizes a hidden feed over continuity during failures; it does not imply that every possible tracking or rendering defect can be detected perfectly.

After a temporary failure, the selected effect returns automatically once tracking and rendering are healthy. Persistent errors keep the output hidden and show an explanation in the app.

Startup, having no active effect, and manual pause also produce the paused output. Closing Shymask stops its camera output. The prototype supports one person; detecting multiple faces pauses the output, which resumes automatically when one face remains and processing is healthy. There is no raw-webcam passthrough mode in the prototype.
