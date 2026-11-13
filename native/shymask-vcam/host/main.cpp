// Shymask virtual camera host (registrar + camera lifetime owner).
//
// Commands:
//   install     per-user COM registration for the media source + data dir ACL
//   uninstall   remove the per-user COM registration
//   run         create and start the session-lifetime virtual camera, keep it
//               alive until stdin closes or a "stop" line is received
//   list        enumerate Media Foundation video capture devices as JSON
//
// The app spawns `run` and talks to it over stdin/stdout. The session lifetime
// means the camera disappears when this process exits or calls Stop/Remove, so
// closing Shymask stops its camera output even if the app crashes.
#include <windows.h>
#include <aclapi.h>
#include <mfapi.h>
#include <mfidl.h>
#include <mfvirtualcamera.h>
#include <sddl.h>

#include <cstdio>
#include <cstdlib>
#include <iostream>
#include <string>
#include <vector>

#include "protocol.h"
#include "logging.h"

#pragma comment(lib, "mfplat.lib")
#pragma comment(lib, "mf.lib")
#pragma comment(lib, "mfsensorgroup.lib")
#pragma comment(lib, "mfuuid.lib")
#pragma comment(lib, "ole32.lib")
#pragma comment(lib, "oleaut32.lib")
#pragma comment(lib, "advapi32.lib")

using namespace shymask;

namespace {

std::string HrText(HRESULT hr) {
  wchar_t buffer[32];
  swprintf_s(buffer, L"0x%08X", static_cast<unsigned>(hr));
  char narrow[32] = {0};
  WideCharToMultiByte(CP_UTF8, 0, buffer, -1, narrow, sizeof(narrow), nullptr, nullptr);
  return narrow;
}

std::string ToUtf8(const std::wstring& text) {
  if (text.empty()) return std::string();
  const int size = WideCharToMultiByte(CP_UTF8, 0, text.c_str(), -1, nullptr, 0, nullptr, nullptr);
  std::string result(static_cast<size_t>(size > 0 ? size - 1 : 0), '\0');
  if (size > 0) {
    WideCharToMultiByte(CP_UTF8, 0, text.c_str(), -1, result.data(), size, nullptr, nullptr);
  }
  return result;
}

/** Escapes a UTF-8 string for inclusion in a JSON string literal. */
std::string JsonEscape(const std::string& text) {
  std::string out;
  out.reserve(text.size() + 8);
  for (const char character : text) {
    switch (character) {
      case '\\':
        out += "\\\\";
        break;
      case '"':
        out += "\\\"";
        break;
      case '\n':
        out += "\\n";
        break;
      case '\r':
        out += "\\r";
        break;
      case '\t':
        out += "\\t";
        break;
      default:
        out += character;
        break;
    }
  }
  return out;
}

void EmitJson(const std::string& json) {
  std::cout << json << std::endl;
}

void EmitError(const char* code, const std::string& message, HRESULT hr = S_OK) {
  std::string json = "{\"event\":\"error\",\"code\":\"";
  json += code;
  json += "\",\"message\":\"";
  json += JsonEscape(message);
  json += "\",\"hresult\":\"";
  json += HrText(hr);
  json += "\"}";
  EmitJson(json);
}

std::wstring SourceDllPath() { return ModuleDirectory() + L"\\" + kShymaskSourceDllName; }

// Grants Local Service and Local System access to the shared data directory so
// the media source can read the port file and write logs when Media Foundation
// hosts it outside the app process.
bool EnsureDataDirectoryAcl(std::string* detail) {
  const std::wstring directory = DataDirectory();
  const DWORD attributes = GetFileAttributesW(directory.c_str());
  if (attributes == INVALID_FILE_ATTRIBUTES) {
    *detail = "data directory could not be created";
    return false;
  }

  PSECURITY_DESCRIPTOR descriptor = nullptr;
  PACL existingDacl = nullptr;
  if (GetNamedSecurityInfoW(directory.c_str(), SE_FILE_OBJECT, DACL_SECURITY_INFORMATION, nullptr,
                            nullptr, &existingDacl, nullptr, &descriptor) != ERROR_SUCCESS) {
    *detail = "could not read the data directory ACL";
    if (descriptor) LocalFree(descriptor);
    return false;
  }

  PSID localService = nullptr;
  PSID localSystem = nullptr;
  ConvertStringSidToSidW(L"S-1-5-19", &localService);
  ConvertStringSidToSidW(L"S-1-5-18", &localSystem);

  EXPLICIT_ACCESSW entries[2] = {};
  entries[0].grfAccessPermissions = GENERIC_ALL;
  entries[0].grfAccessMode = GRANT_ACCESS;
  entries[0].grfInheritance = SUB_CONTAINERS_AND_OBJECTS_INHERIT;
  BuildTrusteeWithSidW(&entries[0].Trustee, localService);
  entries[1].grfAccessPermissions = GENERIC_ALL;
  entries[1].grfAccessMode = GRANT_ACCESS;
  entries[1].grfInheritance = SUB_CONTAINERS_AND_OBJECTS_INHERIT;
  BuildTrusteeWithSidW(&entries[1].Trustee, localSystem);

  PACL updatedDacl = nullptr;
  const DWORD aclStatus = SetEntriesInAclW(2, entries, existingDacl, &updatedDacl);
  bool ok = false;
  if (aclStatus == ERROR_SUCCESS) {
    ok = SetNamedSecurityInfoW(const_cast<LPWSTR>(directory.c_str()), SE_FILE_OBJECT,
                               DACL_SECURITY_INFORMATION, nullptr, nullptr, updatedDacl,
                               nullptr) == ERROR_SUCCESS;
    *detail = ok ? "data directory ACL updated for Local Service and Local System"
                 : "could not apply the data directory ACL";
  } else {
    *detail = "could not build the data directory ACL";
  }
  if (updatedDacl) LocalFree(updatedDacl);
  if (localService) LocalFree(localService);
  if (localSystem) LocalFree(localSystem);
  if (descriptor) LocalFree(descriptor);
  return ok;
}

bool IsElevated() {
  HANDLE token = nullptr;
  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token)) return false;
  TOKEN_ELEVATION elevation{};
  DWORD size = sizeof(elevation);
  const BOOL ok = GetTokenInformation(token, TokenElevation, &elevation, sizeof(elevation), &size);
  CloseHandle(token);
  return ok && elevation.TokenIsElevated != 0;
}

