#include "media-stream.h"

#include "protocol.h"
#include "paused-frame.h"
#include "logging.h"
#include "module-lock.h"

#include <mfapi.h>
#include <mferror.h>
#include <mfidl.h>

#include <algorithm>
#include <chrono>
#include <cstring>

using Microsoft::WRL::ComPtr;

namespace shymask {
namespace {

ComPtr<IMFMediaType> CreateRgb32Type() {
  ComPtr<IMFMediaType> type;
  if (FAILED(MFCreateMediaType(&type))) return nullptr;
  type->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Video);
  type->SetGUID(MF_MT_SUBTYPE, MFVideoFormat_RGB32);
  MFSetAttributeSize(type.Get(), MF_MT_FRAME_SIZE, kShymaskFrameWidth, kShymaskFrameHeight);
  type->SetUINT32(MF_MT_DEFAULT_STRIDE, kShymaskFrameWidth * 4);
  type->SetUINT32(MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive);
  type->SetUINT32(MF_MT_ALL_SAMPLES_INDEPENDENT, TRUE);
  MFSetAttributeRatio(type.Get(), MF_MT_FRAME_RATE, kShymaskFrameRateNumerator,
                      kShymaskFrameRateDenominator);
  MFSetAttributeRatio(type.Get(), MF_MT_PIXEL_ASPECT_RATIO, 1, 1);
  type->SetUINT32(MF_MT_AVG_BITRATE, kShymaskFrameWidth * kShymaskFrameHeight * 4 * 8 * 30);
  return type;
}

// RGBA (Chromium ImageData order) -> RGB32 / BGRA (Media Foundation order).
void ConvertRgbaToRgb32(const uint8_t* source, uint8_t* destination, size_t pixels) {
  for (size_t index = 0; index < pixels; ++index) {
    const uint8_t red = source[index * 4 + 0];
    const uint8_t green = source[index * 4 + 1];
    const uint8_t blue = source[index * 4 + 2];
    destination[index * 4 + 0] = blue;
    destination[index * 4 + 1] = green;
    destination[index * 4 + 2] = red;
    destination[index * 4 + 3] = 255;
  }
}

}  // namespace

MediaStream::MediaStream() { ModuleAddLiveObject(); }

MediaStream::~MediaStream() {
  Shutdown();
  ModuleRemoveLiveObject();
}

HRESULT MediaStream::Initialize(IMFMediaSource* source, DWORD streamId) {
  if (!source) return E_POINTER;
  source_ = source;

  ComPtr<IMFAttributes> attributes;
  HRESULT hr = MFCreateAttributes(&attributes, 4);
  if (FAILED(hr)) return hr;
  attributes->SetGUID(MF_DEVICESTREAM_STREAM_CATEGORY, kPinCategoryVideoCapture);
  attributes->SetUINT32(MF_DEVICESTREAM_STREAM_ID, streamId);
  attributes->SetUINT32(MF_DEVICESTREAM_FRAMESERVER_SHARED, 1);
  attributes->SetUINT32(MF_DEVICESTREAM_ATTRIBUTE_FRAMESOURCE_TYPES,
                        static_cast<UINT32>(MFFrameSourceTypes_Color));
  attributes_ = attributes;

  hr = MFCreateEventQueue(&queue_);
  if (FAILED(hr)) return hr;

  ComPtr<IMFMediaType> type = CreateRgb32Type();
  if (!type) return E_OUTOFMEMORY;
  currentType_ = type;

  IMFMediaType* types[1] = {type.Get()};
  hr = MFCreateStreamDescriptor(streamId, 1, types, &descriptor_);
  if (FAILED(hr)) return hr;

  descriptor_->SetGUID(MF_DEVICESTREAM_STREAM_CATEGORY, kPinCategoryVideoCapture);
  descriptor_->SetUINT32(MF_DEVICESTREAM_STREAM_ID, streamId);
  descriptor_->SetUINT32(MF_DEVICESTREAM_FRAMESERVER_SHARED, 1);
  descriptor_->SetUINT32(MF_DEVICESTREAM_ATTRIBUTE_FRAMESOURCE_TYPES,
                         static_cast<UINT32>(MFFrameSourceTypes_Color));

  ComPtr<IMFMediaTypeHandler> handler;
  hr = descriptor_->GetMediaTypeHandler(&handler);
  if (FAILED(hr)) return hr;
  hr = handler->SetCurrentMediaType(type.Get());
  if (FAILED(hr)) return hr;

  Log(L"MediaStream initialized streamId=%u format=RGB32 %ux%u@30", streamId, kShymaskFrameWidth,
      kShymaskFrameHeight);
  return S_OK;
}

