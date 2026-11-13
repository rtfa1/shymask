// Owns the local frame transport between the Shymask app (the only producer of
// output frames) and the Media Foundation media source.
//
// The app listens on 127.0.0.1 and pushes wire frames (see protocol.h). This is
// intentionally a plain socket rather than a Windows camera API: the media
// source is the only component that knows about Media Foundation, and the app
// only knows about RGBA frames. A future macOS integration can replace this
// transport without touching the renderer or output policy.
#pragma once

#include <cstdint>
#include <string>
#include <vector>

namespace shymask {

class FrameTransport {
 public:
  FrameTransport();
  ~FrameTransport();

  FrameTransport(const FrameTransport&) = delete;
  FrameTransport& operator=(const FrameTransport&) = delete;

  // Non-blocking: attempts a connection when disconnected, drains any buffered
  // frames, and keeps only the newest complete frame.
  void Poll();

  bool HasFrame() const { return hasFrame_; }
  bool Connected() const { return socket_ != kInvalidSocket; }

  // Copies the newest RGBA frame. Returns false when no frame has arrived yet.
  bool CopyLatest(std::vector<uint8_t>* rgba, uint64_t* captureUnixMs, uint64_t* sequence) const;

  // Drops the connection (used when the app exits) and the cached frame.
  void Reset();

  struct Stats {
    uint64_t framesReceived = 0;
    uint64_t framesDropped = 0;
    uint64_t connectAttempts = 0;
    uint64_t connectFailures = 0;
    uint64_t resyncs = 0;
  };
  Stats GetStats() const { return stats_; }

 private:
  static constexpr uintptr_t kInvalidSocket = static_cast<uintptr_t>(~0ull);

  void TryConnect();
  bool ConnectTo(uint16_t port);
  void ReadAvailable();
  void ConsumeBufferedFrames();

  uintptr_t socket_;
  std::vector<uint8_t> rx_;
  std::vector<uint8_t> latest_;
  uint64_t captureUnixMs_ = 0;
  uint64_t sequence_ = 0;
  bool hasFrame_ = false;
  uint64_t nextConnectAttemptMs_ = 0;
  Stats stats_;
};

}  // namespace shymask