bool WriteComRegistration(HKEY hive, REGSAM access, const wchar_t* scope, std::string* detail) {
  const std::wstring dllPath = SourceDllPath();
  const std::wstring keyPath = std::wstring(L"Software\\Classes\\CLSID\\{5E1D3A6B-2C4F-4A7E-9B8D-0C1F2A3B4C5D}\\InprocServer32");
  HKEY key = nullptr;
  const LSTATUS created =
      RegCreateKeyExW(hive, keyPath.c_str(), 0, nullptr, 0, KEY_WRITE | access, nullptr, &key, nullptr);
  if (created != ERROR_SUCCESS) {
    *detail = "could not create the registration key";
    return false;
  }
  const DWORD bytes = static_cast<DWORD>((dllPath.size() + 1) * sizeof(wchar_t));
  const LSTATUS value = RegSetValueExW(key, nullptr, 0, REG_SZ,
                                       reinterpret_cast<const BYTE*>(dllPath.c_str()), bytes);
  const LSTATUS threading = RegSetValueExW(key, L"ThreadingModel", 0, REG_SZ,
                                           reinterpret_cast<const BYTE*>(L"Both"), sizeof(L"Both"));
  RegCloseKey(key);
  if (value != ERROR_SUCCESS || threading != ERROR_SUCCESS) {
    *detail = "could not write the registration values";
    return false;
  }
  Log(L"install: %s HKCU/HKLM\\%s -> %s", scope, keyPath.c_str(), dllPath.c_str());
  return true;
}