HRESULT MediaStream::Start(IMFMediaType* type) {
  std::lock_guard<std::mutex> guard(lock_);
  if (!queue_ || !descriptor_) return MF_E_SHUTDOWN;
  if (running_) return S_OK;

  if (type) {
    GUID subtype = GUID_NULL;
    if (FAILED(type->GetGUID(MF_MT_SUBTYPE, &subtype))) return MF_E_INVALIDMEDIATYPE;
    if (subtype != MFVideoFormat_RGB32) {
      Log(L"MediaStream::Start rejecting unsupported subtype");
      return MF_E_INVALIDMEDIATYPE;
    }
    currentType_ = type;
  }

  HRESULT hr = EnsureAllocator(currentType_.Get());
  if (FAILED(hr)) {
    Log(L"MediaStream::Start could not initialize a sample allocator, hr=0x%08X",
        static_cast<unsigned>(hr));
    return hr;
  }

  transport_.Reset();
  deliveredSamples_ = 0;
  fallbackSamples_ = 0;
  allocatorFailures_ = 0;
  loggedConnected_ = false;
  stopWorker_ = false;
  running_ = true;
  worker_ = std::thread([this] { RunWorker(); });

  hr = queue_->QueueEventParamVar(MEStreamStarted, GUID_NULL, S_OK, nullptr);
  Log(L"MediaStream started (providedAllocator=%d), hr=0x%08X", allocatorProvided_ ? 1 : 0,
      static_cast<unsigned>(hr));
  return hr;
}

HRESULT MediaStream::EnsureAllocator(IMFMediaType* type) {
  if (!type) return E_INVALIDARG;
  if (!allocator_) {
    // No allocator was provided (for example an in-process host): fall back to
    // a private CPU allocator so the stream can still produce samples.
    ComPtr<IMFVideoSampleAllocatorEx> allocator;
    HRESULT hr = MFCreateVideoSampleAllocatorEx(IID_PPV_ARGS(&allocator));
    if (FAILED(hr)) return hr;
    allocator_ = allocator;
    Log(L"MediaStream created a private video sample allocator");
  }

  allocatorInitialized_ = false;
  const HRESULT hr = allocator_->InitializeSampleAllocator(10, type);
  if (SUCCEEDED(hr)) {
    allocatorInitialized_ = true;
    Log(L"MediaStream initialized the video sample allocator");
  }
  return hr;
}

HRESULT MediaStream::Stop() {
  StopWorker();
  std::lock_guard<std::mutex> guard(lock_);
  if (!queue_) return MF_E_SHUTDOWN;
  running_ = false;
  pendingRequests_.clear();
  if (allocatorInitialized_ && allocator_) {
    allocator_->UninitializeSampleAllocator();
    allocatorInitialized_ = false;
  }
  const HRESULT hr = queue_->QueueEventParamVar(MEStreamStopped, GUID_NULL, S_OK, nullptr);
  Log(L"MediaStream stopped, hr=0x%08X", static_cast<unsigned>(hr));
  return hr;
}

void MediaStream::StopWorker() {
  {
    std::lock_guard<std::mutex> guard(lock_);
    stopWorker_ = true;
    running_ = false;
  }
  requestsAvailable_.notify_all();
  if (worker_.joinable()) worker_.join();
}

