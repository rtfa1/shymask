#include "logging.h"

#include <windows.h>
#include <shlobj.h>

#include <cstdarg>
#include <cstdio>
#include <cwchar>
#include <mutex>
#include <string>

namespace shymask {
namespace {

std::mutex g_logMutex;
std::wstring g_component = L"vcam";

std::wstring Join(const std::wstring& left, const wchar_t* right) {
  if (left.empty()) return right;
  std::wstring result = left;
  if (result.back() != L'\\') result.push_back(L'\\');
  result.append(right);
  return result;
}

}  // namespace

std::wstring DataDirectory() {
  wchar_t programData[MAX_PATH] = L"";
  std::wstring base = L"C:\\ProgramData";
  if (SUCCEEDED(SHGetFolderPathW(nullptr, CSIDL_COMMON_APPDATA, nullptr, 0, programData))) {
    base = programData;
  }
  const std::wstring directory = Join(base, L"Shymask");
  CreateDirectoryW(directory.c_str(), nullptr);
  return directory;
}

std::wstring LogFilePath() { return Join(DataDirectory(), L"vcam.log"); }

std::wstring PortFilePath() { return Join(DataDirectory(), L"vcam-port"); }

std::wstring ModuleFileName() {
  wchar_t path[4096] = L"";
  GetModuleFileNameW(nullptr, path, ARRAYSIZE(path));
  return path;
}

std::wstring ModuleDirectory() {
  std::wstring path = ModuleFileName();
  const auto slash = path.find_last_of(L"\\/");
  return slash == std::wstring::npos ? std::wstring() : path.substr(0, slash);
}

void LogInit(const wchar_t* component) {
  std::lock_guard<std::mutex> guard(g_logMutex);
  g_component = component;
}

void Log(const wchar_t* format, ...) {
  wchar_t message[4096];
  va_list args;
  va_start(args, format);
  vswprintf_s(message, format, args);
  va_end(args);

  SYSTEMTIME now;
  GetLocalTime(&now);

  wchar_t line[4600];
  {
    std::lock_guard<std::mutex> guard(g_logMutex);
    swprintf_s(line, L"%04u-%02u-%02uT%02u:%02u:%02u.%03u pid=%lu tid=%lu [%s] %s\r\n", now.wYear,
               now.wMonth, now.wDay, now.wHour, now.wMinute, now.wSecond, now.wMilliseconds,
               GetCurrentProcessId(), GetCurrentThreadId(), g_component.c_str(), message);
    const int utf8Bytes =
        WideCharToMultiByte(CP_UTF8, 0, line, -1, nullptr, 0, nullptr, nullptr);
    std::string utf8(static_cast<size_t>(utf8Bytes > 0 ? utf8Bytes - 1 : 0), '\0');
    if (utf8Bytes > 0) {
      WideCharToMultiByte(CP_UTF8, 0, line, -1, utf8.data(), utf8Bytes, nullptr, nullptr);
    }
    const std::wstring path = LogFilePath();
    HANDLE file = CreateFileW(path.c_str(), FILE_APPEND_DATA, FILE_SHARE_READ | FILE_SHARE_WRITE,
                              nullptr, OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (file == INVALID_HANDLE_VALUE) return;
    DWORD written = 0;
    WriteFile(file, utf8.data(), static_cast<DWORD>(utf8.size()), &written, nullptr);
    CloseHandle(file);
  }
}

}  // namespace shymask
