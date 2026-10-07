@echo off
rem Builds E:\Projects\shadPS4-AYOUB1080p (Release, clang-cl + Ninja, ThinLTO like the official
rem release, -mtune=znver3 for the Ryzen 7 7735H) into build-znver3\, then installs the exe to
rem E:\Entertaiment\shadPS4-own\ (what the desktop shortcut runs).
rem Needs: VS 2022 Build Tools (C++ and Clang), Python 3.12. Runs on any AVX2 CPU (x86-64-v3).
call "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat" >nul || exit /b 1
cd /d E:\Projects\shadPS4-AYOUB1080p || exit /b 1
if not exist build-znver3\build.ninja (
  cmake -S . -B build-znver3 -G Ninja -DCMAKE_BUILD_TYPE=Release -DCMAKE_C_COMPILER=clang-cl -DCMAKE_CXX_COMPILER=clang-cl ^
    -DCMAKE_INTERPROCEDURAL_OPTIMIZATION=ON ^
    "-DCMAKE_C_FLAGS_RELEASE=/O2 /Ob2 /DNDEBUG /clang:-mtune=znver3" "-DCMAKE_CXX_FLAGS_RELEASE=/O2 /Ob2 /DNDEBUG /clang:-mtune=znver3" ^
    -DPython3_EXECUTABLE=%LOCALAPPDATA%\Programs\Python\Python312\python.exe || exit /b 1
)
cmake --build build-znver3 --parallel 14 || exit /b 1
rem A running emulator keeps its exe locked but it can be renamed: the next launch uses the new one.
del /q E:\Entertaiment\shadPS4-own\shadps4.old.exe 2>nul
if exist E:\Entertaiment\shadPS4-own\shadps4.exe move /y E:\Entertaiment\shadPS4-own\shadps4.exe E:\Entertaiment\shadPS4-own\shadps4.old.exe >nul
copy /y build-znver3\shadps4.exe E:\Entertaiment\shadPS4-own\shadps4.exe >nul && echo Installed to E:\Entertaiment\shadPS4-own\shadps4.exe
