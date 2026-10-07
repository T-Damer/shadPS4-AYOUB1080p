@echo off
rem Builds E:\Projects\shadPS4-FixBuild (rayhlancaner-png/shadPS4-Infamous-FixBuild, an inFAMOUS
rem specific fork) the same way as build-emulator.bat, and installs it to
rem E:\Entertaiment\shadPS4-FixBuild\ with a portable user\ folder of its own (settings, shader
rem cache), so it never touches E:\Entertaiment\shadPS4-user.
call "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat" >nul || exit /b 1
cd /d E:\Projects\shadPS4-FixBuild || exit /b 1
cmake -S . -B build -G Ninja -DCMAKE_BUILD_TYPE=Release -DCMAKE_C_COMPILER=clang-cl -DCMAKE_CXX_COMPILER=clang-cl ^
    -DCMAKE_INTERPROCEDURAL_OPTIMIZATION=ON ^
    "-DCMAKE_C_FLAGS_RELEASE=/O2 /Ob2 /DNDEBUG /Z7 /clang:-mtune=znver3" "-DCMAKE_CXX_FLAGS_RELEASE=/O2 /Ob2 /DNDEBUG /Z7 /clang:-mtune=znver3" ^
    "-DCMAKE_EXE_LINKER_FLAGS_RELEASE=/INCREMENTAL:NO /DEBUG /OPT:REF /OPT:ICF" ^
    -DPython3_EXECUTABLE=%LOCALAPPDATA%\Programs\Python\Python312\python.exe >nul || exit /b 1
cmake --build build --parallel 14 || exit /b 1
if not exist E:\Entertaiment\shadPS4-FixBuild\user mkdir E:\Entertaiment\shadPS4-FixBuild\user
del /q E:\Entertaiment\shadPS4-FixBuild\shadps4.old.exe 2>nul
if exist E:\Entertaiment\shadPS4-FixBuild\shadps4.exe move /y E:\Entertaiment\shadPS4-FixBuild\shadps4.exe E:\Entertaiment\shadPS4-FixBuild\shadps4.old.exe >nul
copy /y build\shadps4.exe E:\Entertaiment\shadPS4-FixBuild\shadps4.exe >nul && echo Installed to E:\Entertaiment\shadPS4-FixBuild\shadps4.exe