void MediaStream::Shutdown() {
  StopWorker();
  std::lock_guard<std::mutex> guard(lock_);
  if (queue_) {
    queue_->Shutdown();
    queue_.Reset();
  }
  transport_.Reset();
  descriptor_.Reset();
  currentType_.Reset();
  source_.Reset();
  attributes_.Reset();
}

HRESULT MediaStream::GetStreamAttributes(IMFAttributes** attributes) {
  if (!attributes) return E_POINTER;
  *attributes = nullptr;
  std::lock_guard<std::mutex> guard(lock_);
  if (!attributes_) return MF_E_SHUTDOWN;
  return attributes_.CopyTo(attributes);
}

MF_STREAM_STATE MediaStream::GetState() const {
  std::lock_guard<std::mutex> guard(lock_);
  return running_ ? MF_STREAM_STATE_RUNNING : MF_STREAM_STATE_STOPPED;
}

HRESULT MediaStream::SetAllocator(IUnknown* allocator) {
  if (!allocator) return E_POINTER;
  ComPtr<IMFVideoSampleAllocatorEx> videoAllocator;
  const HRESULT hr = allocator->QueryInterface(IID_PPV_ARGS(&videoAllocator));
  Log(L"MediaStream::SetAllocator requested, hr=0x%08X", static_cast<unsigned>(hr));
  if (FAILED(hr)) return hr;
  std::lock_guard<std::mutex> guard(lock_);
  allocator_ = videoAllocator;
  allocatorProvided_ = true;
  return S_OK;
}

HRESULT MediaStream::SetD3DManager(IUnknown* manager) {
  Log(L"MediaStream::SetD3DManager manager=%p", manager);
  // The Shymask pipeline produces CPU canvas frames, so the stream writes into
  // CPU-accessible samples. Nothing is retained from the manager.
  return S_OK;
}

MFSampleAllocatorUsage MediaStream::GetAllocatorUsage() const {
  std::lock_guard<std::mutex> guard(lock_);
  // Only claim the caller-provided allocator when one was actually supplied
  // through IMFSampleAllocatorControl::SetDefaultAllocator. The in-process
  // fallback uses a private allocator (or a plain memory sample), which is a
  // custom allocator, not the frame server's provided one.
  return allocator_ && allocatorProvided_ ? MFSampleAllocatorUsage_UsesProvidedAllocator
                                          : MFSampleAllocatorUsage_UsesCustomAllocator;
}

// IMFMediaStream2

STDMETHODIMP MediaStream::SetStreamState(MF_STREAM_STATE state) {
  Log(L"MediaStream::SetStreamState %u", static_cast<unsigned>(state));
  switch (state) {
    case MF_STREAM_STATE_RUNNING: {
      ComPtr<IMFMediaType> type;
      {
        std::lock_guard<std::mutex> guard(lock_);
        if (running_) return S_OK;
        type = currentType_;
      }
      return Start(type.Get());
    }
    case MF_STREAM_STATE_STOPPED:
      return Stop();
    case MF_STREAM_STATE_PAUSED:
      // This live camera source has no paused delivery state: samples are
      // produced on RequestSample and GetStreamState reports only RUNNING or
      // STOPPED. Acknowledging PAUSED while delivery continued (the previous
      // behavior) made GetStreamState lie, so the unsupported transition is
      // rejected explicitly. The frame server starts and stops the stream and
      // does not pause it.
      Log(L"MediaStream::SetStreamState(PAUSED) is not supported");
      return E_NOTIMPL;
    default:
      return MF_E_INVALID_STATE_TRANSITION;
  }
}

STDMETHODIMP MediaStream::GetStreamState(MF_STREAM_STATE* state) {
  if (!state) return E_POINTER;
  *state = GetState();
  return S_OK;
}

// IMFMediaEventGenerator

STDMETHODIMP MediaStream::BeginGetEvent(IMFAsyncCallback* callback, IUnknown* state) {
  std::lock_guard<std::mutex> guard(lock_);
  if (!queue_) return MF_E_SHUTDOWN;
  return queue_->BeginGetEvent(callback, state);
}

