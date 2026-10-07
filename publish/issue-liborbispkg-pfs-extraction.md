## PkgTool `pkg_extract` silently corrupts large PKGs (zero-filled data, missing files)

Repository: maxton/LibOrbisPkg (PkgTool.Core 0.2.231)

### What happens
`PkgTool.Core pkg_extract --passcode 000... game.pkg out` on inFAMOUS Second Son (CUSA00004,
23.8 GB game PKG + 3.9 GB update) finishes without an error, but:

- the game PKG gives 1,495 files instead of 1,794 (about 300 files never written), and
- many written files contain zero-filled 64 KiB blocks where the data should be (one shader pack
  lost about 30% of its content).

The game then crashes at startup in an emulator, looking up objects that are missing from the
corrupted files.

### Cause (as far as I can tell)
Files of the inner PFS image are mostly stored contiguously: the inode's first direct block
pointer is the start block and the next direct pointers are `0xFFFFFFFF`, with the block count in
the inode. Treating those markers as real block pointers (or the indirect pointers that follow)
reads the wrong blocks for every file larger than one block. A reader that maps
`start .. start + blocks - 1` when `db[1] == 0xFFFFFFFF` extracts every file correctly
(byte-identical, 487/487 files of the update verified).

### Workaround
`pkg_extractouterpfs` (decryption) is fine; extracting the inner image with a reader that
handles contiguous inodes works: <!-- link to ps4kit lib/pfs.js (blockList) once published -->.
