@echo off
rem Builds E:\Projects\shadPS4-AYOUB1080p (Release, clang-cl + Ninja) into its build\ folder.
rem Needs: VS 2022 Build Tools (C++ + Clang), Python 3.12. Output: build\shadps4.exe
call "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat" >nul || exit /b 1
cd /d E:\Projects\shadPS4-AYOUB1080p || exit /b 1
if not exist build\build.ninja (
  cmake -S . -B build -G Ninja -DCMAKE_BUILD_TYPE=Release -DCMAKE_C_COMPILER=clang-cl -DCMAKE_CXX_COMPILER=clang-cl ^
    -DPython3_EXECUTABLE=%LOCALAPPDATA%\Programs\Python\Python312\python.exe || exit /b 1
)
cmake --build build --parallel 14
