#include "media-stream.h"

#include "protocol.h"
#include "paused-frame.h"
#include "logging.h"

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

MediaStream::MediaStream() = default;
MediaStream::~MediaStream() { Shutdown(); }

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
  type->GetGUID(MF_MT_SUBTYPE, &subtype_);

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
    subtype_ = subtype;
  }

  transport_.Reset();
  deliveredSamples_ = 0;
  fallbackSamples_ = 0;
  loggedConnected_ = false;
  stopWorker_ = false;
  running_ = true;
  streamStartMs_ = GetTickCount64();
  nextTickMs_ = streamStartMs_;
  worker_ = std::thread([this] { RunWorker(); });

  const HRESULT hr = queue_->QueueEventParamVar(MEStreamStarted, GUID_NULL, S_OK, nullptr);
  Log(L"MediaStream started, hr=0x%08X", static_cast<unsigned>(hr));
  return hr;
}

HRESULT MediaStream::Stop() {
  StopWorker();
  std::lock_guard<std::mutex> guard(lock_);
  if (!queue_) return MF_E_SHUTDOWN;
  running_ = false;
  pendingRequests_.clear();
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
    if (now - next > std::chrono::milliseconds(500)) next = now;

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

  ComPtr<IMFMediaBuffer> buffer;
  HRESULT hr = MFCreateMemoryBuffer(payloadBytes, &buffer);
  if (FAILED(hr)) return hr;

  BYTE* destination = nullptr;
  DWORD maxLength = 0;
  DWORD currentLength = 0;
  hr = buffer->Lock(&destination, &maxLength, &currentLength);
  if (FAILED(hr)) return hr;
  ConvertRgbaToRgb32(rgba.data(), destination, static_cast<size_t>(kShymaskFrameWidth) *
                                                    kShymaskFrameHeight);
  buffer->Unlock();
  hr = buffer->SetCurrentLength(payloadBytes);
  if (FAILED(hr)) return hr;

  ComPtr<IMFSample> created;
  hr = MFCreateSample(&created);
  if (FAILED(hr)) return hr;
  hr = created->AddBuffer(buffer.Get());
  if (FAILED(hr)) return hr;

  const LONGLONG sampleTime = static_cast<LONGLONG>(GetTickCount64() - streamStartMs_) * 10000;
  created->SetSampleTime(sampleTime);
  created->SetSampleDuration(kShymaskFrameDuration100ns);
  created->SetUINT32(MFSampleExtension_CleanPoint, 1);
  if (captureUnixMs != 0) {
    created->SetUINT64(kShymaskSampleAttributeCaptureUnixMs, captureUnixMs);
  }
  if (token) created->SetUnknown(MFSampleExtension_Token, token);
  created->SetUINT32(MFSampleExtension_Interlaced, 0);
  (void)sequence;

  *sample = created.Detach();
  return S_OK;
}

}  // namespace shymask




