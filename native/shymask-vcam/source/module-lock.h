// Live-object accounting for the in-proc COM server.
//
// DllCanUnloadNow must not unload the media source DLL while a class factory,
// an activator, or a media source created by it is still alive. The frame
// server keeps the media source (and may keep the activator) across sample
// requests, so the module lock count alone is not sufficient.
#pragma once

namespace shymask {

void ModuleAddLiveObject();
void ModuleRemoveLiveObject();

}  // namespace shymask
