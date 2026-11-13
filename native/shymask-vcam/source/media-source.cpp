#include "media-source.h"

#include "logging.h"
#include "protocol.h"

#include <mfapi.h>
#include <mferror.h>

#include <algorithm>
#include <mutex>

using Microsoft::WRL::ComPtr;

namespace shymask {

MediaSource::~MediaSource() { Shutdown(); }

HRESULT MediaSource::Initialize(IMFAttributes* activatorAttributes) {
  HRESULT hr = MFCreateAttributes(&attributes_, 4);
  if (FAILED(hr)) return hr;
  if (activatorAttributes) {
    // Copy the activator's configuration (for example
    // MF_VIRTUALCAMERA_PROVIDE_ASSOCIATED_CAMERA_SOURCES) onto the source.
    UINT32 attributeCount = 0;
    activatorAttributes->GetCount(&attributeCount);
    for (UINT32 index = 0; index < attributeCount; ++index) {
      GUID key = GUID_NULL;
      PROPVARIANT value;
      PropVariantInit(&value);
      if (SUCCEEDED(activatorAttributes->GetItemByIndex(index, &key, &value))) {
        attributes_->SetItem(key, value);
        PropVariantClear(&value);
      }
    }
  }

  hr = MFCreateEventQueue(&queue_);
  if (FAILED(hr)) return hr;

  auto stream = Microsoft::WRL::Make<MediaStream>();
  if (!stream) return E_OUTOFMEMORY;
  hr = stream->Initialize(this, 0);
  if (FAILED(hr)) return hr;
  stream_ = stream;

  ComPtr<IMFStreamDescriptor> streamDescriptor;
  hr = stream->GetStreamDescriptor(&streamDescriptor);
  if (FAILED(hr)) return hr;

  IMFStreamDescriptor* descriptors[1] = {streamDescriptor.Get()};
  hr = MFCreatePresentationDescriptor(1, descriptors, &descriptor_);
  if (FAILED(hr)) return hr;
  hr = descriptor_->SelectStream(0);
  if (FAILED(hr)) return hr;

  Log(L"MediaSource initialized (single RGB32 stream)");
  return S_OK;
}

// IMFMediaEventGenerator

STDMETHODIMP MediaSource::BeginGetEvent(IMFAsyncCallback* callback, IUnknown* state) {
  std::lock_guard<std::mutex> guard(lock_);
  if (!queue_) return MF_E_SHUTDOWN;
  return queue_->BeginGetEvent(callback, state);
}

STDMETHODIMP MediaSource::EndGetEvent(IMFAsyncResult* result, IMFMediaEvent** event) {
  if (!event) return E_POINTER;
  *event = nullptr;
  std::lock_guard<std::mutex> guard(lock_);
  if (!queue_) return MF_E_SHUTDOWN;
  return queue_->EndGetEvent(result, event);
}

STDMETHODIMP MediaSource::GetEvent(DWORD flags, IMFMediaEvent** event) {
  if (!event) return E_POINTER;
  *event = nullptr;
  std::lock_guard<std::mutex> guard(lock_);
  if (!queue_) return MF_E_SHUTDOWN;
  return queue_->GetEvent(flags, event);
}

STDMETHODIMP MediaSource::QueueEvent(MediaEventType type, REFGUID extendedType, HRESULT status,
                                     const PROPVARIANT* value) {
  std::lock_guard<std::mutex> guard(lock_);
  if (!queue_) return MF_E_SHUTDOWN;
  return queue_->QueueEventParamVar(type, extendedType, status, value);
}

// IMFMediaSource

STDMETHODIMP MediaSource::CreatePresentationDescriptor(IMFPresentationDescriptor** descriptor) {
  Log(L"MediaSource::CreatePresentationDescriptor");
  if (!descriptor) return E_POINTER;
  *descriptor = nullptr;
  std::lock_guard<std::mutex> guard(lock_);
  if (!descriptor_) return MF_E_SHUTDOWN;
  return descriptor_->Clone(descriptor);
}

STDMETHODIMP MediaSource::GetCharacteristics(DWORD* characteristics) {
  Log(L"MediaSource::GetCharacteristics");
  if (!characteristics) return E_POINTER;
  *characteristics = MFMEDIASOURCE_IS_LIVE;
  return S_OK;
}

STDMETHODIMP MediaSource::Pause() { return MF_E_INVALID_STATE_TRANSITION; }

STDMETHODIMP MediaSource::Shutdown() {
  std::lock_guard<std::mutex> guard(lock_);
  if (shutdown_) return S_OK;
  shutdown_ = true;
  if (queue_) {
    queue_->Shutdown();
    queue_.Reset();
  }
  if (stream_) {
    stream_->Shutdown();
    stream_.Reset();
  }
  descriptor_.Reset();
  attributes_.Reset();
  Log(L"MediaSource shutdown");
  return S_OK;
}

STDMETHODIMP MediaSource::Start(IMFPresentationDescriptor* descriptor, const GUID* timeFormat,
                                const PROPVARIANT* startPosition) {
  if (!descriptor) return E_POINTER;
  if (timeFormat && *timeFormat != GUID_NULL) return E_INVALIDARG;
  if (!startPosition) return E_POINTER;

  std::lock_guard<std::mutex> guard(lock_);
  if (shutdown_ || !queue_ || !descriptor_) return MF_E_SHUTDOWN;

  DWORD count = 0;
  HRESULT hr = descriptor->GetStreamDescriptorCount(&count);
  if (FAILED(hr)) return hr;
  if (count != 1) return E_INVALIDARG;

  BOOL selected = FALSE;
  ComPtr<IMFStreamDescriptor> streamDescriptor;
  hr = descriptor->GetStreamDescriptorByIndex(0, &selected, &streamDescriptor);
  if (FAILED(hr)) return hr;

  if (selected && stream_->GetState() == MF_STREAM_STATE_STOPPED) {
    hr = descriptor_->SelectStream(0);
    if (FAILED(hr)) return hr;

    ComPtr<IUnknown> unknown;
    hr = stream_.As(&unknown);
    if (FAILED(hr)) return hr;
    hr = queue_->QueueEventParamUnk(MENewStream, GUID_NULL, S_OK, unknown.Get());
    if (FAILED(hr)) return hr;

    ComPtr<IMFMediaTypeHandler> handler;
    ComPtr<IMFMediaType> currentType;
    hr = streamDescriptor->GetMediaTypeHandler(&handler);
    if (FAILED(hr)) return hr;
    hr = handler->GetCurrentMediaType(&currentType);
    if (FAILED(hr)) return hr;
    hr = stream_->Start(currentType.Get());
    if (FAILED(hr)) return hr;
  } else if (!selected) {
    descriptor_->DeselectStream(0);
    stream_->Stop();
  }

  PROPVARIANT time;
  PropVariantInit(&time);
  time.vt = VT_I8;
  time.hVal.QuadPart = MFGetSystemTime();
  hr = queue_->QueueEventParamVar(MESourceStarted, GUID_NULL, S_OK, &time);
  PropVariantClear(&time);
  Log(L"MediaSource started, hr=0x%08X", static_cast<unsigned>(hr));
  return hr;
}

STDMETHODIMP MediaSource::Stop() {
  std::lock_guard<std::mutex> guard(lock_);
  if (shutdown_ || !queue_ || !descriptor_) return MF_E_SHUTDOWN;

  stream_->Stop();
  descriptor_->DeselectStream(0);

  PROPVARIANT time;
  PropVariantInit(&time);
  time.vt = VT_I8;
  time.hVal.QuadPart = MFGetSystemTime();
  const HRESULT hr = queue_->QueueEventParamVar(MESourceStopped, GUID_NULL, S_OK, &time);
  PropVariantClear(&time);
  Log(L"MediaSource stopped, hr=0x%08X", static_cast<unsigned>(hr));
  return hr;
}

// IMFMediaSourceEx

STDMETHODIMP MediaSource::GetSourceAttributes(IMFAttributes** attributes) {
  Log(L"MediaSource::GetSourceAttributes");
  if (!attributes) return E_POINTER;
  *attributes = nullptr;
  std::lock_guard<std::mutex> guard(lock_);
  if (!attributes_) return MF_E_SHUTDOWN;
  return attributes_.CopyTo(attributes);
}

STDMETHODIMP MediaSource::GetStreamAttributes(DWORD streamIdentifier, IMFAttributes** attributes) {
  Log(L"MediaSource::GetStreamAttributes id=%u", streamIdentifier);
  if (!attributes) return E_POINTER;
  *attributes = nullptr;
  std::lock_guard<std::mutex> guard(lock_);
  if (!stream_) return MF_E_SHUTDOWN;
  if (streamIdentifier != 0) return E_INVALIDARG;
  return stream_->GetStreamAttributes(attributes);
}

STDMETHODIMP MediaSource::SetD3DManager(IUnknown* manager) {
  Log(L"MediaSource::SetD3DManager manager=%p", manager);
  // The Shymask camera is deliberately CPU-only: the app produces canvas frames
  // and the media source converts them to RGB32 samples without a D3D device.
  std::lock_guard<std::mutex> guard(lock_);
  if (stream_) stream_->SetD3DManager(manager);
  return S_OK;
}

// IMFSampleAllocatorControl

STDMETHODIMP MediaSource::SetDefaultAllocator(DWORD outputStreamId, IUnknown* allocator) {
  Log(L"MediaSource::SetDefaultAllocator stream=%u allocator=%p", outputStreamId, allocator);
  if (!allocator) return E_POINTER;
  std::lock_guard<std::mutex> guard(lock_);
  if (!stream_) return MF_E_SHUTDOWN;
  return stream_->SetAllocator(allocator);
}

STDMETHODIMP MediaSource::GetAllocatorUsage(DWORD outputStreamId, DWORD* inputStreamId,
                                            MFSampleAllocatorUsage* usage) {
  if (!inputStreamId || !usage) return E_POINTER;
  std::lock_guard<std::mutex> guard(lock_);
  if (!stream_) return MF_E_SHUTDOWN;
  *inputStreamId = outputStreamId;
  *usage = stream_->GetAllocatorUsage();
  return S_OK;
}

// IMFGetService

STDMETHODIMP MediaSource::GetService(REFGUID, REFIID, LPVOID* object) {
  if (object) *object = nullptr;
  return MF_E_UNSUPPORTED_SERVICE;
}

}  // namespace shymask


