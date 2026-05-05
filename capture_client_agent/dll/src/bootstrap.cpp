// PageSignal CLR-bootstrap shim for cross-process DLL injection.
//
// Build (MSVC x64 Developer Prompt):
//     cl /LD /EHsc /O2 bootstrap.cpp /Fe:PageSignalBootstrap.dll mscoree.lib
//
// What this DLL does when LoadLibrary'd into a target process:
//   1. On DLL_PROCESS_ATTACH it spawns a worker thread.
//   2. The worker thread starts the .NET Framework 4.x CLR via mscoree (CLRCreateInstance).
//   3. It calls PageSignal.NativeAgent.Agent.StartBackground() in PageSignalAgent.dll.
//
// PageSignalAgent.dll is expected to live alongside this DLL on disk.

#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <metahost.h>
#include <string>
#pragma comment(lib, "mscoree.lib")

#import "mscorlib.tlb" raw_interfaces_only \
    high_property_prefixes("_get","_put","_putref") rename("ReportEvent","InteropServices_ReportEvent")

static std::wstring ModuleDirectory(HMODULE h) {
    wchar_t buf[MAX_PATH];
    DWORD n = GetModuleFileNameW(h, buf, MAX_PATH);
    if (n == 0) return L"";
    std::wstring p(buf, n);
    size_t slash = p.find_last_of(L"\\/");
    return (slash == std::wstring::npos) ? L"" : p.substr(0, slash);
}

static HMODULE g_self = nullptr;

static DWORD WINAPI Bootstrap(LPVOID) {
    ICLRMetaHost*       metaHost   = nullptr;
    ICLRRuntimeInfo*    runtimeInfo = nullptr;
    ICLRRuntimeHost*    runtimeHost = nullptr;
    HRESULT hr = S_OK;

    hr = CLRCreateInstance(CLSID_CLRMetaHost, IID_PPV_ARGS(&metaHost));
    if (FAILED(hr)) return (DWORD)hr;

    hr = metaHost->GetRuntime(L"v4.0.30319", IID_PPV_ARGS(&runtimeInfo));
    if (FAILED(hr)) { metaHost->Release(); return (DWORD)hr; }

    BOOL loadable = FALSE;
    hr = runtimeInfo->IsLoadable(&loadable);
    if (FAILED(hr) || !loadable) { runtimeInfo->Release(); metaHost->Release(); return (DWORD)hr; }

    hr = runtimeInfo->GetInterface(CLSID_CLRRuntimeHost, IID_PPV_ARGS(&runtimeHost));
    if (FAILED(hr)) { runtimeInfo->Release(); metaHost->Release(); return (DWORD)hr; }

    // Start may return HOST_E_CLRNOTAVAILABLE or S_FALSE if CLR is already up; ignore those.
    runtimeHost->Start();

    std::wstring dir = ModuleDirectory(g_self);
    std::wstring asmPath = dir + L"\\PageSignalAgent.dll";

    DWORD ret = 0;
    hr = runtimeHost->ExecuteInDefaultAppDomain(
        asmPath.c_str(),
        L"PageSignal.NativeAgent.Agent",
        L"StartBackground",
        L"", // unused argument
        &ret);

    runtimeHost->Release();
    runtimeInfo->Release();
    metaHost->Release();
    return (DWORD)hr;
}

BOOL APIENTRY DllMain(HMODULE hModule, DWORD reason, LPVOID) {
    if (reason == DLL_PROCESS_ATTACH) {
        g_self = hModule;
        DisableThreadLibraryCalls(hModule);
        // Bootstrap on a worker thread — never block inside DllMain.
        HANDLE h = CreateThread(nullptr, 0, Bootstrap, nullptr, 0, nullptr);
        if (h) CloseHandle(h);
    }
    return TRUE;
}