int Install() {
  const std::wstring dllPath = SourceDllPath();
  if (GetFileAttributesW(dllPath.c_str()) == INVALID_FILE_ATTRIBUTES) {
    EmitError("source-missing", "The media source DLL is missing; run npm run build:native.");
    return 2;
  }

  std::string aclDetail;
  const bool elevated = IsElevated();
  const bool aclOk = elevated ? EnsureDataDirectoryAcl(&aclDetail) : true;
  if (!elevated) aclDetail = "not elevated; sharing ACL unchanged";

  std::string userDetail;
  const bool userRegistered = WriteComRegistration(HKEY_CURRENT_USER, 0, L"per-user", &userDetail);
  if (!userRegistered) {
    EmitError("register-failed", "Could not write the per-user COM registration.");
    return 3;
  }

  std::string machineDetail = "requires an elevated shell";
  bool machineRegistered = false;
  if (elevated) {
    machineRegistered = WriteComRegistration(HKEY_LOCAL_MACHINE, KEY_WOW64_64KEY, L"machine", &machineDetail);
  }

  std::string json = "{\"event\":\"installed\",\"perUser\":true,\"machine\":";
  json += machineRegistered ? "true" : "false";
  json += ",\"elevated\":";
  json += elevated ? "true" : "false";
  json += ",\"clsid\":\"{5E1D3A6B-2C4F-4A7E-9B8D-0C1F2A3B4C5D}\",\"dll\":\"";
  json += JsonEscape(ToUtf8(dllPath));
  json += "\",\"dataDirectory\":\"";
  json += JsonEscape(ToUtf8(DataDirectory()));
  json += "\",\"acl\":\"";
  json += aclOk ? "ok" : "failed";
  json += "\",\"aclDetail\":\"";
  json += JsonEscape(aclDetail);
  json += "\",\"machineDetail\":\"";
  json += JsonEscape(machineDetail);
  json += "\"}";
  EmitJson(json);
  return 0;
}

int Uninstall() {
  const std::wstring keyPath = L"Software\\Classes\\CLSID\\{5E1D3A6B-2C4F-4A7E-9B8D-0C1F2A3B4C5D}";
  const LSTATUS userStatus = RegDeleteTreeW(HKEY_CURRENT_USER, keyPath.c_str());
  LSTATUS machineStatus = ERROR_FILE_NOT_FOUND;
  const bool elevated = IsElevated();
  if (elevated) {
    machineStatus = RegDeleteTreeW(HKEY_LOCAL_MACHINE, keyPath.c_str());
  }
  Log(L"uninstall: per-user RegDeleteTree -> %ld, machine -> %ld (elevated=%d)", userStatus,
      machineStatus, elevated ? 1 : 0);
  if (userStatus != ERROR_SUCCESS && userStatus != ERROR_FILE_NOT_FOUND) {
    EmitError("unregister-failed", "Could not remove the per-user COM registration.",
              HRESULT_FROM_WIN32(userStatus));
    return 3;
  }
  std::string json = "{\"event\":\"uninstalled\",\"perUser\":true,\"machine\":";
  json += elevated ? "true" : "false";
  json += ",\"machineDetail\":\"";
  json += elevated ? "machine registration removed" : "not elevated; machine registration not touched";
  json += "\"}";
  EmitJson(json);
  return 0;
}

struct DeviceInfo {
  std::wstring name;
  std::wstring symbolicLink;
};

std::vector<DeviceInfo> EnumerateCameras() {
  std::vector<DeviceInfo> result;
  IMFAttributes* attributes = nullptr;
  if (FAILED(MFCreateAttributes(&attributes, 1))) return result;
  attributes->SetGUID(MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE,
                      MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE_VIDCAP_GUID);
  IMFActivate** devices = nullptr;
  UINT32 count = 0;
  const HRESULT hr = MFEnumDeviceSources(attributes, &devices, &count);
  attributes->Release();
  if (FAILED(hr)) return result;
  for (UINT32 index = 0; index < count; ++index) {
    wchar_t name[512] = L"";
    UINT32 nameLength = 0;
    devices[index]->GetString(MF_DEVSOURCE_ATTRIBUTE_FRIENDLY_NAME, name, ARRAYSIZE(name),
                              &nameLength);
    wchar_t link[1024] = L"";
    UINT32 linkLength = 0;
    devices[index]->GetString(MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE_VIDCAP_SYMBOLIC_LINK, link,
                              ARRAYSIZE(link), &linkLength);
    result.push_back({name, link});
    devices[index]->Release();
  }
  CoTaskMemFree(devices);
  return result;
}

bool IsShymaskCamera(const std::wstring& name) {
  return name.rfind(kShymaskCameraFriendlyNamePrefix, 0) == 0;
}

int List() {
  EmitJson("{\"event\":\"devices\"}");
  for (const DeviceInfo& device : EnumerateCameras()) {
    std::string json = "{\"event\":\"device\",\"name\":\"";
    json += JsonEscape(ToUtf8(device.name));
    json += "\",\"symbolicLink\":\"";
    json += JsonEscape(ToUtf8(device.symbolicLink));
    json += "\",\"shymask\":";
    json += IsShymaskCamera(device.name) ? "true" : "false";
    json += "}";
    EmitJson(json);
  }
  EmitJson("{\"event\":\"devices-end\"}");
  return 0;
}