STDMETHODIMP MediaStream::EndGetEvent(IMFAsyncResult* result, IMFMediaEvent** event) {
  if (!event) return E_POINTER;
  *event = nullptr;
  std::lock_guard<std::mutex> guard(lock_);
  if (!queue_) return MF_E_SHUTDOWN;
  return queue_->EndGetEvent(result, event);
}

STDMETHODIMP MediaStream::GetEvent(DWORD flags, IMFMediaEvent** event) {
  if (!event) return E_POINTER;
  *event = nullptr;
  std::lock_guard<std::mutex> guard(lock_);
  if (!queue_) return MF_E_SHUTDOWN;
  return queue_->GetEvent(flags, event);
}

STDMETHODIMP MediaStream::QueueEvent(MediaEventType type, REFGUID extendedType, HRESULT status,
                                     const PROPVARIANT* value) {
  std::lock_guard<std::mutex> guard(lock_);
  if (!queue_) return MF_E_SHUTDOWN;
  return queue_->QueueEventParamVar(type, extendedType, status, value);
}

// IMFMediaStream

STDMETHODIMP MediaStream::GetMediaSource(IMFMediaSource** source) {
  if (!source) return E_POINTER;
  *source = nullptr;
  std::lock_guard<std::mutex> guard(lock_);
  if (!source_) return MF_E_SHUTDOWN;
  return source_.CopyTo(source);
}

STDMETHODIMP MediaStream::GetStreamDescriptor(IMFStreamDescriptor** descriptor) {
  Log(L"MediaStream::GetStreamDescriptor");
  if (!descriptor) return E_POINTER;
  *descriptor = nullptr;
  std::lock_guard<std::mutex> guard(lock_);
  if (!descriptor_) return MF_E_SHUTDOWN;
  return descriptor_.CopyTo(descriptor);
}

STDMETHODIMP MediaStream::RequestSample(IUnknown* token) {
  std::lock_guard<std::mutex> guard(lock_);
  if (!queue_ || !running_) return MF_E_INVALIDREQUEST;
  pendingRequests_.push_back(token);
  // Keep at most four outstanding requests: the source reader normally has at
  // most two, and an unbounded queue would turn a stalled consumer into
  // unbounded memory growth.
  while (pendingRequests_.size() > 4) pendingRequests_.pop_front();
  requestsAvailable_.notify_one();
  return S_OK;
}

// IMFGetService

STDMETHODIMP MediaStream::GetService(REFGUID, REFIID, LPVOID* object) {
  if (object) *object = nullptr;
  return MF_E_UNSUPPORTED_SERVICE;
}

void MediaStream::RunWorker() {
  Log(L"MediaStream worker started");
  auto next = std::chrono::steady_clock::now();
  for (;;) {
    ComPtr<IUnknown> token;
    {
      std::unique_lock<std::mutex> guard(lock_);
      requestsAvailable_.wait_for(guard, std::chrono::milliseconds(50),
                                  [this] { return stopWorker_ || !pendingRequests_.empty(); });
      if (stopWorker_) break;
      if (pendingRequests_.empty()) continue;
      token = pendingRequests_.front();
      pendingRequests_.pop_front();
    }

    const auto now = std::chrono::steady_clock::now();
    if (now < next) std::this_thread::sleep_until(next);
    next = std::max(next, now) + std::chrono::milliseconds(33);

    const HRESULT hr = DeliverSample(token.Get());
    if (FAILED(hr)) {
      Log(L"MediaStream sample delivery failed, hr=0x%08X", static_cast<unsigned>(hr));
    }
  }
  Log(L"MediaStream worker stopped after %llu samples (%llu paused fallbacks)",
      static_cast<unsigned long long>(deliveredSamples_),
      static_cast<unsigned long long>(fallbackSamples_));
}

