// Media Foundation media source for the Shymask virtual camera.
//
// The source is a single-stream live source. It is activated by an IMFActivate
// object (see activator.h) whose CLSID is the sourceId passed to
// MFCreateVirtualCamera. All Windows camera-specific code lives in this native
// directory; the Electron app never links Media Foundation.
#pragma once

#include <windows.h>
#include <mfidl.h>
#include <wrl/client.h>
#include <wrl/implements.h>

#include <mutex>

#include "media-stream.h"

namespace shymask {

class MediaSource final
    : public Microsoft::WRL::RuntimeClass<
          Microsoft::WRL::RuntimeClassFlags<Microsoft::WRL::ClassicCom>,
          Microsoft::WRL::ChainInterfaces<IMFMediaSourceEx, IMFMediaSource, IMFMediaEventGenerator>,
          IMFGetService, IMFSampleAllocatorControl> {
 public:
  MediaSource();
  HRESULT Initialize(IMFAttributes* activatorAttributes);

  // IMFMediaEventGenerator
  STDMETHODIMP BeginGetEvent(IMFAsyncCallback* callback, IUnknown* state) override;
  STDMETHODIMP EndGetEvent(IMFAsyncResult* result, IMFMediaEvent** event) override;
  STDMETHODIMP GetEvent(DWORD flags, IMFMediaEvent** event) override;
  STDMETHODIMP QueueEvent(MediaEventType type, REFGUID extendedType, HRESULT status,
                          const PROPVARIANT* value) override;

  // IMFMediaSource
  STDMETHODIMP CreatePresentationDescriptor(IMFPresentationDescriptor** descriptor) override;
  STDMETHODIMP GetCharacteristics(DWORD* characteristics) override;
  STDMETHODIMP Pause() override;
  STDMETHODIMP Shutdown() override;
  STDMETHODIMP Start(IMFPresentationDescriptor* descriptor, const GUID* timeFormat,
                     const PROPVARIANT* startPosition) override;
  STDMETHODIMP Stop() override;

  // IMFMediaSourceEx
  STDMETHODIMP GetSourceAttributes(IMFAttributes** attributes) override;
  STDMETHODIMP GetStreamAttributes(DWORD streamIdentifier, IMFAttributes** attributes) override;
  STDMETHODIMP SetD3DManager(IUnknown* manager) override;

  // IMFSampleAllocatorControl
  STDMETHODIMP SetDefaultAllocator(DWORD outputStreamId, IUnknown* allocator) override;
  STDMETHODIMP GetAllocatorUsage(DWORD outputStreamId, DWORD* inputStreamId,
                                 MFSampleAllocatorUsage* usage) override;

  // IMFGetService
  STDMETHODIMP GetService(REFGUID service, REFIID interfaceId, LPVOID* object) override;

  ~MediaSource() override;

 private:

  mutable std::mutex lock_;
  Microsoft::WRL::ComPtr<MediaStream> stream_;
  Microsoft::WRL::ComPtr<IMFPresentationDescriptor> descriptor_;
  Microsoft::WRL::ComPtr<IMFMediaEventQueue> queue_;
  Microsoft::WRL::ComPtr<IMFAttributes> attributes_;
  bool shutdown_ = false;
};

}  // namespace shymask

