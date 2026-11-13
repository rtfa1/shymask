#include "paused-frame.h"

#include "protocol.h"
#include "logging.h"

#pragma comment(lib, "gdi32.lib")
#pragma comment(lib, "user32.lib")

#include <windows.h>

#include <mutex>

namespace shymask {
namespace {

constexpr uint8_t kBackgroundR = 0x0a;
constexpr uint8_t kBackgroundG = 0x0d;
constexpr uint8_t kBackgroundB = 0x12;

void DrawPausedScreen(std::vector<uint8_t>* rgba) {
  const int width = static_cast<int>(kShymaskFrameWidth);
  const int height = static_cast<int>(kShymaskFrameHeight);
  rgba->assign(static_cast<size_t>(width) * height * 4, 0);

  BITMAPINFO info{};
  info.bmiHeader.biSize = sizeof(BITMAPINFOHEADER);
  info.bmiHeader.biWidth = width;
  info.bmiHeader.biHeight = -height;  // top-down
  info.bmiHeader.biPlanes = 1;
  info.bmiHeader.biBitCount = 32;
  info.bmiHeader.biCompression = BI_RGB;

  void* bits = nullptr;
  HDC screen = GetDC(nullptr);
  HDC memory = CreateCompatibleDC(screen);
  HBITMAP bitmap = CreateDIBSection(memory, &info, DIB_RGB_COLORS, &bits, nullptr, 0);
  HGDIOBJ previous = nullptr;
  if (bitmap && bits) {
    previous = SelectObject(memory, bitmap);

    RECT full{0, 0, width, height};
    HBRUSH background = CreateSolidBrush(RGB(kBackgroundR, kBackgroundG, kBackgroundB));
    FillRect(memory, &full, background);
    DeleteObject(background);

    SetBkMode(memory, TRANSPARENT);
    SetTextColor(memory, RGB(0xf4, 0xf6, 0xf8));
    SetTextAlign(memory, TA_CENTER | TA_BASELINE);
    HFONT font = CreateFontW(-72, 0, 0, 0, FW_SEMIBOLD, FALSE, FALSE, FALSE, DEFAULT_CHARSET,
                             OUT_DEFAULT_PRECIS, CLIP_DEFAULT_PRECIS, CLEARTYPE_QUALITY,
                             DEFAULT_PITCH | FF_DONTCARE, L"Segoe UI");
    HGDIOBJ previousFont = font ? SelectObject(memory, font) : nullptr;
    const wchar_t* title = L"Tracking paused";
    TextOutW(memory, width / 2, height / 2 + 24, title, static_cast<int>(wcslen(title)));
    if (font) {
      SelectObject(memory, previousFont);
      DeleteObject(font);
    }

    const auto* source = static_cast<const uint8_t*>(bits);
    uint8_t* destination = rgba->data();
    const size_t pixels = static_cast<size_t>(width) * height;
    for (size_t index = 0; index < pixels; ++index) {
      const uint8_t blue = source[index * 4 + 0];
      const uint8_t green = source[index * 4 + 1];
      const uint8_t red = source[index * 4 + 2];
      destination[index * 4 + 0] = red;
      destination[index * 4 + 1] = green;
      destination[index * 4 + 2] = blue;
      destination[index * 4 + 3] = 255;
    }

    SelectObject(memory, previous);
  } else {
    Log(L"paused frame: GDI drawing failed, using an opaque solid fill");
    for (size_t index = 0; index < rgba->size(); index += 4) {
      (*rgba)[index + 0] = kBackgroundR;
      (*rgba)[index + 1] = kBackgroundG;
      (*rgba)[index + 2] = kBackgroundB;
      (*rgba)[index + 3] = 255;
    }
  }

  if (bitmap) DeleteObject(bitmap);
  if (memory) DeleteDC(memory);
  if (screen) ReleaseDC(nullptr, screen);
}

}  // namespace

const std::vector<uint8_t>& PausedFrame() {
  static std::once_flag once;
  static std::vector<uint8_t> frame;
  std::call_once(once, [] {
    DrawPausedScreen(&frame);
    Log(L"paused fallback frame prepared (%zu bytes)", frame.size());
  });
  return frame;
}

}  // namespace shymask