HRESULT MediaStream::DeliverSample(IUnknown* token) {
  transport_.Poll();
  if (!loggedConnected_ && transport_.Connected()) {
    loggedConnected_ = true;
    Log(L"MediaStream connected to the Shymask frame transport");
  }

  std::vector<uint8_t> frame;
  uint64_t captureUnixMs = 0;
  uint64_t sequence = 0;
  const bool fromApp = transport_.CopyLatest(&frame, &captureUnixMs, &sequence);
  if (!fromApp) {
    frame = PausedFrame();
    fallbackSamples_++;
  }

  ComPtr<IMFSample> sample;
  HRESULT hr = CreateSample(frame, fromApp ? captureUnixMs : 0, sequence, token, &sample);
  if (FAILED(hr)) return hr;

  ComPtr<IMFMediaEventQueue> queue;
  {
    std::lock_guard<std::mutex> guard(lock_);
    queue = queue_;
  }
  if (!queue) return MF_E_SHUTDOWN;
  hr = queue->QueueEventParamUnk(MEMediaSample, GUID_NULL, S_OK, sample.Get());
  if (SUCCEEDED(hr)) {
    deliveredSamples_++;
    if (deliveredSamples_ == 1) Log(L"MediaStream delivered its first sample (fromApp=%d)", fromApp);
  }
  return hr;
}

HRESULT MediaStream::CreateSample(const std::vector<uint8_t>& rgba, uint64_t captureUnixMs,
                                  uint64_t sequence, IUnknown* token, IMFSample** sample) {
  *sample = nullptr;
  const DWORD payloadBytes = kShymaskFrameWidth * kShymaskFrameHeight * 4;
  if (rgba.size() != payloadBytes) return E_INVALIDARG;

  ComPtr<IMFSample> created;
  ComPtr<IMFVideoSampleAllocatorEx> allocator;
  bool allocatorReady = false;
  {
    std::lock_guard<std::mutex> guard(lock_);
    allocator = allocator_;
    allocatorReady = allocatorInitialized_;
  }
  if (allocator && allocatorReady) {
    const HRESULT allocateHr = allocator->AllocateSample(&created);
    if (FAILED(allocateHr) || !created) {
      allocatorFailures_++;
      if (allocatorFailures_ <= 3) {
        Log(L"MediaStream allocated sample from the provided allocator failed, hr=0x%08X",
            static_cast<unsigned>(allocateHr));
      }
      created.Reset();
    }
  }

  if (!created) {
    // Fallback: a private memory sample. This works for in-process hosts but the
    // frame server needs its shared allocator for cross-process delivery.
    ComPtr<IMFMediaBuffer> buffer;
    HRESULT hr = MFCreateMemoryBuffer(payloadBytes, &buffer);
    if (FAILED(hr)) return hr;
    hr = MFCreateSample(&created);
    if (FAILED(hr)) return hr;
    hr = created->AddBuffer(buffer.Get());
    if (FAILED(hr)) return hr;
  }

  HRESULT hr = FillSampleBuffer(created.Get(), rgba);
  if (FAILED(hr)) return hr;

  created->SetSampleTime(MFGetSystemTime());
  created->SetSampleDuration(kShymaskFrameDuration100ns);
  created->SetUINT32(MFSampleExtension_CleanPoint, 1);
  if (captureUnixMs != 0) {
    created->SetUINT64(kShymaskSampleAttributeCaptureUnixMs, captureUnixMs);
  }
  if (token) created->SetUnknown(MFSampleExtension_Token, token);
  created->SetUINT32(MFSampleExtension_Interlaced, 0);
  // Diagnostic: expose the producer's frame sequence so a consumer can tell
  // which app frame a sample came from (several 30 Hz samples reuse one
  // ~21-24 Hz app frame). Sequence 0 does not imply the native paused fallback
  // (the first published app frame can also be 0); captureUnixMs == 0 does.
  created->SetUINT64(kShymaskSampleAttributeSequence, sequence);

  *sample = created.Detach();
  return S_OK;
}

