#include "frame-transport.h"

#include "protocol.h"
#include "logging.h"

#pragma comment(lib, "ws2_32.lib")

#include <winsock2.h>
#include <ws2tcpip.h>

#include <algorithm>
#include <cstring>

namespace shymask {
namespace {

void EnsureWinsock() {
  static bool started = false;
  if (!started) {
    WSADATA data{};
    WSAStartup(MAKEWORD(2, 2), &data);
    started = true;
  }
}

uint16_t ReadPortFile() {
  const std::wstring path = PortFilePath();
  HANDLE file = CreateFileW(path.c_str(), GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr,
                            OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
  if (file == INVALID_HANDLE_VALUE) return 0;
  char buffer[32] = {0};
  DWORD read = 0;
  ReadFile(file, buffer, sizeof(buffer) - 1, &read, nullptr);
  CloseHandle(file);
  const int value = std::atoi(buffer);
  if (value <= 0 || value > 65535) return 0;
  return static_cast<uint16_t>(value);
}

}  // namespace

FrameTransport::FrameTransport() {
  EnsureWinsock();
  socket_ = kInvalidSocket;
}

FrameTransport::~FrameTransport() { Reset(); }

void FrameTransport::Reset() {
  if (socket_ != kInvalidSocket) {
    closesocket(static_cast<SOCKET>(socket_));
    socket_ = kInvalidSocket;
  }
  rx_.clear();
  latest_.clear();
  hasFrame_ = false;
  captureUnixMs_ = 0;
  sequence_ = 0;
}

void FrameTransport::Poll() {
  if (socket_ == kInvalidSocket) {
    const uint64_t now = GetTickCount64();
    if (now < nextConnectAttemptMs_) return;
    TryConnect();
    if (socket_ == kInvalidSocket) return;
  }
  ReadAvailable();
  ConsumeBufferedFrames();
}

void FrameTransport::TryConnect() {
  nextConnectAttemptMs_ = GetTickCount64() + 500;
  stats_.connectAttempts++;

  std::vector<uint16_t> ports;
  const uint16_t portFromFile = ReadPortFile();
  if (portFromFile != 0) ports.push_back(portFromFile);
  for (uint16_t port = kShymaskPortRangeFirst; port <= kShymaskPortRangeLast; ++port) {
    if (std::find(ports.begin(), ports.end(), port) == ports.end()) ports.push_back(port);
  }

  for (const uint16_t port : ports) {
    if (ConnectTo(port)) {
      Log(L"frame transport connected to 127.0.0.1:%u", static_cast<unsigned>(port));
      return;
    }
  }
  stats_.connectFailures++;
  if (stats_.connectFailures % 20 == 1) {
    Log(L"frame transport has no app connection yet (attempts=%llu)",
        static_cast<unsigned long long>(stats_.connectFailures));
  }
}

bool FrameTransport::ConnectTo(uint16_t port) {
  SOCKET socket = ::socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
  if (socket == INVALID_SOCKET) return false;

  sockaddr_in address{};
  address.sin_family = AF_INET;
  address.sin_port = htons(port);
  inet_pton(AF_INET, "127.0.0.1", &address.sin_addr);
  if (::connect(socket, reinterpret_cast<sockaddr*>(&address), sizeof(address)) != 0) {
    closesocket(socket);
    return false;
  }

  BOOL noDelay = TRUE;
  setsockopt(socket, IPPROTO_TCP, TCP_NODELAY, reinterpret_cast<const char*>(&noDelay),
             sizeof(noDelay));
  u_long nonBlocking = 1;
  ioctlsocket(socket, FIONBIO, &nonBlocking);
  socket_ = static_cast<uintptr_t>(socket);
  return true;
}

void FrameTransport::ReadAvailable() {
  for (;;) {
    char buffer[64 * 1024];
    const int received = ::recv(static_cast<SOCKET>(socket_), buffer, sizeof(buffer), 0);
    if (received > 0) {
      rx_.insert(rx_.end(), buffer, buffer + received);
      continue;
    }
    if (received == 0) {
      Log(L"frame transport closed by the app");
      Reset();
      return;
    }
    const int error = WSAGetLastError();
    if (error == WSAEWOULDBLOCK) return;
    Log(L"frame transport recv failed, error=%d", error);
    Reset();
    return;
  }
}

void FrameTransport::ConsumeBufferedFrames() {
  constexpr size_t kHeaderBytes = kShymaskFrameHeaderBytes;
  while (rx_.size() >= kHeaderBytes) {
    const uint8_t* header = rx_.data();
    uint32_t magic = 0;
    uint16_t version = 0;
    uint16_t flags = 0;
    uint32_t width = 0;
    uint32_t height = 0;
    uint32_t stride = 0;
    uint32_t payloadBytes = 0;
    uint64_t captureUnixMs = 0;
    uint64_t sequence = 0;
    std::memcpy(&magic, header + 0, 4);
    std::memcpy(&version, header + 4, 2);
    std::memcpy(&flags, header + 6, 2);
    std::memcpy(&width, header + 8, 4);
    std::memcpy(&height, header + 12, 4);
    std::memcpy(&stride, header + 16, 4);
    std::memcpy(&payloadBytes, header + 20, 4);
    std::memcpy(&captureUnixMs, header + 24, 8);
    std::memcpy(&sequence, header + 32, 8);

    if (magic != kShymaskFrameMagic || version != kShymaskFrameVersion || width != kShymaskFrameWidth ||
        height != kShymaskFrameHeight || stride != width * 4 ||
        payloadBytes != stride * height) {
      stats_.resyncs++;
      Log(L"frame transport resync: magic=0x%08X version=%u size=%ux%u stride=%u payload=%u",
          magic, version, width, height, stride, payloadBytes);
      rx_.clear();
      Reset();
      return;
    }
    const size_t frameBytes = kHeaderBytes + payloadBytes;
    if (rx_.size() < frameBytes) return;

    latest_.assign(header + kHeaderBytes, header + frameBytes);
    captureUnixMs_ = captureUnixMs;
    sequence_ = sequence;
    hasFrame_ = true;
    stats_.framesReceived++;
    rx_.erase(rx_.begin(), rx_.begin() + static_cast<std::ptrdiff_t>(frameBytes));

    // Never let a slow consumer accumulate stale frames.
    if (rx_.size() > frameBytes * 4) {
      stats_.framesDropped += rx_.size() / frameBytes;
      rx_.clear();
    }
  }
}

bool FrameTransport::CopyLatest(std::vector<uint8_t>* rgba, uint64_t* captureUnixMs,
                                uint64_t* sequence) const {
  if (!hasFrame_) return false;
  *rgba = latest_;
  *captureUnixMs = captureUnixMs_;
  *sequence = sequence_;
  return true;
}

}  // namespace shymask

