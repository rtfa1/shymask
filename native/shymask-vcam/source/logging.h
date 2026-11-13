// Minimal file logger for the native virtual camera components.
//
// Media Foundation can host the camera media source in a process the app does
// not own (the Windows Frame Server), so returning errors only to the app is not
// enough to diagnose activation problems. Logs are appended to
// %ProgramData%\Shymask\vcam.log, which the installer makes readable/writable
// for Local Service and Local System.
#pragma once

#include <string>

namespace shymask {

// Sets the component tag written at the start of every line. Safe to call once.
void LogInit(const wchar_t* component);
void Log(const wchar_t* format, ...);
std::wstring DataDirectory();
std::wstring LogFilePath();
std::wstring PortFilePath();
std::wstring ModuleDirectory();
std::wstring ModuleFileName();

}  // namespace shymask
