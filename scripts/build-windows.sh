#!/usr/bin/env bash
# Cross-compiles the desktop app for Windows from Linux/WSL: clang-cl + lld-link + the xwin-splatted MSVC CRT/SDK.
# Needs: rustup target x86_64-pc-windows-msvc, LLVM (clang-cl, lld-link, llvm-lib, llvm-rc) on PATH, cmake, ninja,
# and `xwin --accept-license --arch x86_64 --variant desktop splat --output $XWIN_SDK`.
set -euo pipefail
cd "$(dirname "$0")/../apps/desktop"
X=${XWIN_SDK:-$HOME/.local/toolchains/xwin-sdk}
# -msse4.2: Windows 11 24H2 requires SSE4.2; libopus needs it for its SSE4.1 kernels under clang-cl
FLAGS="--target=x86_64-pc-windows-msvc -msse4.2 -Wno-unused-command-line-argument -fuse-ld=lld-link /imsvc$X/crt/include /imsvc$X/sdk/include/ucrt /imsvc$X/sdk/include/um /imsvc$X/sdk/include/shared"
TC=$(mktemp --suffix=.cmake)
cat > "$TC" <<CMAKE
set(CMAKE_SYSTEM_NAME Windows)
set(CMAKE_SYSTEM_PROCESSOR AMD64)
set(CMAKE_C_COMPILER clang-cl)
set(CMAKE_CXX_COMPILER clang-cl)
set(CMAKE_AR llvm-lib)
set(CMAKE_LINKER lld-link)
set(CMAKE_RC_COMPILER llvm-rc)
set(CMAKE_MT llvm-mt)
set(CMAKE_C_FLAGS_INIT "$FLAGS")
set(CMAKE_CXX_FLAGS_INIT "$FLAGS")
set(CMAKE_TRY_COMPILE_TARGET_TYPE STATIC_LIBRARY)
CMAKE
export CC_x86_64_pc_windows_msvc=clang-cl CXX_x86_64_pc_windows_msvc=clang-cl AR_x86_64_pc_windows_msvc=llvm-lib
export CFLAGS_x86_64_pc_windows_msvc="$FLAGS" CXXFLAGS_x86_64_pc_windows_msvc="$FLAGS"
export CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_LINKER=lld-link
export CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_RUSTFLAGS="-Lnative=$X/crt/lib/x86_64 -Lnative=$X/sdk/lib/um/x86_64 -Lnative=$X/sdk/lib/ucrt/x86_64"
export CMAKE_TOOLCHAIN_FILE_x86_64_pc_windows_msvc="$TC" CMAKE_GENERATOR=Ninja CMAKE_POLICY_VERSION_MINIMUM=3.5 # libopus predates CMake 4
pnpm build
cd src-tauri
cargo build --release --target x86_64-pc-windows-msvc --features tauri/custom-protocol "$@"
ls -la target/x86_64-pc-windows-msvc/release/kazetix.exe

# Installer (NSIS): run with INSTALLER=1. Needs makensis (apt package nsis, or its
# .deb extracted with NSISDIR pointing at usr/share/nsis). tauri-cli asks pkg-config for the Linux tray library even when
# bundling for Windows, so a throwaway shim answers that one query.
if [ "${INSTALLER:-}" = 1 ]; then
  SHIM=$(mktemp -d)
  printf '#!/bin/sh\ncase "$*" in *appindicator*) case "$*" in *--variable=libdir*) echo /usr/lib/x86_64-linux-gnu;; *--modversion*) echo 0.5.93;; *--exists*) ;; *) echo "-L/usr/lib/x86_64-linux-gnu -layatana-appindicator3";; esac; exit 0;; esac\nexit 1\n' > "$SHIM/pkg-config"
  chmod +x "$SHIM/pkg-config"
  cd ..
  PATH="$SHIM:$PATH" TAURI_LINUX_AYATANA_APPINDICATOR=true npx tauri bundle --target x86_64-pc-windows-msvc --bundles nsis
  rm -rf "$SHIM"
  ls -la src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis/*.exe
fi
