// Shared constants and wire format for the Shymask Windows virtual camera.
//
// This header is included by the COM media source (which runs inside whatever
// process Media Foundation asks to host it), the virtual camera host/registrar,
// and the independent camera consumer. It deliberately contains no Windows
// camera API usage: the portable frame-processing side of Shymask only produces
// RGBA frames and never touches Media Foundation.
#pragma once

#include <guiddef.h>
#include <cstdint>

// CLSID of the in-proc COM media source. Per-user registration (HKCU) is used
// by default; see docs/notes/0002-windows-virtual-camera.md for the exact
// requirements the OS places on this registration.
// {5E1D3A6B-2C4F-4A7E-9B8D-0C1F2A3B4C5D}
inline constexpr GUID kShymaskCameraSourceClsid = {
    0x5e1d3a6b, 0x2c4f, 0x4a7e, {0x9b, 0x8d, 0x0c, 0x1f, 0x2a, 0x3b, 0x4c, 0x5d}};

// KSCATEGORY / PINNAME_VIDEO_CAPTURE {FB6C4281-0353-11d1-905F-0000F80047FA}. It is
// declared by ksmedia.h through DEFINE_GUIDSTRUCT, so the value is repeated here
// instead of depending on an INITGUID translation unit.
inline constexpr GUID kPinCategoryVideoCapture = {
    0xfb6c4281, 0x0353, 0x11d1, {0x90, 0x5f, 0x00, 0x00, 0xf8, 0x00, 0x47, 0xfa}};

// The friendly name passed to MFCreateVirtualCamera. Windows appends its own
// "Windows Virtual Camera" suffix when the device is enumerated, so consumers
// match on this prefix rather than on exact equality.
inline constexpr wchar_t kShymaskCameraFriendlyName[] = L"Shymask Camera";
inline constexpr wchar_t kShymaskCameraFriendlyNamePrefix[] = L"Shymask Camera";

inline constexpr uint32_t kShymaskFrameWidth = 1280;
inline constexpr uint32_t kShymaskFrameHeight = 720;
inline constexpr uint32_t kShymaskFrameBytes = kShymaskFrameWidth * kShymaskFrameHeight * 4;
inline constexpr uint32_t kShymaskFrameRateNumerator = 30;
inline constexpr uint32_t kShymaskFrameRateDenominator = 1;
inline constexpr int64_t kShymaskFrameDuration100ns = 333333;

// Port discovery: the app writes the listening port to this world-readable file
// (the media source may run as a service account, so it cannot read the user's
// HKCU). The fixed range is a fallback when the file is missing.
inline constexpr wchar_t kShymaskPortFilePath[] = L"Shymask\\vcam-port";
inline constexpr uint16_t kShymaskPortRangeFirst = 48010;
inline constexpr uint16_t kShymaskPortRangeLast = 48019;

// Application data directory (created by `npm run vcam:install`, ACL-adjusted
// so Local Service / Local System can read the port file and write logs).
inline constexpr wchar_t kShymaskDataDirectory[] = L"Shymask";

// Internal frame wire format, little-endian:
//   uint32 magic ('SHYM')
//   uint16 version (1)
//   uint16 flags (reserved, 0)
//   uint32 width
//   uint32 height
//   uint32 strideBytes
//   uint32 payloadBytes
//   uint64 captureUnixMs
//   uint64 sequence
// followed by strideBytes * height bytes of RGBA (row major, top-down).
inline constexpr uint32_t kShymaskFrameMagic = 0x4d594853;  // 'S','H','Y','M' little-endian
inline constexpr uint16_t kShymaskFrameVersion = 1;
inline constexpr uint32_t kShymaskFrameHeaderBytes = 40;

// Custom per-sample attribute carrying the wall-clock capture time of the
// canvas frame the sample was made from, so a consumer can measure the
// replay-to-consumer transit time on the same machine.
// {6B0A2F1C-9D34-4E58-8A7B-1C2D3E4F5A60}
inline constexpr GUID kShymaskSampleAttributeCaptureUnixMs = {
    0x6b0a2f1c, 0x9d34, 0x4e58, {0x8a, 0x7b, 0x1c, 0x2d, 0x3e, 0x4f, 0x5a, 0x60}};

// Custom per-sample attribute carrying the producer's frame sequence from the
// wire header (0 for native paused fallback samples). Several 30 Hz samples can
// reuse one app frame, so the sequence identifies the source frame a sample was
// made from without assuming one new frame per sample.
// {7C4E1B2A-5D6F-4A83-9E0C-2B4D6F8A1C35}
inline constexpr GUID kShymaskSampleAttributeSequence = {
    0x7c4e1b2a, 0x5d6f, 0x4a83, {0x9e, 0x0c, 0x2b, 0x4d, 0x6f, 0x8a, 0x1c, 0x35}};

// File names of the native binaries.
inline constexpr wchar_t kShymaskSourceDllName[] = L"ShymaskVirtualCamera.dll";
inline constexpr wchar_t kShymaskHostExeName[] = L"shymask-vcam-host.exe";
inline constexpr wchar_t kShymaskConsumerExeName[] = L"shymask-camera-consumer.exe";

