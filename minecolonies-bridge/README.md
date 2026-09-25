# Voyager Bridge (MineColonies experiment)

Forge mod that runs inside the MineColonies server process and exposes an
HTTP API so an LLM agent can drive colony placement directly, bypassing the
client GUI entirely.

## Why this exists

MineColonies registers mandatory FML network channels, so a plain
vanilla-protocol bot (mineflayer) cannot even log into a server running it -
the connection is rejected with "This server has mods that require Forge to
be installed on the client." A Forge-aware client is required just to join.

Separately, building placement (where a hut goes) and colony founding are
GUI-driven flows (Build Tool + Structurize), not chat commands.

This mod sidesteps both problems by running *inside* the same JVM as the
server and calling MineColonies'/Structurize's own Java methods directly -
no network protocol involved. It turns out MineColonies' own classes
(`IColonyManager`, `ICitizenManager`, etc.) are **not** obfuscated (Forge
only obfuscates vanilla Minecraft classes), so they can be referenced by
their normal method names at compile time via `fg.deobf(files(...))`
pointing at the already-installed mod jars.

## Endpoints (port 8089)

- `POST /place?x=&y=&z=&block=minecolonies:blockhuttownhall` - places a hut
  block directly (`Level.setBlockAndUpdate` + `Block.setPlacedBy`, the same
  hooks a normal player placement would trigger).
- `POST /found?x=&y=&z=&name=` - founds a colony on a previously-placed,
  not-yet-colonized town hall (mirrors `CreateColonyMessage`, sent when a
  player confirms the in-game "found colony" prompt).
- `POST /spawnCitizen?colonyId=` - force-spawns a new citizen in the colony
  (mirrors the `/mc citizens spawnNew <id>` console command).
- `GET /ping` - health check.

## Known gotchas hit while building this

- Gradle 8.1.1 (bundled in the Forge MDK) cannot run on JDK 21
  ("Unsupported class file major version 65"). Build with JDK 17
  (`JAVA_HOME` pointed at a Temurin 17 install) and let Gradle's toolchain
  resolve the rest.
- `ICitizenManager.spawnOrCreateCitizen()` (no-arg) has a bug in this
  MineColonies build: it ends up calling `List.of(null)` internally and
  throws an NPE. Call `spawnOrCreateCivilian(null, world, new ArrayList<>(), true)`
  directly instead (passing an *empty*, not null, list) - this is what the
  official `/mc citizens spawnNew` console command does under the hood.
- `TileEntityColonyBuilding.setStructurePack` requires Domum Ornamentum on
  the compile classpath too (`IMateriallyTexturedBlockEntity`), even though
  we never call into Domum Ornamentum directly.

## Building

Requires JDK 17 and the MineColonies/Structurize/Domum Ornamentum jars to
already exist at the paths referenced in `build.gradle`'s `compileOnly
fg.deobf(files(...))` lines (adjust those paths if your server's mods folder
is elsewhere).

```bash
export JAVA_HOME=/path/to/jdk-17
./gradlew build -x test
# output: build/libs/voyagerbridge-0.1.0.jar -> copy into the server's mods/ folder
```

## Third-party mods and licensing

This mod is built and run **against** [MineColonies](https://github.com/ldtteam/minecolonies)
and [Structurize](https://github.com/ldtteam/structurize) (both by ldtteam,
licensed GPL-3.0) as compile-time-only (`compileOnly`) API dependencies -
their code is never copied, bundled, or redistributed here. This repository
only contains original `voyagerbridge` source; the referenced MineColonies/
Structurize/Domum Ornamentum jars are expected to already be present on the
end user's own server install (see `build.gradle`) and are not shipped with
this project. Full credit to ldtteam for MineColonies, Structurize, and
Domum Ornamentum, which this experiment depends on entirely for the colony
simulation itself - `voyagerbridge` only adds an HTTP control surface on top.
