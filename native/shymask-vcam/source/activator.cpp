#include "activator.h"

#include "logging.h"
#include "module-lock.h"
#include "protocol.h"

#include <mfapi.h>
#include <mfvirtualcamera.h>
#include <mferror.h>

using Microsoft::WRL::ComPtr;

namespace shymask {

Activator::Activator() { ModuleAddLiveObject(); }

HRESULT Activator::Initialize() {
  HRESULT hr = MFCreateAttributes(&attributes_, 8);
  if (FAILED(hr)) return hr;

  // Tell the frame server that this camera provides its own associated sources.
  attributes_->SetUINT32(MF_VIRTUALCAMERA_PROVIDE_ASSOCIATED_CAMERA_SOURCES, 1);
  attributes_->SetGUID(MFT_TRANSFORM_CLSID_Attribute, kShymaskCameraSourceClsid);

  auto source = Microsoft::WRL::Make<MediaSource>();
  if (!source) return E_OUTOFMEMORY;
  hr = source->Initialize(attributes_.Get());
  if (FAILED(hr)) return hr;
  source_ = source;

  Log(L"Activator initialized (module=%s)", ModuleFileName().c_str());
  return S_OK;
}

Activator::~Activator() {
  source_.Reset();
  ModuleRemoveLiveObject();
}

STDMETHODIMP Activator::ActivateObject(REFIID riid, void** object) {
  if (!object) return E_POINTER;
  *object = nullptr;
  Log(L"Activator::ActivateObject requested from pid=%lu module=%s", GetCurrentProcessId(),
      ModuleFileName().c_str());
  if (!source_) {
    const HRESULT initHr = Initialize();
    if (FAILED(initHr)) {
      Log(L"Activator::ActivateObject lazy Initialize failed, hr=0x%08X",
          static_cast<unsigned>(initHr));
      return initHr;
    }
  }
  const HRESULT hr = source_->QueryInterface(riid, object);
  Log(L"Activator::ActivateObject hr=0x%08X", static_cast<unsigned>(hr));
  return hr;
}

STDMETHODIMP Activator::ShutdownObject() {
  Log(L"Activator::ShutdownObject");
  return S_OK;
}

STDMETHODIMP Activator::DetachObject() {
  Log(L"Activator::DetachObject");
  source_.Reset();
  return S_OK;
}

// IMFAttributes forwarding

STDMETHODIMP Activator::GetItem(REFGUID key, PROPVARIANT* value) {
  return attributes_->GetItem(key, value);
}
STDMETHODIMP Activator::GetItemType(REFGUID key, MF_ATTRIBUTE_TYPE* type) {
  return attributes_->GetItemType(key, type);
}
STDMETHODIMP Activator::CompareItem(REFGUID key, REFPROPVARIANT value, BOOL* result) {
  return attributes_->CompareItem(key, value, result);
}
STDMETHODIMP Activator::Compare(IMFAttributes* theirs, MF_ATTRIBUTES_MATCH_TYPE match,
                               BOOL* result) {
  return attributes_->Compare(theirs, match, result);
}
STDMETHODIMP Activator::GetUINT32(REFGUID key, UINT32* value) {
  return attributes_->GetUINT32(key, value);
}
STDMETHODIMP Activator::GetUINT64(REFGUID key, UINT64* value) {
  return attributes_->GetUINT64(key, value);
}
STDMETHODIMP Activator::GetDouble(REFGUID key, double* value) {
  return attributes_->GetDouble(key, value);
}
STDMETHODIMP Activator::GetGUID(REFGUID key, GUID* value) {
  return attributes_->GetGUID(key, value);
}
STDMETHODIMP Activator::GetStringLength(REFGUID key, UINT32* length) {
  return attributes_->GetStringLength(key, length);
}
STDMETHODIMP Activator::GetString(REFGUID key, LPWSTR value, UINT32 size, UINT32* length) {
  return attributes_->GetString(key, value, size, length);
}
STDMETHODIMP Activator::GetAllocatedString(REFGUID key, LPWSTR* value, UINT32* length) {
  return attributes_->GetAllocatedString(key, value, length);
}
STDMETHODIMP Activator::GetBlobSize(REFGUID key, UINT32* size) {
  return attributes_->GetBlobSize(key, size);
}
STDMETHODIMP Activator::GetBlob(REFGUID key, UINT8* buffer, UINT32 size, UINT32* blobSize) {
  return attributes_->GetBlob(key, buffer, size, blobSize);
}
STDMETHODIMP Activator::GetAllocatedBlob(REFGUID key, UINT8** buffer, UINT32* size) {
  return attributes_->GetAllocatedBlob(key, buffer, size);
}
STDMETHODIMP Activator::GetUnknown(REFGUID key, REFIID riid, LPVOID* object) {
  return attributes_->GetUnknown(key, riid, object);
}
STDMETHODIMP Activator::SetItem(REFGUID key, REFPROPVARIANT value) {
  return attributes_->SetItem(key, value);
}
STDMETHODIMP Activator::DeleteItem(REFGUID key) { return attributes_->DeleteItem(key); }
STDMETHODIMP Activator::DeleteAllItems() { return attributes_->DeleteAllItems(); }
STDMETHODIMP Activator::SetUINT32(REFGUID key, UINT32 value) {
  return attributes_->SetUINT32(key, value);
}
STDMETHODIMP Activator::SetUINT64(REFGUID key, UINT64 value) {
  return attributes_->SetUINT64(key, value);
}
STDMETHODIMP Activator::SetDouble(REFGUID key, double value) {
  return attributes_->SetDouble(key, value);
}
STDMETHODIMP Activator::SetGUID(REFGUID key, REFGUID value) {
  return attributes_->SetGUID(key, value);
}
STDMETHODIMP Activator::SetString(REFGUID key, LPCWSTR value) {
  return attributes_->SetString(key, value);
}
STDMETHODIMP Activator::SetBlob(REFGUID key, const UINT8* buffer, UINT32 size) {
  return attributes_->SetBlob(key, buffer, size);
}
STDMETHODIMP Activator::SetUnknown(REFGUID key, IUnknown* object) {
  return attributes_->SetUnknown(key, object);
}
STDMETHODIMP Activator::LockStore() { return attributes_->LockStore(); }
STDMETHODIMP Activator::UnlockStore() { return attributes_->UnlockStore(); }
STDMETHODIMP Activator::GetCount(UINT32* count) { return attributes_->GetCount(count); }
STDMETHODIMP Activator::GetItemByIndex(UINT32 index, GUID* key, PROPVARIANT* value) {
  return attributes_->GetItemByIndex(index, key, value);
}
STDMETHODIMP Activator::CopyAllItems(IMFAttributes* destination) {
  return attributes_->CopyAllItems(destination);
}

}  // namespace shymask

