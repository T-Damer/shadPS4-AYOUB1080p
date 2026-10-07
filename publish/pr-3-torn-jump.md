# cpu_patches: avoid torn jumps when patching instructions at runtime

Branch: `T-Damer:fix/torn-jump-runtime-patches` -> `weshayoub92:main`

inFAMOUS Second Son crashed while the save loaded in about 1 of 3 boots: ~13 s in, a JobWorker
thread executed a garbage address. Instructions patched at runtime (from the fault handler) got
their 5-byte jump written with a plain copy while other game threads could be running the same
code, so a thread could fetch a half-written jump.

Now the patch parks such threads on a 2-byte `jmp $` (atomic store), writes the rest, then
publishes the first two bytes atomically. Patching ahead of time keeps the plain copy.

This is a port of upstream shadPS4 PR #5239 (shadps4-emu/shadPS4#5239).

Testing: 7 of 7 boots loaded without a crash (before: about 1 in 3 crashed), Windows, RTX 4060 Laptop.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
