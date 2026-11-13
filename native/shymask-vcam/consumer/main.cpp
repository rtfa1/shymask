// Independent camera consumer harness for the Shymask virtual camera.
//
// This process is deliberately separate from the Shymask app: it enumerates the
// public Windows camera device list through Media Foundation, activates the
// Shymask Camera source, reads RGB32 samples through the Source Reader, writes
// PNG evidence, and reports pixel/timing statistics as JSON lines. It is the
// external consumer used by `npm run check`.
#include <windows.h>
#include <wrl/client.h>
#include <mfapi.h>
#include <mfidl.h>
#include <mfreadwrite.h>
#include <wincodec.h>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <mutex>
#include <string>
#include <thread>
#include <utility>
#include <vector>

#include "protocol.h"

#pragma comment(lib, "mfplat.lib")
#pragma comment(lib, "mfreadwrite.lib")
#pragma comment(lib, "mf.lib")
#pragma comment(lib, "mfuuid.lib")
#pragma comment(lib, "ole32.lib")
#pragma comment(lib, "oleaut32.lib")
#pragma comment(lib, "windowscodecs.lib")
#pragma comment(lib, "shlwapi.lib")

using Microsoft::WRL::ComPtr;

namespace {

struct Options {
  std::wstring devicePrefix = kShymaskCameraFriendlyNamePrefix;
  std::wstring outDirectory;
  std::wstring prefix = L"frame";
  int frames = 5;
  int timeoutMs = 8000;
  int maxPngs = 3;
  bool listOnly = false;
  bool probe = false;
  bool nativeType = false;
};

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

std::mutex g_emitMutex;

void Emit(const std::string& json) {
  std::lock_guard<std::mutex> guard(g_emitMutex);
  std::printf("%s\n", json.c_str());
  std::fflush(stdout);
}

void EmitDeviceList() {
  IMFAttributes* attributes = nullptr;
  if (FAILED(MFCreateAttributes(&attributes, 1))) return;
  attributes->SetGUID(MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE,
                      MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE_VIDCAP_GUID);
  IMFActivate** devices = nullptr;
  UINT32 count = 0;
  const HRESULT hr = MFEnumDeviceSources(attributes, &devices, &count);
  attributes->Release();
  if (FAILED(hr)) {
    Emit("{\"event\":\"enumeration-failed\"}");
    return;
  }
  Emit("{\"event\":\"enumeration\",\"count\":" + std::to_string(count) + "}");
  for (UINT32 index = 0; index < count; ++index) {
    wchar_t name[512] = L"";
    UINT32 nameLength = 0;
    devices[index]->GetString(MF_DEVSOURCE_ATTRIBUTE_FRIENDLY_NAME, name, ARRAYSIZE(name),
                              &nameLength);
    wchar_t link[1024] = L"";
    UINT32 linkLength = 0;
    devices[index]->GetString(MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE_VIDCAP_SYMBOLIC_LINK, link,
                              ARRAYSIZE(link), &linkLength);
    std::string json = "{\"event\":\"device\",\"name\":\"";
    json += JsonEscape(ToUtf8(name));
    json += "\",\"symbolicLink\":\"";
    json += JsonEscape(ToUtf8(link));
    json += "\"}";
    Emit(json);
    devices[index]->Release();
  }
  CoTaskMemFree(devices);
}

bool WritePng(const std::wstring& filePath, int width, int height, int stride, const BYTE* pixels) {
  ComPtr<IWICImagingFactory> factory;
  HRESULT hr = CoCreateInstance(CLSID_WICImagingFactory, nullptr, CLSCTX_INPROC_SERVER,
                                IID_PPV_ARGS(&factory));
  if (FAILED(hr)) return false;

  ComPtr<IWICStream> stream;
  hr = factory->CreateStream(&stream);
  if (FAILED(hr)) return false;
  hr = stream->InitializeFromFilename(filePath.c_str(), GENERIC_WRITE);
  if (FAILED(hr)) return false;

  ComPtr<IWICBitmapEncoder> encoder;
  hr = factory->CreateEncoder(GUID_ContainerFormatPng, nullptr, &encoder);
  if (FAILED(hr)) return false;
  hr = encoder->Initialize(stream.Get(), WICBitmapEncoderNoCache);
  if (FAILED(hr)) return false;

  ComPtr<IWICBitmapFrameEncode> frame;
  ComPtr<IPropertyBag2> properties;
  hr = encoder->CreateNewFrame(&frame, &properties);
  if (FAILED(hr)) return false;
  hr = frame->Initialize(properties.Get());
  if (FAILED(hr)) return false;
  frame->SetSize(static_cast<UINT>(width), static_cast<UINT>(height));
  WICPixelFormatGUID format = GUID_WICPixelFormat32bppBGRA;
  frame->SetPixelFormat(&format);
  hr = frame->WritePixels(static_cast<UINT>(height), static_cast<UINT>(stride),
                          static_cast<UINT>(stride * height), const_cast<BYTE*>(pixels));
  if (FAILED(hr)) return false;
  hr = frame->Commit();
  if (FAILED(hr)) return false;
  hr = encoder->Commit();
  return SUCCEEDED(hr);
}

void ComputeMeanRgb(const BYTE* bgra, int width, int height, int stride, int* red, int* green,
                    int* blue) {
  uint64_t sumR = 0;
  uint64_t sumG = 0;
  uint64_t sumB = 0;
  uint64_t count = 0;
  for (int y = 0; y < height; y += 2) {
    const BYTE* row = bgra + static_cast<size_t>(y) * stride;
    for (int x = 0; x < width; x += 2) {
      const BYTE* pixel = row + static_cast<size_t>(x) * 4;
      sumB += pixel[0];
      sumG += pixel[1];
      sumR += pixel[2];
      ++count;
    }
  }
  *red = count ? static_cast<int>(sumR / count) : 0;
  *green = count ? static_cast<int>(sumG / count) : 0;
  *blue = count ? static_cast<int>(sumB / count) : 0;
}

uint64_t NowUnixMs() {
  FILETIME fileTime;
  GetSystemTimeAsFileTime(&fileTime);
  ULARGE_INTEGER value;
  value.LowPart = fileTime.dwLowDateTime;
  value.HighPart = fileTime.dwHighDateTime;
  return value.QuadPart / 10000ull - 11644473600000ull;
}

bool ParseInt(const wchar_t* text, int* value) {
  wchar_t* end = nullptr;
  const long parsed = wcstol(text, &end, 10);
  if (!end || *end != L'\0') return false;
  *value = static_cast<int>(parsed);
  return true;
}

Options ParseOptions(int argc, wchar_t** argv) {
  Options options;
  for (int index = 1; index < argc; ++index) {
    const std::wstring argument = argv[index];
    auto next = [&](const wchar_t* name) -> const wchar_t* {
      if (index + 1 >= argc) {
        std::fprintf(stderr, "missing value for %ls\n", name);
        std::exit(1);
      }
      return argv[++index];
    };
    if (argument == L"--device") options.devicePrefix = next(L"--device");
    else if (argument == L"--out") options.outDirectory = next(L"--out");
    else if (argument == L"--prefix") options.prefix = next(L"--prefix");
    else if (argument == L"--frames") ParseInt(next(L"--frames"), &options.frames);
    else if (argument == L"--timeout-ms") ParseInt(next(L"--timeout-ms"), &options.timeoutMs);
    else if (argument == L"--max-pngs") ParseInt(next(L"--max-pngs"), &options.maxPngs);
    else if (argument == L"--list") options.listOnly = true;
    else if (argument == L"--probe") options.probe = true;
    else if (argument == L"--native") options.nativeType = true;
  }
  return options;
}

/** A frame held in memory until the consumer knows which PNGs to keep. */
struct PngCandidate {
  int index = 0;
  int width = 0;
  int height = 0;
  int stride = 0;
  uint64_t captureUnixMs = 0;
  int meanR = 0;
  int meanG = 0;
  int meanB = 0;
  std::vector<BYTE> pixels;
};

ComPtr<IMFMediaType> CreateRgb32Type(UINT32 width, UINT32 height) {
  ComPtr<IMFMediaType> type;
  if (FAILED(MFCreateMediaType(&type))) return nullptr;
  type->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Video);
  type->SetGUID(MF_MT_SUBTYPE, MFVideoFormat_RGB32);
  MFSetAttributeSize(type.Get(), MF_MT_FRAME_SIZE, width, height);
  MFSetAttributeRatio(type.Get(), MF_MT_FRAME_RATE, kShymaskFrameRateNumerator,
                      kShymaskFrameRateDenominator);
  type->SetUINT32(MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive);
  type->SetUINT32(MF_MT_DEFAULT_STRIDE, width * 4);
  MFSetAttributeRatio(type.Get(), MF_MT_PIXEL_ASPECT_RATIO, 1, 1);
  return type;
}