HRESULT MediaStream::FillSampleBuffer(IMFSample* sample, const std::vector<uint8_t>& rgba) {
  constexpr DWORD kPayloadBytes = kShymaskFrameWidth * kShymaskFrameHeight * 4;
  if (rgba.size() != kPayloadBytes) return E_INVALIDARG;

  ComPtr<IMFMediaBuffer> buffer;
  HRESULT hr = sample->GetBufferByIndex(0, &buffer);
  if (FAILED(hr)) return hr;

  // Reject a buffer that cannot hold a full frame before touching memory. A
  // zero length can mean the 2-D path below is required, so the Lock result is
  // checked again for the authoritative limit.
  DWORD declaredMaxLength = 0;
  if (SUCCEEDED(buffer->GetMaxLength(&declaredMaxLength)) && declaredMaxLength != 0 &&
      declaredMaxLength < kPayloadBytes) {
    Log(L"MediaStream sample buffer is too small (max=%u, need=%u)",
        static_cast<unsigned>(declaredMaxLength), static_cast<unsigned>(kPayloadBytes));
    return MF_E_BUFFERTOOSMALL;
  }

  BYTE* destination = nullptr;
  DWORD maxLength = 0;
  DWORD currentLength = 0;
  hr = buffer->Lock(&destination, &maxLength, &currentLength);
  if (SUCCEEDED(hr)) {
    if (!destination || maxLength < kPayloadBytes) {
      buffer->Unlock();
      Log(L"MediaStream locked buffer is too small (max=%u, need=%u)",
          static_cast<unsigned>(maxLength), static_cast<unsigned>(kPayloadBytes));
      return MF_E_BUFFERTOOSMALL;
    }
    ConvertRgbaToRgb32(rgba.data(), destination,
                       static_cast<size_t>(kShymaskFrameWidth) * kShymaskFrameHeight);
    buffer->Unlock();
    return buffer->SetCurrentLength(kPayloadBytes);
  }

  // Some frame-server allocator buffers are 2D (DXGI/staging) surfaces and
  // must be written through IMF2DBuffer.
  ComPtr<IMF2DBuffer> buffer2d;
  hr = buffer.As(&buffer2d);
  if (FAILED(hr)) return hr;
  BYTE* scanline0 = nullptr;
  LONG pitch = 0;
  hr = buffer2d->Lock2D(&scanline0, &pitch);
  if (FAILED(hr)) return hr;

  const int64_t pitchMagnitude = pitch < 0 ? -static_cast<int64_t>(pitch) : pitch;
  if (!scanline0 || pitchMagnitude < static_cast<int64_t>(kShymaskFrameWidth) * 4 ||
      pitchMagnitude * static_cast<int64_t>(kShymaskFrameHeight) <
          static_cast<int64_t>(kPayloadBytes)) {
    buffer2d->Unlock2D();
    Log(L"MediaStream 2-D buffer is too small (pitch=%ld, need=%u)", pitch,
        static_cast<unsigned>(kPayloadBytes));
    return MF_E_BUFFERTOOSMALL;
  }

  for (uint32_t y = 0; y < kShymaskFrameHeight; ++y) {
    const uint8_t* source = rgba.data() + static_cast<size_t>(y) * kShymaskFrameWidth * 4;
    // Lock2D documents pbScanline0 as the first byte of the top row of the
    // image as presented (which "might not be the first row in memory") and
    // plPitch as the byte stride to the next presented row, negative for a
    // bottom-up surface. scanline0 + y*pitch is therefore the correct address
    // for row y under both signs, and the pitch-magnitude check above keeps
    // the last row inside the surface. Mirroring a negative pitch (the
    // previous behavior) wrote up to (h-1)*|pitch| beyond the buffer.
    uint8_t* row = scanline0 + static_cast<ptrdiff_t>(y) * static_cast<ptrdiff_t>(pitch);
    ConvertRgbaToRgb32(source, row, kShymaskFrameWidth);
  }
  buffer2d->Unlock2D();
  return S_OK;
}

}  // namespace shymask





