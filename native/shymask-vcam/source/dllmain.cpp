// COM in-proc server for the Shymask Windows virtual camera media source.
//
// Registration is per user (HKCU\Software\Classes\CLSID\{...}\InprocServer32) so
// a standard Windows account can install it without administrator rights. The
// camera itself is created by shymask-vcam-host.exe with session lifetime.

#include "activator.h"
#include "logging.h"
#include "protocol.h"

#include <windows.h>
#include <mfapi.h>

#include <new>
#include <string>

using Microsoft::WRL::ComPtr;

namespace {

HMODULE g_module = nullptr;
LONG g_lockCount = 0;

constexpr wchar_t kClsidKey[] = L"Software\\Classes\\CLSID";
const wchar_t* kClsidString = L"{5E1D3A6B-2C4F-4A7E-9B8D-0C1F2A3B4C5D}";

std::wstring ClsidKeyPath() {
  std::wstring path = kClsidKey;
  path += L"\\";
  path += kClsidString;
  return path;
}

}  // namespace

class ClassFactory final : public IClassFactory {
 public:
  STDMETHODIMP QueryInterface(REFIID riid, void** object) override {
    if (!object) return E_POINTER;
    *object = nullptr;
    if (riid == __uuidof(IUnknown) || riid == __uuidof(IClassFactory)) {
      *object = static_cast<IClassFactory*>(this);
      AddRef();
      return S_OK;
    }
    return E_NOINTERFACE;
  }
  STDMETHODIMP_(ULONG) AddRef() override { return InterlockedIncrement(&references_); }
  STDMETHODIMP_(ULONG) Release() override {
    const ULONG references = InterlockedDecrement(&references_);
    if (references == 0) delete this;
    return references;
  }
  STDMETHODIMP CreateInstance(IUnknown* outer, REFIID riid, void** object) override {
    if (!object) return E_POINTER;
    *object = nullptr;
    if (outer) return CLASS_E_NOAGGREGATION;
    shymask::Log(L"ClassFactory::CreateInstance (pid=%lu)", GetCurrentProcessId());
    auto activator = Microsoft::WRL::Make<shymask::Activator>();
    if (!activator) return E_OUTOFMEMORY;
    const HRESULT hr = activator->Initialize();
    if (FAILED(hr)) return hr;
    return activator->QueryInterface(riid, object);
  }
  STDMETHODIMP LockServer(BOOL lock) override {
    if (lock) {
      InterlockedIncrement(&g_lockCount);
    } else {
      InterlockedDecrement(&g_lockCount);
    }
    return S_OK;
  }

 private:
  ~ClassFactory() = default;
  LONG references_ = 1;
};

STDAPI DllGetClassObject(REFCLSID clsid, REFIID riid, LPVOID* object) {
  if (!object) return E_POINTER;
  *object = nullptr;
  if (clsid != kShymaskCameraSourceClsid) return CLASS_E_CLASSNOTAVAILABLE;
  auto* factory = new (std::nothrow) ClassFactory();
  if (!factory) return E_OUTOFMEMORY;
  const HRESULT hr = factory->QueryInterface(riid, object);
  factory->Release();
  return hr;
}

STDAPI DllCanUnloadNow() { return g_lockCount == 0 ? S_OK : S_FALSE; }

STDAPI DllRegisterServer() {
  const std::wstring keyPath = ClsidKeyPath() + L"\\InprocServer32";
  HKEY key = nullptr;
  const LSTATUS created = RegCreateKeyExW(HKEY_CURRENT_USER, keyPath.c_str(), 0, nullptr, 0, KEY_WRITE,
                                          nullptr, &key, nullptr);
  if (created != ERROR_SUCCESS) return HRESULT_FROM_WIN32(created);

  const std::wstring dllPath = shymask::ModuleFileName();
  const DWORD bytes = static_cast<DWORD>((dllPath.size() + 1) * sizeof(wchar_t));
  const LSTATUS value = RegSetValueExW(key, nullptr, 0, REG_SZ,
                                       reinterpret_cast<const BYTE*>(dllPath.c_str()), bytes);
  const LSTATUS threading =
      RegSetValueExW(key, L"ThreadingModel", 0, REG_SZ,
                     reinterpret_cast<const BYTE*>(L"Both"), sizeof(L"Both"));
  RegCloseKey(key);
  if (value != ERROR_SUCCESS) return HRESULT_FROM_WIN32(value);
  if (threading != ERROR_SUCCESS) return HRESULT_FROM_WIN32(threading);
  shymask::Log(L"DllRegisterServer HKCU\\%s -> %s", keyPath.c_str(), dllPath.c_str());
  return S_OK;
}

STDAPI DllUnregisterServer() {
  const std::wstring keyPath = ClsidKeyPath();
  const LSTATUS status = RegDeleteTreeW(HKEY_CURRENT_USER, keyPath.c_str());
  shymask::Log(L"DllUnregisterServer HKCU\\%s -> %ld", keyPath.c_str(), status);
  return status == ERROR_SUCCESS || status == ERROR_FILE_NOT_FOUND ? S_OK
                                                                  : HRESULT_FROM_WIN32(status);
}

BOOL APIENTRY DllMain(HMODULE module, DWORD reason, LPVOID) {
  if (reason == DLL_PROCESS_ATTACH) {
    g_module = module;
    DisableThreadLibraryCalls(module);
    shymask::LogInit(L"source");
    shymask::Log(L"DllMain process attach: pid=%lu module=%s", GetCurrentProcessId(),
                 shymask::ModuleFileName().c_str());
  } else if (reason == DLL_PROCESS_DETACH) {
    shymask::Log(L"DllMain process detach: pid=%lu", GetCurrentProcessId());
  }
  return TRUE;
}


