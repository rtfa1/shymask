// IMFActivate implementation that creates the Shymask media source.
//
// MFCreateVirtualCamera is given the CLSID of this COM class; the OS (or a
// consumer process) activates it, asks for IMFActivate, and calls
// ActivateObject to obtain the media source.
#pragma once

#include <windows.h>
#include <mfapi.h>
#include <mfidl.h>
#include <wrl/client.h>
#include <wrl/implements.h>

#include "media-source.h"

namespace shymask {

class Activator final
    : public Microsoft::WRL::RuntimeClass<
          Microsoft::WRL::RuntimeClassFlags<Microsoft::WRL::ClassicCom>,
          Microsoft::WRL::ChainInterfaces<IMFActivate, IMFAttributes>> {
 public:
  Activator();
  HRESULT Initialize();
  ~Activator() override;

  // IMFActivate
  STDMETHODIMP ActivateObject(REFIID riid, void** object) override;
  STDMETHODIMP ShutdownObject() override;
  STDMETHODIMP DetachObject() override;

  // IMFAttributes (forwarded to a real attribute store so the OS can configure
  // the activation object before ActivateObject is called).
  STDMETHODIMP GetItem(REFGUID key, PROPVARIANT* value) override;
  STDMETHODIMP GetItemType(REFGUID key, MF_ATTRIBUTE_TYPE* type) override;
  STDMETHODIMP CompareItem(REFGUID key, REFPROPVARIANT value, BOOL* result) override;
  STDMETHODIMP Compare(IMFAttributes* theirs, MF_ATTRIBUTES_MATCH_TYPE match, BOOL* result) override;
  STDMETHODIMP GetUINT32(REFGUID key, UINT32* value) override;
  STDMETHODIMP GetUINT64(REFGUID key, UINT64* value) override;
  STDMETHODIMP GetDouble(REFGUID key, double* value) override;
  STDMETHODIMP GetGUID(REFGUID key, GUID* value) override;
  STDMETHODIMP GetStringLength(REFGUID key, UINT32* length) override;
  STDMETHODIMP GetString(REFGUID key, LPWSTR value, UINT32 size, UINT32* length) override;
  STDMETHODIMP GetAllocatedString(REFGUID key, LPWSTR* value, UINT32* length) override;
  STDMETHODIMP GetBlobSize(REFGUID key, UINT32* size) override;
  STDMETHODIMP GetBlob(REFGUID key, UINT8* buffer, UINT32 size, UINT32* blobSize) override;
  STDMETHODIMP GetAllocatedBlob(REFGUID key, UINT8** buffer, UINT32* size) override;
  STDMETHODIMP GetUnknown(REFGUID key, REFIID riid, LPVOID* object) override;
  STDMETHODIMP SetItem(REFGUID key, REFPROPVARIANT value) override;
  STDMETHODIMP DeleteItem(REFGUID key) override;
  STDMETHODIMP DeleteAllItems() override;
  STDMETHODIMP SetUINT32(REFGUID key, UINT32 value) override;
  STDMETHODIMP SetUINT64(REFGUID key, UINT64 value) override;
  STDMETHODIMP SetDouble(REFGUID key, double value) override;
  STDMETHODIMP SetGUID(REFGUID key, REFGUID value) override;
  STDMETHODIMP SetString(REFGUID key, LPCWSTR value) override;
  STDMETHODIMP SetBlob(REFGUID key, const UINT8* buffer, UINT32 size) override;
  STDMETHODIMP SetUnknown(REFGUID key, IUnknown* object) override;
  STDMETHODIMP LockStore() override;
  STDMETHODIMP UnlockStore() override;
  STDMETHODIMP GetCount(UINT32* count) override;
  STDMETHODIMP GetItemByIndex(UINT32 index, GUID* key, PROPVARIANT* value) override;
  STDMETHODIMP CopyAllItems(IMFAttributes* destination) override;

 private:
  Microsoft::WRL::ComPtr<IMFAttributes> attributes_;
  Microsoft::WRL::ComPtr<MediaSource> source_;
};

}  // namespace shymask
