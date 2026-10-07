## Patches: address fixed-address executables from their first segment

Branch: `fix/patches-fixed-address-eboot`

### Problem
Patch files (and the built-in fixes / `OriginalHash` checks of this fork) address the
executable as if it were loaded at `0x400000`: the patcher writes to
`eboot base + address - 0x400000`. That is only right for position-independent
executables, whose first `PT_LOAD` segment has `p_vaddr` 0.

A fixed-address executable (`ET_SCE_EXEC`, first `PT_LOAD` at `p_vaddr` 0x400000) is mapped at
`base + p_vaddr`, so every patch read or wrote 0x400000 bytes below the code, in the unmapped
part of the reservation. With the European 1.00 release of inFAMOUS Second Son (CUSA00004, eboot
SDK 0x1500111) the emulator crashed in the `OriginalHash` check before the game started:

```
Unhandled Exception code 0xc0000005 ... access=read target=0x5631736
```
(`0x5631736` = base `0x5440000` + `0x5f1736` - `0x400000`, below the first segment at `0x5840000`.)

### Fix
`g_eboot_address` points at the first loaded segment (`base + lowest p_vaddr`), and
`g_eboot_image_size` shrinks by the same amount. Nothing changes for position-independent
executables (lowest `p_vaddr` = 0), so the existing patches of 1.07 behave exactly as before.

### Testing
- inFAMOUS Second Son 1.00 (fixed address): patches are now checked against the right bytes and
  skipped cleanly when they belong to another version, no more crash at boot.
- inFAMOUS Second Son 1.07 (position independent): same addresses as before, built-in fix applied
  (`Applied patch: PS4 Pro mode without checkerboard (built in)`).

The same address computation exists in upstream shadPS4 (`MemoryPatcher::PatchMemory`), so this
probably applies there too.
