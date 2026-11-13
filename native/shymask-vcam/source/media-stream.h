// Media Foundation stream for the Shymask virtual camera.
//
// One RGB32 1280x720 stream. Sample delivery is pull-driven (IMFMediaStream::
// RequestSample) and paced at 30 Hz. Each delivered sample is the newest frame
// produced by the app; when the app has not connected yet, the opaque paused
// fallback frame is delivered instead. No raw input is ever available on this
// path.
#pragma once

#include <windows.h>
#include <mfidl.h>
#include <wrl/client.h>
#include <wrl/implements.h>

#include <condition_variable>
#include <cstdint>
#include <deque>
#include <mutex>
#include <thread>
#include <vector>

#include "frame-transport.h"

namespace shymask {

class MediaStream final
    : public Microsoft::WRL::RuntimeClass<Microsoft::WRL::RuntimeClassFlags<
                                              Microsoft::WRL::ClassicCom>,
                                          Microsoft::WRL::ChainInterfaces<IMFMediaStream, IMFMediaEventGenerator>, IMFGetService> {
 public:
  MediaStream();

  HRESULT Initialize(IMFMediaSource* source, DWORD streamId);
  HRESULT Start(IMFMediaType* type);
  HRESULT Stop();
  void Shutdown();
  HRESULT GetStreamAttributes(IMFAttributes** attributes);
  MF_STREAM_STATE GetState() const;

  // IMFMediaEventGenerator
  STDMETHODIMP BeginGetEvent(IMFAsyncCallback* callback, IUnknown* state) override;
  STDMETHODIMP EndGetEvent(IMFAsyncResult* result, IMFMediaEvent** event) override;
  STDMETHODIMP GetEvent(DWORD flags, IMFMediaEvent** event) override;
  STDMETHODIMP QueueEvent(MediaEventType type, REFGUID extendedType, HRESULT status,
                          const PROPVARIANT* value) override;

  // IMFMediaStream
  STDMETHODIMP GetMediaSource(IMFMediaSource** source) override;
  STDMETHODIMP GetStreamDescriptor(IMFStreamDescriptor** descriptor) override;
  STDMETHODIMP RequestSample(IUnknown* token) override;

  // IMFGetService
  STDMETHODIMP GetService(REFGUID service, REFIID interfaceId, LPVOID* object) override;

  ~MediaStream() override;

 private:

  void RunWorker();
  void StopWorker();
  HRESULT DeliverSample(IUnknown* token);
  HRESULT CreateSample(const std::vector<uint8_t>& rgba, uint64_t captureUnixMs,
                       uint64_t sequence, IUnknown* token, IMFSample** sample);

  mutable std::mutex lock_;
  Microsoft::WRL::ComPtr<IMFMediaSource> source_;
  Microsoft::WRL::ComPtr<IMFStreamDescriptor> descriptor_;
  Microsoft::WRL::ComPtr<IMFMediaEventQueue> queue_;
  Microsoft::WRL::ComPtr<IMFAttributes> attributes_;
  Microsoft::WRL::ComPtr<IMFMediaType> currentType_;
  GUID subtype_ = GUID_NULL;

  std::condition_variable requestsAvailable_;
  std::deque<Microsoft::WRL::ComPtr<IUnknown>> pendingRequests_;
  std::thread worker_;
  bool running_ = false;
  bool stopWorker_ = false;

  FrameTransport transport_;
  std::vector<uint8_t> scratchFrame_;
  uint64_t streamStartMs_ = 0;
  uint64_t nextTickMs_ = 0;
  uint64_t deliveredSamples_ = 0;
  uint64_t fallbackSamples_ = 0;
  bool loggedConnected_ = false;
};

}  // namespace shymask