int Capture(const Options& options) {
  IMFAttributes* enumeratorAttributes = nullptr;
  if (FAILED(MFCreateAttributes(&enumeratorAttributes, 1))) return 4;
  enumeratorAttributes->SetGUID(MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE,
                                MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE_VIDCAP_GUID);
  IMFActivate** devices = nullptr;
  UINT32 count = 0;
  HRESULT hr = MFEnumDeviceSources(enumeratorAttributes, &devices, &count);
  enumeratorAttributes->Release();
  if (FAILED(hr) || count == 0) {
    Emit("{\"event\":\"error\",\"code\":\"no-devices\"}");
    return 2;
  }

  IMFActivate* selected = nullptr;
  for (UINT32 index = 0; index < count; ++index) {
    wchar_t name[512] = L"";
    UINT32 nameLength = 0;
    devices[index]->GetString(MF_DEVSOURCE_ATTRIBUTE_FRIENDLY_NAME, name, ARRAYSIZE(name),
                              &nameLength);
    const std::wstring deviceName = name;
    if (!selected && deviceName.rfind(options.devicePrefix, 0) == 0) {
      selected = devices[index];
      selected->AddRef();
      std::string json = "{\"event\":\"selected\",\"name\":\"";
      json += JsonEscape(ToUtf8(deviceName));
      json += "\"}";
      Emit(json);
    }
    devices[index]->Release();
  }
  CoTaskMemFree(devices);

  if (!selected) {
    Emit("{\"event\":\"error\",\"code\":\"device-not-found\",\"prefix\":\"" +
         JsonEscape(ToUtf8(options.devicePrefix)) + "\"}");
    return 2;
  }

  ComPtr<IMFMediaSource> source;
  hr = selected->ActivateObject(IID_PPV_ARGS(&source));
  selected->Release();
  if (FAILED(hr)) {
    char buffer[160];
    std::snprintf(buffer, sizeof(buffer),
                  "{\"event\":\"error\",\"code\":\"activate-failed\",\"hresult\":\"0x%08X\"}",
                  static_cast<unsigned>(hr));
    Emit(buffer);
    return 4;
  }

  ComPtr<IMFSourceReader> reader;
  hr = MFCreateSourceReaderFromMediaSource(source.Get(), nullptr, &reader);
  if (FAILED(hr)) {
    char buffer[160];
    std::snprintf(buffer, sizeof(buffer),
                  "{\"event\":\"error\",\"code\":\"reader-failed\",\"hresult\":\"0x%08X\"}",
                  static_cast<unsigned>(hr));
    Emit(buffer);
    return 4;
  }

  if (options.probe) {
    ComPtr<IMFPresentationDescriptor> descriptor;
    if (SUCCEEDED(source->CreatePresentationDescriptor(&descriptor))) {
      DWORD streamCount = 0;
      descriptor->GetStreamDescriptorCount(&streamCount);
      BOOL selected = FALSE;
      ComPtr<IMFStreamDescriptor> streamDescriptor;
      descriptor->GetStreamDescriptorByIndex(0, &selected, &streamDescriptor);
      Emit("{\"event\":\"probe-presentation\",\"streams\":" + std::to_string(streamCount) +
           ",\"selected\":" + (selected ? "true" : "false") + "}");
      ComPtr<IMFMediaTypeHandler> handler;
      if (streamDescriptor && SUCCEEDED(streamDescriptor->GetMediaTypeHandler(&handler))) {
        DWORD typeCount = 0;
        handler->GetMediaTypeCount(&typeCount);
        for (DWORD index = 0; index < typeCount; ++index) {
          ComPtr<IMFMediaType> type;
          if (FAILED(handler->GetMediaTypeByIndex(index, &type))) continue;
          GUID subtype = GUID_NULL;
          type->GetGUID(MF_MT_SUBTYPE, &subtype);
          UINT32 typeWidth = 0;
          UINT32 typeHeight = 0;
          MFGetAttributeSize(type.Get(), MF_MT_FRAME_SIZE, &typeWidth, &typeHeight);
          wchar_t subtypeText[64] = L"";
          StringFromGUID2(subtype, subtypeText, ARRAYSIZE(subtypeText));
          Emit("{\"event\":\"probe-type\",\"index\":" + std::to_string(index) +
               ",\"subtype\":\"" + ToUtf8(subtypeText) + "\",\"width\":" +
               std::to_string(typeWidth) + ",\"height\":" + std::to_string(typeHeight) + "}");
        }
      }
    }
  }

  ComPtr<IMFMediaType> requested = CreateRgb32Type(kShymaskFrameWidth, kShymaskFrameHeight);
  if (!options.nativeType) {
    hr = reader->SetCurrentMediaType(MF_SOURCE_READER_FIRST_VIDEO_STREAM, nullptr, requested.Get());
    if (FAILED(hr)) {
      char buffer[160];
      std::snprintf(buffer, sizeof(buffer),
                    "{\"event\":\"error\",\"code\":\"set-media-type-failed\",\"hresult\":\"0x%08X\"}",
                    static_cast<unsigned>(hr));
      Emit(buffer);
      return 4;
    }
  }

  ComPtr<IMFMediaType> currentType;
  reader->GetCurrentMediaType(MF_SOURCE_READER_FIRST_VIDEO_STREAM, &currentType);
  UINT32 width = kShymaskFrameWidth;
  UINT32 height = kShymaskFrameHeight;
  GUID currentSubtype = GUID_NULL;
  if (currentType) {
    MFGetAttributeSize(currentType.Get(), MF_MT_FRAME_SIZE, &width, &height);
    currentType->GetGUID(MF_MT_SUBTYPE, &currentSubtype);
  }
  const bool isNv12 = currentSubtype == MFVideoFormat_NV12;
  Emit("{\"event\":\"media-type\",\"width\":" + std::to_string(width) +
       ",\"height\":" + std::to_string(height) + ",\"format\":\"" +
       (isNv12 ? "NV12" : currentSubtype == MFVideoFormat_RGB32 ? "RGB32" : "other") + "\"}");

  const uint64_t startedAtMs = NowUnixMs();
  std::vector<double> intervals;
  int frames = 0;
  // PNG evidence prefers app-published frames (captureUnixMs > 0). The native
  // paused fallback is only kept when the whole run produced no app frame, so
  // a processed state can never be evidenced by a pre-connection fallback.
  std::vector<PngCandidate> appPngCandidates;
  std::vector<PngCandidate> fallbackPngCandidates;
  int64_t previousCaptureMs = -1;
  uint64_t lastSampleTime = 0;
  HRESULT lastError = S_OK;

  // IMFSourceReader::ReadSample can block forever when the frame server never
  // delivers a sample, so the harness enforces a hard wall-clock budget and
  // exits with a machine-readable timeout event instead of hanging.
  std::atomic<int> framesObserved{0};
  std::atomic<bool> finished{false};
  std::thread watchdog([&] {
    const uint64_t watchdogStart = NowUnixMs();
    while (!finished.load()) {
      std::this_thread::sleep_for(std::chrono::milliseconds(100));
      if (NowUnixMs() - watchdogStart > static_cast<uint64_t>(options.timeoutMs)) {
        Emit("{\"event\":\"timeout\",\"phase\":\"read-sample\",\"frames\":" +
             std::to_string(framesObserved.load()) + "}");
        std::_Exit(3);
      }
    }
  });

  while (frames < options.frames) {
    DWORD streamIndex = 0;
    DWORD flags = 0;
    LONGLONG timestamp = 0;
    ComPtr<IMFSample> sample;
    hr = reader->ReadSample(MF_SOURCE_READER_FIRST_VIDEO_STREAM, 0, &streamIndex, &flags, &timestamp,
                            &sample);
    if (FAILED(hr)) {
      lastError = hr;
      char buffer[200];
      std::snprintf(buffer, sizeof(buffer),
                    "{\"event\":\"read-failed\",\"hresult\":\"0x%08X\",\"afterMs\":%llu}",
                    static_cast<unsigned>(hr),
                    static_cast<unsigned long long>(NowUnixMs() - startedAtMs));
      Emit(buffer);
      break;
    }
    if (flags & MF_SOURCE_READERF_ENDOFSTREAM) {
      Emit("{\"event\":\"stream-end\"}");
      break;
    }
    if (flags & MF_SOURCE_READERF_STREAMTICK) continue;
    if (!sample) continue;
    if (NowUnixMs() - startedAtMs > static_cast<uint64_t>(options.timeoutMs)) {
      Emit("{\"event\":\"timeout\",\"frames\":" + std::to_string(frames) + "}");
      lastError = static_cast<HRESULT>(0x8000000B);
      break;
    }

    ComPtr<IMFMediaBuffer> buffer;
    hr = sample->ConvertToContiguousBuffer(&buffer);
    if (FAILED(hr)) {
      lastError = hr;
      continue;
    }
    BYTE* pixels = nullptr;
    DWORD maxLength = 0;
    DWORD currentLength = 0;
    hr = buffer->Lock(&pixels, &maxLength, &currentLength);
    if (FAILED(hr)) {
      lastError = hr;
      continue;
    }

    const int stride = static_cast<int>(width) * 4;
    int meanR = 0;
    int meanG = 0;
    int meanB = 0;
    ComputeMeanRgb(pixels, static_cast<int>(width), static_cast<int>(height), stride, &meanR,
                   &meanG, &meanB);

    uint64_t captureUnixMs = 0;
    sample->GetUINT64(kShymaskSampleAttributeCaptureUnixMs, &captureUnixMs);
    const uint64_t receivedUnixMs = NowUnixMs();
    const int64_t latencyMs = captureUnixMs != 0 ? static_cast<int64_t>(receivedUnixMs) -
                                                       static_cast<int64_t>(captureUnixMs)
                                                 : -1;
    if (previousCaptureMs >= 0 && latencyMs >= 0) {
      const double interval = static_cast<double>(receivedUnixMs - previousCaptureMs);
      intervals.push_back(interval);
    }
    previousCaptureMs = static_cast<int64_t>(receivedUnixMs);

    if (!options.outDirectory.empty() && options.maxPngs > 0) {
      std::vector<PngCandidate>* target = nullptr;
      if (captureUnixMs > 0) {
        if (static_cast<int>(appPngCandidates.size()) < options.maxPngs) {
          target = &appPngCandidates;
        }
      } else if (static_cast<int>(fallbackPngCandidates.size()) < options.maxPngs) {
        target = &fallbackPngCandidates;
      }
      if (target) {
        PngCandidate candidate;
        candidate.index = frames;
        candidate.width = static_cast<int>(width);
        candidate.height = static_cast<int>(height);
        candidate.stride = stride;
        candidate.captureUnixMs = captureUnixMs;
        candidate.meanR = meanR;
        candidate.meanG = meanG;
        candidate.meanB = meanB;
        candidate.pixels.assign(pixels, pixels + static_cast<size_t>(stride) * height);
        target->push_back(std::move(candidate));
      }
    }

    char frameJson[1024];
    std::snprintf(frameJson, sizeof(frameJson),
                  "{\"event\":\"frame\",\"index\":%d,\"sampleTimeMs\":%.1f,\"receivedUnixMs\":%llu,"
                  "\"captureUnixMs\":%llu,\"latencyMs\":%lld,\"width\":%u,\"height\":%u,"
                  "\"meanR\":%d,\"meanG\":%d,\"meanB\":%d}",
                  frames, static_cast<double>(timestamp) / 10000.0,
                  static_cast<unsigned long long>(receivedUnixMs),
                  static_cast<unsigned long long>(captureUnixMs),
                  static_cast<long long>(latencyMs), width, height, meanR, meanG, meanB);
    Emit(frameJson);
    lastSampleTime = static_cast<uint64_t>(timestamp);
    ++frames;
    framesObserved.store(frames);
    buffer->Unlock();
  }

  finished.store(true);
  watchdog.join();

  // Write PNG evidence only from the preferred class of frames: app frames
  // when at least one arrived, otherwise the native paused fallback (a stream
  // with no app connection at all).
  const std::vector<PngCandidate>& selectedPngs =
      !appPngCandidates.empty() ? appPngCandidates : fallbackPngCandidates;
  for (const PngCandidate& candidate : selectedPngs) {
    wchar_t fileName[512];
    swprintf_s(fileName, L"%s-%03d.png", options.prefix.c_str(), candidate.index);
    const std::wstring fullPath = options.outDirectory + L"\\" + fileName;
    if (!WritePng(fullPath, candidate.width, candidate.height, candidate.stride,
                  candidate.pixels.data())) {
      continue;
    }
    char pngJson[2048];
    std::snprintf(pngJson, sizeof(pngJson),
                  "{\"event\":\"png\",\"index\":%d,\"captureUnixMs\":%llu,\"width\":%d,"
                  "\"height\":%d,\"meanR\":%d,\"meanG\":%d,\"meanB\":%d,\"path\":\"%s\"}",
                  candidate.index, static_cast<unsigned long long>(candidate.captureUnixMs),
                  candidate.width, candidate.height, candidate.meanR, candidate.meanG,
                  candidate.meanB, JsonEscape(ToUtf8(fullPath)).c_str());
    Emit(pngJson);
  }

  if (intervals.empty()) {
    Emit("{\"event\":\"summary\",\"frames\":" + std::to_string(frames) + ",\"intervalsMs\":[]}");
  } else {
    std::vector<double> sorted = intervals;
    std::sort(sorted.begin(), sorted.end());
    const double p95 = sorted[std::min(sorted.size() - 1,
                                       static_cast<size_t>(std::ceil(sorted.size() * 0.95)) - 1)];
    std::string json = "{\"event\":\"summary\",\"frames\":" + std::to_string(frames) +
                       ",\"lastSampleTimeMs\":" + std::to_string(lastSampleTime) +
                       ",\"intervalCount\":" + std::to_string(intervals.size()) +
                       ",\"intervalP95Ms\":" + std::to_string(static_cast<int>(p95 * 10) / 10.0) +
                       ",\"intervalsMs\":[";
    for (size_t index = 0; index < intervals.size(); ++index) {
      if (index) json += ",";
      char value[32];
      std::snprintf(value, sizeof(value), "%.1f", intervals[index]);
      json += value;
    }
    json += "]}";
    Emit(json);
  }

  if (lastError != S_OK) return 3;
  return frames >= options.frames ? 0 : 3;
}

}  // namespace

int wmain(int argc, wchar_t** argv) {
  const Options options = ParseOptions(argc, argv);
  CoInitializeEx(nullptr, COINIT_MULTITHREADED);
  const HRESULT mfHr = MFStartup(MF_VERSION, MFSTARTUP_FULL);
  if (FAILED(mfHr)) {
    Emit("{\"event\":\"error\",\"code\":\"mfstartup-failed\"}");
    return 4;
  }

  int result = 0;
  if (options.listOnly) {
    EmitDeviceList();
  } else {
    result = Capture(options);
  }

  MFShutdown();
  CoUninitialize();
  return result;
}