int RunCamera() {
  // COM/MF must be initialized by the caller in Run().
  IMFVirtualCamera* camera = nullptr;
  HRESULT hr = MFCreateVirtualCamera(
      MFVirtualCameraType_SoftwareCameraSource, MFVirtualCameraLifetime_Session,
      MFVirtualCameraAccess_CurrentUser, kShymaskCameraFriendlyName,
      L"{5E1D3A6B-2C4F-4A7E-9B8D-0C1F2A3B4C5D}", nullptr, 0, &camera);
  Log(L"run: MFCreateVirtualCamera hr=0x%08X", static_cast<unsigned>(hr));
  if (FAILED(hr)) {
    EmitError("create-failed",
              "MFCreateVirtualCamera failed. If the HRESULT is 0x80070005, Windows camera privacy "
              "settings may be blocking camera access; allow camera access and retry.",
              hr);
    return 2;
  }

  hr = camera->Start(nullptr);
  Log(L"run: IMFVirtualCamera::Start hr=0x%08X", static_cast<unsigned>(hr));
  if (FAILED(hr)) {
    camera->Shutdown();
    camera->Release();
    wchar_t errorText[512] = L"";
    FormatMessageW(FORMAT_MESSAGE_FROM_SYSTEM | FORMAT_MESSAGE_IGNORE_INSERTS, nullptr, hr, 0, errorText,
                   ARRAYSIZE(errorText), nullptr);
    Log(L"run: Start failed message=%s", errorText);
    EmitError("start-failed",
              "Windows could not initialize the virtual camera. The Media Foundation frame server "
              "runs as Local Service and activates the camera media source itself, so a per-user "
              "(HKCU) COM registration is not visible to it and an elevated, machine-wide (HKLM) "
              "registration is required. Run `npm run vcam:install` once from an elevated prompt, "
              "then retry.",
              hr);
    return 3;
  }

  bool enumerable = false;
  for (int attempt = 0; attempt < 10 && !enumerable; ++attempt) {
    for (const DeviceInfo& device : EnumerateCameras()) {
      if (IsShymaskCamera(device.name)) enumerable = true;
    }
    if (!enumerable) Sleep(100);
  }

  {
    std::string json = "{\"event\":\"camera-started\",\"friendlyName\":\"";
    json += JsonEscape(ToUtf8(kShymaskCameraFriendlyName));
    json += "\",\"sourceId\":\"{5E1D3A6B-2C4F-4A7E-9B8D-0C1F2A3B4C5D}\",\"lifetime\":\"session\",\"scope\":\"current-user\",\"enumerable\":";
    json += enumerable ? "true" : "false";
    json += "}";
    EmitJson(json);
  }

  std::string line;
  while (std::getline(std::cin, line)) {
    if (line == "stop") break;
  }

  Log(L"run: stopping the virtual camera");
  camera->Stop();
  const HRESULT removeHr = camera->Remove();
  Log(L"run: Remove hr=0x%08X", static_cast<unsigned>(removeHr));
  camera->Shutdown();
  camera->Release();
  EmitJson("{\"event\":\"camera-stopped\"}");
  return 0;
}

}  // namespace

int wmain(int argc, wchar_t** argv) {
  LogInit(L"host");
  const std::wstring command = argc > 1 ? argv[1] : L"list";
  if (command == L"install") return Install();
  if (command == L"uninstall") return Uninstall();
  if (command == L"list") {
    CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    MFStartup(MF_VERSION, MFSTARTUP_FULL);
    const int result = List();
    MFShutdown();
    CoUninitialize();
    return result;
  }
  if (command == L"run") {
    const HRESULT comHr = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    Log(L"run: CoInitializeEx hr=0x%08X", static_cast<unsigned>(comHr));
    const HRESULT mfHr = MFStartup(MF_VERSION, MFSTARTUP_FULL);
    Log(L"run: MFStartup hr=0x%08X", static_cast<unsigned>(mfHr));
    if (FAILED(mfHr)) {
      EmitError("mfstartup-failed", "Media Foundation could not be initialized.", mfHr);
      return 2;
    }
    const int result = RunCamera();
    MFShutdown();
    CoUninitialize();
    return result;
  }

  std::printf("usage: shymask-vcam-host.exe <install|uninstall|list|run>\n");
  return 1;
}




