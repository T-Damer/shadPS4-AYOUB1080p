@echo off
rem Same as build-emulator.bat, tuned for this laptop's Ryzen 7 7735H (Zen 3+): link time
rem optimization (as the official release) plus -mtune=znver3. The project already targets
rem x86-64-v3 (AVX2), so the binary still runs on any AVX2 CPU. Output: build-znver3\shadps4.exe
call "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat" >nul || exit /b 1
cd /d E:\Projects\shadPS4-AYOUB1080p || exit /b 1
if not exist build-znver3\build.ninja (
  cmake -S . -B build-znver3 -G Ninja -DCMAKE_BUILD_TYPE=Release -DCMAKE_C_COMPILER=clang-cl -DCMAKE_CXX_COMPILER=clang-cl ^
    -DCMAKE_INTERPROCEDURAL_OPTIMIZATION=ON ^
    "-DCMAKE_C_FLAGS_RELEASE=/O2 /Ob2 /DNDEBUG /clang:-mtune=znver3" "-DCMAKE_CXX_FLAGS_RELEASE=/O2 /Ob2 /DNDEBUG /clang:-mtune=znver3" ^
    -DPython3_EXECUTABLE=%LOCALAPPDATA%\Programs\Python\Python312\python.exe || exit /b 1
)
cmake --build build-znver3 --parallel 14
