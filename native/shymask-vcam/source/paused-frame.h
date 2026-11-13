// Fallback image used when no app frame has arrived yet.
//
// The app itself sends the exact opaque "Tracking paused" canvas for every
// paused state through the normal frame transport, so this fallback only covers
// the brief window before the first frame (or a disconnected app). It renders
// the same opaque paused screen so a camera consumer can never see a blank or
// transparent frame instead.
#pragma once

#include <cstdint>
#include <vector>

namespace shymask {

// Returns a cached, top-down RGBA frame (1280x720) with the opaque paused
// screen. Thread-safe after the first call.
const std::vector<uint8_t>& PausedFrame();

}  // namespace shymask
