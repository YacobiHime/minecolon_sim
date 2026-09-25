package com.voyagerbridge;

import com.ldtteam.structurize.storage.StructurePackMeta;
import com.ldtteam.structurize.storage.StructurePacks;
import com.mojang.authlib.GameProfile;
import com.mojang.logging.LogUtils;
import com.minecolonies.api.colony.IColony;
import com.minecolonies.api.colony.IColonyManager;
import com.minecolonies.api.colony.buildings.IBuilding;
import com.minecolonies.api.colony.ICitizenData;
import com.minecolonies.api.entity.citizen.AbstractEntityCitizen;
import com.minecolonies.api.inventory.InventoryCitizen;
import com.minecolonies.api.colony.requestsystem.request.IRequest;
import com.minecolonies.core.tileentities.TileEntityColonyBuilding;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import net.minecraft.core.BlockPos;
import net.minecraft.nbt.CompoundTag;
import net.minecraft.resources.ResourceLocation;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.entity.player.Player;
import net.minecraft.world.item.Item;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.entity.BlockEntity;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.levelgen.Heightmap;
import net.minecraftforge.common.MinecraftForge;
import net.minecraftforge.common.util.FakePlayer;
import net.minecraftforge.event.TickEvent;
import net.minecraftforge.event.server.ServerStartedEvent;
import net.minecraftforge.event.server.ServerStoppingEvent;
import net.minecraftforge.eventbus.api.SubscribeEvent;
import net.minecraftforge.fml.common.Mod;
import net.minecraftforge.registries.ForgeRegistries;
import org.slf4j.Logger;

import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.UUID;

/**
 * Minimal HTTP bridge so an LLM agent process can drive world/colony state
 * directly from inside the server JVM, without needing a real (Forge-aware)
 * client connection. MineColonies/Structurize register mandatory FML network
 * channels, so a plain vanilla-protocol bot (mineflayer) cannot even log in -
 * this mod sidesteps that entirely by calling the same standard Block/Level
 * APIs a player's client action would trigger, from the server side.
 */
@Mod(VoyagerBridge.MODID)
public class VoyagerBridge {
    public static final String MODID = "voyagerbridge";
    private static final Logger LOGGER = LogUtils.getLogger();
    private static final int PORT = 8089;
    private static final GameProfile AI_PROFILE =
            new GameProfile(UUID.nameUUIDFromBytes("voyager-ai".getBytes(StandardCharsets.UTF_8)), "VoyagerAI");

    private MinecraftServer server;
    private HttpServer httpServer;

    // Tick rate multiplier, set via POST /tickrate?multiplier=N.
    private static volatile int tickMultiplier = 1;

    public static int getTickMultiplier() { return tickMultiplier; }

    // Cached reflection access to MinecraftServer.nextTickTime (SRG: f_129726_).
    // Set to non-null once resolved; null means "not found or not yet searched."
    private static volatile java.lang.reflect.Field nextTickTimeField = null;
    private static volatile boolean nextTickTimeSearched = false;

    private static java.lang.reflect.Field resolveNextTickTimeField(MinecraftServer srv) {
        if (nextTickTimeSearched) return nextTickTimeField;
        nextTickTimeSearched = true;
        // Search the class hierarchy for a long field matching either name.
        Class<?> cls = srv.getClass();
        while (cls != null) {
            for (java.lang.reflect.Field f : cls.getDeclaredFields()) {
                if (f.getType() != long.class) continue;
                String n = f.getName();
                if ("nextTickTime".equals(n) || "f_129726_".equals(n)) {
                    f.setAccessible(true);
                    nextTickTimeField = f;
                    return f;
                }
            }
            cls = cls.getSuperclass();
        }
        return null;
    }

    // Called at the END of each server tick, before waitUntilNextTick() sleeps.
    // When multiplier > 1, we rewind nextTickTime so the upcoming managedBlock()
    // (which adds 50ms then loops until time is past) exits immediately, giving
    // approximately mult × 20 TPS (bounded by actual tick processing cost).
    //
    // IMPORTANT: nextTickTime uses Util.getMillis() = System.nanoTime()/1_000_000L
    // (milliseconds since system boot), NOT System.currentTimeMillis() (Unix epoch).
    // Using currentTimeMillis() would set nextTickTime ~58 years into the future,
    // causing the tick loop to block indefinitely.
    @SubscribeEvent
    public void onServerTick(TickEvent.ServerTickEvent event) {
        if (event.phase != TickEvent.Phase.START) return;
        keepColoniesActive();
        keepBuildSitesLoaded();
        tickrateGovernor();
        rescueVoidFallers();
        tickCitizenOrders();
        int mult = tickMultiplier;
        if (mult <= 1 || server == null) return;
        java.lang.reflect.Field f = resolveNextTickTimeField(server);
        if (f != null) {
            try {
                // At Phase.START, the previous managedBlock has just set nextTickTime
                // to prevNextTickTime + 50 (and then waited for it).
                // nextTickTime ≈ Util.getMillis() right now.
                // We subtract (50 - 50/mult) so that upcoming managedBlock's += 50
                // targets only 50/mult ms in the future instead of 50ms.
                // Util.getMillis() == System.nanoTime() / 1_000_000L (boot-time base)
                long cur = f.getLong(server);
                long adj = 50L - 50L / mult;  // for mult=10: 45ms
                f.setLong(server, cur - adj);
            } catch (Exception ignored) {}
        }
        suppressFloatingKicks();
        suppressLoginTimeouts();
    }

    // --- Unmanned-colony keep-alive ---
    //
    // Colony.updateState() drops a colony to UNLOADED as soon as no player is
    // near (closeSubscribers empty, no important colony player online). In
    // UNLOADED only worldTickUnloaded runs: tickWorkManager (binds claimed
    // work orders to builder huts), checkDayTime (the colony day counter that
    // day-based schedulers like the farmer's field rotation depend on),
    // tickRequests and worldTickSlow (building ticks) all stop. Entities keep
    // walking (forceloaded chunks), so the colony LOOKS alive while its brain
    // is off - builders wander on leisure forever and the day freezes.
    // This experiment runs unmanned, so while nobody is online we force the
    // state machine back to ACTIVE (both the state field and the cached
    // transition list must be swapped - see BasicStateMachine.transitionToNext).
    // updateState() flips it back every 100 machine ticks; re-forcing every 20
    // server ticks keeps the colony effectively always ACTIVE.
    private int keepActiveCounter = 0;
    private static volatile java.lang.reflect.Field colonyStateMachineField = null;
    private static volatile java.lang.reflect.Field smStateField = null;
    private static volatile java.lang.reflect.Field smTransitionMapField = null;
    private static volatile java.lang.reflect.Field smCurrentTransitionsField = null;

    // Builder AIs silently wait when the build site's chunks aren't loaded -
    // with no players online, frontier sites (claim edge, ~90-130 blocks out)
    // never load and the bound hut's queue freezes (the second 21-order stall,
    // 2026-07-06; manually forceloading the area unstuck it within seconds).
    // Keep the chunks of every hut-bound work order force-loaded, and release
    // chunks whose orders completed.
    private int keepLoadedCounter = 0;
    private final java.util.HashSet<Long> forcedBuildChunks = new java.util.HashSet<>();
    private static java.lang.reflect.Field boundWorkOrderIdField = null;

    private void keepBuildSitesLoaded() {
        if (server == null || ++keepLoadedCounter < 200) return; // ~1s at 10x
        keepLoadedCounter = 0;
        try {
            ServerLevel level = server.overworld();
            java.util.HashSet<Long> desired = new java.util.HashSet<>();
            // Chunk radius (in chunks) of the always-loaded colony core. env
            // VOYAGER_CORE_CHUNK_RADIUS overrides. Default 12 -> ~192 blocks,
            // covering a compact colony; far build sites are handled per-hut below.
            int coreR = 12;
            try {
                String cr = System.getenv("VOYAGER_CORE_CHUNK_RADIUS");
                if (cr == null) cr = System.getProperty("voyager.core.chunkradius");
                if (cr != null) coreR = Integer.parseInt(cr.trim());
            } catch (Exception ignored) {}
            for (IColony colony : IColonyManager.getInstance().getAllColonies()) {
                // Always keep the colony CORE loaded. The per-build-site set below
                // is tiny and its cleanup calls setChunkForced(false), which -
                // because vanilla forceload is one boolean per chunk - also clears
                // the static start_server forceload on that chunk. As builds
                // completed across the colony this unloaded citizen/work chunks and
                // despawned workers (no-entity, construction frozen; seen on both
                // superflat and normal worlds 2026-07-12). Pinning a core disc in
                // `desired` keeps it force-loaded and off the unload path.
                net.minecraft.core.BlockPos cc = colony.getCenter();
                int ccx = cc.getX() >> 4, ccz = cc.getZ() >> 4;
                for (int dx = -coreR; dx <= coreR; dx++) {
                    for (int dz = -coreR; dz <= coreR; dz++) {
                        desired.add((((long) (ccx + dx)) << 32) | ((ccz + dz) & 0xffffffffL));
                    }
                }
                // Only the order each hut is BOUND to (workOrderId) - that's
                // the one its builder is trying to start right now. Max one
                // site per hut keeps the forced set small (~25 chunks/hut).
                for (IBuilding hut : colony.getServerBuildingManager().getBuildings().values()) {
                    if (!(hut instanceof com.minecolonies.core.colony.buildings.AbstractBuildingStructureBuilder sb)) continue;
                    if (boundWorkOrderIdField == null) {
                        boundWorkOrderIdField = com.minecolonies.core.colony.buildings.AbstractBuildingStructureBuilder.class
                                .getDeclaredField("workOrderId");
                        boundWorkOrderIdField.setAccessible(true);
                    }
                    int woId = boundWorkOrderIdField.getInt(sb);
                    if (woId == 0) continue;
                    com.minecolonies.api.colony.workorders.IWorkOrder wo =
                        colony.getWorkManager().getWorkOrder(woId);
                    if (wo == null || wo.getLocation() == null) continue;
                    int cx = wo.getLocation().getX() >> 4, cz = wo.getLocation().getZ() >> 4;
                    for (int dx = -2; dx <= 2; dx++) {
                        for (int dz = -2; dz <= 2; dz++) {
                            desired.add((((long) (cx + dx)) << 32) | ((cz + dz) & 0xffffffffL));
                        }
                    }
                }
            }
            for (long key : desired) {
                if (forcedBuildChunks.add(key)) {
                    level.setChunkForced((int) (key >> 32), (int) key, true);
                }
            }
            forcedBuildChunks.removeIf(key -> {
                if (desired.contains(key)) return false;
                long k = key;
                level.setChunkForced((int) (k >> 32), (int) k, false);
                return true;
            });
        } catch (Exception e) {
            LOGGER.warn("keepBuildSitesLoaded failed: {}", e.toString());
        }
    }

    // A citizen that slips below the world (into the void under the superflat
    // bedrock at y=-64) would keep falling to void-damage death. Checked every
    // ~0.5s in-process (fast enough - void damage only starts far below, and a
    // poll-based rescue at the 6s supply_bot cadence would miss fast falls):
    // any citizen below THRESHOLD is teleported back to its home (or work, or
    // colony centre) at the surface, with fall state reset so it lands safely.
    private int voidRescueCounter = 0;
    private static final double VOID_RESCUE_Y = -70.0;

    private void rescueVoidFallers() {
        if (server == null || ++voidRescueCounter < 10) return;
        voidRescueCounter = 0;
        try {
            for (IColony colony : IColonyManager.getInstance().getAllColonies()) {
                BlockPos center = colony.getCenter();
                for (ICitizenData cd : colony.getCitizenManager().getCitizens()) {
                    java.util.Optional<com.minecolonies.api.entity.citizen.AbstractEntityCitizen> opt = cd.getEntity();
                    if (opt.isEmpty()) continue;
                    com.minecolonies.api.entity.citizen.AbstractEntityCitizen ent = opt.get();
                    if (ent.getY() >= VOID_RESCUE_Y) continue;
                    BlockPos t = cd.getHomeBuilding() != null ? cd.getHomeBuilding().getPosition()
                        : (cd.getWorkBuilding() != null ? cd.getWorkBuilding().getPosition() : center);
                    ent.teleportTo(t.getX() + 0.5, t.getY() + 1, t.getZ() + 0.5);
                    ent.setDeltaMovement(0.0, 0.0, 0.0);
                    ent.fallDistance = 0.0f; // no fall damage on landing
                    LOGGER.info("[voidrescue] {} fell below y={}, returned to {}",
                        cd.getName(), VOID_RESCUE_Y, t.toShortString());
                }
            }
        } catch (Exception e) {
            LOGGER.warn("rescueVoidFallers failed: {}", e.toString());
        }
    }

    private void keepColoniesActive() {
        if (server == null || ++keepActiveCounter < 20) return;
        keepActiveCounter = 0;
        if (server.getPlayerList().getPlayerCount() > 0) return; // vanilla logic is fine with players on
        try {
            for (IColony colony : IColonyManager.getInstance().getAllColonies()) {
                if (!(colony instanceof com.minecolonies.core.colony.Colony)) continue;
                if (colonyStateMachineField == null) {
                    colonyStateMachineField = com.minecolonies.core.colony.Colony.class
                            .getDeclaredField("colonyStateMachine");
                    colonyStateMachineField.setAccessible(true);
                }
                Object sm = colonyStateMachineField.get(colony);
                if (smStateField == null) {
                    Class<?> cls = sm.getClass();
                    while (cls != null && smStateField == null) {
                        for (java.lang.reflect.Field f : cls.getDeclaredFields()) {
                            if ("state".equals(f.getName())) smStateField = f;
                            else if ("transitionMap".equals(f.getName())) smTransitionMapField = f;
                            else if ("currentStateTransitions".equals(f.getName())) smCurrentTransitionsField = f;
                        }
                        cls = cls.getSuperclass();
                    }
                    if (smStateField == null || smTransitionMapField == null || smCurrentTransitionsField == null) {
                        LOGGER.warn("keepColoniesActive: state machine fields not found (state={}, map={}, cur={})",
                                smStateField != null, smTransitionMapField != null, smCurrentTransitionsField != null);
                        return;
                    }
                    smStateField.setAccessible(true);
                    smTransitionMapField.setAccessible(true);
                    smCurrentTransitionsField.setAccessible(true);
                }
                Object cur = smStateField.get(sm);
                Object active = com.minecolonies.api.colony.ColonyState.ACTIVE;
                if (cur != active) {
                    java.util.Map<?, ?> map = (java.util.Map<?, ?>) smTransitionMapField.get(sm);
                    Object activeTransitions = map.get(active);
                    if (activeTransitions != null) {
                        smCurrentTransitionsField.set(sm, activeTransitions);
                        smStateField.set(sm, active);
                    }
                }
            }
        } catch (Exception e) {
            LOGGER.warn("keepColoniesActive failed", e);
        }
    }

    // --- Login timeout suppression while tick-accelerated ---
    //
    // Same class of problem as the flying kick below: ServerLoginPacketListenerImpl
    // .tick() increments its `tick` counter (SRG f_10020_) once per SERVER tick and
    // disconnects with "Took too long to log in" at 600 ticks (30s at 20 TPS). At
    // 10x the whole login handshake budget shrinks to ~3 real seconds, which a real
    // client cannot meet (observed: unkositai kicked at 2026-07-02 11:59 while
    // multiplier=10). Reset the counter every tick while accelerated.
    private static volatile java.lang.reflect.Field loginTickField = null;
    private static volatile boolean loginTickSearched = false;

    private void suppressLoginTimeouts() {
        try {
            if (server.getConnection() == null) return;
            for (net.minecraft.network.Connection conn : server.getConnection().getConnections()) {
                net.minecraft.network.PacketListener listener = conn.getPacketListener();
                if (!(listener instanceof net.minecraft.server.network.ServerLoginPacketListenerImpl)) continue;
                if (!loginTickSearched) {
                    loginTickSearched = true;
                    Class<?> cls = listener.getClass();
                    while (cls != null) {
                        for (java.lang.reflect.Field f : cls.getDeclaredFields()) {
                            String n = f.getName();
                            if (("tick".equals(n) || "f_10020_".equals(n)) && f.getType() == int.class) {
                                f.setAccessible(true);
                                loginTickField = f;
                            }
                        }
                        cls = cls.getSuperclass();
                    }
                }
                if (loginTickField != null) loginTickField.setInt(listener, 0);
            }
        } catch (Exception ignored) {}
    }

    // --- Anti-"flying" kick suppression while tick-accelerated ---
    //
    // ServerGamePacketListenerImpl.tick() (SRG m_9933_) runs once per SERVER
    // tick (not once per network packet). It increments aboveGroundTickCount
    // (SRG f_9737_) whenever clientIsFloating (f_9736_) is true, and kicks the
    // player with "multiplayer.disconnect.flying" once the counter exceeds 80
    // (vanilla source, confirmed via javap on the SRG server jar).
    //
    // At normal 20 TPS, 80 ticks = 4 real seconds - plenty of slack for a
    // legitimate jump's client/server position reconciliation. Our tick
    // acceleration hack (above) speeds up server-tick wall-clock cadence
    // without speeding up the connected client (which still sends movement
    // packets at real-time cadence), so at 10x that same 80-tick budget burns
    // in ~0.4 real seconds - not enough time for a normal jump's correction
    // packet to arrive, so every jump gets kicked. This is not fixable by
    // correcting a logic error; it's an unavoidable side effect of racing
    // server ticks ahead of real-time network I/O for connected players.
    // Mitigation: while multiplier > 1, reset the counters every tick so the
    // vanilla check never accumulates enough to fire. This disables that one
    // anti-cheat check during acceleration; acceptable for a private
    // research server where the "opponent" is our own client, not a griefer.
    private static volatile java.lang.reflect.Field clientIsFloatingField = null;
    private static volatile java.lang.reflect.Field aboveGroundTickCountField = null;
    private static volatile java.lang.reflect.Field clientVehicleIsFloatingField = null;
    private static volatile java.lang.reflect.Field aboveGroundVehicleTickCountField = null;
    private static volatile boolean floatingFieldsSearched = false;

    private static void resolveFloatingFields(Object connection) {
        if (floatingFieldsSearched) return;
        floatingFieldsSearched = true;
        try {
            Class<?> cls = connection.getClass();
            while (cls != null) {
                for (java.lang.reflect.Field f : cls.getDeclaredFields()) {
                    String n = f.getName();
                    if (("clientIsFloating".equals(n) || "f_9736_".equals(n)) && f.getType() == boolean.class) {
                        f.setAccessible(true);
                        clientIsFloatingField = f;
                    } else if (("aboveGroundTickCount".equals(n) || "f_9737_".equals(n)) && f.getType() == int.class) {
                        f.setAccessible(true);
                        aboveGroundTickCountField = f;
                    } else if (("clientVehicleIsFloating".equals(n) || "f_9738_".equals(n)) && f.getType() == boolean.class) {
                        f.setAccessible(true);
                        clientVehicleIsFloatingField = f;
                    } else if (("aboveGroundVehicleTickCount".equals(n) || "f_9739_".equals(n)) && f.getType() == int.class) {
                        f.setAccessible(true);
                        aboveGroundVehicleTickCountField = f;
                    }
                }
                cls = cls.getSuperclass();
            }
        } catch (Exception ignored) {}
    }

    private void suppressFloatingKicks() {
        if (server.getPlayerList() == null) return;
        for (net.minecraft.server.level.ServerPlayer sp : server.getPlayerList().getPlayers()) {
            Object connection = sp.connection;
            if (connection == null) continue;
            resolveFloatingFields(connection);
            try {
                if (clientIsFloatingField != null) clientIsFloatingField.setBoolean(connection, false);
                if (aboveGroundTickCountField != null) aboveGroundTickCountField.setInt(connection, 0);
                if (clientVehicleIsFloatingField != null) clientVehicleIsFloatingField.setBoolean(connection, false);
                if (aboveGroundVehicleTickCountField != null) aboveGroundVehicleTickCountField.setInt(connection, 0);
            } catch (Exception ignored) {}
        }
    }

    public VoyagerBridge() {
        MinecraftForge.EVENT_BUS.register(this);
    }

    @SubscribeEvent
    public void onServerStarted(ServerStartedEvent event) {
        this.server = event.getServer();
        try {
            httpServer = HttpServer.create(new InetSocketAddress("0.0.0.0", PORT), 0);
            httpServer.createContext("/place", this::handlePlace);
            httpServer.createContext("/found", this::handleFound);
            httpServer.createContext("/spawnCitizen", this::handleSpawnCitizen);
            httpServer.createContext("/status", this::handleStatus);
            httpServer.createContext("/requestBuild", this::handleRequestBuild);
            httpServer.createContext("/giveToCitizen", this::handleGiveToCitizen);
            httpServer.createContext("/citizenInventory", this::handleCitizenInventory);
            httpServer.createContext("/transferCitizenItem", this::handleTransferCitizenItem);
            httpServer.createContext("/giveTexturedBlock", this::handleGiveTexturedBlock);
            httpServer.createContext("/openRequests", this::handleOpenRequests);
            httpServer.createContext("/resolveRequest", this::handleResolveRequest);
            httpServer.createContext("/clearCitizenInventory", this::handleClearCitizenInventory);
            httpServer.createContext("/placeNext", this::handlePlaceNext);
            httpServer.createContext("/suggestPosition", this::handleSuggestPosition);
            httpServer.createContext("/tickrate", this::handleTickrate);
            httpServer.createContext("/debugTick", this::handleDebugTick);
            httpServer.createContext("/debugFootprints", this::handleDebugFootprints);
            httpServer.createContext("/removeBuilding", this::handleRemoveBuilding);
            httpServer.createContext("/rebalanceWorkOrders", this::handleRebalanceWorkOrders);
            httpServer.createContext("/debugWorkOrders", this::handleDebugWorkOrders);
            httpServer.createContext("/setMenu", this::handleSetMenu);
            httpServer.createContext("/upgradeWarehouse", this::handleUpgradeWarehouse);
            httpServer.createContext("/debugBuildGates", this::handleDebugBuildGates);
            httpServer.createContext("/assignHome", this::handleAssignHome);
            httpServer.createContext("/optimizeHomes", this::handleOptimizeHomes);
            httpServer.createContext("/teachRecipe", this::handleTeachRecipe);
            httpServer.createContext("/recipes", this::handleRecipes);
            httpServer.createContext("/setHiringMode", this::handleSetHiringMode);
            httpServer.createContext("/setItemList", this::handleSetItemList);
            httpServer.createContext("/warehouseStats", this::handleWarehouseStats);
            httpServer.createContext("/trimWarehouse", this::handleTrimWarehouse);
            httpServer.createContext("/scanHoles", this::handleScanHoles);
            httpServer.createContext("/stockRestaurant", this::handleStockRestaurant);
            httpServer.createContext("/neededResources", this::handleNeededResources);
            httpServer.createContext("/fillBuilderResources", this::handleFillBuilderResources);
            httpServer.createContext("/setFieldSeed", this::handleSetFieldSeed);
            httpServer.createContext("/fields", this::handleFields);
            httpServer.createContext("/debugCitizenAI", this::handleDebugCitizenAI);
            httpServer.createContext("/debugFarm", this::handleDebugFarm);
            httpServer.createContext("/debugBuilder", this::handleDebugBuilder);
            httpServer.createContext("/assignWorker", this::handleAssignWorker);
            httpServer.createContext("/citizenSkills", this::handleCitizenSkills);
            httpServer.createContext("/autoAssignJobs", this::handleAutoAssignJobs);
            httpServer.createContext("/research", this::handleResearch);
            httpServer.createContext("/startResearch", this::handleStartResearch);
            httpServer.createContext("/autoResearch", this::handleAutoResearch);
            httpServer.createContext("/surfaceY", this::handleSurfaceY);
            httpServer.createContext("/heightmap", this::handleHeightmap);
            httpServer.createContext("/threats", this::handleThreats);
            httpServer.createContext("/moveCitizen", this::handleMoveCitizen);
            httpServer.createContext("/guardOrder", this::handleGuardOrder);
            httpServer.createContext("/ping", VoyagerBridge::handlePing);
            httpServer.setExecutor(null);
            httpServer.start();
            LOGGER.info("VoyagerBridge HTTP server listening on port {}", PORT);
        } catch (IOException e) {
            LOGGER.error("VoyagerBridge failed to start HTTP server", e);
        }
    }

    @SubscribeEvent
    public void onServerStopping(ServerStoppingEvent event) {
        if (httpServer != null) {
            httpServer.stop(0);
        }
    }

    private static void handlePing(HttpExchange exchange) throws IOException {
        respond(exchange, 200, "{\"status\":\"ok\"}");
    }

    // POST /place?x=100&y=64&z=200&block=minecolonies:blockhuttownhall
    private void handlePlace(HttpExchange exchange) throws IOException {
        if (!"POST".equalsIgnoreCase(exchange.getRequestMethod())) {
            respond(exchange, 405, "{\"error\":\"use POST\"}");
            return;
        }
        try {
            String query = exchange.getRequestURI().getQuery();
            java.util.Map<String, String> params = parseQuery(query);
            int x = Integer.parseInt(params.get("x"));
            int y = Integer.parseInt(params.get("y"));
            int z = Integer.parseInt(params.get("z"));
            String blockId = params.getOrDefault("block", "minecolonies:blockhuttownhall");

            // World mutation must happen on the server thread, not the HTTP
            // handler thread, so schedule it and block this thread for the result.
            java.util.concurrent.CompletableFuture<String> result = new java.util.concurrent.CompletableFuture<>();
            server.execute(() -> {
                try {
                    result.complete(placeOnServerThread(x, y, z, blockId));
                } catch (Exception e) {
                    result.complete("ERROR: " + e);
                }
            });
            String outcome = result.get();
            if (outcome.startsWith("ERROR")) {
                respond(exchange, 500, "{\"error\":\"" + escape(outcome) + "\"}");
            } else {
                respond(exchange, 200, "{\"result\":\"" + escape(outcome) + "\"}");
            }
        } catch (Exception e) {
            respond(exchange, 400, "{\"error\":\"" + escape(String.valueOf(e)) + "\"}");
        }
    }

    // POST /found?x=..&y=..&z=..&name=MyColony
    // Founds a colony on a previously-placed (but not yet colonized) town
    // hall, mirroring what CreateColonyMessage does when a player confirms
    // the in-game "found colony" prompt - but triggered over HTTP instead.
    private void handleFound(HttpExchange exchange) throws IOException {
        if (!"POST".equalsIgnoreCase(exchange.getRequestMethod())) {
            respond(exchange, 405, "{\"error\":\"use POST\"}");
            return;
        }
        try {
            java.util.Map<String, String> params = parseQuery(exchange.getRequestURI().getQuery());
            int x = Integer.parseInt(params.get("x"));
            int y = Integer.parseInt(params.get("y"));
            int z = Integer.parseInt(params.get("z"));
            String name = params.getOrDefault("name", "VoyagerColony");

            java.util.concurrent.CompletableFuture<String> result = new java.util.concurrent.CompletableFuture<>();
            server.execute(() -> {
                try {
                    result.complete(foundOnServerThread(x, y, z, name));
                } catch (Exception e) {
                    result.complete("ERROR: " + e);
                }
            });
            String outcome = result.get();
            if (outcome.startsWith("ERROR")) {
                respond(exchange, 500, "{\"error\":\"" + escape(outcome) + "\"}");
            } else {
                respond(exchange, 200, "{\"result\":\"" + escape(outcome) + "\"}");
            }
        } catch (Exception e) {
            respond(exchange, 400, "{\"error\":\"" + escape(String.valueOf(e)) + "\"}");
        }
    }

    private String foundOnServerThread(int x, int y, int z, String colonyName) {
        ServerLevel level = server.overworld();
        Player fakePlayer = new FakePlayer(level, AI_PROFILE);
        BlockPos pos = new BlockPos(x, y, z);

        // Placing a town-hall block already fires MineColonies' setPlacedBy, which
        // auto-creates a colony owned by the FakePlayer. So a colony usually exists
        // here already; only create one if it doesn't yet (a race where found ran
        // before the auto-creation finished).
        IColony owned = IColonyManager.getInstance().getIColonyByOwner(level, fakePlayer);
        if (owned == null) {
            BlockEntity tileEntity = level.getBlockEntity(pos);
            if (!(tileEntity instanceof TileEntityColonyBuilding)) {
                return "ERROR: no colony building tile entity at " + x + "," + y + "," + z;
            }
            StructurePackMeta pack = getPinnedPack();
            if (pack == null) {
                return "ERROR: no structure packs registered";
            }
            try {
                IColony created = IColonyManager.getInstance().createColony(level, pos, fakePlayer, colonyName, pack.getName());
                created.getServerBuildingManager().addNewBuilding((TileEntityColonyBuilding) tileEntity, level);
                owned = created;
            } catch (Exception e) {
                // createColony can NPE when the town-hall block entity isn't fully
                // linked yet (AbstractSchematicProvider.getTileEntity() null). The
                // setPlacedBy auto-creation usually wins that race - re-fetch it.
                owned = IColonyManager.getInstance().getIColonyByOwner(level, fakePlayer);
                if (owned == null) {
                    return "ERROR: found failed (" + e + ") and no auto-created colony present";
                }
            }
        }

        try { owned.setName(colonyName); } catch (Exception ignored) {}
        // An auto-created (setPlacedBy) colony defers its chunk claim, which is
        // never applied for an unattended colony - leaving the town hall
        // !inTerritory and blocking upgrades/work orders. Force the claim now,
        // mirroring the requestBuild/placeNext claim self-heal.
        try {
            IBuilding th = owned.getServerBuildingManager().getBuilding(pos);
            if (th != null) {
                forceLoadAndClaim(owned, level, pos, th.getClaimRadius(Math.max(1, th.getBuildingLevel())), th.getCorners());
            } else {
                forceLoadAndClaim(owned, level, pos, 2, null);
            }
        } catch (Exception e) {
            LOGGER.warn("found: territory claim self-heal failed at {}: {}", pos, e.toString());
        }
        String packName = owned.getStructurePack();
        return "founded colony " + owned.getID() + " (" + colonyName + ")"
            + (packName != null && !packName.isEmpty() ? " with pack " + packName : "");
    }

    // POST /spawnCitizen?colonyId=1
    private void handleSpawnCitizen(HttpExchange exchange) throws IOException {
        if (!"POST".equalsIgnoreCase(exchange.getRequestMethod())) {
            respond(exchange, 405, "{\"error\":\"use POST\"}");
            return;
        }
        try {
            java.util.Map<String, String> params = parseQuery(exchange.getRequestURI().getQuery());
            int colonyId = Integer.parseInt(params.get("colonyId"));

            java.util.concurrent.CompletableFuture<String> result = new java.util.concurrent.CompletableFuture<>();
            // Phase 1 (server thread): ensure max cap and force-load colony chunks.
            // setChunkForced schedules a ticket that ChunkMap.tick() processes on the
            // same or next server tick; isPositionEntityTicking won't be true until
            // after that tick completes. We run phase 1, sleep 100ms on the HTTP
            // thread (≈2 server ticks), then run phase 2 to do the actual spawn.
            java.util.concurrent.CompletableFuture<Void> phase1 = new java.util.concurrent.CompletableFuture<>();
            server.execute(() -> {
                try {
                    IColony colony = IColonyManager.getInstance().getColonyByWorld(colonyId, server.overworld());
                    if (colony == null) {
                        result.complete("ERROR: no colony with id " + colonyId);
                        phase1.complete(null);
                        return;
                    }
                    int before = colony.getCitizenManager().getCurrentCitizenCount();
                    int cap = colony.getCitizenManager().getMaxCitizens();
                    if (cap <= before) {
                        colony.getCitizenManager().setMaxCitizens(before + 1);
                    }
                    ServerLevel overworld = server.overworld();
                    BlockPos center = colony.getCenter();
                    // Force-load a 3×3 chunk area around town hall so entity ticking
                    // is enabled even with no player connected.
                    int cx = center.getX() >> 4;
                    int cz = center.getZ() >> 4;
                    for (int dx = -1; dx <= 1; dx++) {
                        for (int dz = -1; dz <= 1; dz++) {
                            overworld.setChunkForced(cx + dx, cz + dz, true);
                        }
                    }
                    phase1.complete(null);
                } catch (Exception e) {
                    LOGGER.error("spawnCitizen phase1 failed", e);
                    result.complete("ERROR: " + e);
                    phase1.complete(null);
                }
            });
            phase1.get(); // wait for phase 1 on HTTP thread
            Thread.sleep(120); // 2-3 ticks for ChunkMap to process the tickets
            // Phase 2 (server thread): spawn the citizen now that ticking is active.
            server.execute(() -> {
                try {
                    IColony colony = IColonyManager.getInstance().getColonyByWorld(colonyId, server.overworld());
                    if (colony == null || result.isDone()) { result.complete("ERROR: colony gone"); return; }
                    int before = colony.getCitizenManager().getCurrentCitizenCount();
                    ServerLevel overworld = server.overworld();
                    BlockPos center = colony.getCenter();
                    java.util.List<BlockPos> spawnPos = new java.util.ArrayList<>();
                    spawnPos.add(center);
                    colony.getCitizenManager().spawnOrCreateCivilian(null, overworld, spawnPos, true);
                    int after = colony.getCitizenManager().getCurrentCitizenCount();
                    result.complete("citizen count " + before + " -> " + after);
                } catch (Exception e) {
                    LOGGER.error("spawnCitizen phase2 failed", e);
                    result.complete("ERROR: " + e);
                }
            });
            String outcome = result.get();
            if (outcome.startsWith("ERROR")) {
                respond(exchange, 500, "{\"error\":\"" + escape(outcome) + "\"}");
            } else {
                respond(exchange, 200, "{\"result\":\"" + escape(outcome) + "\"}");
            }
        } catch (Exception e) {
            respond(exchange, 400, "{\"error\":\"" + escape(String.valueOf(e)) + "\"}");
        }
    }

    // GET /status - lists all colonies with id/name/center/citizen count, so
    // an LLM agent can decide what to do next without needing a game client.
    private void handleStatus(HttpExchange exchange) throws IOException {
        java.util.concurrent.CompletableFuture<String> result = new java.util.concurrent.CompletableFuture<>();
        server.execute(() -> {
            try {
                ServerLevel level = server.overworld();
                java.util.List<IColony> colonies = IColonyManager.getInstance().getAllColonies();
                StringBuilder sb = new StringBuilder("[");
                for (int i = 0; i < colonies.size(); i++) {
                    IColony c = colonies.get(i);
                    BlockPos center = c.getCenter();
                    if (i > 0) sb.append(",");
                    sb.append("{")
                      .append("\"id\":").append(c.getID()).append(",")
                      .append("\"name\":\"").append(escape(c.getName())).append("\",")
                      .append("\"x\":").append(center.getX()).append(",")
                      .append("\"y\":").append(center.getY()).append(",")
                      .append("\"z\":").append(center.getZ()).append(",")
                      .append("\"buildings\":[");
                    java.util.List<ICitizenData> citizens = c.getCitizenManager().getCitizens();
                    java.util.Map<BlockPos, IBuilding> buildings = c.getServerBuildingManager().getBuildings();
                    boolean firstBld = true;
                    for (java.util.Map.Entry<BlockPos, IBuilding> bldEntry : buildings.entrySet()) {
                        if (!firstBld) sb.append(",");
                        firstBld = false;
                        BlockPos bp = bldEntry.getKey();
                        IBuilding bld = bldEntry.getValue();
                        ResourceLocation bldKey = ForgeRegistries.BLOCKS.getKey(
                            level.getBlockState(bp).getBlock());
                        String bldType = bldKey != null ? bldKey.getPath() : "unknown";
                        boolean operational = bld.getBuildingLevel() >= 1 && !bld.isPendingConstruction();
                        boolean inTerritory = c.isCoordInColony(level, bp);
                        java.util.List<Integer> workerIds = citizens.stream()
                            .filter(w -> w.getWorkBuilding() != null
                                && w.getWorkBuilding().getPosition().equals(bp))
                            .map(ICitizenData::getId)
                            .collect(java.util.stream.Collectors.toList());
                        sb.append("{")
                          .append("\"x\":").append(bp.getX()).append(",")
                          .append("\"y\":").append(bp.getY()).append(",")
                          .append("\"z\":").append(bp.getZ()).append(",")
                          .append("\"type\":\"").append(escape(bldType)).append("\",")
                          .append("\"level\":").append(bld.getBuildingLevel()).append(",")
                          // Colonial's tavern tops out at 3, postbox at 1, etc. -
                          // council needs this to stop proposing impossible upgrades
                          // (requestUpgrade silently no-ops past max).
                          .append("\"maxLevel\":").append(bld.getMaxBuildingLevel()).append(",")
                          .append("\"pending\":").append(bld.isPendingConstruction()).append(",")
                          .append("\"operational\":").append(operational).append(",")
                          .append("\"inTerritory\":").append(inTerritory).append(",")
                          .append("\"workers\":").append(workerIds)
                          .append("}");
                    }
                    // Research-unlocked buildings: which research-gated building types
                    // have had their unlock-research completed in this colony.
                    sb.append("],\"researchUnlocked\":[");
                    boolean firstR = true;
                    for (String bType : RESEARCH_GATED_BUILDINGS) {
                        ResourceLocation eff = new ResourceLocation("minecolonies", "effects/" + bType);
                        if (c.getResearchManager().getResearchEffects().getEffectStrength(eff) > 0) {
                            if (!firstR) sb.append(",");
                            sb.append("\"").append(bType).append("\"");
                            firstR = false;
                        }
                    }
                    sb.append("],\"gameTime\":").append(level.getGameTime()).append(",\"citizens\":[");
                    for (int j = 0; j < citizens.size(); j++) {
                        ICitizenData cit = citizens.get(j);
                        if (j > 0) sb.append(",");
                        String jobName = cit.getJob() == null ? "unemployed"
                            : cit.getJob().getJobRegistryEntry().getKey().getPath();
                        String jobStatusStr = cit.getJobStatus() != null
                            ? cit.getJobStatus().name().toLowerCase() : "unknown";
                        IBuilding workBld = cit.getWorkBuilding();
                        sb.append("{")
                          .append("\"id\":").append(cit.getId()).append(",")
                          .append("\"name\":\"").append(escape(cit.getName())).append("\",")
                          .append("\"job\":\"").append(escape(jobName)).append("\",")
                          .append("\"jobStatus\":\"").append(jobStatusStr).append("\",")
                          // Saturation (0-20). Citizens stop working to hunt for food
                          // when this runs low, so supply agents feed them proactively.
                          .append("\"saturation\":").append(String.format(java.util.Locale.ROOT, "%.1f", cit.getSaturation())).append(",");
                        // Happiness (roughly 0-10) is the fitness signal for the
                        // persona heredity daemon; guard against handler quirks so
                        // /status never breaks over an optional field.
                        try {
                            double happiness = cit.getCitizenHappinessHandler().getHappiness(c, cit);
                            sb.append("\"happiness\":").append(String.format(java.util.Locale.ROOT, "%.2f", happiness)).append(",");
                        } catch (Exception ignored) {}
                        // Disease info so supply agents can deliver cure items. A sick
                        // citizen's EntityAISickTask self-cures (APPLY_CURE) once every
                        // cure item is present in the citizen's own inventory - the same
                        // delivery mechanism /giveToCitizen already provides.
                        boolean sick = false;
                        String diseaseId = null;
                        StringBuilder cures = new StringBuilder();
                        try {
                            com.minecolonies.api.entity.citizen.citizenhandlers.ICitizenDiseaseHandler dh =
                                cit.getCitizenDiseaseHandler();
                            if (dh != null && dh.isSick() && dh.getDisease() != null) {
                                sick = true;
                                com.minecolonies.core.datalistener.model.Disease disease = dh.getDisease();
                                diseaseId = disease.id().toString();
                                java.util.List<com.minecolonies.api.crafting.ItemStorage> cureItems = disease.cureItems();
                                for (int k = 0; k < cureItems.size(); k++) {
                                    if (k > 0) cures.append(",");
                                    ResourceLocation itemKey = ForgeRegistries.ITEMS.getKey(cureItems.get(k).getItem());
                                    cures.append("{\"item\":\"").append(itemKey)
                                         .append("\",\"count\":").append(cureItems.get(k).getAmount()).append("}");
                                }
                            }
                        } catch (Exception ignored) {}
                        sb.append("\"sick\":").append(sick).append(",")
                          .append("\"disease\":").append(diseaseId == null ? "null" : "\"" + diseaseId + "\"").append(",")
                          .append("\"cureItems\":[").append(cures).append("],");
                        // Family graph for the persona/heredity daemon (P-D3/P-D4).
                        // MineColonies records parents as NAMES (Tuple<String,String>,
                        // set at child birth), children/siblings as citizen IDs and the
                        // partner as ICitizenData - the Node side maps names to ids.
                        boolean isChildCit = false;
                        String parentA = null, parentB = null;
                        StringBuilder kidsJson = new StringBuilder();
                        StringBuilder sibsJson = new StringBuilder();
                        Integer partnerId = null;
                        try {
                            if (cit instanceof com.minecolonies.core.colony.CitizenData cdc) isChildCit = cdc.isChild();
                            com.minecolonies.api.util.Tuple<String, String> par = cit.getParents();
                            if (par != null) {
                                if (par.getA() != null && !par.getA().isEmpty()) parentA = par.getA();
                                if (par.getB() != null && !par.getB().isEmpty()) parentB = par.getB();
                            }
                            java.util.List<Integer> kids = cit.getChildren();
                            for (int k = 0; k < kids.size(); k++) {
                                if (k > 0) kidsJson.append(",");
                                kidsJson.append(kids.get(k));
                            }
                            java.util.List<Integer> sibs = cit.getSiblings();
                            for (int k = 0; k < sibs.size(); k++) {
                                if (k > 0) sibsJson.append(",");
                                sibsJson.append(sibs.get(k));
                            }
                            ICitizenData partner = cit.getPartner();
                            if (partner != null) partnerId = partner.getId();
                        } catch (Exception ignored) {}
                        sb.append("\"isChild\":").append(isChildCit).append(",")
                          .append("\"parents\":[");
                        if (parentA != null) sb.append("\"").append(escape(parentA)).append("\"");
                        if (parentB != null) sb.append(parentA != null ? "," : "").append("\"").append(escape(parentB)).append("\"");
                        sb.append("],\"children\":[").append(kidsJson).append("],")
                          .append("\"siblings\":[").append(sibsJson).append("],")
                          .append("\"partner\":").append(partnerId == null ? "null" : partnerId).append(",");
                        java.util.Optional<AbstractEntityCitizen> liveEntity = cit.getEntity();
                        if (liveEntity.isPresent()) {
                            BlockPos cp = liveEntity.get().blockPosition();
                            sb.append("\"position\":{")
                              .append("\"x\":").append(cp.getX()).append(",")
                              .append("\"y\":").append(cp.getY()).append(",")
                              .append("\"z\":").append(cp.getZ()).append("},");
                        } else {
                            sb.append("\"position\":null,");
                        }
                        if (workBld != null) {
                            BlockPos wp = workBld.getPosition();
                            sb.append("\"workBuilding\":{")
                              .append("\"x\":").append(wp.getX()).append(",")
                              .append("\"y\":").append(wp.getY()).append(",")
                              .append("\"z\":").append(wp.getZ()).append(",")
                              .append("\"level\":").append(workBld.getBuildingLevel())
                              .append("}");
                        } else {
                            sb.append("\"workBuilding\":null");
                        }
                        IBuilding homeBld = cit.getHomeBuilding();
                        if (homeBld != null) {
                            BlockPos hp = homeBld.getPosition();
                            sb.append(",\"homeBuilding\":{")
                              .append("\"x\":").append(hp.getX()).append(",")
                              .append("\"y\":").append(hp.getY()).append(",")
                              .append("\"z\":").append(hp.getZ()).append(",")
                              .append("\"level\":").append(homeBld.getBuildingLevel())
                              .append("}");
                        } else {
                            sb.append(",\"homeBuilding\":null");
                        }
                        sb.append("}");
                    }
                    sb.append("]}");
                }
                sb.append("]");
                result.complete(sb.toString());
            } catch (Exception e) {
                LOGGER.error("status failed", e);
                result.complete("ERROR: " + e);
            }
        });
        try {
            String outcome = result.get();
            if (outcome.startsWith("ERROR")) {
                respond(exchange, 500, "{\"error\":\"" + escape(outcome) + "\"}");
            } else {
                respond(exchange, 200, outcome);
            }
        } catch (Exception e) {
            respond(exchange, 500, "{\"error\":\"" + escape(String.valueOf(e)) + "\"}");
        }
    }

    // POST /requestBuild?x=..&y=..&z=..
    // Queues a work order for the building at this position, mirroring
    // BuildRequestMessage (the network message the in-game "Build" button
    // sends). Placing a hut block alone never creates a work order - that's
    // a separate, deliberate step in the GUI, so the colony's builders sit
    // idle forever without this.
    private void handleRequestBuild(HttpExchange exchange) throws IOException {
        if (!"POST".equalsIgnoreCase(exchange.getRequestMethod())) {
            respond(exchange, 405, "{\"error\":\"use POST\"}");
            return;
        }
        try {
            java.util.Map<String, String> params = parseQuery(exchange.getRequestURI().getQuery());
            int x = Integer.parseInt(params.get("x"));
            int y = Integer.parseInt(params.get("y"));
            int z = Integer.parseInt(params.get("z"));

            java.util.concurrent.CompletableFuture<String> result = new java.util.concurrent.CompletableFuture<>();
            server.execute(() -> {
                try {
                    ServerLevel level = server.overworld();
                    BlockPos pos = new BlockPos(x, y, z);
                    IColony colony = findColonyAt(level, pos);
                    if (colony == null) {
                        result.complete("ERROR: no colony at " + x + "," + y + "," + z);
                        return;
                    }
                    IBuilding building = colony.getServerBuildingManager().getBuilding(pos);
                    if (building == null) {
                        result.complete("ERROR: no building registered at " + x + "," + y + "," + z);
                        return;
                    }
                    if (building.isPendingConstruction()) {
                        result.complete("already has a pending work order");
                        return;
                    }
                    Block targetBlock = level.getBlockState(pos).getBlock();
                    ResourceLocation targetKey = ForgeRegistries.BLOCKS.getKey(targetBlock);
                    boolean isBuilderHut = targetKey != null && "blockhutbuilder".equals(targetKey.getPath());

                    // Research gate: some buildings require university research before
                    // they can be built. The effect ID follows the naming convention
                    // minecolonies:effects/<block_registry_path> (verified from JAR:
                    // effects/blockhutsawmill.json, effects/blockhutflorist.json, etc.).
                    // getResearchEffectIdFrom(Block) is unreliable server-side (returns
                    // null before research is done), so we use a static list of
                    // research-gated buildings derived from the JAR's effects/ directory,
                    // and check effect strength directly via the constructed effect ID.
                    if (!isBuilderHut && targetKey != null
                            && RESEARCH_GATED_BUILDINGS.contains(targetKey.getPath())) {
                        ResourceLocation effectId = new ResourceLocation("minecolonies",
                                "effects/" + targetKey.getPath());
                        double strength = colony.getResearchManager().getResearchEffects()
                                .getEffectStrength(effectId);
                        if (strength <= 0) {
                            result.complete("ERROR: " + targetKey.getPath()
                                + " requires university research (effect: " + effectId
                                + "); complete that research at the University first");
                            return;
                        }
                    }

                    // Builder level gate: upgrading a building from level N to N+1
                    // requires a Builder's Hut at level >= N+1. Level-0 builders can
                    // only build their own hut (exempted above). Queueing a work order
                    // no builder can execute leaves it stuck at 0/0 steps in the UI.
                    if (!isBuilderHut) {
                        int targetLevel = building.getBuildingLevel();          // current level
                        int requiredBuilderLevel = targetLevel + 1;             // need this to upgrade
                        boolean hasCapableBuilder = colony.getServerBuildingManager().getBuildings().values().stream()
                            .anyMatch(bld -> {
                                ResourceLocation bldKey = ForgeRegistries.BLOCKS.getKey(
                                    level.getBlockState(bld.getPosition()).getBlock());
                                return bldKey != null && "blockhutbuilder".equals(bldKey.getPath())
                                    && bld.getBuildingLevel() >= requiredBuilderLevel;
                            });
                        if (!hasCapableBuilder) {
                            result.complete("ERROR: upgrading this building (level " + targetLevel + "→" + (targetLevel + 1)
                                + ") needs a Builder's Hut at level " + requiredBuilderLevel
                                + "; upgrade a Builder's Hut first");
                            return;
                        }
                    }
                    // requestUpgrade's second argument is the BlockPos of the builder's
                    // hut that should handle this work order - NOT the target building's
                    // own position. Passing pos (the target building) worked for builder
                    // huts building themselves (pos == their own hut), but silently
                    // produced no work order for every other building type.
                    // For builder huts: assign to self (pos). For others: pick an
                    // idle lv1+ hut so work fans out across builders instead of
                    // always piling onto whichever hut the stream happens to
                    // enumerate first (previously every non-builder-hut work
                    // order landed on the same single builder while the rest
                    // sat idle - see requestBuild history).
                    BlockPos builderHutPos;
                    if (isBuilderHut) {
                        builderHutPos = pos;
                    } else {
                        // Only huts within the 100-block build radius
                        // (WorkOrderBuilding.canBuild) - assigning a farther
                        // hut binds its queue to an order it can never start.
                        java.util.List<IBuilding> capableBuilderHuts = colony.getServerBuildingManager().getBuildings().values().stream()
                            .filter(bld -> {
                                ResourceLocation bldKey = ForgeRegistries.BLOCKS.getKey(
                                    level.getBlockState(bld.getPosition()).getBlock());
                                return bldKey != null && "blockhutbuilder".equals(bldKey.getPath())
                                    && bld.getBuildingLevel() >= 1
                                    && bld.getPosition().distSqr(pos) <= 10000L;
                            })
                            .collect(java.util.stream.Collectors.toList());
                        if (capableBuilderHuts.isEmpty()) {
                            result.complete("ERROR: no builder hut within 100 blocks of " + x + "," + y + "," + z
                                + " (builders cannot construct beyond that radius; place a builder hut nearby first)");
                            return;
                        }
                        // Pick the hut with the fewest claimed work orders. Judging by
                        // the citizen's jobStatus alone doesn't balance anything: the
                        // status stays "idle" until the builder physically starts, so
                        // a burst of requests all saw every builder idle and piled
                        // onto the first hut in enumeration order.
                        java.util.Map<BlockPos, Long> claimedCounts =
                            colony.getWorkManager().getWorkOrders().values().stream()
                                .filter(wo -> wo.getClaimedBy() != null)
                                .collect(java.util.stream.Collectors.groupingBy(
                                    wo -> wo.getClaimedBy(), java.util.stream.Collectors.counting()));
                        builderHutPos = capableBuilderHuts.stream()
                            .map(IBuilding::getPosition)
                            .min(java.util.Comparator.comparingLong(
                                hutPos -> claimedCounts.getOrDefault(hutPos, 0L)))
                            .orElse(pos);
                    }
                    // If the building has no blueprint path (can happen when getBuilding(pos)
                    // returned null during /place and the IBuilding was not patched), fix it
                    // now before requestUpgrade reads the path to create the work order.
                    if (building.getBlueprintPath() == null || building.getBlueprintPath().isEmpty()) {
                        String typeName = targetKey != null ? targetKey.getPath().replaceFirst("^blockhut", "") : "";
                        String bpPath = BLUEPRINT_PATHS.get(typeName);
                        StructurePackMeta pack = getPinnedPack();
                        if (bpPath != null && pack != null) {
                            try { building.setStructurePack(pack.getName()); } catch (NullPointerException ignored) {}
                            try { building.setBlueprintPath(bpPath); } catch (NullPointerException ignored) {}
                            BlockEntity te = level.getBlockEntity(pos);
                            if (te instanceof TileEntityColonyBuilding) {
                                try { ((TileEntityColonyBuilding) te).setStructurePack(pack); } catch (Exception ignored) {}
                                try { ((TileEntityColonyBuilding) te).setBlueprintPath(bpPath); } catch (Exception ignored) {}
                            }
                        }
                    }
                    // Self-heal chunk claims. onPlacement()'s claimBuildingChunks
                    // throws for bridge-placed buildings (calculateCorners runs
                    // before pack/path are set), so footprint chunks can stay
                    // unclaimed - and WorkManager.addWorkOrder silently drops any
                    // order whose blueprint touches an unowned chunk
                    // (isWorkOrderWithinColony). Re-claim here, where pack/path
                    // are guaranteed set; claiming owned chunks is a no-op.
                    try {
                        int claimRadius = building.getClaimRadius(Math.max(1, building.getBuildingLevel()));
                        forceLoadAndClaim(colony, level, pos, claimRadius, building.getCorners());
                    } catch (Exception e) {
                        LOGGER.warn("re-claim before requestBuild failed for {}: {}", pos, e.toString());
                    }
                    String pathBeforeUpgrade = building.getBlueprintPath();
                    Player fakePlayer = new FakePlayer(level, AI_PROFILE);
                    building.requestUpgrade(fakePlayer, builderHutPos);
                    boolean nowPending = building.isPendingConstruction();
                    result.complete("requested build for building at " + x + "," + y + "," + z
                        + " (assigned to builder hut at " + builderHutPos + ")"
                        + (nowPending ? "" : " [WARN: not pending after requestUpgrade; path='" + pathBeforeUpgrade + "']"));
                } catch (Exception e) {
                    LOGGER.error("requestBuild failed", e);
                    result.complete("ERROR: " + e);
                }
            });
            String outcome = result.get();
            if (outcome.startsWith("ERROR")) {
                respond(exchange, 500, "{\"error\":\"" + escape(outcome) + "\"}");
            } else {
                respond(exchange, 200, "{\"result\":\"" + escape(outcome) + "\"}");
            }
        } catch (Exception e) {
            respond(exchange, 400, "{\"error\":\"" + escape(String.valueOf(e)) + "\"}");
        }
    }

    // POST /giveToCitizen?colonyId=1&citizenId=3&item=minecraft:oak_log&count=80
    // Inserts items directly into a citizen's personal inventory. Used as a
    // workaround while the colony's Warehouse is still level 0 (and so isn't
    // a functioning storage building yet) - the builder can use materials
    // it's personally carrying even before any warehouse exists.
    private void handleGiveToCitizen(HttpExchange exchange) throws IOException {
        if (!"POST".equalsIgnoreCase(exchange.getRequestMethod())) {
            respond(exchange, 405, "{\"error\":\"use POST\"}");
            return;
        }
        try {
            java.util.Map<String, String> params = parseQuery(exchange.getRequestURI().getQuery());
            int colonyId = Integer.parseInt(params.get("colonyId"));
            int citizenId = Integer.parseInt(params.get("citizenId"));
            String itemId = params.get("item");
            int count = Integer.parseInt(params.getOrDefault("count", "1"));

            java.util.concurrent.CompletableFuture<String> result = new java.util.concurrent.CompletableFuture<>();
            server.execute(() -> {
                try {
                    IColony colony = IColonyManager.getInstance().getColonyByWorld(colonyId, server.overworld());
                    if (colony == null) {
                        result.complete("ERROR: no colony with id " + colonyId);
                        return;
                    }
                    ICitizenData citizen = colony.getCitizenManager().getCivilian(citizenId);
                    if (citizen == null) {
                        result.complete("ERROR: no citizen with id " + citizenId);
                        return;
                    }
                    java.util.Optional<AbstractEntityCitizen> entityOpt = citizen.getEntity();
                    if (entityOpt.isEmpty()) {
                        result.complete("ERROR: citizen " + citizenId + " has no live entity right now");
                        return;
                    }
                    Item item = ForgeRegistries.ITEMS.getValue(new ResourceLocation(itemId));
                    if (item == null) {
                        result.complete("ERROR: unknown item id " + itemId);
                        return;
                    }
                    InventoryCitizen inv = entityOpt.get().getInventoryCitizen();
                    ItemStack remainder = new ItemStack(item, count);
                    int slots = inv.getSlots();
                    for (int slot = 0; slot < slots && !remainder.isEmpty(); slot++) {
                        remainder = inv.insertItem(slot, remainder, false);
                    }
                    int given = count - remainder.getCount();
                    result.complete("gave " + given + "/" + count + " of " + itemId + " to citizen " + citizenId);
                } catch (Exception e) {
                    LOGGER.error("giveToCitizen failed", e);
                    result.complete("ERROR: " + e);
                }
            });
            String outcome = result.get();
            if (outcome.startsWith("ERROR")) {
                respond(exchange, 500, "{\"error\":\"" + escape(outcome) + "\"}");
            } else {
                respond(exchange, 200, "{\"result\":\"" + escape(outcome) + "\"}");
            }
        } catch (Exception e) {
            respond(exchange, 400, "{\"error\":\"" + escape(String.valueOf(e)) + "\"}");
        }
    }

    // GET /citizenInventory?colonyId=1&citizenId=3
    // Read-only inventory summary for social-action feasibility checks. Counts
    // are aggregated by registry id so callers never depend on slot layout.
    private void handleCitizenInventory(HttpExchange exchange) throws IOException {
        if (!"GET".equalsIgnoreCase(exchange.getRequestMethod())) {
            respond(exchange, 405, "{\"error\":\"use GET\"}");
            return;
        }
        try {
            java.util.Map<String, String> params = parseQuery(exchange.getRequestURI().getQuery());
            int colonyId = Integer.parseInt(params.getOrDefault("colonyId", "1"));
            int citizenId = Integer.parseInt(params.get("citizenId"));
            java.util.concurrent.CompletableFuture<String> result = new java.util.concurrent.CompletableFuture<>();
            server.execute(() -> {
                try {
                    IColony colony = IColonyManager.getInstance().getColonyByWorld(colonyId, server.overworld());
                    if (colony == null) { result.complete("ERROR: no colony with id " + colonyId); return; }
                    ICitizenData citizen = colony.getCitizenManager().getCivilian(citizenId);
                    if (citizen == null) { result.complete("ERROR: no citizen with id " + citizenId); return; }
                    java.util.Optional<AbstractEntityCitizen> entityOpt = citizen.getEntity();
                    if (entityOpt.isEmpty()) {
                        result.complete("ERROR: citizen " + citizenId + " has no live entity right now");
                        return;
                    }
                    InventoryCitizen inv = entityOpt.get().getInventoryCitizen();
                    java.util.Map<String, Integer> counts = new java.util.TreeMap<>();
                    for (int slot = 0; slot < inv.getSlots(); slot++) {
                        ItemStack stack = inv.getStackInSlot(slot);
                        if (stack.isEmpty()) continue;
                        ResourceLocation key = ForgeRegistries.ITEMS.getKey(stack.getItem());
                        if (key != null) counts.merge(key.toString(), stack.getCount(), Integer::sum);
                    }
                    StringBuilder json = new StringBuilder("{\"citizenId\":")
                        .append(citizenId).append(",\"items\":[");
                    boolean first = true;
                    for (java.util.Map.Entry<String, Integer> entry : counts.entrySet()) {
                        if (!first) json.append(",");
                        json.append("{\"item\":\"").append(escape(entry.getKey()))
                            .append("\",\"count\":").append(entry.getValue()).append("}");
                        first = false;
                    }
                    json.append("]}");
                    result.complete(json.toString());
                } catch (Exception e) {
                    LOGGER.error("citizenInventory failed", e);
                    result.complete("ERROR: " + e);
                }
            });
            String outcome = result.get();
            if (outcome.startsWith("ERROR")) {
                respond(exchange, 500, "{\"error\":\"" + escape(outcome) + "\"}");
            } else {
                respond(exchange, 200, outcome);
            }
        } catch (Exception e) {
            respond(exchange, 400, "{\"error\":\"" + escape(String.valueOf(e)) + "\"}");
        }
    }

    // POST /transferCitizenItem?colonyId=1&fromCitizenId=2&toCitizenId=3&item=minecraft:bread&count=1
    // Atomically moves existing inventory between two live citizens. Unlike
    // /giveToCitizen this creates no resources, so a successful social-help
    // event corresponds to a real cost and a real recipient gain.
    private void handleTransferCitizenItem(HttpExchange exchange) throws IOException {
        if (!"POST".equalsIgnoreCase(exchange.getRequestMethod())) {
            respond(exchange, 405, "{\"error\":\"use POST\"}");
            return;
        }
        try {
            java.util.Map<String, String> params = parseQuery(exchange.getRequestURI().getQuery());
            int colonyId = Integer.parseInt(params.getOrDefault("colonyId", "1"));
            int fromId = Integer.parseInt(params.get("fromCitizenId"));
            int toId = Integer.parseInt(params.get("toCitizenId"));
            String itemId = params.get("item");
            int count = Integer.parseInt(params.getOrDefault("count", "1"));
            int maxDistance = Integer.parseInt(params.getOrDefault("maxDistance", "4"));
            if (fromId == toId) throw new IllegalArgumentException("citizens must differ");
            if (count <= 0 || count > 64) throw new IllegalArgumentException("count must be 1..64");
            if (maxDistance < 1 || maxDistance > 128) {
                throw new IllegalArgumentException("maxDistance must be 1..128");
            }

            java.util.concurrent.CompletableFuture<String> result = new java.util.concurrent.CompletableFuture<>();
            server.execute(() -> {
                try {
                    IColony colony = IColonyManager.getInstance().getColonyByWorld(colonyId, server.overworld());
                    if (colony == null) { result.complete("ERROR: no colony with id " + colonyId); return; }
                    ICitizenData from = colony.getCitizenManager().getCivilian(fromId);
                    ICitizenData to = colony.getCitizenManager().getCivilian(toId);
                    if (from == null || to == null) {
                        result.complete("ERROR: citizen not found (from=" + fromId + ", to=" + toId + ")");
                        return;
                    }
                    if (from.getEntity().isEmpty() || to.getEntity().isEmpty()) {
                        result.complete("ERROR: both citizens must have live entities");
                        return;
                    }
                    AbstractEntityCitizen fromEntity = from.getEntity().get();
                    AbstractEntityCitizen toEntity = to.getEntity().get();
                    double distance = fromEntity.distanceTo(toEntity);
                    if (distance > maxDistance) {
                        result.complete(String.format(java.util.Locale.ROOT,
                            "ERROR: citizens are %.1f blocks apart (maxDistance=%d)", distance, maxDistance));
                        return;
                    }
                    Item item = ForgeRegistries.ITEMS.getValue(new ResourceLocation(itemId));
                    if (item == null || item == net.minecraft.world.item.Items.AIR) {
                        result.complete("ERROR: unknown item id " + itemId); return;
                    }
                    InventoryCitizen fromInv = fromEntity.getInventoryCitizen();
                    InventoryCitizen toInv = toEntity.getInventoryCitizen();
                    int available = countItem(fromInv, item);
                    if (available < count) {
                        result.complete("ERROR: citizen " + fromId + " has " + available + "/" + count + " of " + itemId);
                        return;
                    }
                    ItemStack simulated = insertCitizenItem(toInv, new ItemStack(item, count), true);
                    if (!simulated.isEmpty()) {
                        result.complete("ERROR: citizen " + toId + " has room for only "
                            + (count - simulated.getCount()) + "/" + count + " of " + itemId);
                        return;
                    }
                    extractItem(fromInv, item, count);
                    ItemStack remainder = insertCitizenItem(toInv, new ItemStack(item, count), false);
                    if (!remainder.isEmpty()) {
                        // The capacity simulation and insertion run on the same
                        // server task, so this is defensive rollback only.
                        int delivered = count - remainder.getCount();
                        extractItem(toInv, item, delivered);
                        insertCitizenItem(fromInv, new ItemStack(item, count), false);
                        result.complete("ERROR: transfer changed unexpectedly; rolled back delivered items");
                        return;
                    }
                    result.complete("transferred " + count + " of " + itemId + " from citizen " + fromId
                        + " to citizen " + toId);
                } catch (Exception e) {
                    LOGGER.error("transferCitizenItem failed", e);
                    result.complete("ERROR: " + e);
                }
            });
            String outcome = result.get();
            if (outcome.startsWith("ERROR")) {
                respond(exchange, 500, "{\"error\":\"" + escape(outcome) + "\"}");
            } else {
                respond(exchange, 200, "{\"result\":\"" + escape(outcome) + "\"}");
            }
        } catch (Exception e) {
            respond(exchange, 400, "{\"error\":\"" + escape(String.valueOf(e)) + "\"}");
        }
    }

    private static ItemStack insertCitizenItem(InventoryCitizen inv, ItemStack stack, boolean simulate) {
        ItemStack remainder = stack;
        for (int slot = 0; slot < inv.getSlots() && !remainder.isEmpty(); slot++) {
            remainder = inv.insertItem(slot, remainder, simulate);
        }
        return remainder;
    }

    // GET  /neededResources?x=&y=&z=      - a builder hut's remaining material
    //      list for its current work order: [{item, needed, available, given:0}]
    // POST /fillBuilderResources?x=&y=&z= - same list, but first tops up every
    //      deficit (needed - available) into the hut's racks in one shot.
    //
    // The builder AI requests materials one item type at a time as construction
    // reaches them, so reactive request-resolution (supply_bot's default) costs
    // a request->deliver round-trip per item type. The building already tracks
    // the whole remaining bill of materials (AbstractBuildingStructureBuilder
    // .getNeededResources()), and the builder picks materials out of its hut's
    // racks before filing requests - so bulk-filling the racks up front removes
    // the ping-pong entirely. Tools/armor are NOT in this list and still flow
    // through the normal request path.
    private void handleNeededResources(HttpExchange exchange) throws IOException {
        handleBuilderResources(exchange, false);
    }

    private void handleFillBuilderResources(HttpExchange exchange) throws IOException {
        if (!"POST".equalsIgnoreCase(exchange.getRequestMethod())) {
            respond(exchange, 405, "{\"error\":\"use POST\"}");
            return;
        }
        handleBuilderResources(exchange, true);
    }

    private void handleBuilderResources(HttpExchange exchange, boolean fill) throws IOException {
        try {
            java.util.Map<String, String> params = parseQuery(exchange.getRequestURI().getQuery());
            int x = Integer.parseInt(params.get("x"));
            int y = Integer.parseInt(params.get("y"));
            int z = Integer.parseInt(params.get("z"));
            // Items the caller wants left to the colony's own crafter economy:
            // not bulk-delivered, so the builder requests them individually and
            // the request resolver routes them to a crafter with the taught
            // recipe (supply_bot passes its taught-outputs set here).
            java.util.Set<String> skip = new java.util.HashSet<>();
            for (String s : params.getOrDefault("skip", "").split(",")) {
                if (!s.trim().isEmpty()) skip.add(s.trim());
            }

            java.util.concurrent.CompletableFuture<String> result = new java.util.concurrent.CompletableFuture<>();
            server.execute(() -> {
                try {
                    ServerLevel level = server.overworld();
                    BlockPos pos = new BlockPos(x, y, z);
                    IColony colony = findColonyAt(level, pos);
                    if (colony == null) {
                        result.complete("ERROR: no colony at " + x + "," + y + "," + z);
                        return;
                    }
                    IBuilding building = colony.getServerBuildingManager().getBuilding(pos);
                    if (building == null) {
                        result.complete("ERROR: no building registered at " + x + "," + y + "," + z);
                        return;
                    }
                    if (!(building instanceof com.minecolonies.core.colony.buildings.AbstractBuildingStructureBuilder sb)) {
                        result.complete("ERROR: building at " + x + "," + y + "," + z
                                + " is not a structure-builder hut");
                        return;
                    }
                    net.minecraftforge.items.IItemHandler handler = null;
                    if (fill) {
                        com.minecolonies.api.tileentities.AbstractTileEntityColonyBuilding te = building.getTileEntity();
                        if (te == null) {
                            result.complete("ERROR: hut tile entity not loaded");
                            return;
                        }
                        handler = te.getCapability(net.minecraftforge.common.capabilities.ForgeCapabilities.ITEM_HANDLER)
                                .resolve().orElse(null);
                        if (handler == null) {
                            result.complete("ERROR: hut has no item handler capability");
                            return;
                        }
                    }
                    // Rack janitor + dump reserve (2026-07-07). Builders dump
                    // CLEAR-stage debris (dug dirt/stone) into their hut racks;
                    // if the racks are stuffed, the worker wedges in
                    // INVENTORY_FULL forever. On lv1 frontier huts the old
                    // fill-to-the-brim behaviour caused exactly that. Now:
                    // (1) evict rack stacks that are NOT on the current bill of
                    // materials (debris / stale leftovers - cheat economy, no
                    // loss that matters), (2) never fill past a reserve of
                    // empty slots kept free for the builder's dumps.
                    final int DUMP_RESERVE_SLOTS = 9;
                    int evicted = 0;
                    if (fill) {
                        java.util.List<ItemStack> neededProtos = new java.util.ArrayList<>();
                        for (com.minecolonies.core.colony.buildings.utils.BuildingBuilderResource r
                                : sb.getNeededResources().values()) {
                            neededProtos.add(r.getItemStack());
                        }
                        for (int slot = 0; slot < handler.getSlots(); slot++) {
                            ItemStack s = handler.getStackInSlot(slot);
                            if (s.isEmpty()) continue;
                            boolean needed0 = false;
                            for (ItemStack p : neededProtos) {
                                if (ItemStack.isSameItemSameTags(s, p)) { needed0 = true; break; }
                            }
                            if (!needed0) {
                                evicted += s.getCount();
                                handler.extractItem(slot, s.getCount(), false);
                            }
                        }
                    }
                    StringBuilder json = new StringBuilder("[");
                    boolean first = true;
                    for (com.minecolonies.core.colony.buildings.utils.BuildingBuilderResource res
                            : sb.getNeededResources().values()) {
                        ItemStack proto = res.getItemStack();
                        int needed = res.getAmount();
                        int available = res.getAvailable();
                        if (fill) {
                            // The module's availability counter resets to 0 whenever a
                            // new work order (re)computes its resource list and only
                            // catches up on a later tick - trusting it right after that
                            // reset would re-deliver items already sitting in the racks.
                            // Count the racks directly and use whichever is higher.
                            int inRacks = 0;
                            for (int slot = 0; slot < handler.getSlots(); slot++) {
                                ItemStack s = handler.getStackInSlot(slot);
                                if (!s.isEmpty() && ItemStack.isSameItemSameTags(s, proto)) {
                                    inRacks += s.getCount();
                                }
                            }
                            available = Math.max(available, inRacks);
                        }
                        ResourceLocation protoKey = ForgeRegistries.ITEMS.getKey(proto.getItem());
                        boolean leftToCrafters = protoKey != null && skip.contains(protoKey.toString());
                        int inserted = 0;
                        if (fill && !leftToCrafters && needed > available) {
                            int remaining = needed - available;
                            while (remaining > 0) {
                                int emptySlots = 0;
                                for (int slot = 0; slot < handler.getSlots(); slot++) {
                                    if (handler.getStackInSlot(slot).isEmpty()) emptySlots++;
                                }
                                if (emptySlots <= DUMP_RESERVE_SLOTS) break; // keep dump space
                                int chunkSize = Math.min(remaining, proto.getMaxStackSize());
                                ItemStack chunk = proto.copy();
                                chunk.setCount(chunkSize);
                                ItemStack leftover = chunk;
                                for (int slot = 0; slot < handler.getSlots() && !leftover.isEmpty(); slot++) {
                                    leftover = handler.insertItem(slot, leftover, false);
                                }
                                int put = chunkSize - leftover.getCount();
                                inserted += put;
                                remaining -= chunkSize;
                                if (put < chunkSize) break; // racks full
                            }
                            if (inserted > 0) {
                                // keep the module's availability bookkeeping in sync until
                                // its own tick recomputes it
                                res.setAvailable(available + inserted);
                            }
                        }
                        if (!first) json.append(",");
                        first = false;
                        json.append("{\"item\":\"")
                            .append(escape(String.valueOf(ForgeRegistries.ITEMS.getKey(proto.getItem()))))
                            .append("\",\"needed\":").append(needed)
                            .append(",\"available\":").append(available)
                            .append(",\"given\":").append(inserted)
                            .append("}");
                    }
                    json.append("]");
                    result.complete(json.toString());
                } catch (Exception e) {
                    LOGGER.error("builderResources failed", e);
                    result.complete("ERROR: " + e);
                }
            });
            String outcome = result.get();
            if (outcome.startsWith("ERROR")) {
                respond(exchange, 500, "{\"error\":\"" + escape(outcome) + "\"}");
            } else {
                respond(exchange, 200, outcome);
            }
        } catch (Exception e) {
            respond(exchange, 400, "{\"error\":\"" + escape(String.valueOf(e)) + "\"}");
        }
    }

    // POST /stockRestaurant?x=&y=&z=&countPerItem=32
    //
    // Tops the cook hut's racks up to countPerItem of every food on its
    // RestaurantMenuModule menu. The menu module does file MinimumStock
    // requests on colony ticks, but citizens queue at the restaurant faster
    // than that pipeline delivers at 10x - stocking the racks directly means
    // the cook can serve arrivals immediately instead of them loitering.
    private void handleStockRestaurant(HttpExchange exchange) throws IOException {
        if (!"POST".equalsIgnoreCase(exchange.getRequestMethod())) {
            respond(exchange, 405, "{\"error\":\"use POST\"}");
            return;
        }
        try {
            java.util.Map<String, String> params = parseQuery(exchange.getRequestURI().getQuery());
            int x = Integer.parseInt(params.get("x"));
            int y = Integer.parseInt(params.get("y"));
            int z = Integer.parseInt(params.get("z"));
            int target = Integer.parseInt(params.getOrDefault("countPerItem", "32"));
            // Menu items the colony can produce itself (baker's bread, the
            // cook's own dishes): skipping them here leaves the restaurant's
            // MinimumStock requests for the real economy to fulfil.
            java.util.Set<String> stockSkip = new java.util.HashSet<>();
            for (String s : params.getOrDefault("skip", "").split(",")) {
                if (!s.trim().isEmpty()) stockSkip.add(s.trim());
            }

            java.util.concurrent.CompletableFuture<String> result = new java.util.concurrent.CompletableFuture<>();
            server.execute(() -> {
                try {
                    ServerLevel level = server.overworld();
                    BlockPos pos = new BlockPos(x, y, z);
                    IColony colony = findColonyAt(level, pos);
                    if (colony == null) {
                        result.complete("ERROR: no colony at " + x + "," + y + "," + z);
                        return;
                    }
                    IBuilding building = colony.getServerBuildingManager().getBuilding(pos);
                    if (building == null) {
                        result.complete("ERROR: no building registered at " + x + "," + y + "," + z);
                        return;
                    }
                    com.minecolonies.core.colony.buildings.modules.RestaurantMenuModule menu =
                            building.getModule(com.minecolonies.core.colony.buildings.modules.BuildingModules.RESTAURANT_MENU);
                    if (menu == null) {
                        result.complete("ERROR: building at " + x + "," + y + "," + z
                                + " has no restaurant menu module (not a cook hut?)");
                        return;
                    }
                    com.minecolonies.api.tileentities.AbstractTileEntityColonyBuilding te = building.getTileEntity();
                    net.minecraftforge.items.IItemHandler handler = te == null ? null
                            : te.getCapability(net.minecraftforge.common.capabilities.ForgeCapabilities.ITEM_HANDLER)
                                .resolve().orElse(null);
                    if (handler == null) {
                        result.complete("ERROR: hut has no item handler (tile entity not loaded?)");
                        return;
                    }
                    StringBuilder json = new StringBuilder("[");
                    boolean first = true;
                    for (com.minecolonies.api.crafting.ItemStorage st : menu.getMenu()) {
                        ItemStack proto = st.getItemStack();
                        int have = 0;
                        for (int slot = 0; slot < handler.getSlots(); slot++) {
                            ItemStack s = handler.getStackInSlot(slot);
                            if (!s.isEmpty() && ItemStack.isSameItemSameTags(s, proto)) {
                                have += s.getCount();
                            }
                        }
                        ResourceLocation stKey = ForgeRegistries.ITEMS.getKey(proto.getItem());
                        int inserted = 0;
                        int remaining = (stKey != null && stockSkip.contains(stKey.toString())) ? 0 : target - have;
                        while (remaining > 0) {
                            int chunkSize = Math.min(remaining, proto.getMaxStackSize());
                            ItemStack chunk = proto.copy();
                            chunk.setCount(chunkSize);
                            ItemStack leftover = chunk;
                            for (int slot = 0; slot < handler.getSlots() && !leftover.isEmpty(); slot++) {
                                leftover = handler.insertItem(slot, leftover, false);
                            }
                            int put = chunkSize - leftover.getCount();
                            inserted += put;
                            remaining -= chunkSize;
                            if (put < chunkSize) break; // racks full
                        }
                        if (!first) json.append(",");
                        first = false;
                        json.append("{\"item\":\"")
                            .append(escape(String.valueOf(ForgeRegistries.ITEMS.getKey(proto.getItem()))))
                            .append("\",\"had\":").append(have)
                            .append(",\"given\":").append(inserted)
                            .append("}");
                    }
                    json.append("]");
                    result.complete(json.toString());
                } catch (Exception e) {
                    LOGGER.error("stockRestaurant failed", e);
                    result.complete("ERROR: " + e);
                }
            });
            String outcome = result.get();
            if (outcome.startsWith("ERROR")) {
                respond(exchange, 500, "{\"error\":\"" + escape(outcome) + "\"}");
            } else {
                respond(exchange, 200, outcome);
            }
        } catch (Exception e) {
            respond(exchange, 400, "{\"error\":\"" + escape(String.valueOf(e)) + "\"}");
        }
    }

    // POST /setMenu?x=200&y=-60&z=182&items=minecraft:bread,minecraft:cooked_beef
    //
    // Once a cook hut (restaurant) exists and is staffed, citizens stop eating
    // food from their own inventory and will only eat what is registered on the
    // restaurant's menu (RestaurantMenuModule - the list the player normally
    // edits in the hut GUI). A freshly built cook hut has an EMPTY menu, which
    // starves the entire colony. addMenuItem enforces edibility (FoodUtils.EDIBLE)
    // and a per-building-level size cap and silently ignores rejects, so the
    // response re-reads the menu to show what actually stuck.
    private void handleSetMenu(HttpExchange exchange) throws IOException {
        if (!"POST".equalsIgnoreCase(exchange.getRequestMethod())) {
            respond(exchange, 405, "{\"error\":\"use POST\"}");
            return;
        }
        try {
            java.util.Map<String, String> params = parseQuery(exchange.getRequestURI().getQuery());
            int x = Integer.parseInt(params.get("x"));
            int y = Integer.parseInt(params.get("y"));
            int z = Integer.parseInt(params.get("z"));
            String itemsCsv = params.getOrDefault("items", "");

            java.util.concurrent.CompletableFuture<String> result = new java.util.concurrent.CompletableFuture<>();
            server.execute(() -> {
                try {
                    ServerLevel level = server.overworld();
                    BlockPos pos = new BlockPos(x, y, z);
                    IColony colony = findColonyAt(level, pos);
                    if (colony == null) {
                        result.complete("ERROR: no colony at " + x + "," + y + "," + z);
                        return;
                    }
                    IBuilding building = colony.getServerBuildingManager().getBuilding(pos);
                    if (building == null) {
                        result.complete("ERROR: no building registered at " + x + "," + y + "," + z);
                        return;
                    }
                    com.minecolonies.core.colony.buildings.modules.RestaurantMenuModule menu =
                            building.getModule(com.minecolonies.core.colony.buildings.modules.BuildingModules.RESTAURANT_MENU);
                    if (menu == null) {
                        result.complete("ERROR: building at " + x + "," + y + "," + z
                                + " has no restaurant menu module (not a cook hut?)");
                        return;
                    }
                    for (String id : itemsCsv.split(",")) {
                        id = id.trim();
                        if (id.isEmpty()) continue;
                        Item item = ForgeRegistries.ITEMS.getValue(new ResourceLocation(id));
                        if (item == null) {
                            result.complete("ERROR: unknown item id " + id);
                            return;
                        }
                        menu.addMenuItem(new ItemStack(item, 1));
                    }
                    StringBuilder sb = new StringBuilder("menu now (" + menu.getMenu().size() + "): ");
                    boolean first = true;
                    for (com.minecolonies.api.crafting.ItemStorage st : menu.getMenu()) {
                        if (!first) sb.append(", ");
                        first = false;
                        sb.append(ForgeRegistries.ITEMS.getKey(st.getItemStack().getItem()));
                    }
                    result.complete(sb.toString());
                } catch (Exception e) {
                    LOGGER.error("setMenu failed", e);
                    result.complete("ERROR: " + e);
                }
            });
            String outcome = result.get();
            if (outcome.startsWith("ERROR")) {
                respond(exchange, 500, "{\"error\":\"" + escape(outcome) + "\"}");
            } else {
                respond(exchange, 200, "{\"result\":\"" + escape(outcome) + "\"}");
            }
        } catch (Exception e) {
            respond(exchange, 400, "{\"error\":\"" + escape(String.valueOf(e)) + "\"}");
        }
    }

    // ChunkDataHelper.tryClaimBuilding defers the claim of any UNLOADED chunk
    // to "next chunk load" (queued in the chunk manager) - which for an
    // unattended colony's frontier chunks is never. Force-load every chunk the
    // claim will touch first, so the claim takes the loaded path and sets
    // ownership immediately. The chunks may unload again afterwards; the
    // capability persists with the chunk data. (Root cause of the sawmill
    // work order silently vanishing, 2026-07-06.)
    private void forceLoadAndClaim(IColony colony, ServerLevel level, BlockPos pos, int radius,
            net.minecraft.util.Tuple<BlockPos, BlockPos> corners) {
        int anchorCX = pos.getX() >> 4, anchorCZ = pos.getZ() >> 4;
        java.util.HashSet<Long> chunks = new java.util.HashSet<>();
        for (int cx = anchorCX - radius; cx <= anchorCX + radius; cx++) {
            for (int cz = anchorCZ - radius; cz <= anchorCZ + radius; cz++) {
                chunks.add(((long) cx << 32) | (cz & 0xffffffffL));
            }
        }
        if (corners != null) {
            int minCX = Math.min(corners.getA().getX(), corners.getB().getX()) >> 4;
            int maxCX = Math.max(corners.getA().getX(), corners.getB().getX()) >> 4;
            int minCZ = Math.min(corners.getA().getZ(), corners.getB().getZ()) >> 4;
            int maxCZ = Math.max(corners.getA().getZ(), corners.getB().getZ()) >> 4;
            for (int cx = minCX; cx <= maxCX; cx++) {
                for (int cz = minCZ; cz <= maxCZ; cz++) {
                    chunks.add(((long) cx << 32) | (cz & 0xffffffffL));
                }
            }
        }
        // Don't go through ChunkDataHelper.tryClaimBuilding: its
        // WorldUtil.isChunkLoaded gate reads the VISIBLE chunk-holder map, which
        // doesn't include a chunk synchronously loaded this tick - the claim
        // would be re-queued to "next chunk load" (i.e. never, out here). We
        // hold the loaded LevelChunk already, so write the claim into its
        // capability directly, exactly like tryClaimBuilding's loaded path.
        for (long key : chunks) {
            net.minecraft.world.level.chunk.LevelChunk chunk =
                level.getChunk((int) (key >> 32), (int) key); // synchronous force load
            com.minecolonies.api.colony.IColonyTagCapability cap =
                chunk.getCapability(IColony.CLOSE_COLONY_CAP, null).resolve().orElse(null);
            if (cap != null) {
                cap.addBuildingClaim(colony.getID(), pos, chunk); // sets owner if unowned; idempotent otherwise
            }
        }
    }

    // POST /teachRecipe?x=&y=&z=&output=<item id>[&outputCount=1]&inputs=<id:count,id:count,...>[&grid=3]
    //
    // Teaches a crafter building a recipe, exactly like the crafting GUI's
    // teach button: build a RecipeStorage, register it with the global recipe
    // manager, then offer it to each of the building's crafting modules until
    // one accepts. The module's own canRecipeBeAdded enforces both the
    // capacity formula (2^buildingLevel x research x canLearnManyRecipes) and
    // the per-crafter compatibility tags (crafting_sawmill etc.), so no
    // validation is duplicated here. grid=1 marks a furnace (smelting) recipe
    // per the GUI's convention; 2/3 are crafting-grid recipes.
    private void handleTeachRecipe(HttpExchange exchange) throws IOException {
        if (!"POST".equalsIgnoreCase(exchange.getRequestMethod())) {
            respond(exchange, 405, "{\"error\":\"use POST\"}");
            return;
        }
        try {
            java.util.Map<String, String> params = parseQuery(exchange.getRequestURI().getQuery());
            int x = Integer.parseInt(params.get("x"));
            int y = Integer.parseInt(params.get("y"));
            int z = Integer.parseInt(params.get("z"));
            String outputId = params.get("output");
            int outputCount = Integer.parseInt(params.getOrDefault("outputCount", "1"));
            String inputsCsv = params.getOrDefault("inputs", "");
            int grid = Integer.parseInt(params.getOrDefault("grid", "3"));

            java.util.concurrent.CompletableFuture<String> result = new java.util.concurrent.CompletableFuture<>();
            server.execute(() -> {
                try {
                    ServerLevel level = server.overworld();
                    BlockPos pos = new BlockPos(x, y, z);
                    IColony colony = findColonyAt(level, pos);
                    if (colony == null) { result.complete("ERROR: no colony at " + x + "," + y + "," + z); return; }
                    IBuilding building = colony.getServerBuildingManager().getBuilding(pos);
                    if (building == null) { result.complete("ERROR: no building at " + x + "," + y + "," + z); return; }

                    Item outItem = ForgeRegistries.ITEMS.getValue(new ResourceLocation(outputId));
                    if (outItem == null || outItem == net.minecraft.world.item.Items.AIR) {
                        result.complete("ERROR: unknown output item " + outputId); return;
                    }
                    java.util.List<com.minecolonies.api.crafting.ItemStorage> inputs = new java.util.ArrayList<>();
                    for (String part : inputsCsv.split(",")) {
                        part = part.trim();
                        if (part.isEmpty()) continue;
                        String[] kv = part.split(":");
                        // item ids contain a namespace colon: ns:name[:count]
                        String id = kv.length >= 2 ? kv[0] + ":" + kv[1] : kv[0];
                        int count = kv.length >= 3 ? Integer.parseInt(kv[2]) : 1;
                        Item inItem = ForgeRegistries.ITEMS.getValue(new ResourceLocation(id));
                        if (inItem == null || inItem == net.minecraft.world.item.Items.AIR) {
                            result.complete("ERROR: unknown input item " + id); return;
                        }
                        inputs.add(new com.minecolonies.api.crafting.ItemStorage(new ItemStack(inItem, count)));
                    }
                    if (inputs.isEmpty()) { result.complete("ERROR: no inputs given"); return; }

                    com.minecolonies.api.crafting.IRecipeStorage storage =
                        com.minecolonies.api.crafting.RecipeStorage.builder()
                            .withInputs(inputs)
                            .withPrimaryOutput(new ItemStack(outItem, outputCount))
                            .withGridSize(grid)
                            .withIntermediate(grid == 1
                                ? net.minecraft.world.level.block.Blocks.FURNACE
                                : net.minecraft.world.level.block.Blocks.AIR)
                            .build();
                    com.minecolonies.api.colony.requestsystem.token.IToken<?> token =
                        IColonyManager.getInstance().getRecipeManager().checkOrAddRecipe(storage);

                    java.util.List<com.minecolonies.core.colony.buildings.modules.AbstractCraftingBuildingModule> modules =
                        building.getModulesByType(com.minecolonies.core.colony.buildings.modules.AbstractCraftingBuildingModule.class);
                    if (modules.isEmpty()) {
                        result.complete("ERROR: building at " + x + "," + y + "," + z + " has no crafting modules"); return;
                    }
                    for (com.minecolonies.core.colony.buildings.modules.AbstractCraftingBuildingModule m : modules) {
                        // already taught? (idempotency for the auto-teach loop)
                        for (com.minecolonies.api.colony.requestsystem.token.IToken<?> t : m.getRecipes()) {
                            com.minecolonies.api.crafting.IRecipeStorage rs =
                                IColonyManager.getInstance().getRecipeManager().getRecipes().get(t);
                            if (rs != null && ItemStack.isSameItem(rs.getPrimaryOutput(), storage.getPrimaryOutput())) {
                                result.complete("already taught: " + outputId + " (module " + m.getClass().getSimpleName() + ")");
                                return;
                            }
                        }
                    }
                    for (com.minecolonies.core.colony.buildings.modules.AbstractCraftingBuildingModule m : modules) {
                        if (m.addRecipe(token)) {
                            building.markDirty();
                            result.complete("taught " + outputId + " x" + outputCount + " to "
                                + m.getClass().getSimpleName() + " (recipes now " + m.getRecipes().size() + ")");
                            return;
                        }
                    }
                    result.complete("ERROR: no crafting module accepted the recipe (capacity full or incompatible with this crafter)");
                } catch (Exception e) {
                    LOGGER.error("teachRecipe failed", e);
                    result.complete("ERROR: " + e);
                }
            });
            String outcome = result.get();
            respond(exchange, outcome.startsWith("ERROR") ? 500 : 200,
                "{\"result\":\"" + escape(outcome) + "\"}");
        } catch (Exception e) {
            respond(exchange, 400, "{\"error\":\"" + escape(String.valueOf(e)) + "\"}");
        }
    }

    // GET /recipes?x=&y=&z= - taught recipes and capacity per crafting module.
    // getMaxRecipes is protected, so it's read via reflection; the auto-teach
    // loop uses "taught" + "max" to know when a building has free slots again
    // (level-ups and the RECIPES research both raise max).
    private void handleRecipes(HttpExchange exchange) throws IOException {
        try {
            java.util.Map<String, String> params = parseQuery(exchange.getRequestURI().getQuery());
            int x = Integer.parseInt(params.get("x"));
            int y = Integer.parseInt(params.get("y"));
            int z = Integer.parseInt(params.get("z"));
            java.util.concurrent.CompletableFuture<String> result = new java.util.concurrent.CompletableFuture<>();
            server.execute(() -> {
                try {
                    ServerLevel level = server.overworld();
                    BlockPos pos = new BlockPos(x, y, z);
                    IColony colony = findColonyAt(level, pos);
                    if (colony == null) { result.complete("{\"error\":\"no colony\"}"); return; }
                    IBuilding building = colony.getServerBuildingManager().getBuilding(pos);
                    if (building == null) { result.complete("{\"error\":\"no building\"}"); return; }
                    StringBuilder json = new StringBuilder("{\"modules\":[");
                    boolean firstM = true;
                    for (com.minecolonies.core.colony.buildings.modules.AbstractCraftingBuildingModule m
                            : building.getModulesByType(com.minecolonies.core.colony.buildings.modules.AbstractCraftingBuildingModule.class)) {
                        if (!firstM) json.append(',');
                        firstM = false;
                        int max = -1;
                        try {
                            java.lang.reflect.Method gm = com.minecolonies.core.colony.buildings.modules.AbstractCraftingBuildingModule.class
                                .getDeclaredMethod("getMaxRecipes");
                            gm.setAccessible(true);
                            max = (Integer) gm.invoke(m);
                        } catch (Exception ignored) {}
                        json.append("{\"module\":\"").append(m.getClass().getSimpleName())
                            .append("\",\"taught\":").append(m.getRecipes().size())
                            .append(",\"max\":").append(max).append(",\"recipes\":[");
                        boolean firstR = true;
                        for (com.minecolonies.api.colony.requestsystem.token.IToken<?> t : m.getRecipes()) {
                            com.minecolonies.api.crafting.IRecipeStorage rs =
                                IColonyManager.getInstance().getRecipeManager().getRecipes().get(t);
                            if (rs == null) continue;
                            if (!firstR) json.append(',');
                            firstR = false;
                            ResourceLocation outKey = ForgeRegistries.ITEMS.getKey(rs.getPrimaryOutput().getItem());
                            json.append("{\"output\":\"").append(outKey)
                                .append("\",\"count\":").append(rs.getPrimaryOutput().getCount()).append('}');
                        }
                        json.append("]}");
                    }
                    json.append("]}");
                    result.complete(json.toString());
                } catch (Exception e) {
                    LOGGER.error("recipes failed", e);
                    result.complete("{\"error\":\"" + escape(String.valueOf(e)) + "\"}");
                }
            });
            respond(exchange, 200, result.get());
        } catch (Exception e) {
            respond(exchange, 400, "{\"error\":\"" + escape(String.valueOf(e)) + "\"}");
        }
    }

    // GET /warehouseStats?colonyId=1 - rack occupancy of every warehouse.
    // "Is the warehouse full?" had no measurable answer before (user asked
    // twice); couriers wedge silently when they can't dump pickups.
    private void handleWarehouseStats(HttpExchange exchange) throws IOException {
        try {
            java.util.Map<String, String> params = parseQuery(exchange.getRequestURI().getQuery());
            int colonyId = Integer.parseInt(params.getOrDefault("colonyId", "1"));
            java.util.concurrent.CompletableFuture<String> result = new java.util.concurrent.CompletableFuture<>();
            server.execute(() -> {
                try {
                    ServerLevel level = server.overworld();
                    IColony colony = IColonyManager.getInstance().getColonyByWorld(colonyId, level);
                    if (colony == null) { result.complete("{\"error\":\"no colony\"}"); return; }
                    StringBuilder json = new StringBuilder("{\"warehouses\":[");
                    boolean first = true;
                    for (IBuilding b : colony.getServerBuildingManager().getBuildings().values()) {
                        if (!(b instanceof com.minecolonies.core.colony.buildings.workerbuildings.BuildingWareHouse wh)) continue;
                        int racks = 0, slots = 0, used = 0;
                        for (BlockPos rp : wh.getContainers()) {
                            BlockEntity te = level.getBlockEntity(rp);
                            if (!(te instanceof com.minecolonies.core.tileentities.TileEntityRack rack)
                                    || te instanceof TileEntityColonyBuilding) continue;
                            racks++;
                            net.minecraftforge.items.IItemHandler h = rack.getInventory();
                            slots += h.getSlots();
                            for (int i = 0; i < h.getSlots(); i++) {
                                if (!h.getStackInSlot(i).isEmpty()) used++;
                            }
                        }
                        if (!first) json.append(',');
                        first = false;
                        json.append("{\"pos\":\"").append(b.getPosition().toShortString())
                            .append("\",\"level\":").append(b.getBuildingLevel())
                            .append(",\"racks\":").append(racks)
                            .append(",\"slots\":").append(slots)
                            .append(",\"usedSlots\":").append(used)
                            .append(",\"fullness\":").append(slots == 0 ? 0 : Math.round(100.0 * used / slots) / 100.0)
                            .append('}');
                    }
                    json.append("]}");
                    result.complete(json.toString());
                } catch (Exception e) {
                    LOGGER.error("warehouseStats failed", e);
                    result.complete("{\"error\":\"" + escape(String.valueOf(e)) + "\"}");
                }
            });
            respond(exchange, 200, result.get());
        } catch (Exception e) {
            respond(exchange, 400, "{\"error\":\"" + escape(String.valueOf(e)) + "\"}");
        }
    }

    // POST /trimWarehouse?colonyId=1&keepPerItem=256[&dryRun=true]
    //
    // The warehouse hit 100% (6696/6696 slots) because 120 citizens' harvest
    // inflow has no outflow in a cheat economy. Caps each distinct item to
    // keepPerItem and voids the surplus (deletion is free here); dryRun just
    // reports the top stacks so the caller can see what's hoarded.
    private void handleTrimWarehouse(HttpExchange exchange) throws IOException {
        try {
            java.util.Map<String, String> params = parseQuery(exchange.getRequestURI().getQuery());
            int colonyId = Integer.parseInt(params.getOrDefault("colonyId", "1"));
            int keep = Integer.parseInt(params.getOrDefault("keepPerItem", "256"));
            boolean dryRun = "true".equalsIgnoreCase(params.getOrDefault("dryRun", "false"));
            java.util.concurrent.CompletableFuture<String> result = new java.util.concurrent.CompletableFuture<>();
            server.execute(() -> {
                try {
                    ServerLevel level = server.overworld();
                    IColony colony = IColonyManager.getInstance().getColonyByWorld(colonyId, level);
                    if (colony == null) { result.complete("{\"error\":\"no colony\"}"); return; }
                    java.util.Map<String, Integer> totals = new java.util.HashMap<>();
                    java.util.Map<String, Integer> trimmed = new java.util.HashMap<>();
                    for (IBuilding b : colony.getServerBuildingManager().getBuildings().values()) {
                        if (!(b instanceof com.minecolonies.core.colony.buildings.workerbuildings.BuildingWareHouse wh)) continue;
                        for (BlockPos rp : wh.getContainers()) {
                            BlockEntity te = level.getBlockEntity(rp);
                            if (!(te instanceof com.minecolonies.core.tileentities.TileEntityRack rack)
                                    || te instanceof TileEntityColonyBuilding) continue;
                            net.minecraftforge.items.IItemHandler h = rack.getInventory();
                            for (int i = 0; i < h.getSlots(); i++) {
                                ItemStack s = h.getStackInSlot(i);
                                if (s.isEmpty()) continue;
                                ResourceLocation k = ForgeRegistries.ITEMS.getKey(s.getItem());
                                String key = k == null ? "?" : k.toString();
                                int seen = totals.getOrDefault(key, 0);
                                totals.put(key, seen + s.getCount());
                                if (!dryRun && seen + s.getCount() > keep) {
                                    int over = Math.min(s.getCount(), seen + s.getCount() - keep);
                                    h.extractItem(i, over, false);
                                    trimmed.merge(key, over, Integer::sum);
                                }
                            }
                        }
                    }
                    java.util.List<java.util.Map.Entry<String, Integer>> top = new java.util.ArrayList<>(totals.entrySet());
                    top.sort((a, b2) -> b2.getValue() - a.getValue());
                    StringBuilder json = new StringBuilder("{\"distinctItems\":" + totals.size());
                    json.append(",\"trimmedTypes\":").append(trimmed.size());
                    json.append(",\"trimmedTotal\":").append(trimmed.values().stream().mapToInt(Integer::intValue).sum());
                    json.append(",\"topItems\":[");
                    for (int i = 0; i < Math.min(20, top.size()); i++) {
                        if (i > 0) json.append(',');
                        json.append("{\"item\":\"").append(escape(top.get(i).getKey()))
                            .append("\",\"count\":").append(top.get(i).getValue()).append('}');
                    }
                    json.append("]}");
                    result.complete(json.toString());
                } catch (Exception e) {
                    LOGGER.error("trimWarehouse failed", e);
                    result.complete("{\"error\":\"" + escape(String.valueOf(e)) + "\"}");
                }
            });
            respond(exchange, 200, result.get());
        } catch (Exception e) {
            respond(exchange, 400, "{\"error\":\"" + escape(String.valueOf(e)) + "\"}");
        }
    }

    // GET /scanHoles?minX=&minZ=&maxX=&maxZ=[&colonyId=1]
    //
    // Finds surface pits: columns whose top superflat layer (y=-61) is air.
    // Columns inside any registered building's footprint are skipped -
    // basements and active construction digs are intentional. Returns up to
    // 2000 hole columns for a fill script to close.
    private void handleScanHoles(HttpExchange exchange) throws IOException {
        try {
            java.util.Map<String, String> params = parseQuery(exchange.getRequestURI().getQuery());
            int minX = Integer.parseInt(params.getOrDefault("minX", "0"));
            int minZ = Integer.parseInt(params.getOrDefault("minZ", "0"));
            int maxX = Integer.parseInt(params.getOrDefault("maxX", "400"));
            int maxZ = Integer.parseInt(params.getOrDefault("maxZ", "400"));
            int colonyId = Integer.parseInt(params.getOrDefault("colonyId", "1"));
            java.util.concurrent.CompletableFuture<String> result = new java.util.concurrent.CompletableFuture<>();
            server.execute(() -> {
                try {
                    ServerLevel level = server.overworld();
                    IColony colony = IColonyManager.getInstance().getColonyByWorld(colonyId, level);
                    java.util.List<int[]> rects = new java.util.ArrayList<>();
                    if (colony != null) {
                        for (IBuilding b : colony.getServerBuildingManager().getBuildings().values()) {
                            int[] r = realFootprintRect(b);
                            if (r != null) rects.add(r);
                        }
                    }
                    StringBuilder json = new StringBuilder("{\"holes\":[");
                    int count = 0;
                    outer:
                    for (int x = minX; x <= maxX; x++) {
                        for (int z = minZ; z <= maxZ; z++) {
                            boolean inside = false;
                            for (int[] r : rects) {
                                if (x >= r[0] - 1 && x <= r[2] + 1 && z >= r[1] - 1 && z <= r[3] + 1) { inside = true; break; }
                            }
                            if (inside) continue;
                            BlockPos top = new BlockPos(x, -61, z);
                            if (!com.minecolonies.api.util.WorldUtil.isBlockLoaded(level, top)) continue;
                            if (!level.getBlockState(top).isAir()) continue;
                            if (count > 0) json.append(',');
                            json.append('[').append(x).append(',').append(z).append(']');
                            if (++count >= 2000) break outer;
                        }
                    }
                    json.append("],\"count\":").append(count).append('}');
                    result.complete(json.toString());
                } catch (Exception e) {
                    LOGGER.error("scanHoles failed", e);
                    result.complete("{\"error\":\"" + escape(String.valueOf(e)) + "\"}");
                }
            });
            respond(exchange, 200, result.get());
        } catch (Exception e) {
            respond(exchange, 400, "{\"error\":\"" + escape(String.valueOf(e)) + "\"}");
        }
    }

    // POST /setItemList?x=&y=&z=&listId=compostables&items=minecraft:wheat_seeds,minecraft:oak_sapling
    //
    // Generic setter for ItemListModule-based GUI configs (composter's
    // compostables list, etc.). Without the list the composter wedges at
    // GET_MATERIALS forever. Items are ADDED to the named list; the response
    // echoes the list size afterwards.
    private void handleSetItemList(HttpExchange exchange) throws IOException {
        if (!"POST".equalsIgnoreCase(exchange.getRequestMethod())) {
            respond(exchange, 405, "{\"error\":\"use POST\"}");
            return;
        }
        try {
            java.util.Map<String, String> params = parseQuery(exchange.getRequestURI().getQuery());
            int x = Integer.parseInt(params.get("x"));
            int y = Integer.parseInt(params.get("y"));
            int z = Integer.parseInt(params.get("z"));
            String listId = params.getOrDefault("listId", "compostables");
            String itemsCsv = params.getOrDefault("items", "");
            java.util.concurrent.CompletableFuture<String> result = new java.util.concurrent.CompletableFuture<>();
            server.execute(() -> {
                try {
                    ServerLevel level = server.overworld();
                    BlockPos pos = new BlockPos(x, y, z);
                    IColony colony = findColonyAt(level, pos);
                    if (colony == null) { result.complete("ERROR: no colony at " + x + "," + y + "," + z); return; }
                    IBuilding building = colony.getServerBuildingManager().getBuilding(pos);
                    if (building == null) { result.complete("ERROR: no building at " + x + "," + y + "," + z); return; }
                    com.minecolonies.core.colony.buildings.modules.ItemListModule module =
                        building.getModuleMatching(
                            com.minecolonies.core.colony.buildings.modules.ItemListModule.class,
                            m -> m.getId().equals(listId));
                    if (module == null) { result.complete("ERROR: no ItemListModule '" + listId + "' on this building"); return; }
                    int added = 0;
                    for (String id : itemsCsv.split(",")) {
                        id = id.trim();
                        if (id.isEmpty()) continue;
                        Item item = ForgeRegistries.ITEMS.getValue(new ResourceLocation(id));
                        if (item == null || item == net.minecraft.world.item.Items.AIR) {
                            result.complete("ERROR: unknown item " + id); return;
                        }
                        module.addItem(new com.minecolonies.api.crafting.ItemStorage(new ItemStack(item, 1)));
                        added++;
                    }
                    building.markDirty();
                    result.complete("added " + added + " item(s) to '" + listId + "' (list now "
                        + module.getList().size() + ")");
                } catch (Exception e) {
                    LOGGER.error("setItemList failed", e);
                    result.complete("ERROR: " + e);
                }
            });
            String outcome = result.get();
            respond(exchange, outcome.startsWith("ERROR") ? 500 : 200,
                "{\"result\":\"" + escape(outcome) + "\"}");
        } catch (Exception e) {
            respond(exchange, 400, "{\"error\":\"" + escape(String.valueOf(e)) + "\"}");
        }
    }

    // POST /setHiringMode?x=&y=&z=&mode=MANUAL|AUTO|DEFAULT[&fire=true]
    //
    // MANUAL stops the auto-hire loop from refilling the building (used to
    // decommission the mayor's surplus alchemist towers without deregistering
    // them - a deregistered building's structure becomes invisible to the
    // placement collision logic, which is worse). fire=true also unassigns
    // the current workers so they return to the jobless pool.
    private void handleSetHiringMode(HttpExchange exchange) throws IOException {
        if (!"POST".equalsIgnoreCase(exchange.getRequestMethod())) {
            respond(exchange, 405, "{\"error\":\"use POST\"}");
            return;
        }
        try {
            java.util.Map<String, String> params = parseQuery(exchange.getRequestURI().getQuery());
            int x = Integer.parseInt(params.get("x"));
            int y = Integer.parseInt(params.get("y"));
            int z = Integer.parseInt(params.get("z"));
            String mode = params.getOrDefault("mode", "MANUAL").toUpperCase(java.util.Locale.ROOT);
            boolean fire = "true".equalsIgnoreCase(params.getOrDefault("fire", "false"));
            java.util.concurrent.CompletableFuture<String> result = new java.util.concurrent.CompletableFuture<>();
            server.execute(() -> {
                try {
                    ServerLevel level = server.overworld();
                    BlockPos pos = new BlockPos(x, y, z);
                    IColony colony = findColonyAt(level, pos);
                    if (colony == null) { result.complete("ERROR: no colony at " + x + "," + y + "," + z); return; }
                    IBuilding building = colony.getServerBuildingManager().getBuilding(pos);
                    if (building == null) { result.complete("ERROR: no building at " + x + "," + y + "," + z); return; }
                    com.minecolonies.core.colony.buildings.modules.WorkerBuildingModule wm =
                        building.getFirstModuleOccurance(com.minecolonies.core.colony.buildings.modules.WorkerBuildingModule.class);
                    if (wm == null) { result.complete("ERROR: no worker module at " + x + "," + y + "," + z); return; }
                    wm.setHiringMode(com.minecolonies.api.colony.buildings.HiringMode.valueOf(mode));
                    int fired = 0;
                    if (fire) {
                        for (ICitizenData c : new java.util.ArrayList<>(wm.getAssignedCitizen())) {
                            wm.removeCitizen(c);
                            fired++;
                        }
                    }
                    building.markDirty();
                    result.complete("hiring mode " + mode + " at " + x + "," + y + "," + z
                        + (fire ? " (fired " + fired + ")" : ""));
                } catch (Exception e) {
                    LOGGER.error("setHiringMode failed", e);
                    result.complete("ERROR: " + e);
                }
            });
            String outcome = result.get();
            respond(exchange, outcome.startsWith("ERROR") ? 500 : 200,
                "{\"result\":\"" + escape(outcome) + "\"}");
        } catch (Exception e) {
            respond(exchange, 400, "{\"error\":\"" + escape(String.valueOf(e)) + "\"}");
        }
    }

    // POST /optimizeHomes?colonyId=1[&maxDist=50][&max=20][&dryRun=true]
    //
    // Citizens complain when home is far from work (a happiness penalty), and
    // MineColonies' home auto-assignment doesn't optimize for it. For each
    // worker whose home is more than maxDist blocks from their workplace, move
    // them to the nearest residence (blockhutcitizen) with a free bed that is
    // closer than their current home. Mirrors the residence-GUI reassignment
    // (remove from old LivingBuildingModule, assign to new).
    private void handleOptimizeHomes(HttpExchange exchange) throws IOException {
        try {
            java.util.Map<String, String> params = parseQuery(exchange.getRequestURI().getQuery());
            int colonyId = Integer.parseInt(params.getOrDefault("colonyId", "1"));
            double maxDist = Double.parseDouble(params.getOrDefault("maxDist", "50"));
            int max = Integer.parseInt(params.getOrDefault("max", "20"));
            boolean dryRun = "true".equalsIgnoreCase(params.getOrDefault("dryRun", "false"));
            java.util.concurrent.CompletableFuture<String> result = new java.util.concurrent.CompletableFuture<>();
            server.execute(() -> {
                try {
                    ServerLevel level = server.overworld();
                    IColony colony = IColonyManager.getInstance().getColonyByWorld(colonyId, level);
                    if (colony == null) { result.complete("{\"error\":\"no colony\"}"); return; }

                    // Residences with free beds.
                    class Res { com.minecolonies.core.colony.buildings.modules.LivingBuildingModule m; BlockPos pos; }
                    java.util.List<Res> residences = new java.util.ArrayList<>();
                    for (IBuilding b : colony.getServerBuildingManager().getBuildings().values()) {
                        if (b.getBuildingLevel() <= 0) continue;
                        ResourceLocation bk = ForgeRegistries.BLOCKS.getKey(
                            level.getBlockState(b.getPosition()).getBlock());
                        if (bk == null || !"blockhutcitizen".equals(bk.getPath())) continue;
                        com.minecolonies.core.colony.buildings.modules.LivingBuildingModule m =
                            b.getFirstModuleOccurance(com.minecolonies.core.colony.buildings.modules.LivingBuildingModule.class);
                        if (m == null) continue;
                        Res r = new Res(); r.m = m; r.pos = b.getPosition();
                        residences.add(r);
                    }

                    StringBuilder acts = new StringBuilder();
                    boolean first = true;
                    int moved = 0;
                    for (ICitizenData cd : colony.getCitizenManager().getCitizens()) {
                        if (moved >= max) break;
                        if (cd.getJob() == null || cd.getWorkBuilding() == null) continue;
                        BlockPos work = cd.getWorkBuilding().getPosition();
                        IBuilding homeB = cd.getHomeBuilding();
                        double curDist = homeB == null ? Double.MAX_VALUE
                            : Math.sqrt(homeB.getPosition().distSqr(work));
                        if (curDist <= maxDist) continue;
                        Res best = null; double bestDist = curDist;
                        for (Res r : residences) {
                            if (homeB != null && r.pos.equals(homeB.getPosition())) continue;
                            if (r.m.getAssignedCitizen().size() >= r.m.getModuleMax()) continue;
                            double d = Math.sqrt(r.pos.distSqr(work));
                            if (d < bestDist) { bestDist = d; best = r; }
                        }
                        if (best == null) continue;
                        if (!dryRun) {
                            if (homeB != null) {
                                com.minecolonies.core.colony.buildings.modules.LivingBuildingModule oldM =
                                    homeB.getFirstModuleOccurance(com.minecolonies.core.colony.buildings.modules.LivingBuildingModule.class);
                                if (oldM != null) oldM.removeCitizen(cd);
                            }
                            if (!best.m.assignCitizen(cd)) continue;
                        }
                        moved++;
                        if (!first) acts.append(',');
                        first = false;
                        acts.append("{\"citizen\":").append(cd.getId())
                            .append(",\"name\":\"").append(escape(cd.getName())).append('"')
                            .append(",\"fromDist\":").append(Math.round(curDist))
                            .append(",\"toDist\":").append(Math.round(bestDist))
                            .append(",\"home\":\"").append(best.pos.toShortString()).append("\"}");
                    }
                    result.complete("{\"dryRun\":" + dryRun + ",\"maxDist\":" + maxDist
                        + ",\"moved\":" + moved + ",\"moves\":[" + acts + "]}");
                } catch (Exception e) {
                    LOGGER.error("optimizeHomes failed", e);
                    result.complete("{\"error\":\"" + escape(String.valueOf(e)) + "\"}");
                }
            });
            respond(exchange, 200, result.get());
        } catch (Exception e) {
            respond(exchange, 400, "{\"error\":\"" + escape(String.valueOf(e)) + "\"}");
        }
    }

    // POST /assignHome?x=&y=&z=&citizenId=[&colonyId=1]
    //
    // Moves a citizen's HOME to the residence at (x,y,z). MineColonies only
    // exposes this via the residence GUI; auto-assignment ignores workplace
    // distance, so frontier workers commuted 180+ blocks each morning and -
    // at 10x, where a whole day is ~2 real minutes - reached the site just in
    // time for nightfall (the 64-order frontier stall, 2026-07-07). Mirrors
    // the GUI: remove from the old home's LivingBuildingModule, assign to the
    // new one.
    private void handleAssignHome(HttpExchange exchange) throws IOException {
        if (!"POST".equalsIgnoreCase(exchange.getRequestMethod())) {
            respond(exchange, 405, "{\"error\":\"use POST\"}");
            return;
        }
        try {
            java.util.Map<String, String> params = parseQuery(exchange.getRequestURI().getQuery());
            int x = Integer.parseInt(params.get("x"));
            int y = Integer.parseInt(params.get("y"));
            int z = Integer.parseInt(params.get("z"));
            int citizenId = Integer.parseInt(params.get("citizenId"));
            int colonyId = Integer.parseInt(params.getOrDefault("colonyId", "1"));

            java.util.concurrent.CompletableFuture<String> result = new java.util.concurrent.CompletableFuture<>();
            server.execute(() -> {
                try {
                    ServerLevel level = server.overworld();
                    IColony colony = IColonyManager.getInstance().getColonyByWorld(colonyId, level);
                    if (colony == null) { result.complete("ERROR: no colony " + colonyId); return; }
                    ICitizenData citizen = colony.getCitizenManager().getCivilian(citizenId);
                    if (citizen == null) { result.complete("ERROR: no citizen " + citizenId); return; }
                    IBuilding home = colony.getServerBuildingManager().getBuilding(new BlockPos(x, y, z));
                    if (home == null) { result.complete("ERROR: no building at " + x + "," + y + "," + z); return; }
                    com.minecolonies.core.colony.buildings.modules.LivingBuildingModule module =
                        home.getFirstModuleOccurance(com.minecolonies.core.colony.buildings.modules.LivingBuildingModule.class);
                    if (module == null) { result.complete("ERROR: building at " + x + "," + y + "," + z + " is not a residence"); return; }
                    IBuilding oldHome = citizen.getHomeBuilding();
                    if (oldHome != null) {
                        com.minecolonies.core.colony.buildings.modules.LivingBuildingModule oldModule =
                            oldHome.getFirstModuleOccurance(com.minecolonies.core.colony.buildings.modules.LivingBuildingModule.class);
                        if (oldModule != null) oldModule.removeCitizen(citizen);
                    }
                    boolean ok = module.assignCitizen(citizen);
                    result.complete(ok
                        ? "citizen " + citizenId + " now lives at " + x + "," + y + "," + z
                        : "ERROR: assignCitizen returned false (residence full?)");
                } catch (Exception e) {
                    LOGGER.error("assignHome failed", e);
                    result.complete("ERROR: " + e);
                }
            });
            String outcome = result.get();
            respond(exchange, outcome.startsWith("ERROR") ? 500 : 200,
                "{\"result\":\"" + escape(outcome) + "\"}");
        } catch (Exception e) {
            respond(exchange, 400, "{\"error\":\"" + escape(String.valueOf(e)) + "\"}");
        }
    }

    // GET /debugBuildGates?x=&y=&z=
    //
    // Dumps every gate that can silently swallow a requestBuild: the research
    // effect check in requestUpgrade, the duplicate-order check, canBeResolved,
    // and - the only gate with no log line at all - WorkManager's
    // isWorkOrderWithinColony (every chunk touched by the blueprint footprint
    // must be owned by the colony). Written for the 2026-07-06 sawmill order
    // that vanished without a trace.
    private void handleDebugBuildGates(HttpExchange exchange) throws IOException {
        try {
            java.util.Map<String, String> params = parseQuery(exchange.getRequestURI().getQuery());
            int x = Integer.parseInt(params.get("x"));
            int y = Integer.parseInt(params.get("y"));
            int z = Integer.parseInt(params.get("z"));

            java.util.concurrent.CompletableFuture<String> result = new java.util.concurrent.CompletableFuture<>();
            server.execute(() -> {
                try {
                    ServerLevel level = server.overworld();
                    BlockPos pos = new BlockPos(x, y, z);
                    IColony colony = findColonyAt(level, pos);
                    if (colony == null) { result.complete("{\"error\":\"no colony\"}"); return; }
                    IBuilding building = colony.getServerBuildingManager().getBuilding(pos);
                    if (building == null) { result.complete("{\"error\":\"no building\"}"); return; }

                    StringBuilder json = new StringBuilder("{");
                    json.append("\"pack\":\"").append(escape(String.valueOf(building.getStructurePack()))).append('"');
                    json.append(",\"path\":\"").append(escape(String.valueOf(building.getBlueprintPath()))).append('"');
                    json.append(",\"level\":").append(building.getBuildingLevel());

                    ResourceLocation hutResearch = colony.getResearchManager()
                        .getResearchEffectIdFrom(level.getBlockState(pos).getBlock());
                    boolean hasEffect = com.minecolonies.api.MinecoloniesAPIProxy.getInstance()
                        .getGlobalResearchTree().hasResearchEffect(hutResearch);
                    double strength = colony.getResearchManager().getResearchEffects().getEffectStrength(hutResearch);
                    json.append(",\"researchEffect\":\"").append(escape(String.valueOf(hutResearch)))
                        .append("\",\"hasEffect\":").append(hasEffect)
                        .append(",\"strength\":").append(strength);

                    int dup = 0;
                    for (com.minecolonies.core.colony.workorders.WorkOrderBuilding o
                            : colony.getWorkManager().getWorkOrdersOfType(
                                com.minecolonies.core.colony.workorders.WorkOrderBuilding.class)) {
                        if (o.getLocation().equals(building.getID())) dup++;
                    }
                    json.append(",\"duplicateOrders\":").append(dup);

                    boolean resolvable = colony.getServerBuildingManager().getBuildings().values().stream()
                        .anyMatch(b -> b instanceof com.minecolonies.core.colony.buildings.workerbuildings.BuildingBuilder
                            && !b.getAllAssignedCitizen().isEmpty() && b.getBuildingLevel() >= 1);
                    json.append(",\"canBeResolved\":").append(resolvable);

                    net.minecraft.util.Tuple<BlockPos, BlockPos> corners = building.getCorners();
                    json.append(",\"corners\":\"").append(corners.getA()).append(" / ").append(corners.getB()).append('"');
                    json.append(",\"chunks\":[");
                    int minX = Math.min(corners.getA().getX(), corners.getB().getX()) + 1;
                    int maxX = Math.max(corners.getA().getX(), corners.getB().getX());
                    int minZ = Math.min(corners.getA().getZ(), corners.getB().getZ()) + 1;
                    int maxZ = Math.max(corners.getA().getZ(), corners.getB().getZ());
                    boolean first = true;
                    java.util.HashSet<Long> seen = new java.util.HashSet<>();
                    for (int cx = minX; cx < maxX; cx += 16) {
                        for (int cz = minZ; cz < maxZ; cz += 16) {
                            int chunkX = cx >> 4, chunkZ = cz >> 4;
                            long key = ((long) chunkX << 32) | (chunkZ & 0xffffffffL);
                            if (!seen.add(key)) continue;
                            int owner = com.minecolonies.api.util.ColonyUtils.getOwningColony(
                                level.getChunk(chunkX, chunkZ));
                            if (!first) json.append(',');
                            first = false;
                            json.append("{\"chunk\":\"").append(chunkX).append(',').append(chunkZ)
                                .append("\",\"owner\":").append(owner).append('}');
                        }
                    }
                    json.append("]}");
                    result.complete(json.toString());
                } catch (Exception e) {
                    LOGGER.error("debugBuildGates failed", e);
                    result.complete("{\"error\":\"" + escape(String.valueOf(e)) + "\"}");
                }
            });
            respond(exchange, 200, result.get());
        } catch (Exception e) {
            respond(exchange, 400, "{\"error\":\"" + escape(String.valueOf(e)) + "\"}");
        }
    }

    // POST /upgradeWarehouse?x=&y=&z=[&times=3]
    //
    // The warehouse GUI's rack-capacity upgrade (normally 1 emerald block per
    // step, max 3 steps, independent of the hut's building level). Mirrors
    // UpgradeWarehouseMessage.onExecute minus the item cost - consistent with
    // the colony's cheat-supply policy. upgradeContainers() itself no-ops once
    // WarehouseModule.getStorageUpgrade() reaches 3, so over-calling is safe;
    // the response reports the resulting upgrade level.
    private void handleUpgradeWarehouse(HttpExchange exchange) throws IOException {
        if (!"POST".equalsIgnoreCase(exchange.getRequestMethod())) {
            respond(exchange, 405, "{\"error\":\"use POST\"}");
            return;
        }
        try {
            java.util.Map<String, String> params = parseQuery(exchange.getRequestURI().getQuery());
            int x = Integer.parseInt(params.get("x"));
            int y = Integer.parseInt(params.get("y"));
            int z = Integer.parseInt(params.get("z"));
            int times = Integer.parseInt(params.getOrDefault("times", "1"));

            java.util.concurrent.CompletableFuture<String> result = new java.util.concurrent.CompletableFuture<>();
            server.execute(() -> {
                try {
                    ServerLevel level = server.overworld();
                    BlockPos pos = new BlockPos(x, y, z);
                    IColony colony = findColonyAt(level, pos);
                    if (colony == null) {
                        result.complete("ERROR: no colony at " + x + "," + y + "," + z);
                        return;
                    }
                    IBuilding building = colony.getServerBuildingManager().getBuilding(pos);
                    if (!(building instanceof com.minecolonies.core.colony.buildings.workerbuildings.BuildingWareHouse wh)) {
                        result.complete("ERROR: building at " + x + "," + y + "," + z + " is not a warehouse");
                        return;
                    }
                    com.minecolonies.core.colony.buildings.modules.WarehouseModule module =
                            wh.getFirstModuleOccurance(
                                com.minecolonies.core.colony.buildings.modules.WarehouseModule.class);
                    int before = module.getStorageUpgrade();
                    for (int i = 0; i < times; i++) {
                        wh.upgradeContainers(level);
                    }
                    result.complete("storageUpgrade " + before + " -> " + module.getStorageUpgrade()
                            + " (max 3, racks " + wh.getContainers().size() + ")");
                } catch (Exception e) {
                    LOGGER.error("upgradeWarehouse failed", e);
                    result.complete("ERROR: " + e);
                }
            });
            String outcome = result.get();
            if (outcome.startsWith("ERROR")) {
                respond(exchange, 500, "{\"error\":\"" + escape(outcome) + "\"}");
            } else {
                respond(exchange, 200, "{\"result\":\"" + escape(outcome) + "\"}");
            }
        } catch (Exception e) {
            respond(exchange, 400, "{\"error\":\"" + escape(String.valueOf(e)) + "\"}");
        }
    }

    // POST /setFieldSeed?x=&y=&z=&seed=minecraft:wheat_seeds
    //
    // A farm field (scarecrow block) grows nothing until a seed is assigned,
    // which is normally done in the scarecrow GUI - without it the farmer never
    // starts working. (x,y,z) is the scarecrow's position. Mirrors what
    // FarmFieldUpdateSeedMessage.onExecute does server-side.
    private void handleSetFieldSeed(HttpExchange exchange) throws IOException {
        if (!"POST".equalsIgnoreCase(exchange.getRequestMethod())) {
            respond(exchange, 405, "{\"error\":\"use POST\"}");
            return;
        }
        try {
            java.util.Map<String, String> params = parseQuery(exchange.getRequestURI().getQuery());
            int x = Integer.parseInt(params.get("x"));
            int y = Integer.parseInt(params.get("y"));
            int z = Integer.parseInt(params.get("z"));
            String seedId = params.get("seed");

            java.util.concurrent.CompletableFuture<String> result = new java.util.concurrent.CompletableFuture<>();
            server.execute(() -> {
                try {
                    ServerLevel level = server.overworld();
                    BlockPos pos = new BlockPos(x, y, z);
                    IColony colony = findColonyAt(level, pos);
                    if (colony == null) {
                        result.complete("ERROR: no colony at " + x + "," + y + "," + z);
                        return;
                    }
                    Item seedItem = ForgeRegistries.ITEMS.getValue(new ResourceLocation(seedId));
                    if (seedItem == null) {
                        result.complete("ERROR: unknown item id " + seedId);
                        return;
                    }
                    java.util.Optional<com.minecolonies.api.colony.buildingextensions.IBuildingExtension> extOpt =
                            colony.getServerBuildingManager().getMatchingBuildingExtension(ext ->
                                    ext.getBuildingExtensionType()
                                            == com.minecolonies.api.colony.buildingextensions.registry.BuildingExtensionRegistries.farmField.get()
                                    && ext.getPosition().equals(pos));
                    if (extOpt.isEmpty()) {
                        result.complete("ERROR: no farm field registered at " + x + "," + y + "," + z
                                + " (is that the scarecrow position, and has the field been built?)");
                        return;
                    }
                    ((com.minecolonies.core.colony.buildingextensions.FarmField) extOpt.get())
                            .setSeed(new ItemStack(seedItem, 1));
                    colony.getServerBuildingManager().markBuildingExtensionsDirty();
                    result.complete("seed of field at " + x + "," + y + "," + z + " set to " + seedId);
                } catch (Exception e) {
                    LOGGER.error("setFieldSeed failed", e);
                    result.complete("ERROR: " + e);
                }
            });
            String outcome = result.get();
            if (outcome.startsWith("ERROR")) {
                respond(exchange, 500, "{\"error\":\"" + escape(outcome) + "\"}");
            } else {
                respond(exchange, 200, "{\"result\":\"" + escape(outcome) + "\"}");
            }
        } catch (Exception e) {
            respond(exchange, 400, "{\"error\":\"" + escape(String.valueOf(e)) + "\"}");
        }
    }

    // GET /debugCitizenAI?colonyId=1&citizenId=12
    //
    // Read-only dump of the internals CitizenAI.calculateNextState() uses to
    // decide WORK vs IDLE, for diagnosing citizens that wander instead of
    // working: a citizen only enters WORK when its job's workerAI is an
    // AbstractEntityAIBasic, canGoIdle() is false, and it has no leisure time
    // left (leisureTime is private, so reflection).
    private void handleDebugCitizenAI(HttpExchange exchange) throws IOException {
        try {
            java.util.Map<String, String> params = parseQuery(exchange.getRequestURI().getQuery());
            int colonyId = Integer.parseInt(params.getOrDefault("colonyId", "1"));
            int citizenId = Integer.parseInt(params.get("citizenId"));

            java.util.concurrent.CompletableFuture<String> result = new java.util.concurrent.CompletableFuture<>();
            server.execute(() -> {
                try {
                    IColony colony = IColonyManager.getInstance().getColonyByWorld(colonyId, server.overworld());
                    if (colony == null) {
                        result.complete("ERROR: no colony with id " + colonyId);
                        return;
                    }
                    ICitizenData data = colony.getCitizenManager().getCivilian(citizenId);
                    if (data == null) {
                        result.complete("ERROR: no citizen with id " + citizenId);
                        return;
                    }
                    StringBuilder sb = new StringBuilder("{");
                    int leisure = -1;
                    try {
                        java.lang.reflect.Field f =
                                com.minecolonies.core.colony.CitizenData.class.getDeclaredField("leisureTime");
                        f.setAccessible(true);
                        leisure = f.getInt(data);
                    } catch (Exception e) {
                        LOGGER.warn("leisureTime reflection failed", e);
                    }
                    sb.append("\"leisureTime\":").append(leisure);
                    sb.append(",\"saturation\":").append(String.format(java.util.Locale.ROOT, "%.1f", data.getSaturation()));

                    com.minecolonies.api.colony.jobs.IJob<?> job = data.getJob();
                    sb.append(",\"jobClass\":\"").append(job == null ? "" : job.getClass().getSimpleName()).append("\"");
                    Object workerAI = job == null ? null : job.getWorkerAI();
                    sb.append(",\"workerAIClass\":\"").append(workerAI == null ? "null" : workerAI.getClass().getSimpleName()).append("\"");
                    boolean isBasic = workerAI instanceof com.minecolonies.core.entity.ai.workers.AbstractEntityAIBasic;
                    sb.append(",\"workerAIIsBasic\":").append(isBasic);
                    boolean canGoIdle = false;
                    if (isBasic) {
                        try {
                            canGoIdle = ((com.minecolonies.core.entity.ai.workers.AbstractEntityAIBasic<?, ?>) workerAI).canGoIdle();
                        } catch (Exception e) {
                            sb.append(",\"canGoIdleError\":\"").append(escape(String.valueOf(e))).append("\"");
                        }
                    }
                    sb.append(",\"canGoIdle\":").append(canGoIdle);
                    sb.append(",\"canAIBeInterrupted\":").append(job != null && job.canAIBeInterrupted());
                    String entityState = data.getEntity()
                            .map(e -> e instanceof com.minecolonies.core.entity.citizen.EntityCitizen ec
                                    ? String.valueOf(ec.getCitizenAI().getState()) : "not-EntityCitizen")
                            .orElse("no-entity");
                    sb.append(",\"citizenAIState\":\"").append(escape(entityState)).append("\"");
                    sb.append("}");
                    result.complete(sb.toString());
                } catch (Exception e) {
                    LOGGER.error("debugCitizenAI failed", e);
                    result.complete("ERROR: " + e);
                }
            });
            String outcome = result.get();
            if (outcome.startsWith("ERROR")) {
                respond(exchange, 500, "{\"error\":\"" + escape(outcome) + "\"}");
            } else {
                respond(exchange, 200, outcome);
            }
        } catch (Exception e) {
            respond(exchange, 400, "{\"error\":\"" + escape(String.valueOf(e)) + "\"}");
        }
    }

    // GET /debugFarm?x=&y=&z=  (x,y,z = farmer hut position)
    //
    // Dumps why the farmer's BuildingExtensionsModule does or doesn't hand out
    // a field: the module only re-offers a field whose checkedExtensions day
    // stamp is OLDER than colony.getDay() (fields get stamped after 4 visits
    // with nothing to do), so a farmer can legitimately idle until the next
    // colony day - or forever, if the day counter doesn't advance.
    private void handleDebugFarm(HttpExchange exchange) throws IOException {
        try {
            java.util.Map<String, String> params = parseQuery(exchange.getRequestURI().getQuery());
            int x = Integer.parseInt(params.get("x"));
            int y = Integer.parseInt(params.get("y"));
            int z = Integer.parseInt(params.get("z"));

            java.util.concurrent.CompletableFuture<String> result = new java.util.concurrent.CompletableFuture<>();
            server.execute(() -> {
                try {
                    ServerLevel level = server.overworld();
                    BlockPos pos = new BlockPos(x, y, z);
                    IColony colony = findColonyAt(level, pos);
                    if (colony == null) {
                        result.complete("ERROR: no colony at " + x + "," + y + "," + z);
                        return;
                    }
                    IBuilding building = colony.getServerBuildingManager().getBuilding(pos);
                    if (building == null) {
                        result.complete("ERROR: no building registered at " + x + "," + y + "," + z);
                        return;
                    }
                    com.minecolonies.core.colony.buildings.modules.BuildingExtensionsModule module =
                            building.getFirstModuleOccurance(
                                    com.minecolonies.core.colony.buildings.modules.BuildingExtensionsModule.class);
                    if (module == null) {
                        result.complete("ERROR: building has no BuildingExtensionsModule");
                        return;
                    }
                    StringBuilder sb = new StringBuilder("{");
                    sb.append("\"colonyDay\":").append(colony.getDay());
                    sb.append(",\"worldDayTime\":").append(level.getDayTime());
                    Object currentId = null;
                    String checked = "?";
                    try {
                        java.lang.reflect.Field fCur = com.minecolonies.core.colony.buildings.modules.BuildingExtensionsModule.class
                                .getDeclaredField("currentExtensionId");
                        fCur.setAccessible(true);
                        currentId = fCur.get(module);
                        java.lang.reflect.Field fChk = com.minecolonies.core.colony.buildings.modules.BuildingExtensionsModule.class
                                .getDeclaredField("checkedExtensions");
                        fChk.setAccessible(true);
                        checked = String.valueOf(fChk.get(module));
                    } catch (Exception e) {
                        LOGGER.warn("debugFarm reflection failed", e);
                    }
                    sb.append(",\"currentExtensionId\":\"").append(escape(String.valueOf(currentId))).append("\"");
                    sb.append(",\"checkedExtensions\":\"").append(escape(checked)).append("\"");
                    Object toWorkOn = module.getExtensionToWorkOn();
                    sb.append(",\"extensionToWorkOn\":\"").append(toWorkOn == null ? "null"
                            : escape(String.valueOf(((com.minecolonies.api.colony.buildingextensions.IBuildingExtension) toWorkOn).getPosition()))).append("\"");
                    sb.append(",\"ownedExtensions\":[");
                    boolean first = true;
                    for (com.minecolonies.api.colony.buildingextensions.IBuildingExtension ext : module.getOwnedExtensions()) {
                        if (!first) sb.append(",");
                        first = false;
                        BlockPos p = ext.getPosition();
                        sb.append("{\"x\":").append(p.getX()).append(",\"y\":").append(p.getY()).append(",\"z\":").append(p.getZ());
                        if (ext instanceof com.minecolonies.core.colony.buildingextensions.FarmField farm) {
                            sb.append(",\"stage\":\"").append(farm.getFieldStage()).append("\"");
                            ItemStack seed = farm.getSeed();
                            sb.append(",\"seed\":\"").append(seed == null || seed.isEmpty() ? ""
                                    : escape(String.valueOf(ForgeRegistries.ITEMS.getKey(seed.getItem())))).append("\"");
                        }
                        sb.append("}");
                    }
                    sb.append("]}");
                    result.complete(sb.toString());
                } catch (Exception e) {
                    LOGGER.error("debugFarm failed", e);
                    result.complete("ERROR: " + e);
                }
            });
            String outcome = result.get();
            if (outcome.startsWith("ERROR")) {
                respond(exchange, 500, "{\"error\":\"" + escape(outcome) + "\"}");
            } else {
                respond(exchange, 200, outcome);
            }
        } catch (Exception e) {
            respond(exchange, 400, "{\"error\":\"" + escape(String.valueOf(e)) + "\"}");
        }
    }

    // GET /debugBuilder?x=&y=&z=  (x,y,z = builder hut position)
    //
    // Dumps the inputs of WorkManager.tryAssignWorkOrder for one hut, to see
    // why a claimed work order isn't being bound to the building: binding
    // requires the hut's WorkerBuildingModule to have a citizen, the hut to
    // have no current work order, and the order's claimedBy to equal the
    // hut's position.
    private void handleDebugBuilder(HttpExchange exchange) throws IOException {
        try {
            java.util.Map<String, String> params = parseQuery(exchange.getRequestURI().getQuery());
            int x = Integer.parseInt(params.get("x"));
            int y = Integer.parseInt(params.get("y"));
            int z = Integer.parseInt(params.get("z"));

            java.util.concurrent.CompletableFuture<String> result = new java.util.concurrent.CompletableFuture<>();
            server.execute(() -> {
                try {
                    ServerLevel level = server.overworld();
                    BlockPos pos = new BlockPos(x, y, z);
                    IColony colony = findColonyAt(level, pos);
                    if (colony == null) {
                        result.complete("ERROR: no colony at " + x + "," + y + "," + z);
                        return;
                    }
                    IBuilding building = colony.getServerBuildingManager().getBuilding(pos);
                    if (!(building instanceof com.minecolonies.core.colony.buildings.AbstractBuildingStructureBuilder sb)) {
                        result.complete("ERROR: not a structure-builder hut at " + x + "," + y + "," + z);
                        return;
                    }
                    StringBuilder sbj = new StringBuilder("{");
                    sbj.append("\"class\":\"").append(building.getClass().getSimpleName()).append("\"");
                    sbj.append(",\"level\":").append(building.getBuildingLevel());
                    int woId = -1;
                    try {
                        java.lang.reflect.Field f = com.minecolonies.core.colony.buildings.AbstractBuildingStructureBuilder.class
                                .getDeclaredField("workOrderId");
                        f.setAccessible(true);
                        woId = f.getInt(sb);
                    } catch (Exception e) {
                        LOGGER.warn("workOrderId reflection failed", e);
                    }
                    sbj.append(",\"workOrderId\":").append(woId);
                    sbj.append(",\"hasWorkOrder\":").append(sb.hasWorkOrder());
                    com.minecolonies.core.colony.buildings.modules.WorkerBuildingModule wm =
                            building.getFirstModuleOccurance(com.minecolonies.core.colony.buildings.modules.WorkerBuildingModule.class);
                    ICitizenData first = wm == null ? null : wm.getFirstCitizen();
                    sbj.append(",\"workerModule\":").append(wm != null);
                    sbj.append(",\"firstCitizen\":").append(first == null ? "null" : first.getId());
                    sbj.append(",\"buildingID\":\"").append(building.getID().toShortString()).append("\"");
                    sbj.append(",\"orders\":[");
                    boolean firstOrd = true;
                    for (com.minecolonies.api.colony.workorders.IWorkOrder wo : colony.getWorkManager().getWorkOrders().values()) {
                        if (!firstOrd) sbj.append(",");
                        firstOrd = false;
                        sbj.append("{\"id\":").append(wo.getID())
                           .append(",\"claimedBy\":\"").append(wo.getClaimedBy() == null ? "null" : wo.getClaimedBy().toShortString()).append("\"")
                           .append(",\"claimedEqualsThisHut\":")
                           .append(wo.getClaimedBy() != null && wo.getClaimedBy().equals(building.getPosition()))
                           .append(",\"isClaimed\":").append(wo.isClaimed())
                           .append("}");
                    }
                    sbj.append("]}");
                    result.complete(sbj.toString());
                } catch (Exception e) {
                    LOGGER.error("debugBuilder failed", e);
                    result.complete("ERROR: " + e);
                }
            });
            String outcome = result.get();
            if (outcome.startsWith("ERROR")) {
                respond(exchange, 500, "{\"error\":\"" + escape(outcome) + "\"}");
            } else {
                respond(exchange, 200, outcome);
            }
        } catch (Exception e) {
            respond(exchange, 400, "{\"error\":\"" + escape(String.valueOf(e)) + "\"}");
        }
    }

    // POST /assignWorker?x=&y=&z=&citizenId=N[&fire=true]
    //
    // Hire a specific citizen into the building at (x,y,z), releasing them
    // from their current workplace first (mirrors HireFireMessage: the GUI's
    // hire/fire buttons call IAssignsJob.assignCitizen/removeCitizen). With
    // fire=true just removes them. Needed because MineColonies only auto-hires
    // UNEMPLOYED citizens - reassigning an employed one is a GUI-only action.
    private static final com.minecolonies.api.entity.citizen.Skill[] ALL_SKILLS =
        com.minecolonies.api.entity.citizen.Skill.values();

    // Job-fit score: primary double-weighted (mirrors MineColonies' own
    // primary-centric levelling), secondary breaks ties.
    private int fitScore(ICitizenData c, com.minecolonies.api.entity.citizen.Skill primary,
                         com.minecolonies.api.entity.citizen.Skill secondary) {
        com.minecolonies.api.entity.citizen.citizenhandlers.ICitizenSkillHandler sh =
            c.getCitizenSkillHandler();
        return 2 * sh.getLevel(primary) + sh.getLevel(secondary);
    }

    // Buildings whose worker slots are combat / training / children / students -
    // excluded from the civilian job matcher. Their own auto-hire handles them.
    private static final java.util.Set<String> NON_CIVILIAN_BUILDINGS = java.util.Set.of(
        "blockhutguardtower", "blockhutbarracks", "blockhutbarrackstower",
        "blockhutcombatacademy", "blockhutarchery", "blockhutgatehouse",
        "blockhutstable", "blockhutschool", "blockhutlibrary");

    // GET /citizenSkills?colonyId=1 - read-only. Every citizen's id/name/child
    // flag/jobless flag/workplace + all 11 skill levels. This is the "see the
    // unemployed's stats" view; also the matcher's raw input.
    private void handleCitizenSkills(HttpExchange exchange) throws IOException {
        try {
            java.util.Map<String, String> params = parseQuery(exchange.getRequestURI().getQuery());
            int colonyId = Integer.parseInt(params.getOrDefault("colonyId", "1"));
            java.util.concurrent.CompletableFuture<String> result = new java.util.concurrent.CompletableFuture<>();
            server.execute(() -> {
                try {
                    ServerLevel level = server.overworld();
                    IColony colony = IColonyManager.getInstance().getColonyByWorld(colonyId, level);
                    if (colony == null) { result.complete("{\"error\":\"no colony\"}"); return; }
                    StringBuilder json = new StringBuilder("{\"citizens\":[");
                    boolean firstC = true;
                    for (ICitizenData cd : colony.getCitizenManager().getCitizens()) {
                        if (!firstC) json.append(',');
                        firstC = false;
                        String workBlock = "null";
                        if (cd.getWorkBuilding() != null) {
                            ResourceLocation k = ForgeRegistries.BLOCKS.getKey(
                                level.getBlockState(cd.getWorkBuilding().getPosition()).getBlock());
                            if (k != null) workBlock = "\"" + escape(k.getPath()) + "\"";
                        }
                        json.append("{\"id\":").append(cd.getId())
                            .append(",\"name\":\"").append(escape(cd.getName())).append('"')
                            .append(",\"child\":").append(cd.isChild())
                            .append(",\"jobless\":").append(cd.getJob() == null)
                            .append(",\"workBuilding\":").append(workBlock)
                            .append(",\"skills\":{");
                        com.minecolonies.api.entity.citizen.citizenhandlers.ICitizenSkillHandler sh =
                            cd.getCitizenSkillHandler();
                        boolean firstS = true;
                        for (com.minecolonies.api.entity.citizen.Skill sk : ALL_SKILLS) {
                            if (!firstS) json.append(',');
                            firstS = false;
                            json.append('"').append(sk.name()).append("\":").append(sh.getLevel(sk));
                        }
                        json.append("}}");
                    }
                    json.append("]}");
                    result.complete(json.toString());
                } catch (Exception e) {
                    LOGGER.error("citizenSkills failed", e);
                    result.complete("{\"error\":\"" + escape(String.valueOf(e)) + "\"}");
                }
            });
            respond(exchange, 200, result.get());
        } catch (Exception e) {
            respond(exchange, 400, "{\"error\":\"" + escape(String.valueOf(e)) + "\"}");
        }
    }

    // POST /autoAssignJobs?colonyId=1[&max=20][&dryRun=true]
    //
    // Skill-optimal job assignment: MineColonies' own auto-hire grabs an
    // ARBITRARY jobless citizen (getJoblessCitizen), ignoring skills. This
    // matches unemployed adults to open civilian worker slots by fit score
    // 2*primary + secondary (primary-weighted, mirroring MineColonies' own
    // primary-centric levelling), greedy best-first. Runs server-side so it
    // holds the exact module reference and assigns to the right module even in
    // multi-module huts. Combat/training/children/student buildings excluded.
    private void handleAutoAssignJobs(HttpExchange exchange) throws IOException {
        try {
            java.util.Map<String, String> params = parseQuery(exchange.getRequestURI().getQuery());
            int colonyId = Integer.parseInt(params.getOrDefault("colonyId", "1"));
            int max = Integer.parseInt(params.getOrDefault("max", "20"));
            boolean dryRun = "true".equalsIgnoreCase(params.getOrDefault("dryRun", "false"));
            boolean reassign = "true".equalsIgnoreCase(params.getOrDefault("reassign", "false"));
            int threshold = Integer.parseInt(params.getOrDefault("threshold", "10"));
            java.util.concurrent.CompletableFuture<String> result = new java.util.concurrent.CompletableFuture<>();
            server.execute(() -> {
                try {
                    ServerLevel level = server.overworld();
                    IColony colony = IColonyManager.getInstance().getColonyByWorld(colonyId, level);
                    if (colony == null) { result.complete("{\"error\":\"no colony\"}"); return; }

                    // Assignable pool: unemployed adults.
                    java.util.List<ICitizenData> pool = new java.util.ArrayList<>();
                    for (ICitizenData cd : colony.getCitizenManager().getCitizens()) {
                        if (cd.getJob() == null && !cd.isChild()) pool.add(cd);
                    }
                    int unemployedCount = pool.size();

                    // Every civilian assignment slot (open or filled).
                    class Slot {
                        com.minecolonies.core.colony.buildings.modules.WorkerBuildingModule m;
                        com.minecolonies.api.entity.citizen.Skill primary, secondary;
                        String building; int open;
                    }
                    java.util.List<Slot> slots = new java.util.ArrayList<>();
                    for (IBuilding b : colony.getServerBuildingManager().getBuildings().values()) {
                        if (b.getBuildingLevel() <= 0) continue;
                        ResourceLocation bk = ForgeRegistries.BLOCKS.getKey(
                            level.getBlockState(b.getPosition()).getBlock());
                        String bpath = bk == null ? "" : bk.getPath();
                        if (NON_CIVILIAN_BUILDINGS.contains(bpath)) continue;
                        for (com.minecolonies.core.colony.buildings.modules.WorkerBuildingModule m
                                : b.getModulesByType(com.minecolonies.core.colony.buildings.modules.WorkerBuildingModule.class)) {
                            if (m instanceof com.minecolonies.core.colony.buildings.modules.GuardBuildingModule) continue;
                            if (m instanceof com.minecolonies.core.colony.buildings.modules.ChildrenBuildingModule) continue;
                            if (m.getPrimarySkill() == com.minecolonies.api.entity.citizen.Skill.Intelligence) continue; // student
                            // MANUAL = operator deliberately decommissioned this slot.
                            if (m.getHiringMode() == com.minecolonies.api.colony.buildings.HiringMode.MANUAL) continue;
                            Slot s = new Slot();
                            s.m = m; s.primary = m.getPrimarySkill(); s.secondary = m.getSecondarySkill();
                            s.building = bpath + "@" + b.getPosition().toShortString();
                            s.open = m.getModuleMax() - m.getAssignedCitizen().size();
                            slots.add(s);
                        }
                    }

                    java.util.Set<Integer> used = new java.util.HashSet<>();
                    StringBuilder acts = new StringBuilder();
                    boolean firstAct = true;
                    int filled = 0, swapped = 0;

                    // Phase 1: fill OPEN slots from the pool, best-fit first.
                    class FillPair { ICitizenData c; Slot s; int score; }
                    java.util.List<FillPair> fills = new java.util.ArrayList<>();
                    for (ICitizenData c : pool) {
                        for (Slot s : slots) {
                            if (s.open <= 0) continue;
                            FillPair fp = new FillPair();
                            fp.c = c; fp.s = s; fp.score = fitScore(c, s.primary, s.secondary);
                            fills.add(fp);
                        }
                    }
                    fills.sort((a, b2) -> b2.score - a.score);
                    for (FillPair fp : fills) {
                        if (filled + swapped >= max) break;
                        if (used.contains(fp.c.getId()) || fp.s.open <= 0) continue;
                        if (!dryRun && !fp.s.m.assignCitizen(fp.c)) continue;
                        used.add(fp.c.getId());
                        fp.s.open--;
                        filled++;
                        if (!firstAct) acts.append(',');
                        firstAct = false;
                        acts.append("{\"action\":\"fill\",\"citizen\":").append(fp.c.getId())
                            .append(",\"name\":\"").append(escape(fp.c.getName())).append('"')
                            .append(",\"to\":\"").append(escape(fp.s.building)).append('"')
                            .append(",\"score\":").append(fp.score).append('}');
                    }

                    // Phase 2: reassignment. MineColonies auto-hire assigned workers
                    // arbitrarily; replace a slot's weakest occupant with a clearly
                    // better pool member (fit improvement >= threshold). The fired
                    // worker returns jobless and is re-placed on a later pass.
                    if (reassign) {
                        class Swap { ICitizenData in, out; Slot s; int imp; }
                        java.util.List<Swap> swaps = new java.util.ArrayList<>();
                        for (Slot s : slots) {
                            java.util.List<ICitizenData> occ = s.m.getAssignedCitizen();
                            if (occ.isEmpty()) continue;
                            ICitizenData weakest = null; int weakFit = Integer.MAX_VALUE;
                            for (ICitizenData o : occ) {
                                int f = fitScore(o, s.primary, s.secondary);
                                if (f < weakFit) { weakFit = f; weakest = o; }
                            }
                            for (ICitizenData c : pool) {
                                int imp = fitScore(c, s.primary, s.secondary) - weakFit;
                                if (imp >= threshold) {
                                    Swap sw = new Swap();
                                    sw.in = c; sw.out = weakest; sw.s = s; sw.imp = imp;
                                    swaps.add(sw);
                                }
                            }
                        }
                        swaps.sort((a, b2) -> b2.imp - a.imp);
                        java.util.Set<Integer> displaced = new java.util.HashSet<>();
                        for (Swap sw : swaps) {
                            if (filled + swapped >= max) break;
                            if (used.contains(sw.in.getId()) || displaced.contains(sw.out.getId())) continue;
                            if (!sw.s.m.getAssignedCitizen().contains(sw.out)) continue;
                            if (!dryRun) {
                                sw.s.m.removeCitizen(sw.out);
                                if (!sw.s.m.assignCitizen(sw.in)) { sw.s.m.assignCitizen(sw.out); continue; }
                            }
                            used.add(sw.in.getId());
                            displaced.add(sw.out.getId());
                            swapped++;
                            if (!firstAct) acts.append(',');
                            firstAct = false;
                            acts.append("{\"action\":\"swap\",\"in\":\"").append(escape(sw.in.getName()))
                                .append("\",\"out\":\"").append(escape(sw.out.getName()))
                                .append("\",\"at\":\"").append(escape(sw.s.building))
                                .append("\",\"improvement\":").append(sw.imp).append('}');
                        }
                    }

                    result.complete("{\"dryRun\":" + dryRun
                        + ",\"reassign\":" + reassign
                        + ",\"unemployed\":" + unemployedCount
                        + ",\"civilianSlots\":" + slots.size()
                        + ",\"filled\":" + filled
                        + ",\"swapped\":" + swapped
                        + ",\"actions\":[" + acts + "]}");
                } catch (Exception e) {
                    LOGGER.error("autoAssignJobs failed", e);
                    result.complete("{\"error\":\"" + escape(String.valueOf(e)) + "\"}");
                }
            });
            respond(exchange, 200, result.get());
        } catch (Exception e) {
            respond(exchange, 400, "{\"error\":\"" + escape(String.valueOf(e)) + "\"}");
        }
    }

    private void handleAssignWorker(HttpExchange exchange) throws IOException {
        if (!"POST".equalsIgnoreCase(exchange.getRequestMethod())) {
            respond(exchange, 405, "{\"error\":\"use POST\"}");
            return;
        }
        try {
            java.util.Map<String, String> params = parseQuery(exchange.getRequestURI().getQuery());
            int x = Integer.parseInt(params.get("x"));
            int y = Integer.parseInt(params.get("y"));
            int z = Integer.parseInt(params.get("z"));
            int citizenId = Integer.parseInt(params.get("citizenId"));
            boolean fire = "true".equalsIgnoreCase(params.getOrDefault("fire", "false"));

            java.util.concurrent.CompletableFuture<String> result = new java.util.concurrent.CompletableFuture<>();
            server.execute(() -> {
                try {
                    ServerLevel level = server.overworld();
                    BlockPos pos = new BlockPos(x, y, z);
                    IColony colony = findColonyAt(level, pos);
                    if (colony == null) {
                        result.complete("ERROR: no colony at " + x + "," + y + "," + z);
                        return;
                    }
                    IBuilding building = colony.getServerBuildingManager().getBuilding(pos);
                    if (building == null) {
                        result.complete("ERROR: no building registered at " + x + "," + y + "," + z);
                        return;
                    }
                    com.minecolonies.core.colony.buildings.modules.WorkerBuildingModule module =
                            building.getFirstModuleOccurance(
                                    com.minecolonies.core.colony.buildings.modules.WorkerBuildingModule.class);
                    if (module == null) {
                        result.complete("ERROR: building has no worker module (not a workplace)");
                        return;
                    }
                    ICitizenData citizen = colony.getCitizenManager().getCivilian(citizenId);
                    if (citizen == null) {
                        result.complete("ERROR: no citizen with id " + citizenId);
                        return;
                    }
                    citizen.setPaused(false);
                    if (fire) {
                        module.removeCitizen(citizen);
                        result.complete("removed citizen " + citizenId + " from " + x + "," + y + "," + z);
                        return;
                    }
                    IBuilding oldWork = citizen.getWorkBuilding();
                    if (oldWork != null && !oldWork.getPosition().equals(pos)) {
                        com.minecolonies.core.colony.buildings.modules.WorkerBuildingModule oldModule =
                                oldWork.getFirstModuleOccurance(
                                        com.minecolonies.core.colony.buildings.modules.WorkerBuildingModule.class);
                        if (oldModule != null) oldModule.removeCitizen(citizen);
                    }
                    boolean ok = module.assignCitizen(citizen);
                    result.complete(ok
                            ? "assigned citizen " + citizenId + " to " + building.getClass().getSimpleName()
                              + " at " + x + "," + y + "," + z
                            : "ERROR: assignCitizen returned false (module full or citizen unsuitable)");
                } catch (Exception e) {
                    LOGGER.error("assignWorker failed", e);
                    result.complete("ERROR: " + e);
                }
            });
            String outcome = result.get();
            if (outcome.startsWith("ERROR")) {
                respond(exchange, 500, "{\"error\":\"" + escape(outcome) + "\"}");
            } else {
                respond(exchange, 200, "{\"result\":\"" + escape(outcome) + "\"}");
            }
        } catch (Exception e) {
            respond(exchange, 400, "{\"error\":\"" + escape(String.valueOf(e)) + "\"}");
        }
    }

    // ---------- Research pipeline ----------
    //
    // GET  /research?colonyId=1        - whole tree with local state per research
    // POST /startResearch?colonyId=1&branch=<rl>&id=<rl>
    // POST /autoResearch?colonyId=1    - start the shallowest startable researches
    //                                    until the university's slots are full
    //
    // Research is normally started from the university GUI; the server-side
    // entry point is LocalResearchTree.attemptBeginResearch (TryResearchMessage).
    // A creative player skips the item costs and requirement checks entirely,
    // which matches this experiment's cheat-supply philosophy - so we pass a
    // FakePlayer with abilities.instabuild=true. Progression afterwards is the
    // normal simulation: the university researcher works the research down
    // (config researchCreativeCompletion would make it instant; not used).
    // Concurrent research slots = university building level; the creative path
    // skips that check in vanilla, so we enforce it ourselves.

    private com.minecolonies.core.colony.buildings.workerbuildings.BuildingUniversity findUniversity(IColony colony) {
        for (IBuilding b : colony.getServerBuildingManager().getBuildings().values()) {
            if (b instanceof com.minecolonies.core.colony.buildings.workerbuildings.BuildingUniversity u
                    && u.getBuildingLevel() >= 1) {
                return u;
            }
        }
        return null;
    }

    // getPrimaryResearch/getChildren element types differ across versions
    // (IGlobalResearch vs ResourceLocation ids), so walk defensively.
    private java.util.List<com.minecolonies.api.research.IGlobalResearch> walkBranch(
            com.minecolonies.api.research.IGlobalResearchTree gt, ResourceLocation branch) {
        java.util.List<com.minecolonies.api.research.IGlobalResearch> out = new java.util.ArrayList<>();
        java.util.ArrayDeque<Object> stack = new java.util.ArrayDeque<>();
        java.util.List<?> primary = gt.getPrimaryResearch(branch);
        if (primary != null) stack.addAll(primary);
        while (!stack.isEmpty()) {
            Object o = stack.pop();
            com.minecolonies.api.research.IGlobalResearch r =
                    o instanceof com.minecolonies.api.research.IGlobalResearch g ? g
                    : o instanceof ResourceLocation rl ? gt.getResearch(branch, rl) : null;
            if (r == null) continue;
            out.add(r);
            java.util.List<?> children = r.getChildren();
            if (children != null) stack.addAll(children);
        }
        return out;
    }

    private boolean requirementsMet(com.minecolonies.api.research.IGlobalResearch r, IColony colony) {
        try {
            for (com.minecolonies.api.research.IResearchRequirement req : r.getResearchRequirements()) {
                if (!req.isFulfilled(colony)) return false;
            }
        } catch (Exception e) {
            return true;
        }
        return true;
    }

    private void appendRequirementsJson(StringBuilder json,
            com.minecolonies.api.research.IGlobalResearch r, IColony colony) {
        json.append(",\"requirements\":[");
        boolean first = true;
        try {
            for (com.minecolonies.api.research.IResearchRequirement req : r.getResearchRequirements()) {
                if (!first) json.append(",");
                first = false;
                json.append("{\"met\":").append(req.isFulfilled(colony));
                if (req instanceof com.minecolonies.api.research.requirements.BuildingResearchRequirement br) {
                    json.append(",\"building\":\"").append(escape(br.getBuilding().toString()))
                        .append("\",\"level\":").append(br.getBuildingLevel());
                } else {
                    String desc;
                    try {
                        desc = req.getDesc().getString();
                    } catch (Exception e) {
                        desc = req.getClass().getSimpleName();
                    }
                    json.append(",\"desc\":\"").append(escape(desc)).append("\"");
                }
                json.append("}");
            }
        } catch (Exception ignored) {}
        json.append("]");
    }

    private void handleResearch(HttpExchange exchange) throws IOException {
        try {
            java.util.Map<String, String> params = parseQuery(exchange.getRequestURI().getQuery());
            int colonyId = Integer.parseInt(params.getOrDefault("colonyId", "1"));

            java.util.concurrent.CompletableFuture<String> result = new java.util.concurrent.CompletableFuture<>();
            server.execute(() -> {
                try {
                    IColony colony = IColonyManager.getInstance().getColonyByWorld(colonyId, server.overworld());
                    if (colony == null) {
                        result.complete("ERROR: no colony with id " + colonyId);
                        return;
                    }
                    com.minecolonies.api.research.IGlobalResearchTree gt =
                            com.minecolonies.api.research.IGlobalResearchTree.getInstance();
                    com.minecolonies.api.research.ILocalResearchTree lt =
                            colony.getResearchManager().getResearchTree();
                    com.minecolonies.core.colony.buildings.workerbuildings.BuildingUniversity univ = findUniversity(colony);
                    StringBuilder json = new StringBuilder("{");
                    json.append("\"universityLevel\":").append(univ == null ? 0 : univ.getBuildingLevel());
                    json.append(",\"inProgress\":").append(lt.getResearchInProgress().size());
                    json.append(",\"branches\":[");
                    boolean firstBranch = true;
                    for (ResourceLocation branch : gt.getBranches()) {
                        if (!firstBranch) json.append(",");
                        firstBranch = false;
                        json.append("{\"branch\":\"").append(escape(branch.toString())).append("\",\"researches\":[");
                        boolean firstRes = true;
                        for (com.minecolonies.api.research.IGlobalResearch r : walkBranch(gt, branch)) {
                            com.minecolonies.api.research.ILocalResearch local = lt.getResearch(branch, r.getId());
                            if (!firstRes) json.append(",");
                            firstRes = false;
                            json.append("{\"id\":\"").append(escape(r.getId().toString()))
                                .append("\",\"depth\":").append(r.getDepth())
                                .append(",\"state\":\"").append(local == null ? "NOT_STARTED" : String.valueOf(local.getState()))
                                .append("\",\"progress\":").append(local == null ? 0 : local.getProgress());
                            appendRequirementsJson(json, r, colony);
                            json.append("}");
                        }
                        json.append("]}");
                    }
                    json.append("]");
                    // Researches whose only blocker is an unmet building requirement:
                    // exactly the list a mayor can act on ("upgrade X to lvN to unlock").
                    json.append(",\"blocked\":[");
                    boolean firstBlocked = true;
                    if (univ != null) {
                        for (ResourceLocation branch : gt.getBranches()) {
                            for (com.minecolonies.api.research.IGlobalResearch r : walkBranch(gt, branch)) {
                                if (lt.getResearch(r.getBranch(), r.getId()) != null) continue;
                                boolean canRes;
                                try { canRes = r.canResearch(univ, lt); } catch (Exception e) { continue; }
                                if (!canRes || requirementsMet(r, colony)) continue;
                                if (!firstBlocked) json.append(",");
                                firstBlocked = false;
                                json.append("{\"id\":\"").append(escape(r.getId().toString())).append("\"");
                                appendRequirementsJson(json, r, colony);
                                json.append("}");
                            }
                        }
                    }
                    json.append("]}");
                    result.complete(json.toString());
                } catch (Exception e) {
                    LOGGER.error("research failed", e);
                    result.complete("ERROR: " + e);
                }
            });
            String outcome = result.get();
            respond(exchange, outcome.startsWith("ERROR") ? 500 : 200,
                    outcome.startsWith("ERROR") ? "{\"error\":\"" + escape(outcome) + "\"}" : outcome);
        } catch (Exception e) {
            respond(exchange, 400, "{\"error\":\"" + escape(String.valueOf(e)) + "\"}");
        }
    }

    // Shared: start one research via the creative path; returns null on success
    // or an error string.
    private String startResearchInternal(IColony colony,
            com.minecolonies.core.colony.buildings.workerbuildings.BuildingUniversity univ,
            ResourceLocation branch, ResourceLocation id, ServerLevel level) {
        com.minecolonies.api.research.IGlobalResearchTree gt =
                com.minecolonies.api.research.IGlobalResearchTree.getInstance();
        com.minecolonies.api.research.ILocalResearchTree lt = colony.getResearchManager().getResearchTree();
        com.minecolonies.api.research.IGlobalResearch research = gt.getResearch(branch, id);
        if (research == null) return "unknown research " + branch + "/" + id;
        if (lt.getResearch(branch, id) != null) return "already started/finished: " + id;
        if (lt.getResearchInProgress().size() >= univ.getBuildingLevel()) {
            return "no free research slots (university lv" + univ.getBuildingLevel() + ")";
        }
        // attemptBeginResearch's creative branch boils down to startResearch() -
        // call it directly instead of going through a FakePlayer (whose
        // isCreative() didn't hold up through the vanilla path): item costs are
        // skipped by design (cheat-supply policy), progression stays vanilla.
        research.startResearch(lt);
        if (lt.getResearch(branch, id) == null) return "startResearch did not register " + id;
        colony.getResearchManager().markDirty();
        return null;
    }

    private void handleStartResearch(HttpExchange exchange) throws IOException {
        if (!"POST".equalsIgnoreCase(exchange.getRequestMethod())) {
            respond(exchange, 405, "{\"error\":\"use POST\"}");
            return;
        }
        try {
            java.util.Map<String, String> params = parseQuery(exchange.getRequestURI().getQuery());
            int colonyId = Integer.parseInt(params.getOrDefault("colonyId", "1"));
            ResourceLocation branch = new ResourceLocation(params.get("branch"));
            ResourceLocation id = new ResourceLocation(params.get("id"));

            java.util.concurrent.CompletableFuture<String> result = new java.util.concurrent.CompletableFuture<>();
            server.execute(() -> {
                try {
                    IColony colony = IColonyManager.getInstance().getColonyByWorld(colonyId, server.overworld());
                    if (colony == null) {
                        result.complete("ERROR: no colony with id " + colonyId);
                        return;
                    }
                    com.minecolonies.core.colony.buildings.workerbuildings.BuildingUniversity univ = findUniversity(colony);
                    if (univ == null) {
                        result.complete("ERROR: no operational university in colony");
                        return;
                    }
                    String err = startResearchInternal(colony, univ, branch, id, server.overworld());
                    result.complete(err == null ? "started " + branch + "/" + id : "ERROR: " + err);
                } catch (Exception e) {
                    LOGGER.error("startResearch failed", e);
                    result.complete("ERROR: " + e);
                }
            });
            String outcome = result.get();
            if (outcome.startsWith("ERROR")) {
                respond(exchange, 500, "{\"error\":\"" + escape(outcome) + "\"}");
            } else {
                respond(exchange, 200, "{\"result\":\"" + escape(outcome) + "\"}");
            }
        } catch (Exception e) {
            respond(exchange, 400, "{\"error\":\"" + escape(String.valueOf(e)) + "\"}");
        }
    }

    private void handleAutoResearch(HttpExchange exchange) throws IOException {
        if (!"POST".equalsIgnoreCase(exchange.getRequestMethod())) {
            respond(exchange, 405, "{\"error\":\"use POST\"}");
            return;
        }
        try {
            java.util.Map<String, String> params = parseQuery(exchange.getRequestURI().getQuery());
            int colonyId = Integer.parseInt(params.getOrDefault("colonyId", "1"));

            java.util.concurrent.CompletableFuture<String> result = new java.util.concurrent.CompletableFuture<>();
            server.execute(() -> {
                try {
                    IColony colony = IColonyManager.getInstance().getColonyByWorld(colonyId, server.overworld());
                    if (colony == null) {
                        result.complete("ERROR: no colony with id " + colonyId);
                        return;
                    }
                    com.minecolonies.core.colony.buildings.workerbuildings.BuildingUniversity univ = findUniversity(colony);
                    if (univ == null) {
                        result.complete("ERROR: no operational university in colony");
                        return;
                    }
                    com.minecolonies.api.research.IGlobalResearchTree gt =
                            com.minecolonies.api.research.IGlobalResearchTree.getInstance();
                    com.minecolonies.api.research.ILocalResearchTree lt = colony.getResearchManager().getResearchTree();
                    // Candidates: not locally present, and canResearch (parent done +
                    // university depth gate + building requirements) - the auto path
                    // respects vanilla progression, only the item costs are cheated.
                    java.util.List<com.minecolonies.api.research.IGlobalResearch> candidates = new java.util.ArrayList<>();
                    for (ResourceLocation branch : gt.getBranches()) {
                        for (com.minecolonies.api.research.IGlobalResearch r : walkBranch(gt, branch)) {
                            if (lt.getResearch(r.getBranch(), r.getId()) != null) continue;
                            try {
                                if (!r.canResearch(univ, lt)) continue;
                            } catch (Exception e) {
                                continue;
                            }
                            // vanilla checks building requirements at start time
                            // (attemptBeginResearch); the direct startResearch call
                            // skips them, so enforce here - unmet ones surface in
                            // /research's "blocked" list for the mayor to act on.
                            if (!requirementsMet(r, colony)) continue;
                            candidates.add(r);
                        }
                    }
                    candidates.sort(java.util.Comparator.comparingInt(
                            com.minecolonies.api.research.IGlobalResearch::getDepth));
                    StringBuilder started = new StringBuilder("[");
                    boolean first = true;
                    for (com.minecolonies.api.research.IGlobalResearch r : candidates) {
                        if (lt.getResearchInProgress().size() >= univ.getBuildingLevel()) break;
                        String err = startResearchInternal(colony, univ, r.getBranch(), r.getId(), server.overworld());
                        if (err == null) {
                            if (!first) started.append(",");
                            first = false;
                            started.append("\"").append(escape(r.getId().toString())).append("\"");
                        }
                    }
                    started.append("]");
                    result.complete("{\"started\":" + started
                            + ",\"inProgress\":" + lt.getResearchInProgress().size()
                            + ",\"slots\":" + univ.getBuildingLevel() + "}");
                } catch (Exception e) {
                    LOGGER.error("autoResearch failed", e);
                    result.complete("ERROR: " + e);
                }
            });
            String outcome = result.get();
            respond(exchange, outcome.startsWith("ERROR") ? 500 : 200,
                    outcome.startsWith("ERROR") ? "{\"error\":\"" + escape(outcome) + "\"}" : outcome);
        } catch (Exception e) {
            respond(exchange, 400, "{\"error\":\"" + escape(String.valueOf(e)) + "\"}");
        }
    }

    // GET /fields?colonyId=1
    //
    // Lists the colony's building extensions (farm fields, plantation fields):
    // position, type, whether a hut has claimed it, and the assigned seed for
    // farm fields. IRegisteredStructureManager only exposes a first-match
    // predicate search, so the predicate collects every entry and returns false.
    private void handleFields(HttpExchange exchange) throws IOException {
        try {
            java.util.Map<String, String> params = parseQuery(exchange.getRequestURI().getQuery());
            int colonyId = Integer.parseInt(params.getOrDefault("colonyId", "1"));

            java.util.concurrent.CompletableFuture<String> result = new java.util.concurrent.CompletableFuture<>();
            server.execute(() -> {
                try {
                    IColony colony = IColonyManager.getInstance().getColonyByWorld(colonyId, server.overworld());
                    if (colony == null) {
                        result.complete("ERROR: no colony with id " + colonyId);
                        return;
                    }
                    java.util.List<com.minecolonies.api.colony.buildingextensions.IBuildingExtension> all =
                            new java.util.ArrayList<>();
                    colony.getServerBuildingManager().getMatchingBuildingExtension(ext -> {
                        all.add(ext);
                        return false;
                    });
                    StringBuilder sb = new StringBuilder("[");
                    boolean first = true;
                    for (com.minecolonies.api.colony.buildingextensions.IBuildingExtension ext : all) {
                        if (!first) sb.append(",");
                        first = false;
                        BlockPos p = ext.getPosition();
                        sb.append("{\"x\":").append(p.getX())
                          .append(",\"y\":").append(p.getY())
                          .append(",\"z\":").append(p.getZ())
                          .append(",\"type\":\"").append(escape(ext.getClass().getSimpleName())).append("\"")
                          .append(",\"taken\":").append(ext.isTaken());
                        if (ext instanceof com.minecolonies.core.colony.buildingextensions.FarmField farm) {
                            ItemStack seed = farm.getSeed();
                            sb.append(",\"seed\":\"")
                              .append(seed == null || seed.isEmpty() ? ""
                                      : escape(String.valueOf(ForgeRegistries.ITEMS.getKey(seed.getItem()))))
                              .append("\"");
                        }
                        sb.append("}");
                    }
                    sb.append("]");
                    result.complete(sb.toString());
                } catch (Exception e) {
                    LOGGER.error("fields failed", e);
                    result.complete("ERROR: " + e);
                }
            });
            String outcome = result.get();
            if (outcome.startsWith("ERROR")) {
                respond(exchange, 500, "{\"error\":\"" + escape(outcome) + "\"}");
            } else {
                respond(exchange, 200, outcome);
            }
        } catch (Exception e) {
            respond(exchange, 400, "{\"error\":\"" + escape(String.valueOf(e)) + "\"}");
        }
    }

    // POST /giveTexturedBlock?colonyId=1&citizenId=3&block=domum_ornamentum:double_crossed&count=1
    //      &tex1=minecraft:block/oak_planks&mat1=minecraft:stripped_spruce_wood
    //      &tex2=minecraft:block/dark_oak_planks&mat2=minecraft:stripped_oak_wood
    //
    // Domum Ornamentum's "Framed"/retexturable blocks (the ones the in-game
    // resource list shows as e.g. "Framed Stripped Oak Wood") are not plain
    // items - each instance carries a `textureData` compound directly on the
    // ItemStack's NBT (read via ItemStack.getTagElement("textureData") - NOT
    // nested under vanilla's "BlockEntityTag", which was our first, wrong,
    // guess and produced a buggy item whose frame/centre randomly reassigned
    // on every render) mapping texture-path ResourceLocations (from the
    // block's model, e.g. "minecraft:block/oak_planks") to the actual
    // material block used for that texture slot (e.g.
    // "minecraft:stripped_spruce_wood" for the frame).
    //
    // Rather than conjuring the finished item from nothing (which is what
    // MineColonies' own `creativeresolve` debug option does), this endpoint
    // requires the citizen to actually be holding one of each named material
    // (`mat1`, `mat2`, ...) per output item, and consumes them - an "exchange"
    // rather than a cheat. This mirrors what an Architect's Cutter recipe
    // would consume/produce, since we can't call that recipe's own assemble()
    // method directly (it overrides a vanilla Recipe method and is SRG-named
    // in this un-deobfuscated jar) - we recovered the exact NBT key/value
    // format instead by reading a real placed instance out of a shipped
    // .blueprint file's tile_entities list.
    private void handleGiveTexturedBlock(HttpExchange exchange) throws IOException {
        if (!"POST".equalsIgnoreCase(exchange.getRequestMethod())) {
            respond(exchange, 405, "{\"error\":\"use POST\"}");
            return;
        }
        try {
            java.util.Map<String, String> params = parseQuery(exchange.getRequestURI().getQuery());
            int colonyId = Integer.parseInt(params.get("colonyId"));
            int citizenId = Integer.parseInt(params.get("citizenId"));
            String blockId = params.get("block");
            int count = Integer.parseInt(params.getOrDefault("count", "1"));

            CompoundTag textureData = new CompoundTag();
            java.util.List<Item> materials = new java.util.ArrayList<>();
            for (int i = 1; params.containsKey("tex" + i); i++) {
                String tex = params.get("tex" + i);
                String mat = params.get("mat" + i);
                textureData.putString(tex, mat);
                Item matItem = ForgeRegistries.ITEMS.getValue(new ResourceLocation(mat));
                if (matItem == null) {
                    respond(exchange, 400, "{\"error\":\"unknown material item " + escape(mat) + "\"}");
                    return;
                }
                materials.add(matItem);
            }
            if (textureData.isEmpty()) {
                respond(exchange, 400, "{\"error\":\"no tex1/mat1 (etc) pairs given\"}");
                return;
            }

            java.util.concurrent.CompletableFuture<String> result = new java.util.concurrent.CompletableFuture<>();
            server.execute(() -> {
                try {
                    IColony colony = IColonyManager.getInstance().getColonyByWorld(colonyId, server.overworld());
                    if (colony == null) {
                        result.complete("ERROR: no colony with id " + colonyId);
                        return;
                    }
                    ICitizenData citizen = colony.getCitizenManager().getCivilian(citizenId);
                    if (citizen == null) {
                        result.complete("ERROR: no citizen with id " + citizenId);
                        return;
                    }
                    java.util.Optional<AbstractEntityCitizen> entityOpt = citizen.getEntity();
                    if (entityOpt.isEmpty()) {
                        result.complete("ERROR: citizen " + citizenId + " has no live entity right now");
                        return;
                    }
                    Item item = ForgeRegistries.ITEMS.getValue(new ResourceLocation(blockId));
                    if (item == null) {
                        result.complete("ERROR: unknown item id " + blockId);
                        return;
                    }

                    InventoryCitizen inv = entityOpt.get().getInventoryCitizen();

                    // Check first that every material is available in the required
                    // quantity before consuming anything, so a partial shortage never
                    // leaves the citizen short some materials with nothing to show for it.
                    for (Item mat : materials) {
                        if (countItem(inv, mat) < count) {
                            result.complete("ERROR: not enough " + ForgeRegistries.ITEMS.getKey(mat)
                                    + " (need " + count + ")");
                            return;
                        }
                    }
                    for (Item mat : materials) {
                        extractItem(inv, mat, count);
                    }

                    ItemStack stack = new ItemStack(item, count);
                    stack.getOrCreateTag().put("textureData", textureData);

                    ItemStack remainder = stack;
                    int slots = inv.getSlots();
                    for (int slot = 0; slot < slots && !remainder.isEmpty(); slot++) {
                        remainder = inv.insertItem(slot, remainder, false);
                    }
                    int given = count - remainder.getCount();
                    result.complete("crafted " + given + "/" + count + " of " + blockId
                            + " from " + materials.size() + " material(s) for citizen " + citizenId);
                } catch (Exception e) {
                    LOGGER.error("giveTexturedBlock failed", e);
                    result.complete("ERROR: " + e);
                }
            });
            String outcome = result.get();
            if (outcome.startsWith("ERROR")) {
                respond(exchange, 500, "{\"error\":\"" + escape(outcome) + "\"}");
            } else {
                respond(exchange, 200, "{\"result\":\"" + escape(outcome) + "\"}");
            }
        } catch (Exception e) {
            respond(exchange, 400, "{\"error\":\"" + escape(String.valueOf(e)) + "\"}");
        }
    }

    private static int countItem(InventoryCitizen inv, Item item) {
        int total = 0;
        int slots = inv.getSlots();
        for (int slot = 0; slot < slots; slot++) {
            ItemStack stack = inv.getStackInSlot(slot);
            if (!stack.isEmpty() && stack.getItem() == item) {
                total += stack.getCount();
            }
        }
        return total;
    }

    // Removes up to `amount` of `item` from the inventory, stopping early once
    // enough has been pulled. Caller must have already confirmed via countItem()
    // that at least `amount` exists, so this should never come up short.
    private static void extractItem(InventoryCitizen inv, Item item, int amount) {
        int remaining = amount;
        int slots = inv.getSlots();
        for (int slot = 0; slot < slots && remaining > 0; slot++) {
            ItemStack stack = inv.getStackInSlot(slot);
            if (!stack.isEmpty() && stack.getItem() == item) {
                int take = Math.min(remaining, stack.getCount());
                inv.extractItem(slot, take, false);
                remaining -= take;
            }
        }
    }

    // GET /openRequests?x=..&y=..&z=..&citizenId=3
    // Lists what a citizen's building still needs, straight from the
    // colony's own request system (IBuilding.getOpenRequests), instead of
    // guessing from blueprint files. Each entry's `displayStack` is exactly
    // what /resolveRequest would hand back if asked to fulfill it - read it
    // to decide whether raw materials need to be gathered first.
    private void handleOpenRequests(HttpExchange exchange) throws IOException {
        try {
            java.util.Map<String, String> params = parseQuery(exchange.getRequestURI().getQuery());
            int x = Integer.parseInt(params.get("x"));
            int y = Integer.parseInt(params.get("y"));
            int z = Integer.parseInt(params.get("z"));
            int citizenId = Integer.parseInt(params.get("citizenId"));

            java.util.concurrent.CompletableFuture<String> result = new java.util.concurrent.CompletableFuture<>();
            server.execute(() -> {
                try {
                    ServerLevel level = server.overworld();
                    BlockPos pos = new BlockPos(x, y, z);
                    IColony colony = IColonyManager.getInstance().getIColony(level, pos);
                    if (colony == null) {
                        result.complete("ERROR: no colony at " + x + "," + y + "," + z);
                        return;
                    }
                    IBuilding building = colony.getServerBuildingManager().getBuilding(pos);
                    if (building == null) {
                        result.complete("ERROR: no building registered at " + x + "," + y + "," + z);
                        return;
                    }
                    java.util.Collection<IRequest<?>> requests = building.getOpenRequests(citizenId);
                    StringBuilder sb = new StringBuilder("[");
                    boolean first = true;
                    for (IRequest<?> req : requests) {
                        if (!first) sb.append(",");
                        first = false;
                        java.util.List<ItemStack> displayStacks = req.getDisplayStacks();
                        ItemStack stack = displayStacks.isEmpty() ? ItemStack.EMPTY : displayStacks.get(0);
                        CompoundTag textureData = !stack.isEmpty() ? stack.getTagElement("textureData") : null;
                        boolean textured = textureData != null;
                        sb.append("{")
                          .append("\"description\":\"").append(escape(req.getShortDisplayString().getString())).append("\",")
                          .append("\"item\":\"").append(stack.isEmpty() ? "" : escape(String.valueOf(ForgeRegistries.ITEMS.getKey(stack.getItem())))).append("\",")
                          .append("\"count\":").append(stack.getCount()).append(",")
                          .append("\"textured\":").append(textured);
                        // For textured blocks, expose the required raw materials so callers
                        // can give them to the citizen before resolving the request.
                        if (textured) {
                            sb.append(",\"materials\":[");
                            boolean firstMat = true;
                            for (String texKey : textureData.getAllKeys()) {
                                String matId = textureData.getString(texKey);
                                if (!firstMat) sb.append(",");
                                firstMat = false;
                                sb.append("{\"item\":\"").append(escape(matId))
                                  .append("\",\"count\":").append(stack.getCount()).append("}");
                            }
                            sb.append("]");
                        }
                        sb.append("}");
                    }
                    sb.append("]");
                    result.complete(sb.toString());
                } catch (Exception e) {
                    LOGGER.error("openRequests failed", e);
                    result.complete("ERROR: " + e);
                }
            });
            String outcome = result.get();
            if (outcome.startsWith("ERROR")) {
                respond(exchange, 500, "{\"error\":\"" + escape(outcome) + "\"}");
            } else {
                respond(exchange, 200, outcome);
            }
        } catch (Exception e) {
            respond(exchange, 400, "{\"error\":\"" + escape(String.valueOf(e)) + "\"}");
        }
    }

    // POST /resolveRequest?x=..&y=..&z=..&citizenId=3
    // Fulfills the citizen's oldest open request at this building using the
    // request system's own IBuilding.overruleNextOpenRequestOfCitizenWithStack,
    // which is what GM/creative-resolve style overrides use internally - but
    // rather than conjuring it for free, this is an equivalent-exchange: if
    // the request's own display stack carries Domum Ornamentum "textureData"
    // (a Framed decorative block), we first check the citizen is actually
    // holding one of each named raw material and consume them; plain
    // material requests are granted as-is (creativeresolve in the server
    // config already does this same thing automatically, so this endpoint
    // mainly exists for the textured-block case and as an explicit,
    // LLM-triggerable alternative to waiting on creativeresolve's own retry
    // timing).
    private void handleResolveRequest(HttpExchange exchange) throws IOException {
        if (!"POST".equalsIgnoreCase(exchange.getRequestMethod())) {
            respond(exchange, 405, "{\"error\":\"use POST\"}");
            return;
        }
        try {
            java.util.Map<String, String> params = parseQuery(exchange.getRequestURI().getQuery());
            int x = Integer.parseInt(params.get("x"));
            int y = Integer.parseInt(params.get("y"));
            int z = Integer.parseInt(params.get("z"));
            int citizenId = Integer.parseInt(params.get("citizenId"));

            java.util.concurrent.CompletableFuture<String> result = new java.util.concurrent.CompletableFuture<>();
            server.execute(() -> {
                try {
                    ServerLevel level = server.overworld();
                    BlockPos pos = new BlockPos(x, y, z);
                    IColony colony = IColonyManager.getInstance().getIColony(level, pos);
                    if (colony == null) {
                        result.complete("ERROR: no colony at " + x + "," + y + "," + z);
                        return;
                    }
                    IBuilding building = colony.getServerBuildingManager().getBuilding(pos);
                    if (building == null) {
                        result.complete("ERROR: no building registered at " + x + "," + y + "," + z);
                        return;
                    }
                    ICitizenData citizen = colony.getCitizenManager().getCivilian(citizenId);
                    if (citizen == null) {
                        result.complete("ERROR: no citizen with id " + citizenId);
                        return;
                    }
                    java.util.Collection<IRequest<?>> requests = building.getOpenRequests(citizenId);
                    if (requests.isEmpty()) {
                        result.complete("ERROR: no open requests for citizen " + citizenId + " at this building");
                        return;
                    }
                    IRequest<?> req = requests.iterator().next();
                    java.util.List<ItemStack> displayStacks = req.getDisplayStacks();
                    if (displayStacks.isEmpty()) {
                        result.complete("ERROR: request has no display stack to fulfill with");
                        return;
                    }
                    ItemStack stack = displayStacks.get(0);

                    CompoundTag textureData = stack.getTagElement("textureData");
                    if (textureData != null) {
                        java.util.Optional<AbstractEntityCitizen> entityOpt = citizen.getEntity();
                        if (entityOpt.isEmpty()) {
                            result.complete("ERROR: citizen " + citizenId + " has no live entity right now");
                            return;
                        }
                        InventoryCitizen inv = entityOpt.get().getInventoryCitizen();
                        java.util.List<Item> materials = new java.util.ArrayList<>();
                        for (String key : textureData.getAllKeys()) {
                            String matId = textureData.getString(key);
                            Item matItem = ForgeRegistries.ITEMS.getValue(new ResourceLocation(matId));
                            if (matItem == null) {
                                result.complete("ERROR: unknown material item " + matId);
                                return;
                            }
                            materials.add(matItem);
                        }
                        for (Item mat : materials) {
                            if (countItem(inv, mat) < stack.getCount()) {
                                result.complete("ERROR: not enough " + ForgeRegistries.ITEMS.getKey(mat)
                                        + " (need " + stack.getCount() + ") to craft " + req.getShortDisplayString().getString());
                                return;
                            }
                        }
                        for (Item mat : materials) {
                            extractItem(inv, mat, stack.getCount());
                        }
                        // overruleNextOpenRequestOfCitizenWithStack only changes request
                        // state to OVERRULED - it does not put the item in the citizen's
                        // inventory. The builder AI won't exit NEEDS_ITEM until the
                        // finished textured block physically arrives in its inventory.
                        ItemStack toDeliver = stack.copy();
                        for (int slot = 0; slot < inv.getSlots() && !toDeliver.isEmpty(); slot++) {
                            toDeliver = inv.insertItem(slot, toDeliver, false);
                        }
                    }

                    boolean resolved = building.overruleNextOpenRequestOfCitizenWithStack(citizen, stack);
                    result.complete(resolved
                            ? "resolved request for citizen " + citizenId + ": " + req.getShortDisplayString().getString()
                            : "ERROR: overrule returned false (request may have already been resolved)");
                } catch (Exception e) {
                    LOGGER.error("resolveRequest failed", e);
                    result.complete("ERROR: " + e);
                }
            });
            String outcome = result.get();
            if (outcome.startsWith("ERROR")) {
                respond(exchange, 500, "{\"error\":\"" + escape(outcome) + "\"}");
            } else {
                respond(exchange, 200, "{\"result\":\"" + escape(outcome) + "\"}");
            }
        } catch (Exception e) {
            respond(exchange, 400, "{\"error\":\"" + escape(String.valueOf(e)) + "\"}");
        }
    }

    // POST /clearCitizenInventory?colonyId=1&citizenId=2
    // Extracts every item from the citizen's personal inventory and drops them
    // in the world at the citizen's feet (or discards if the entity isn't loaded).
    // Used to unblock citizens whose inventory was filled by erroneous supply runs.
    private void handleClearCitizenInventory(HttpExchange exchange) throws IOException {
        if (!"POST".equalsIgnoreCase(exchange.getRequestMethod())) {
            respond(exchange, 405, "{\"error\":\"use POST\"}");
            return;
        }
        try {
            java.util.Map<String, String> params = parseQuery(exchange.getRequestURI().getQuery());
            int colonyId = Integer.parseInt(params.get("colonyId"));
            int citizenId = Integer.parseInt(params.get("citizenId"));

            java.util.concurrent.CompletableFuture<String> result = new java.util.concurrent.CompletableFuture<>();
            server.execute(() -> {
                try {
                    IColony colony = IColonyManager.getInstance().getColonyByWorld(colonyId, server.overworld());
                    if (colony == null) { result.complete("ERROR: no colony " + colonyId); return; }
                    ICitizenData citizen = colony.getCitizenManager().getCivilian(citizenId);
                    if (citizen == null) { result.complete("ERROR: no citizen " + citizenId); return; }
                    java.util.Optional<AbstractEntityCitizen> entityOpt = citizen.getEntity();
                    if (entityOpt.isEmpty()) { result.complete("ERROR: citizen has no live entity"); return; }
                    InventoryCitizen inv = entityOpt.get().getInventoryCitizen();
                    int cleared = 0;
                    for (int slot = 0; slot < inv.getSlots(); slot++) {
                        if (!inv.getStackInSlot(slot).isEmpty()) {
                            inv.extractItem(slot, Integer.MAX_VALUE, false);
                            cleared++;
                        }
                    }
                    result.complete("cleared " + cleared + " slot(s) for citizen " + citizenId);
                } catch (Exception e) {
                    LOGGER.error("clearCitizenInventory failed", e);
                    result.complete("ERROR: " + e);
                }
            });
            String outcome = result.get();
            if (outcome.startsWith("ERROR")) {
                respond(exchange, 500, "{\"error\":\"" + escape(outcome) + "\"}");
            } else {
                respond(exchange, 200, "{\"result\":\"" + escape(outcome) + "\"}");
            }
        } catch (Exception e) {
            respond(exchange, 400, "{\"error\":\"" + escape(String.valueOf(e)) + "\"}");
        }
    }

    // POST /tickrate?multiplier=10
    // Sets the tick rate multiplier. multiplier=1 restores normal 20 TPS.
    // The actual sleep removal is implemented in MinecraftServerMixin via Mixin.
    // POST /tickrate?multiplier=N     - fixed speed, disables the governor
    // POST /tickrate?auto=true[&max=40][&headroom=0.8] - adaptive governor:
    //   every 15s set multiplier to what the measured tick time can sustain.
    // GET  /tickrate                  - current state incl. measured mspt.
    //
    // Measured 2026-07-08: at 130 citizens + ~80 animals this machine peaks
    // around 10-11x (mspt ~4.8ms) - a fixed 15x just burns CPU with no gain.
    // The governor exists to (a) always run at the max the hardware allows -
    // a fresh small colony flies at 20x+, a heavy one degrades gracefully -
    // and (b) quantify how much a stronger machine buys.
    private void handleTickrate(HttpExchange exchange) throws IOException {
        try {
            if ("GET".equalsIgnoreCase(exchange.getRequestMethod())) {
                respond(exchange, 200, "{\"multiplier\":" + tickMultiplier
                    + ",\"auto\":" + autoTickrate
                    + ",\"msptMs\":" + Math.round(currentMspt() * 100.0) / 100.0
                    + ",\"autoMax\":" + autoTickMax
                    + ",\"headroom\":" + autoTickHeadroom + "}");
                return;
            }
            if (!"POST".equalsIgnoreCase(exchange.getRequestMethod())) {
                respond(exchange, 405, "{\"error\":\"use POST or GET\"}");
                return;
            }
            java.util.Map<String, String> params = parseQuery(exchange.getRequestURI().getQuery());
            if ("true".equalsIgnoreCase(params.getOrDefault("auto", "false"))) {
                autoTickMax = Integer.parseInt(params.getOrDefault("max", "40"));
                autoTickHeadroom = Double.parseDouble(params.getOrDefault("headroom", "0.8"));
                autoTickrate = true;
                lastGovernorMs = 0; // run on next tick
                respond(exchange, 200, "{\"result\":\"auto tickrate enabled (max=" + autoTickMax
                    + ", headroom=" + autoTickHeadroom + ")\"}");
                return;
            }
            int mult = Integer.parseInt(params.getOrDefault("multiplier", "1"));
            if (mult < 1) mult = 1;
            autoTickrate = false;
            tickMultiplier = mult;
            respond(exchange, 200, "{\"result\":\"multiplier=" + mult + " (auto off)\"}");
        } catch (Exception e) {
            respond(exchange, 400, "{\"error\":\"" + escape(String.valueOf(e)) + "\"}");
        }
    }

    private static volatile boolean autoTickrate = false;
    private static volatile int autoTickMax = 40;
    private static volatile double autoTickHeadroom = 0.8;
    private long lastGovernorMs = 0;

    // Average of the server's own per-tick execution times (the /forge tps
    // mspt). tickTimes is nanoseconds over the last 100 ticks.
    private double currentMspt() {
        long[] times = server.tickTimes;
        if (times == null || times.length == 0) return 50.0;
        long sum = 0;
        for (long t : times) sum += t;
        return sum / (double) times.length / 1.0e6;
    }

    // Called every server tick (from onServerTick). Re-targets the multiplier
    // to what the measured tick cost can sustain: budget per tick at N x is
    // 50/N ms, so sustainable N = 50/mspt * headroom. Hysteresis of +-1 keeps
    // it from flapping; changes are logged for the speedup studies.
    private void tickrateGovernor() {
        if (!autoTickrate || server == null) return;
        long now = System.currentTimeMillis();
        if (now - lastGovernorMs < 15000) return;
        lastGovernorMs = now;
        double mspt = Math.max(0.4, currentMspt());
        int target = (int) Math.floor(50.0 / mspt * autoTickHeadroom);
        target = Math.max(1, Math.min(autoTickMax, target));
        if (Math.abs(target - tickMultiplier) >= 2) {
            LOGGER.info("[tickgov] mspt={}ms -> multiplier {} (was {})",
                String.format("%.2f", mspt), target, tickMultiplier);
            tickMultiplier = target;
        }
    }

    // GET /debugTick — dumps MinecraftServer class hierarchy long fields and current nextTickTime value.
    private void handleDebugTick(HttpExchange exchange) throws IOException {
        StringBuilder sb = new StringBuilder("{");
        sb.append("\"multiplier\":").append(tickMultiplier);
        sb.append(",\"fields\":[");
        boolean first = true;
        Class<?> cls = server.getClass();
        while (cls != null) {
            for (java.lang.reflect.Field f : cls.getDeclaredFields()) {
                if (f.getType() != long.class) continue;
                if (!first) sb.append(",");
                first = false;
                sb.append("{\"class\":\"").append(escape(cls.getSimpleName()))
                  .append("\",\"name\":\"").append(escape(f.getName())).append("\"");
                try {
                    f.setAccessible(true);
                    sb.append(",\"value\":").append(f.getLong(server));
                } catch (Exception e) {
                    sb.append(",\"error\":\"").append(escape(e.getMessage())).append("\"");
                }
                sb.append("}");
            }
            cls = cls.getSuperclass();
        }
        sb.append("],\"currentMs\":").append(System.currentTimeMillis());
        sb.append(",\"resolvedField\":\"").append(nextTickTimeField != null ? escape(nextTickTimeField.getName()) : "null").append("\"");
        sb.append("}");
        respond(exchange, 200, sb.toString());
    }

    // POST /placeNext?block=minecolonies:blockhutbuilder&colonyId=1
    // Finds the nearest valid position for the building type (within territory,
    // no footprint overlap) and places it there in one step. The caller should
    // follow up with /requestBuild at the returned coordinates.
    private void handlePlaceNext(HttpExchange exchange) throws IOException {
        if (!"POST".equalsIgnoreCase(exchange.getRequestMethod())) {
            respond(exchange, 405, "{\"error\":\"use POST\"}");
            return;
        }
        try {
            java.util.Map<String, String> params = parseQuery(exchange.getRequestURI().getQuery());
            String blockId = params.getOrDefault("block", "");
            int colonyId = Integer.parseInt(params.getOrDefault("colonyId", "1"));
            // Optional per-request override of the flatness gate (max-min surface
            // Y across the footprint); falls back to VOYAGER_PLACENEXT_FLATNESS /
            // default when absent or unparseable.
            final int flatness;
            {
                String fv = params.get("flatness");
                int parsed = defaultFlatnessThreshold();
                if (fv != null && !fv.isEmpty()) {
                    try { parsed = Integer.parseInt(fv.trim()); }
                    catch (NumberFormatException ignored) {}
                }
                flatness = parsed;
            }

            java.util.concurrent.CompletableFuture<String> result = new java.util.concurrent.CompletableFuture<>();
            server.execute(() -> {
                try {
                    int[] pos = findPlacementPos(blockId, colonyId, flatness);
                    if (pos == null) {
                        result.complete("ERROR: no valid position found within territory for " + blockId);
                        return;
                    }
                    String placed = placeOnServerThread(pos[0], pos[1], pos[2], blockId);
                    if (placed.startsWith("ERROR")) {
                        result.complete(placed);
                    } else {
                        result.complete(placed + " [pos:" + pos[0] + "," + pos[1] + "," + pos[2] + "]");
                    }
                } catch (Exception e) {
                    LOGGER.error("placeNext failed", e);
                    result.complete("ERROR: " + e);
                }
            });
            String outcome = result.get();
            if (outcome.startsWith("ERROR")) {
                respond(exchange, 500, "{\"error\":\"" + escape(outcome) + "\"}");
            } else {
                respond(exchange, 200, "{\"result\":\"" + escape(outcome) + "\"}");
            }
        } catch (Exception e) {
            respond(exchange, 400, "{\"error\":\"" + escape(String.valueOf(e)) + "\"}");
        }
    }

    // GET /suggestPosition?block=minecolonies:blockhutbuilder&colonyId=1
    // Returns the nearest available anchor coordinate for the given building type
    // that fits inside the colony's territory (≤60 blocks from center) without
    // overlapping any already-placed building footprint (including 5-block gap).
    private void handleSuggestPosition(HttpExchange exchange) throws IOException {
        try {
            java.util.Map<String, String> params = parseQuery(exchange.getRequestURI().getQuery());
            String blockId = params.getOrDefault("block", "");
            int colonyId = Integer.parseInt(params.getOrDefault("colonyId", "1"));

            java.util.concurrent.CompletableFuture<String> result = new java.util.concurrent.CompletableFuture<>();
            server.execute(() -> {
                try {
                    result.complete(suggestPositionOnServerThread(blockId, colonyId));
                } catch (Exception e) {
                    result.complete("ERROR: " + e);
                }
            });
            String outcome = result.get();
            if (outcome.startsWith("ERROR")) {
                respond(exchange, 500, "{\"error\":\"" + escape(outcome) + "\"}");
            } else {
                respond(exchange, 200, outcome);
            }
        } catch (Exception e) {
            respond(exchange, 400, "{\"error\":\"" + escape(String.valueOf(e)) + "\"}");
        }
    }

    // Footprint sizes (X-width × Z-depth) matching the Colonial pack's level-1
    // blueprints. Used by suggestPosition to check for collisions between buildings.
    // Keys match the type names in BLUEPRINT_PATHS (part after "blockhut").
    private static final java.util.Map<String, int[]> BUILDING_FOOTPRINTS = new java.util.HashMap<>();
    static {
        BUILDING_FOOTPRINTS.put("townhall",    new int[]{38, 33});
        BUILDING_FOOTPRINTS.put("builder",     new int[]{22, 11});
        BUILDING_FOOTPRINTS.put("citizen",     new int[]{13, 15});
        BUILDING_FOOTPRINTS.put("warehouse",   new int[]{20, 24});
        BUILDING_FOOTPRINTS.put("tavern",      new int[]{22, 20});
        BUILDING_FOOTPRINTS.put("farmer",      new int[]{25, 20});
        BUILDING_FOOTPRINTS.put("miner",       new int[]{13, 22});
        BUILDING_FOOTPRINTS.put("fisherman",   new int[]{22, 16});
        BUILDING_FOOTPRINTS.put("hospital",    new int[]{16, 17});
        BUILDING_FOOTPRINTS.put("kitchen",     new int[]{17, 17});
        BUILDING_FOOTPRINTS.put("lumberjack",  new int[]{11, 19});
        BUILDING_FOOTPRINTS.put("guardtower",  new int[]{11, 10});
        BUILDING_FOOTPRINTS.put("deliveryman", new int[]{4, 2});
        BUILDING_FOOTPRINTS.put("courier",     new int[]{4, 2});
    }

    // ----------------------------------------------------------------------
    // District zoning for placeNext (2026-07-11, Agent E).
    //
    // Keys are the block registry path with the "blockhut" prefix stripped
    // (same normalisation findPlacementPos applies to `typeName`, and the same
    // form used by BLUEPRINT_PATHS / BUILDING_FOOTPRINTS). Values are one of the
    // 5 layout zones. "guardtower" and "citizen" are deliberately NOT listed
    // here: they take the special ring / round-robin logic in findPlacementPos.
    //
    // Anything not in this map (and not guardtower/citizen) falls back to
    // "secondary" - crafters are the largest, most heterogeneous family, so an
    // unclassified new hut most likely belongs to the industrial ring; the
    // fallback is logged so an unmapped building is easy to spot.
    private static final java.util.Map<String, String> ZONE_MAP = new java.util.HashMap<>();
    static {
        // center: town core - governance, logistics, food service.
        for (String s : new String[]{
                "townhall", "builder", "warehouse", "deliveryman", "courier",
                "cook", "kitchen", "tavern"}) ZONE_MAP.put(s, "center");
        // primary (raw production / gathering).
        for (String s : new String[]{
                "farmer", "lumberjack", "miner", "cowboy", "shepherd",
                "chickenherder", "swineherder", "fisherman", "beekeeper",
                "plantation", "florist", "rabbithutch"}) ZONE_MAP.put(s, "primary");
        // secondary (crafting / processing).
        for (String s : new String[]{
                "sawmill", "stonemason", "smeltery", "blacksmith", "baker",
                "mechanic", "fletcher", "stonesmeltery", "composter", "crusher",
                "concretemixer", "dyer", "glassblower", "sifter", "alchemist",
                "netherworker"}) ZONE_MAP.put(s, "secondary");
        // academic (research / learning / healing).
        for (String s : new String[]{
                "university", "library", "school", "hospital",
                "enchanter"}) ZONE_MAP.put(s, "academic");
        // military.
        for (String s : new String[]{
                "barracks", "barrackstower", "archery", "combatacademy",
                "gatehouse", "graveyard"}) ZONE_MAP.put(s, "military");
    }

    // R1: radius (blocks) of the central hub. center-zone buildings live inside
    // this disc; everything else lives in one of the 4 directional rings beyond
    // it. Override with VOYAGER_ZONE_R1 / -Dvoyager.zone.r1.
    private static double zoneCenterRadius() {
        Double v = readDoubleProp("VOYAGER_ZONE_R1", "voyager.zone.r1");
        return v != null ? v : 28.0;
    }

    // R2: nominal radius of the guardtower boundary ring (one tower per diagonal
    // corner). Override with VOYAGER_ZONE_R2 / -Dvoyager.zone.r2.
    private static double zoneGuardRadius() {
        Double v = readDoubleProp("VOYAGER_ZONE_R2", "voyager.zone.r2");
        return v != null ? v : 44.0;
    }

    private static Double readDoubleProp(String env, String prop) {
        String v = System.getenv(env);
        if (v == null || v.isEmpty()) v = System.getProperty(prop);
        if (v != null && !v.isEmpty()) {
            try { return Double.parseDouble(v.trim()); } catch (NumberFormatException ignored) {}
        }
        return null;
    }

    // Zone of a candidate offset (dx,dz) from the colony center. r<=R1 is the
    // central hub; beyond it the plane is split into 4 quadrants along the
    // diagonals. N/S claim the diagonal ties (>=) so the partition is total and
    // disjoint (E/W use strict >): every (dx,dz) maps to exactly one zone.
    //   primary  = north (dz<0)   academic = south (dz>0)
    //   secondary= east  (dx>0)   military = west  (dx<0)
    private static String zoneOf(int dx, int dz, double r1) {
        double r = Math.sqrt((double) dx * dx + (double) dz * dz);
        if (r <= r1) return "center";
        int adx = Math.abs(dx), adz = Math.abs(dz);
        if (dz < 0 && adz >= adx) return "primary";   // north
        if (dz > 0 && adz >= adx) return "academic";  // south
        if (dx > 0 && adx > adz) return "secondary";  // east
        return "military";                            // west (dx<0, adx>adz)
    }

    // Whether `cand` is an acceptable relaxed zone for a building that wants
    // `required` (used only after no exact-zone site was found). The central
    // hub is adjacent to every ring (central overflow spills outward, and a
    // ring building may spill into the hub); perpendicular quadrants are
    // adjacent; the opposite quadrant is not (last-resort "any zone" tier
    // handles that). Exact matches are handled by the caller, not here.
    private static boolean zoneAdjacent(String required, String cand) {
        if (required.equals(cand)) return false;
        if ("center".equals(required) || "center".equals(cand)) return true;
        return !opposite(required).equals(cand);
    }

    private static String opposite(String zone) {
        switch (zone) {
            case "primary":   return "academic";
            case "academic":  return "primary";
            case "secondary": return "military";
            case "military":  return "secondary";
            default:          return "";
        }
    }

    // Diagonal corner (NE/SE/SW/NW) an offset points toward. Ties on an axis
    // fold to the east/south side (>=0). Used to spread guardtowers over the 4
    // corners of the boundary ring.
    private static String diagOf(int dx, int dz) {
        String ns = (dz < 0) ? "N" : "S";
        String ew = (dx >= 0) ? "E" : "W";
        return ns + ew;
    }

    // A candidate is "diagonal-ish" (suitable for a corner tower) when neither
    // axis dominates too strongly: the shorter leg is at least half the longer.
    // That keeps towers roughly on the 45-degree diagonals (~27deg..63deg band)
    // rather than sliding onto the N/S/E/W ring edges shared with the quadrants.
    private static boolean diagonalish(int dx, int dz) {
        int adx = Math.abs(dx), adz = Math.abs(dz);
        if (adx == 0 || adz == 0) return false;
        int lo = Math.min(adx, adz), hi = Math.max(adx, adz);
        return lo * 2 >= hi;
    }

    // Returns {minX, minZ, maxX, maxZ} of a placed building's actual in-world
    // footprint via IBuilding.getCorners(). getCorners() lazily computes the
    // corners: from the tile entity's schematic data when present, otherwise by
    // loading the building's blueprint (structurePack/blueprintPath, which
    // placeOnServerThread always sets) through ColonyUtils.calculateCorners().
    // The TE-based getInWorldCorners() path used previously returned null for
    // every bridge-placed building because we never call setSchematicCorners().
    // If the blueprint can't be loaded MineColonies stores a degenerate
    // (position, position) pair - return null then so the caller falls back to
    // the BUILDING_FOOTPRINTS guess.
    private int[] realFootprintRect(IBuilding b) {
        try {
            net.minecraft.util.Tuple<BlockPos, BlockPos> corners = b.getCorners();
            if (corners != null && corners.getA() != null && corners.getA().equals(corners.getB())) {
                // Degenerate corners persist in the colony save from sessions where
                // the blueprint failed to load (getCorners only recomputes when the
                // corners are still BlockPos.ZERO). Force a recompute now that the
                // structure packs are loaded - this also heals isInBuilding() for
                // MineColonies' own logic since calculateCorners stores the result.
                b.calculateCorners();
                corners = b.getCorners();
            }
            if (corners == null || corners.getA() == null || corners.getB() == null) return null;
            BlockPos c1 = corners.getA();
            BlockPos c2 = corners.getB();
            if (c1.equals(c2)) return null;
            return new int[]{
                Math.min(c1.getX(), c2.getX()), Math.min(c1.getZ(), c2.getZ()),
                Math.max(c1.getX(), c2.getX()), Math.max(c1.getZ(), c2.getZ())
            };
        } catch (Exception e) {
            return null;
        }
    }

    // GET /debugWorkOrders?colonyId=1 - dumps every work order with the fields
    // the builder AI's LOAD_STRUCTURE step depends on (pack/path/blueprint).
    private void handleDebugWorkOrders(HttpExchange exchange) throws IOException {
        try {
            java.util.Map<String, String> params = parseQuery(exchange.getRequestURI().getQuery());
            int colonyId = Integer.parseInt(params.getOrDefault("colonyId", "1"));
            java.util.concurrent.CompletableFuture<String> result = new java.util.concurrent.CompletableFuture<>();
            server.execute(() -> {
                try {
                    ServerLevel level = server.overworld();
                    IColony colony = IColonyManager.getInstance().getColonyByWorld(colonyId, level);
                    if (colony == null) { result.complete("{\"error\":\"no colony\"}"); return; }
                    StringBuilder sb = new StringBuilder("[");
                    boolean first = true;
                    for (com.minecolonies.api.colony.workorders.IServerWorkOrder wo
                            : colony.getWorkManager().getWorkOrders().values()) {
                        if (!first) sb.append(',');
                        first = false;
                        sb.append("{\"id\":").append(wo.getID())
                          .append(",\"type\":\"").append(wo.getWorkOrderType()).append('"')
                          .append(",\"location\":\"").append(wo.getLocation() == null ? null : wo.getLocation().toShortString()).append('"')
                          .append(",\"claimedBy\":\"").append(wo.getClaimedBy() == null ? null : wo.getClaimedBy().toShortString()).append('"')
                          .append(",\"pack\":\"").append(escape(String.valueOf(wo.getStructurePack()))).append('"')
                          .append(",\"path\":\"").append(escape(String.valueOf(wo.getStructurePath()))).append('"')
                          .append(",\"levels\":\"").append(wo.getCurrentLevel()).append("->").append(wo.getTargetLevel()).append('"')
                          .append(",\"rotation\":").append(wo.getRotation())
                          .append(",\"stage\":\"").append(wo.getStage()).append('"')
                          .append(",\"blueprintLoaded\":").append(wo.getBlueprint() != null)
                          .append('}');
                    }
                    sb.append(']');
                    result.complete(sb.toString());
                } catch (Exception e) {
                    result.complete("{\"error\":\"" + escape(String.valueOf(e)) + "\"}");
                }
            });
            respond(exchange, 200, result.get());
        } catch (Exception e) {
            respond(exchange, 400, "{\"error\":\"" + escape(String.valueOf(e)) + "\"}");
        }
    }

    // POST /rebalanceWorkOrders?colonyId=1 - redistributes claimed building work
    // orders round-robin across all level-1+ builder huts. Work orders created
    // before the fewest-claimed selection existed all piled onto one hut and
    // stay there forever (builders never steal claimed orders), so this is the
    // one-off migration for them. Self-build orders (a builder hut building
    // itself) keep their claim.
    private void handleRebalanceWorkOrders(HttpExchange exchange) throws IOException {
        try {
            java.util.Map<String, String> params = parseQuery(exchange.getRequestURI().getQuery());
            int colonyId = Integer.parseInt(params.getOrDefault("colonyId", "1"));
            java.util.concurrent.CompletableFuture<String> result = new java.util.concurrent.CompletableFuture<>();
            server.execute(() -> {
                try {
                    ServerLevel level = server.overworld();
                    IColony colony = IColonyManager.getInstance().getColonyByWorld(colonyId, level);
                    if (colony == null) { result.complete("ERROR: no colony with id " + colonyId); return; }
                    java.util.List<BlockPos> huts = colony.getServerBuildingManager().getBuildings().values().stream()
                        .filter(bld -> {
                            ResourceLocation bldKey = ForgeRegistries.BLOCKS.getKey(
                                level.getBlockState(bld.getPosition()).getBlock());
                            return bldKey != null && "blockhutbuilder".equals(bldKey.getPath())
                                && bld.getBuildingLevel() >= 1;
                        })
                        .map(IBuilding::getPosition)
                        .sorted(java.util.Comparator.<BlockPos>comparingInt(p -> p.getX())
                            .thenComparingInt(p -> p.getZ()))
                        .collect(java.util.stream.Collectors.toList());
                    if (huts.isEmpty()) { result.complete("ERROR: no operational builder huts"); return; }
                    // WorkOrderBuilding.canBuild demands hut->target distance^2
                    // <= 10000 (100 blocks); an order claimed by a farther hut
                    // binds the hut's workOrderId but the AI never starts it,
                    // and the whole hut queue freezes behind it (134-order
                    // stall, 2026-07-06). Assign each order to the
                    // least-loaded hut WITHIN RANGE; orders no hut can reach
                    // are unclaimed and reported instead.
                    final long MAX_BUILD_DIST_SQ = 10000L;
                    java.util.Map<BlockPos, Integer> load = new java.util.HashMap<>();
                    for (BlockPos h : huts) load.put(h, 0);
                    StringBuilder sb = new StringBuilder();
                    int i = 0, unreachable = 0;
                    for (com.minecolonies.api.colony.workorders.IServerWorkOrder wo
                            : colony.getWorkManager().getWorkOrders().values()) {
                        if (wo.getClaimedBy() == null || wo.getLocation() == null) continue;
                        if (wo.getLocation().equals(wo.getClaimedBy())) continue;
                        BlockPos loc = wo.getLocation();
                        BlockPos target = huts.stream()
                            .filter(h -> h.distSqr(loc) <= MAX_BUILD_DIST_SQ)
                            .min(java.util.Comparator.comparingInt(h -> load.get(h)))
                            .orElse(null);
                        // The old hut caches workOrderId/progress/resources and its
                        // worker AI holds a structurePlacer for this order; only
                        // onWorkOrderCancellation resets all of them. Without it the
                        // old builder keeps working the order it no longer owns and
                        // wedges in a LOAD_STRUCTURE/RECALC loop.
                        if (target == null) {
                            IBuilding oldHut = colony.getServerBuildingManager()
                                .getBuildings().get(wo.getClaimedBy());
                            if (oldHut instanceof com.minecolonies.core.colony.buildings.AbstractBuildingStructureBuilder oldBuilder) {
                                oldBuilder.onWorkOrderCancellation(wo);
                            }
                            wo.setClaimedBy(BlockPos.ZERO);
                            unreachable++;
                            continue;
                        }
                        i++;
                        load.merge(target, 1, Integer::sum);
                        if (!target.equals(wo.getClaimedBy())) {
                            IBuilding oldHut = colony.getServerBuildingManager()
                                .getBuildings().get(wo.getClaimedBy());
                            if (oldHut instanceof com.minecolonies.core.colony.buildings.AbstractBuildingStructureBuilder oldBuilder) {
                                oldBuilder.onWorkOrderCancellation(wo);
                            }
                            wo.setClaimedBy(target);
                            sb.append(loc.toShortString()).append(" -> ")
                              .append(target.toShortString()).append("; ");
                        }
                    }
                    colony.getWorkManager().setDirty(true);
                    result.complete("rebalanced " + i + " work orders (" + unreachable
                        + " unreachable by any builder hut, unclaimed): " + sb);
                } catch (Exception e) {
                    LOGGER.error("rebalanceWorkOrders failed", e);
                    result.complete("ERROR: " + e);
                }
            });
            String outcome = result.get();
            respond(exchange, outcome.startsWith("ERROR") ? 500 : 200,
                "{\"result\":\"" + escape(outcome) + "\"}");
        } catch (Exception e) {
            respond(exchange, 400, "{\"error\":\"" + escape(String.valueOf(e)) + "\"}");
        }
    }

    // POST /removeBuilding?x=&y=&z=&colonyId=1 - deregisters the building at
    // the given anchor from the colony (cancelling its work orders) and removes
    // the hut block from the world. Mirrors what breaking the hut block as a
    // player does; needed to relocate buildings placed by the old overlapping
    // placement logic.
    private void handleRemoveBuilding(HttpExchange exchange) throws IOException {
        try {
            java.util.Map<String, String> params = parseQuery(exchange.getRequestURI().getQuery());
            int x = Integer.parseInt(params.get("x"));
            int y = Integer.parseInt(params.get("y"));
            int z = Integer.parseInt(params.get("z"));
            int colonyId = Integer.parseInt(params.getOrDefault("colonyId", "1"));
            java.util.concurrent.CompletableFuture<String> result = new java.util.concurrent.CompletableFuture<>();
            server.execute(() -> {
                try {
                    ServerLevel level = server.overworld();
                    IColony colony = IColonyManager.getInstance().getColonyByWorld(colonyId, level);
                    if (colony == null) { result.complete("ERROR: no colony with id " + colonyId); return; }
                    BlockPos pos = new BlockPos(x, y, z);
                    IBuilding building = colony.getServerBuildingManager().getBuilding(pos);
                    if (building == null) {
                        for (IBuilding candidate : colony.getServerBuildingManager().getBuildings().values()) {
                            if (candidate.getPosition().equals(pos)) { building = candidate; break; }
                        }
                    }
                    if (building == null) { result.complete("ERROR: no building at " + x + "," + y + "," + z); return; }
                    colony.getServerBuildingManager().removeBuilding(building, new java.util.HashSet<>());
                    level.removeBlock(pos, false);
                    result.complete("removed building at " + x + "," + y + "," + z);
                } catch (Exception e) {
                    LOGGER.error("removeBuilding failed", e);
                    result.complete("ERROR: " + e);
                }
            });
            String outcome = result.get();
            respond(exchange, outcome.startsWith("ERROR") ? 500 : 200,
                "{\"result\":\"" + escape(outcome) + "\"}");
        } catch (Exception e) {
            respond(exchange, 400, "{\"error\":\"" + escape(String.valueOf(e)) + "\"}");
        }
    }

    // GET /debugFootprints?colonyId=1&block=<id> - dumps every existing
    // building's rect as findPlacementPos would compute it (real corners vs
    // table fallback), plus the candidate blueprint offsets for `block`.
    // Diagnostic aid for the footprint-overlap fix; not used by agents.
    private void handleDebugFootprints(HttpExchange exchange) throws IOException {
        try {
            java.util.Map<String, String> params = parseQuery(exchange.getRequestURI().getQuery());
            String blockId = params.getOrDefault("block", "minecolonies:blockhutcitizen");
            int colonyId = Integer.parseInt(params.getOrDefault("colonyId", "1"));
            java.util.concurrent.CompletableFuture<String> result = new java.util.concurrent.CompletableFuture<>();
            server.execute(() -> {
                try {
                    ServerLevel level = server.overworld();
                    IColony colony = IColonyManager.getInstance().getColonyByWorld(colonyId, level);
                    if (colony == null) { result.complete("{\"error\":\"no colony\"}"); return; }
                    StringBuilder sb = new StringBuilder("{\"buildings\":[");
                    boolean first = true;
                    for (IBuilding b : colony.getServerBuildingManager().getBuildings().values()) {
                        if (!first) sb.append(',');
                        first = false;
                        BlockPos bp = b.getPosition();
                        String corners;
                        try {
                            net.minecraft.util.Tuple<BlockPos, BlockPos> c = b.getCorners();
                            corners = c == null ? "null"
                                : "\"" + c.getA().toShortString() + " / " + c.getB().toShortString() + "\"";
                        } catch (Exception e) {
                            corners = "\"EX: " + escape(String.valueOf(e)) + "\"";
                        }
                        int[] rect = realFootprintRect(b);
                        sb.append("{\"pos\":\"").append(bp.toShortString())
                          .append("\",\"pack\":\"").append(escape(String.valueOf(b.getStructurePack())))
                          .append("\",\"path\":\"").append(escape(String.valueOf(b.getBlueprintPath())))
                          .append("\",\"corners\":").append(corners)
                          .append(",\"rect\":").append(rect == null ? "null" : java.util.Arrays.toString(rect))
                          .append('}');
                    }
                    sb.append("],\"candidate\":");
                    String typeName = blockId.contains(":")
                        ? blockId.substring(blockId.indexOf(':') + 1).replaceFirst("^blockhut", "")
                        : blockId.replaceFirst("^blockhut", "");
                    String bpPath = BLUEPRINT_PATHS.get(typeName);
                    StructurePackMeta pinnedPack = getPinnedPack();
                    sb.append("{\"type\":\"").append(typeName)
                      .append("\",\"bpPath\":\"").append(bpPath)
                      .append("\",\"pack\":\"").append(pinnedPack == null ? null : pinnedPack.getName())
                      .append("\",\"offsets\":");
                    if (bpPath != null && pinnedPack != null) {
                        try {
                            com.ldtteam.structurize.blueprints.v1.Blueprint blueprint =
                                StructurePacks.getBlueprint(pinnedPack.getName(), bpPath);
                            if (blueprint == null) {
                                sb.append("\"blueprint null\"");
                            } else {
                                net.minecraft.util.Tuple<BlockPos, BlockPos> c =
                                    com.minecolonies.api.util.ColonyUtils.calculateCorners(
                                        BlockPos.ZERO, level, blueprint, 0, false);
                                sb.append('"').append(c.getA().toShortString()).append(" / ")
                                  .append(c.getB().toShortString()).append('"');
                            }
                        } catch (Exception e) {
                            sb.append("\"EX: ").append(escape(String.valueOf(e))).append('"');
                        }
                    } else {
                        sb.append("\"no path or pack\"");
                    }
                    sb.append("}}");
                    result.complete(sb.toString());
                } catch (Exception e) {
                    result.complete("{\"error\":\"" + escape(String.valueOf(e)) + "\"}");
                }
            });
            respond(exchange, 200, result.get());
        } catch (Exception e) {
            respond(exchange, 400, "{\"error\":\"" + escape(String.valueOf(e)) + "\"}");
        }
    }

    private String suggestPositionOnServerThread(String blockId, int colonyId) {
        ServerLevel level = server.overworld();
        IColony colony = IColonyManager.getInstance().getColonyByWorld(colonyId, level);
        if (colony == null) return "ERROR: no colony with id " + colonyId;
        int[] pos = findPlacementPos(blockId, colonyId);
        if (pos == null) return "ERROR: no valid position found within 100 blocks of colony center";
        BlockPos center = colony.getCenter();
        double dist = Math.sqrt(Math.pow(pos[0] - center.getX(), 2) + Math.pow(pos[2] - center.getZ(), 2));
        return "{\"x\":" + pos[0] + ",\"y\":" + pos[1] + ",\"z\":" + pos[2]
            + ",\"dist\":" + String.format("%.1f", dist) + "}";
    }

    // Env/system-property override for the flatness gate threshold used by
    // findPlacementPos (max-min surface Y across a candidate footprint, in
    // blocks). A per-request ?flatness= query wins; this is the fallback default.
    // Conservative default 3: MineColonies builders reliably terrace a footprint
    // up to a ~3-block step, so cells whose terrain spread is <= T are accepted
    // as-is; steeper cells are skipped (and, if no cell qualifies within the
    // scan disc, the flattest is used and flagged for terraform - Agent C, not
    // yet implemented). Set VOYAGER_PLACENEXT_FLATNESS (or -Dvoyager.placenext.flatness)
    // to retune once the operator's builder-terracing test fixes the real limit.
    private static int defaultFlatnessThreshold() {
        String v = System.getenv("VOYAGER_PLACENEXT_FLATNESS");
        if (v == null || v.isEmpty()) v = System.getProperty("voyager.placenext.flatness");
        if (v != null && !v.isEmpty()) {
            try { return Integer.parseInt(v.trim()); } catch (NumberFormatException ignored) {}
        }
        return 3;
    }

    // Registry path (no namespace) of the block at a building's anchor, e.g.
    // "blockhutguardtower". Empty string if it can't be resolved.
    private String buildingBlockPath(ServerLevel level, IBuilding b) {
        ResourceLocation k = ForgeRegistries.BLOCKS.getKey(level.getBlockState(b.getPosition()).getBlock());
        return k != null ? k.getPath() : "";
    }

    // Guardtowers are spread one-per-corner over the boundary ring. Pick the
    // diagonal (NE/SE/SW/NW, in that deterministic order) that currently holds
    // the fewest towers, so the 4 corners fill before any doubles up.
    private String pickGuardtowerDiagonal(java.util.List<IBuilding> buildings,
            ServerLevel level, BlockPos center) {
        String[] diags = {"NE", "SE", "SW", "NW"};
        java.util.Map<String, Integer> counts = new java.util.HashMap<>();
        for (String d : diags) counts.put(d, 0);
        for (IBuilding b : buildings) {
            if (!"blockhutguardtower".equals(buildingBlockPath(level, b))) continue;
            BlockPos p = b.getPosition();
            counts.merge(diagOf(p.getX() - center.getX(), p.getZ() - center.getZ()), 1, Integer::sum);
        }
        String best = diags[0];
        int bestCount = Integer.MAX_VALUE;
        for (String d : diags) {
            if (counts.get(d) < bestCount) { bestCount = counts.get(d); best = d; }
        }
        return best;
    }

    // Residences (blockhutcitizen) are distributed round-robin across the 4
    // directional districts so optimizeHomes later assigns workers to homes near
    // their workplace. Returns the quadrant zone with the fewest houses (ties
    // broken primary>secondary>academic>military). Houses that landed in the
    // central hub don't count toward any quadrant.
    private String pickLeastPopulatedResidenceZone(java.util.List<IBuilding> buildings,
            ServerLevel level, BlockPos center, double r1) {
        String[] zones = {"primary", "secondary", "academic", "military"};
        java.util.Map<String, Integer> counts = new java.util.HashMap<>();
        for (String z : zones) counts.put(z, 0);
        for (IBuilding b : buildings) {
            if (!"blockhutcitizen".equals(buildingBlockPath(level, b))) continue;
            BlockPos p = b.getPosition();
            String z = zoneOf(p.getX() - center.getX(), p.getZ() - center.getZ(), r1);
            if (counts.containsKey(z)) counts.merge(z, 1, Integer::sum);
        }
        String best = zones[0];
        int bestCount = Integer.MAX_VALUE;
        for (String z : zones) {
            if (counts.get(z) < bestCount) { bestCount = counts.get(z); best = z; }
        }
        return best;
    }

    // Finds the nearest valid anchor position for a building type within the
    // colony's territory. Returns {x, y, z} or null if no valid position exists.
    private int[] findPlacementPos(String blockId, int colonyId) {
        return findPlacementPos(blockId, colonyId, defaultFlatnessThreshold());
    }

    private int[] findPlacementPos(String blockId, int colonyId, int flatnessThreshold) {
        ServerLevel level = server.overworld();
        IColony colony = IColonyManager.getInstance().getColonyByWorld(colonyId, level);
        if (colony == null) return null;

        BlockPos center = colony.getCenter();
        String typeName = blockId.contains(":")
            ? blockId.substring(blockId.indexOf(':') + 1).replaceFirst("^blockhut", "")
            : blockId.replaceFirst("^blockhut", "");
        int[] fp = BUILDING_FOOTPRINTS.getOrDefault(typeName, new int[]{10, 10});
        int bw = fp[0];
        int bd = fp[1];

        // Candidate footprint as offsets relative to the anchor. Blueprints don't
        // all extend +X/+Z from their anchor (townhall extends -Z), so prefer the
        // real blueprint extent: ColonyUtils.calculateCorners is a pure translation
        // of the anchor (anchor - primaryBlockOffset .. +size-1), so computing it
        // once at BlockPos.ZERO gives reusable offsets. rotation=0/mirror=false
        // matches how placeOnServerThread places buildings.
        int offMinX = 0, offMinZ = 0, offMaxX = bw - 1, offMaxZ = bd - 1;
        // Anchor height above the blueprint's "groundlevel"-tagged block. Most
        // huts tag ground at anchor-relative y=-1 (anchor sits on the terrain),
        // but multi-story blueprints put the anchor higher: colonial
        // university1 tags ground at y=-7, so anchoring it at terrain height
        // sank the whole campus 6 blocks into a bedrock pit (2026-07-04).
        int groundAnchorOffset = 1;
        String bpPath = BLUEPRINT_PATHS.get(typeName);
        StructurePackMeta pinnedPack = getPinnedPack();
        if (bpPath != null && pinnedPack != null) {
            try {
                com.ldtteam.structurize.blueprints.v1.Blueprint blueprint =
                    StructurePacks.getBlueprint(pinnedPack.getName(), bpPath);
                if (blueprint != null) {
                    net.minecraft.util.Tuple<BlockPos, BlockPos> c =
                        com.minecolonies.api.util.ColonyUtils.calculateCorners(
                            BlockPos.ZERO, level, blueprint, 0, false);
                    offMinX = c.getA().getX();
                    offMinZ = c.getA().getZ();
                    offMaxX = c.getB().getX();
                    offMaxZ = c.getB().getZ();
                    groundAnchorOffset =
                        com.ldtteam.structurize.blueprints.v1.BlueprintTagUtils
                            .getGroundAnchorOffset(blueprint, 1);
                }
            } catch (Exception ignored) {}
        }

        // Existing buildings as {minX, minZ, maxX, maxZ} rects.
        java.util.List<int[]> existing = new java.util.ArrayList<>();
        for (IBuilding b : colony.getServerBuildingManager().getBuildings().values()) {
            BlockPos bp = b.getPosition();
            int[] realRect = realFootprintRect(b);
            if (realRect != null) {
                existing.add(realRect);
            } else {
                ResourceLocation bKey = ForgeRegistries.BLOCKS.getKey(level.getBlockState(bp).getBlock());
                String bType = bKey != null ? bKey.getPath().replaceFirst("^blockhut", "") : "";
                int[] bFp = BUILDING_FOOTPRINTS.getOrDefault(bType, new int[]{10, 10});
                existing.add(new int[]{bp.getX(), bp.getZ(), bp.getX() + bFp[0] - 1, bp.getZ() + bFp[1] - 1});
            }
        }

        final int GAP = 5;
        // 200 (was 100, was 60): the disc keeps filling up as the colony grows -
        // at 60 buildings the 100-radius disc had no gap left for a blacksmith.
        // isCoordInColony still filters candidates to actual claimed chunks, and
        // claims are capped by the maxColonySize config (20 chunks = 320 blocks),
        // so the scan radius just needs to stay ahead of the claim frontier.
        final int MAX_DIST = 200;
        // Baseline anchor Y, townhall-relative. center.getY() is the townhall
        // anchor = one above the terrain's top solid block, i.e. where a
        // groundAnchorOffset==1 anchor belongs. Taller offsets raise the anchor
        // so the blueprint's ground layer stays flush with the terrain instead
        // of being excavated in. On a flat world this is the actual placement Y
        // for every candidate (matching the pre-terrain behaviour); on rolling
        // terrain it is used only for the Y-insensitive candidate gates below
        // (claim/isInBuilding/builder-proximity), while the real per-cell
        // placement Y is derived from the sampled surface once a candidate clears
        // the XZ collision check.
        final int baselineY = center.getY() - 1 + groundAnchorOffset;

        java.util.List<int[]> offsets = new java.util.ArrayList<>(15000);
        for (int dx = -MAX_DIST; dx <= MAX_DIST; dx++) {
            for (int dz = -MAX_DIST; dz <= MAX_DIST; dz++) {
                double dist = Math.sqrt((double)(dx * dx + dz * dz));
                if (dist <= MAX_DIST) {
                    offsets.add(new int[]{dx, dz, (int)(dist * 1000)});
                }
            }
        }
        offsets.sort((a, b2) -> a[2] - b2[2]);

        java.util.List<IBuilding> allBuildings = new java.util.ArrayList<>(
            colony.getServerBuildingManager().getBuildings().values());

        // A builder can only construct within 100 blocks of its hut
        // (WorkOrderBuilding.canBuild, dist^2 <= 10000). Placing beyond that
        // creates a building no one can ever build - 93 of the runaway
        // orders were stuck exactly like that (2026-07-06). Keep candidates
        // within 90 of some lv1+ builder hut (margin for blueprint extent).
        final long PLACE_NEAR_BUILDER_SQ = 90L * 90L;
        java.util.List<BlockPos> builderHuts = new java.util.ArrayList<>();
        for (IBuilding b : allBuildings) {
            ResourceLocation k = ForgeRegistries.BLOCKS.getKey(level.getBlockState(b.getPosition()).getBlock());
            if (k != null && "blockhutbuilder".equals(k.getPath()) && b.getBuildingLevel() >= 1) {
                builderHuts.add(b.getPosition());
            }
        }

        // District zoning (2026-07-11, Agent E). Every candidate (dx,dz) maps to
        // a zone; a building is only placed in candidates matching its required
        // zone, keeping the layout functionally clustered (workplaces / homes /
        // food near each other). The existing terrain/water/flatness/collision/
        // claim/builder-proximity gates are all still applied first - zoning is
        // an extra accept/reject filter layered on the surviving candidates.
        final double R1 = zoneCenterRadius();   // central hub radius
        final double R2 = zoneGuardRadius();    // guardtower boundary ring radius
        final boolean isGuardtower = "guardtower".equals(typeName);
        final boolean isCitizen = "citizen".equals(typeName);
        final String requiredZone;
        final String targetDiag;
        if (isGuardtower) {
            requiredZone = "guardtower";
            targetDiag = pickGuardtowerDiagonal(allBuildings, level, center);
        } else if (isCitizen) {
            requiredZone = pickLeastPopulatedResidenceZone(allBuildings, level, center, R1);
            targetDiag = null;
        } else {
            String z = ZONE_MAP.get(typeName);
            if (z == null) {
                z = "secondary"; // unmapped hut -> industrial ring (see ZONE_MAP)
                LOGGER.info("placeNext[{}]: type '{}' has no ZONE_MAP entry; "
                        + "defaulting to zone 'secondary'", blockId, typeName);
            }
            requiredZone = z;
            targetDiag = null;
        }
        LOGGER.info("placeNext[{}]: zoning colony {} -> requiredZone={}{} "
                + "(R1={}, R2={})", blockId, colonyId, requiredZone,
                isGuardtower ? " targetDiag=" + targetDiag : "", R1, R2);

        // Fallback bookkeeping: if no candidate clears the flatness gate within
        // the whole scan disc we must still return *something* (placement must
        // never fail). Two tiers, preferred first:
        //   dry*  = flattest DRY (no water in footprint) candidate that only
        //           failed the flatness gate -> still never builds on water.
        //   wet*  = flattest candidate of ANY kind (last resort when the whole
        //           disc is water, e.g. the ~89% water founding area).
        int dryX = 0, dryY = 0, dryZ = 0, drySpread = Integer.MAX_VALUE;
        boolean haveDry = false;
        int wetX = 0, wetY = 0, wetZ = 0, wetSpread = Integer.MAX_VALUE;
        boolean haveWet = false;

        // Zone-relaxation fallbacks. All of these are DRY and pass the flatness
        // gate (buildable as-is, no terraform) - only the *district* is
        // compromised, so they rank above the terraform-needing steep tiers.
        // Populated nearest-first (offsets are distance-sorted).
        int adjX = 0, adjY = 0, adjZ = 0; boolean haveAdj = false;        // adjacent-zone dry+flat
        int anyX = 0, anyY = 0, anyZ = 0; boolean haveAnyFlat = false;    // any-zone dry+flat
        // Exact-zone but too steep for the flatness gate (keeps district, needs
        // terracing); flattest such cell.
        int exX = 0, exY = 0, exZ = 0, exSpread = Integer.MAX_VALUE; boolean haveEx = false;
        // Guardtower: best on the target diagonal (min |r-R2|) and best on any
        // diagonal (nearest fallback), both dry+flat.
        int gX = 0, gY = 0, gZ = 0; long gScore = Long.MAX_VALUE; boolean haveG = false;
        int gaX = 0, gaY = 0, gaZ = 0; boolean haveGAny = false;

        for (int[] off : offsets) {
            int nx = center.getX() + off[0];
            int nz = center.getZ() + off[1];
            BlockPos anchor = new BlockPos(nx, baselineY, nz);
            if (!colony.isCoordInColony(level, anchor)) continue;
            if (!builderHuts.isEmpty() && builderHuts.stream()
                    .noneMatch(h -> h.distSqr(anchor) <= PLACE_NEAR_BUILDER_SQ)) {
                continue;
            }

            // Use MineColonies' own isInBuilding for the anchor to catch actual
            // blueprint bounds (which may extend in -Z or be larger than our table).
            boolean anchorInside = false;
            for (IBuilding b : allBuildings) {
                try {
                    if (b.isInBuilding(anchor)) { anchorInside = true; break; }
                } catch (Exception ignored) {}
            }
            if (anchorInside) continue;

            // Check that the new building's footprint (blueprint-based offsets,
            // table fallback) doesn't overlap any existing building's rect + GAP.
            int cMinX = nx + offMinX, cMaxX = nx + offMaxX;
            int cMinZ = nz + offMinZ, cMaxZ = nz + offMaxZ;
            boolean conflict = false;
            for (int[] eb : existing) {
                if (cMinX <= eb[2] + GAP && cMaxX >= eb[0] - GAP
                        && cMinZ <= eb[3] + GAP && cMaxZ >= eb[1] - GAP) {
                    conflict = true;
                    break;
                }
            }
            if (conflict) continue;

            // Candidate is collision-free. Only now (per the perf budget) do we
            // pay for surface sampling: sample the real terrain across the
            // building's footprint (solid ground Y, spread, and whether any
            // column is water) and decide the per-cell placement Y.
            int[] sample = sampleFootprintSurface(
                level, cMinX, cMinZ, cMaxX, cMaxZ);
            int repFloor = sample[0];        // modal OCEAN_FLOOR (floor = top solid + 1)
            int spread   = sample[1];        // max-min solid-ground Y across footprint
            boolean hasWater = sample[2] != 0;

            // repFloor is where a building floor rests (top solid block + 1), the
            // same convention center.getY() encodes at the townhall. The current
            // Y formula is center.getY()-1+groundAnchorOffset = townhallTopSolid +
            // offset; substituting this cell's top solid block (repFloor-1) gives
            // the terrain-relative anchor. Using OCEAN_FLOOR here (solid ground,
            // fluids excluded) means we never anchor on a water surface. On dry
            // land OCEAN_FLOOR == MOTION_BLOCKING_NO_LEAVES, so on flat terrain
            // repFloor == the townhall floor for every column and this reduces to
            // the old baselineY exactly (backward-compatible).
            int terrainY = repFloor - 1 + groundAnchorOffset;

            if (hasWater) {
                // Any water in the footprint disqualifies the cell just like a
                // failed flatness gate. Still eligible as the very-last-resort
                // (wet) fallback so placement never fails on an all-water map.
                if (spread < wetSpread) {
                    wetSpread = spread;
                    wetX = nx; wetY = terrainY; wetZ = nz;
                    haveWet = true;
                }
                continue;
            }

            // Dry cell. Zone of this candidate (only depends on dx,dz).
            final int dx = off[0], dz = off[1];
            final double r = off[2] / 1000.0;   // Euclidean dist from center, blocks
            final String candZone = zoneOf(dx, dz, R1);

            if (spread <= flatnessThreshold) {
                // Dry AND flat: buildable with no terraform. Now apply zoning.
                if (isGuardtower) {
                    // Spread towers around the boundary ring corners. Ideal:
                    // on the target diagonal, closest to radius R2.
                    if (r >= R1 && diagonalish(dx, dz)) {
                        String cd = diagOf(dx, dz);
                        if (cd.equals(targetDiag)) {
                            long score = Math.round(Math.abs(r - R2));
                            if (score < gScore) {
                                gScore = score; gX = nx; gY = terrainY; gZ = nz; haveG = true;
                            }
                        } else if (!haveGAny) {
                            gaX = nx; gaY = terrainY; gaZ = nz; haveGAny = true;
                        }
                    }
                    if (!haveAnyFlat) { anyX = nx; anyY = terrainY; anyZ = nz; haveAnyFlat = true; }
                    continue;
                }
                // Regular building: exact zone wins (return the nearest such);
                // otherwise remember relaxed tiers and keep scanning for an exact.
                if (candZone.equals(requiredZone)) {
                    return new int[]{nx, terrainY, nz};
                }
                if (!haveAdj && zoneAdjacent(requiredZone, candZone)) {
                    adjX = nx; adjY = terrainY; adjZ = nz; haveAdj = true;
                }
                if (!haveAnyFlat) { anyX = nx; anyY = terrainY; anyZ = nz; haveAnyFlat = true; }
                continue;
            }

            // Dry but too steep for the builder to terrace cleanly. Prefer a
            // steep cell that at least stays in the exact zone (keeps district).
            if (!isGuardtower && candZone.equals(requiredZone) && spread < exSpread) {
                exSpread = spread; exX = nx; exY = terrainY; exZ = nz; haveEx = true;
            }
            // remember the flattest such (dry) cell and keep scanning for a gate-passing one.
            if (spread < drySpread) {
                drySpread = spread;
                dryX = nx; dryY = terrainY; dryZ = nz;
                haveDry = true;
            }
            // A dry cell is also a candidate for the wet-tier fallback (a dry
            // steep site still beats building on water).
            if (spread < wetSpread) {
                wetSpread = spread;
                wetX = nx; wetY = terrainY; wetZ = nz;
                haveWet = true;
            }
        }

        // No exact-zone dry+flat site was found. Relax, best-first. Zoning
        // relaxation (still dry+flat, only the district compromised) is preferred
        // over the terraform-needing steep tiers below.

        // Guardtower: target diagonal, then any diagonal, before generic tiers.
        if (isGuardtower) {
            if (haveG) {
                LOGGER.info("placeNext[{}]: guardtower on target diagonal {} near "
                        + "ring R2={} at ({},{},{})", blockId, targetDiag, R2, gX, gY, gZ);
                return new int[]{gX, gY, gZ};
            }
            if (haveGAny) {
                LOGGER.info("placeNext[{}]: no buildable site on target diagonal {} "
                        + "for colony {}; relaxing to nearest diagonal at ({},{},{})",
                        blockId, targetDiag, colonyId, gaX, gaY, gaZ);
                return new int[]{gaX, gaY, gaZ};
            }
        }

        //   zone-relaxed (a): nearest adjacent-zone dry+flat candidate.
        if (haveAdj) {
            LOGGER.info("placeNext[{}]: zone '{}' had no buildable site in colony {}; "
                    + "relaxing to adjacent district at ({},{},{})",
                    blockId, requiredZone, colonyId, adjX, adjY, adjZ);
            return new int[]{adjX, adjY, adjZ};
        }
        //   zone-relaxed (b): nearest dry+flat candidate anywhere (full circle).
        if (haveAnyFlat) {
            LOGGER.info("placeNext[{}]: zone '{}' and its neighbours had no buildable "
                    + "site in colony {}; relaxing to any district at ({},{},{})",
                    blockId, requiredZone, colonyId, anyX, anyY, anyZ);
            return new int[]{anyX, anyY, anyZ};
        }

        // No dry+flat site in any zone -> terraform-needing fallbacks.
        //   (exact-zone steep) keep the district, needs terracing.
        if (haveEx) {
            LOGGER.warn("placeNext[{}]: no flat site anywhere for colony {}; "
                    + "using flattest exact-zone '{}' candidate at ({},{},{}) with spread {} "
                    + "- TERRAFORM NEEDED (Agent C, not yet implemented)",
                    blockId, colonyId, requiredZone, exX, exY, exZ, exSpread);
            return new int[]{exX, exY, exZ};
        }
        //   (a) flattest DRY candidate (avoids water, just needs terracing)
        if (haveDry) {
            LOGGER.warn("placeNext[{}]: no dry footprint within flatness<=" + flatnessThreshold
                    + " for colony {}; falling back to flattest dry candidate at ({},{},{}) "
                    + "with terrain spread {} - TERRAFORM NEEDED (Agent C, not yet implemented)",
                    blockId, colonyId, dryX, dryY, dryZ, drySpread);
            return new int[]{dryX, dryY, dryZ};
        }
        //   (b) no dry site anywhere in the disc. REFUSE to build on water - a
        //       water-placed hut (submerged/flooded) is worse than an unplaced one
        //       (user 2026-07-12: shepherd/beekeeper in water). Placement fails, so
        //       the mayor just doesn't add this building until the colony has dry
        //       land (terraform or a larger dry footprint would unblock it).
        if (haveWet) {
            LOGGER.warn("placeNext[{}]: no dry buildable site for colony {} - "
                    + "refusing to place on water (needs terraform / more dry land); skipping",
                    blockId, colonyId);
        }
        return null;
    }

    // Samples the terrain across a building footprint (inclusive world rect
    // [minX..maxX] x [minZ..maxZ]) and returns {representativeFloorY, spread, water}:
    //   - representativeFloorY: the modal level.getHeight(OCEAN_FLOOR) over the
    //     sampled columns (median on a multimodal tie). OCEAN_FLOOR is the highest
    //     motion-blocking block EXCLUDING fluids, so getHeight returns the floor
    //     (first empty y ABOVE the top solid ground block) even under water - the
    //     anchor therefore rests on solid ground, never on a water surface. Mode
    //     minimises how much the builder must cut/fill vs the surrounding ground.
    //   - spread: max-min OCEAN_FLOOR Y across the samples = the footprint's solid
    //     step height, used by the flatness gate.
    //   - water: 1 if ANY sampled column is covered by fluid, else 0. Detected by
    //     MOTION_BLOCKING_NO_LEAVES (counts fluids) != OCEAN_FLOOR (ignores fluids):
    //     a mismatch means something non-solid (water/lava) sits above the ground.
    //     A single wet column flags the whole footprint (main fix for the ~89%-water
    //     founding area, where flat WATER SURFACES were passing the flatness gate).
    // Perf: instead of every column (a farmer footprint is 25x20 = 500 columns,
    // times many candidates), we subsample on a fixed stride and always include
    // the far edges/corners. Both getHeight calls are cheap heightmap array lookups
    // once the chunk is loaded, so this is a couple dozen reads per candidate.
    // CAVEAT: the stride subsample can miss a narrow (< STRIDE-wide) water channel
    // or a lone log/leaf column that falls between grid lines; corners+edges catch
    // most, but a 1-2 block creek crossing diagonally between samples could slip
    // through. Terraform/water handling (Agent C) is the backstop.
    // On flat DRY land every sample is identical and OCEAN_FLOOR == the old
    // MOTION_BLOCKING_NO_LEAVES value -> mode == that Y, spread == 0, water == 0,
    // so the result matches the pre-water behaviour exactly (backward-compatible).
    private int[] sampleFootprintSurface(ServerLevel level,
            int minX, int minZ, int maxX, int maxZ) {
        final Heightmap.Types SOLID = Heightmap.Types.OCEAN_FLOOR;              // ground, fluids excluded
        final Heightmap.Types WITH_FLUID = Heightmap.Types.MOTION_BLOCKING_NO_LEAVES; // counts fluids
        final int STRIDE = 4;

        // Ensure the footprint's chunks are loaded before reading heightmaps (see
        // handleSurfaceY). getChunk returns cached chunks cheaply, so this is
        // O(#chunks) not O(#columns).
        for (int cx = minX >> 4; cx <= (maxX >> 4); cx++) {
            for (int cz = minZ >> 4; cz <= (maxZ >> 4); cz++) {
                level.getChunk(cx, cz);
            }
        }

        int[] xs = strideCoords(minX, maxX, STRIDE);
        int[] zs = strideCoords(minZ, maxZ, STRIDE);
        java.util.Map<Integer, Integer> counts = new java.util.HashMap<>();
        int min = Integer.MAX_VALUE, max = Integer.MIN_VALUE;
        boolean water = false;
        for (int x : xs) {
            for (int z : zs) {
                int solidY = level.getHeight(SOLID, x, z);
                if (level.getHeight(WITH_FLUID, x, z) != solidY) water = true;
                counts.merge(solidY, 1, Integer::sum);
                if (solidY < min) min = solidY;
                if (solidY > max) max = solidY;
            }
        }
        int spread = (min == Integer.MAX_VALUE) ? 0 : (max - min);
        return new int[]{modeOrMedian(counts), spread, water ? 1 : 0};
    }

    // Sample coordinates from lo..hi on the given stride, always including both
    // endpoints (so opposite footprint edges/corners are covered exactly).
    private static int[] strideCoords(int lo, int hi, int stride) {
        java.util.List<Integer> l = new java.util.ArrayList<>();
        for (int v = lo; v < hi; v += stride) l.add(v);
        l.add(hi);
        int[] a = new int[l.size()];
        for (int i = 0; i < a.length; i++) a[i] = l.get(i);
        return a;
    }

    // Modal key of a value->count histogram; on a multimodal tie (2+ keys share
    // the top count) falls back to the count-weighted median, which is more
    // robust for a bimodal footprint straddling two terraces.
    private static int modeOrMedian(java.util.Map<Integer, Integer> counts) {
        if (counts.isEmpty()) return 0;
        int bestY = 0, bestCount = -1, tie = 0;
        for (java.util.Map.Entry<Integer, Integer> e : counts.entrySet()) {
            int c = e.getValue();
            if (c > bestCount) { bestCount = c; bestY = e.getKey(); tie = 1; }
            else if (c == bestCount) { tie++; }
        }
        if (tie <= 1) return bestY;
        java.util.List<Integer> ys = new java.util.ArrayList<>();
        for (java.util.Map.Entry<Integer, Integer> e : counts.entrySet()) {
            for (int i = 0; i < e.getValue(); i++) ys.add(e.getKey());
        }
        java.util.Collections.sort(ys);
        return ys.get(ys.size() / 2);
    }

    // Buildings that require university research before they can be built.
    // Derived from data/minecolonies/researches/effects/blockhu*.json entries
    // in minecolonies-*.jar. Effect IDs follow the pattern
    // minecolonies:effects/<block_registry_path>; effect strength > 0 = unlocked.
    private static final java.util.Set<String> RESEARCH_GATED_BUILDINGS =
        java.util.Set.of(
            "blockhutalchemist", "blockhutarchery", "blockhutbarracks",
            "blockhutblacksmith", "blockhutcombatacademy", "blockhutcomposter",
            "blockhutconcretemixer", "blockhutcrusher", "blockhutdyer",
            "blockhutenchanter", "blockhutfletcher", "blockhutflorist",
            "blockhutglassblower", "blockhutgraveyard", "blockhuthospital",
            "blockhutlibrary", "blockhutmechanic", "blockhutmysticalsite",
            "blockhutnetherworker", "blockhutplantation", "blockhutsawmill",
            "blockhutschool", "blockhutsifter", "blockhutsmeltery",
            "blockhutstonemason", "blockhutstonesmeltery"
        );

    // type name (the part of the block id after "blockhut") -> blueprint path
    // relative to a structure pack's root, e.g. "blockhutbuilder" ->
    // "fundamentals/builder1.blueprint". Discovered by listing the Colonial
    // pack's bundled blueprints inside minecolonies-*.jar; folders are not
    // consistent (fundamentals/, craftsmanship/<sub>/, military/, etc.) so
    // this can't be derived from a simple naming rule - it's looked up here
    // instead of resolved dynamically, since Structurize's Blueprint class
    // overrides a vanilla method (getBlockState) whose name only resolves
    // correctly when the dependency jar is properly deobfuscated, which
    // `fg.deobf(files(...))` does not actually do for plain local file refs.
    private static final java.util.Map<String, String> BLUEPRINT_PATHS = new java.util.HashMap<>();
    static {
        // Fundamentals
        BLUEPRINT_PATHS.put("townhall",      "fundamentals/townhall1.blueprint");
        BLUEPRINT_PATHS.put("builder",       "fundamentals/builder1.blueprint");
        BLUEPRINT_PATHS.put("citizen",       "fundamentals/house1.blueprint");
        BLUEPRINT_PATHS.put("hospital",      "fundamentals/hospital1.blueprint");
        BLUEPRINT_PATHS.put("tavern",        "fundamentals/tavern1.blueprint");
        BLUEPRINT_PATHS.put("lumberjack",    "fundamentals/forester1.blueprint");
        BLUEPRINT_PATHS.put("miner",         "fundamentals/mine1.blueprint");
        BLUEPRINT_PATHS.put("kitchen",       "fundamentals/restaurant1.blueprint");
        // Craftsmanship / Storage
        BLUEPRINT_PATHS.put("warehouse",     "craftsmanship/storage/warehouse1.blueprint");
        BLUEPRINT_PATHS.put("deliveryman",   "craftsmanship/storage/courier1.blueprint");
        // Craftsmanship / Carpentry
        BLUEPRINT_PATHS.put("sawmill",       "craftsmanship/carpentry/sawmill1.blueprint");
        BLUEPRINT_PATHS.put("fletcher",      "craftsmanship/carpentry/fletcher1.blueprint");
        // Craftsmanship / Metallurgy
        BLUEPRINT_PATHS.put("blacksmith",    "craftsmanship/metallurgy/blacksmith1.blueprint");
        BLUEPRINT_PATHS.put("mechanic",      "craftsmanship/metallurgy/mechanic1.blueprint");
        BLUEPRINT_PATHS.put("smeltery",      "craftsmanship/metallurgy/smeltery1.blueprint");
        // Craftsmanship / Masonry
        BLUEPRINT_PATHS.put("stonemason",    "craftsmanship/masonry/stonemason1.blueprint");
        BLUEPRINT_PATHS.put("stonesmeltery", "craftsmanship/masonry/stonesmeltery1.blueprint");
        BLUEPRINT_PATHS.put("crusher",       "craftsmanship/masonry/crusher1.blueprint");
        BLUEPRINT_PATHS.put("sifter",        "craftsmanship/masonry/sifter1.blueprint");
        // Craftsmanship / Luxury
        BLUEPRINT_PATHS.put("baker",         "craftsmanship/luxury/bakery1.blueprint");
        BLUEPRINT_PATHS.put("cook",          "craftsmanship/luxury/cookery1.blueprint");
        BLUEPRINT_PATHS.put("dyer",          "craftsmanship/luxury/dyer1.blueprint");
        BLUEPRINT_PATHS.put("glassblower",   "craftsmanship/luxury/glassblower1.blueprint");
        BLUEPRINT_PATHS.put("concretemixer", "craftsmanship/luxury/concretemixer1.blueprint");
        BLUEPRINT_PATHS.put("alchemist",     "craftsmanship/luxury/alchemisttower1.blueprint");
        // Agriculture / Horticulture
        BLUEPRINT_PATHS.put("farmer",        "agriculture/horticulture/farm1.blueprint");
        BLUEPRINT_PATHS.put("composter",     "agriculture/horticulture/composter1.blueprint");
        BLUEPRINT_PATHS.put("florist",       "agriculture/horticulture/flowershop1.blueprint");
        BLUEPRINT_PATHS.put("plantation",    "agriculture/horticulture/plantation1.blueprint");
        // Agriculture / Husbandry
        BLUEPRINT_PATHS.put("fisherman",     "agriculture/husbandry/fisher1.blueprint");
        BLUEPRINT_PATHS.put("beekeeper",     "agriculture/husbandry/apiary1.blueprint");
        BLUEPRINT_PATHS.put("chickenherder", "agriculture/husbandry/chickenfarmer1.blueprint");
        BLUEPRINT_PATHS.put("cowboy",        "agriculture/husbandry/cowhand1.blueprint");
        BLUEPRINT_PATHS.put("shepherd",      "agriculture/husbandry/shepherd1.blueprint");
        BLUEPRINT_PATHS.put("swineherder",   "agriculture/husbandry/swineherd1.blueprint");
        BLUEPRINT_PATHS.put("rabbithutch",   "agriculture/husbandry/rabbithutch1.blueprint");
        // Military
        BLUEPRINT_PATHS.put("guardtower",    "military/guardtower1.blueprint");
        BLUEPRINT_PATHS.put("barracks",      "military/barracks1.blueprint");
        BLUEPRINT_PATHS.put("barrackstower", "military/barrackstower1.blueprint");
        BLUEPRINT_PATHS.put("archery",       "military/archery1.blueprint");
        BLUEPRINT_PATHS.put("combatacademy", "military/combatacademy1.blueprint");
        BLUEPRINT_PATHS.put("gatehouse",     "military/gatehouse1.blueprint");
        // Education
        BLUEPRINT_PATHS.put("library",       "education/library1.blueprint");
        BLUEPRINT_PATHS.put("school",        "education/school1.blueprint");
        BLUEPRINT_PATHS.put("university",    "education/university1.blueprint");
        // Mystic
        BLUEPRINT_PATHS.put("enchanter",     "mystic/enchanterstower1.blueprint");
        BLUEPRINT_PATHS.put("graveyard",     "mystic/graveyard1.blueprint");
        BLUEPRINT_PATHS.put("netherworker",  "mystic/nethermine1.blueprint");
    }

    // The BLUEPRINT_PATHS table was derived specifically from the "Colonial"
    // pack's bundled blueprints, so pin to that pack explicitly rather than
    // trusting StructurePacks.getSelectedPack() (which is whatever pack
    // happened to register/select first and varies across server restarts -
    // other packs may not share the same folder layout for every building).
    private static final String PINNED_PACK_NAME = "Colonial";

    private StructurePackMeta getPinnedPack() {
        StructurePackMeta pack = StructurePacks.getStructurePack(PINNED_PACK_NAME);
        if (pack != null) {
            return pack;
        }
        StructurePacks.ensureSelectedPack();
        pack = StructurePacks.getSelectedPack();
        if (pack != null) {
            return pack;
        }
        java.util.Collection<StructurePackMeta> metas = StructurePacks.getPackMetas();
        return metas.isEmpty() ? null : metas.iterator().next();
    }

    private String placeOnServerThread(int x, int y, int z, String blockId) {
        ServerLevel level = server.overworld();
        ResourceLocation rl = new ResourceLocation(blockId);
        Block block = ForgeRegistries.BLOCKS.getValue(rl);
        if (block == null || block == net.minecraft.world.level.block.Blocks.AIR) {
            return "ERROR: unknown block id " + blockId;
        }
        Item item = ForgeRegistries.ITEMS.getValue(rl);
        BlockPos pos = new BlockPos(x, y, z);

        // Footprint collision check: reject if pos falls inside any existing building's
        // bounding box. MineColonies has no such check itself - the Builder will silently
        // demolish normal blocks of any overlapping building during construction.
        IColony nearbyColony = IColonyManager.getInstance().getIColony(level, pos);
        if (nearbyColony != null) {
            for (IBuilding existingBld : nearbyColony.getServerBuildingManager().getBuildings().values()) {
                // Note: no same-position exception here. Placing a different building type
                // at an existing building's anchor block silently destroys it in MineColonies
                // and leaves the replacement in a broken state where requestUpgrade() no
                // longer creates work orders. Treat same-anchor as a footprint collision.
                try {
                    if (existingBld.isInBuilding(pos)) {
                        ResourceLocation existKey = ForgeRegistries.BLOCKS.getKey(
                            level.getBlockState(existingBld.getPosition()).getBlock());
                        String existType = existKey != null ? existKey.getPath() : "unknown";
                        return "ERROR: (" + x + "," + y + "," + z + ") is inside existing building "
                            + existType + " at " + existingBld.getPosition()
                            + " - choose a position outside its footprint";
                    }
                } catch (Exception ignored) {
                    // getCorners() may not be initialised for buildings with no work order yet
                }
            }
        }
        // Territory check: non-town-hall buildings must be placed inside a colony's
        // Territory check: non-town-hall buildings must be inside the colony AND within
        // the effective build radius. Two separate limits apply:
        //   1. Chunk-claim territory: IColonyManager.getIColony / isCoordInColony
        //   2. Euclidean radius: MineColonies silently rejects requestUpgrade for work
        //      orders whose target building is > ~64 blocks from the colony center. The
        //      chunk-claim check is looser (includes edge chunks), so we add an explicit
        //      distance guard of 60 blocks to stay safely inside both limits.
        boolean isTownHall = "blockhuttownhall".equals(rl.getPath());
        if (!isTownHall) {
            IColony nearestColony = null;
            double nearestDist = Double.MAX_VALUE;
            for (IColony c : IColonyManager.getInstance().getAllColonies()) {
                if (!c.getDimension().equals(level.dimension())) continue;
                BlockPos center = c.getCenter();
                double dist = Math.sqrt(Math.pow(pos.getX() - center.getX(), 2)
                    + Math.pow(pos.getZ() - center.getZ(), 2));
                if (dist < nearestDist) { nearestDist = dist; nearestColony = c; }
            }

            if (nearestColony == null) {
                return "ERROR: (" + x + "," + y + "," + z + ") no colony founded yet";
            }

            // Claimed chunks are authoritative: the territory grows as the townhall
            // and border buildings level up, so the old fixed 62-block cap (sized
            // for a level-0 bootstrap colony) wrongly rejected valid positions once
            // the townhall reached lv5.
            if (!nearestColony.isCoordInColony(level, pos)) {
                BlockPos center = nearestColony.getCenter();
                return "ERROR: (" + x + "," + y + "," + z + ") is outside colony claimed territory ("
                    + (int) nearestDist + " blocks from center " + center + ")";
            }

            // Also verify the position is in a claimed chunk (for multi-colony safety).
            if (!nearestColony.isCoordInColony(level, pos)) {
                BlockPos center = nearestColony.getCenter();
                return "ERROR: (" + x + "," + y + "," + z + ") is not in the colony's claimed chunks"
                    + " (colony center " + center + ", dist=" + (int) nearestDist + ")";
            }
        }

        BlockState state = block.defaultBlockState();
        // Place the hut with the same facing as the blueprint's anchor block.
        // MineColonies derives the building's rotation from the difference
        // between the placed hut's facing and the blueprint anchor's facing
        // (BuildingUtils.getRotationFromBlueprint), and the builder constructs
        // the whole schematic at that rotation. Matching the facing pins the
        // rotation to 0 so findPlacementPos's rotation-0 candidate footprint
        // equals the footprint that actually gets built.
        String typeName = rl.getPath().replaceFirst("^blockhut", "");
        String path = BLUEPRINT_PATHS.get(typeName);
        try {
            StructurePackMeta anchorPack = getPinnedPack();
            if (path != null && anchorPack != null) {
                com.ldtteam.structurize.blueprints.v1.Blueprint blueprint =
                    StructurePacks.getBlueprint(anchorPack.getName(), path);
                if (blueprint != null) {
                    com.ldtteam.structurize.util.BlockInfo anchorInfo =
                        blueprint.getBlockInfoAsMap().get(blueprint.getPrimaryBlockOffset());
                    if (anchorInfo != null && anchorInfo.getState() != null
                            && anchorInfo.getState().getBlock() == block) {
                        state = anchorInfo.getState();
                    }
                }
            }
        } catch (Exception ignored) {}

        level.setBlockAndUpdate(pos, state);

        FakePlayer fakePlayer = new FakePlayer(level, AI_PROFILE);
        ItemStack stack = item != null ? new ItemStack(item, 1) : ItemStack.EMPTY;
        // setPlacedBy registers the building with the colony. When a colony already
        // exists, MineColonies initializes the new building immediately and internally
        // calls building.setStructurePack(), which calls getTileEntity() on the
        // building. getTileEntity() returns null at this point (the building<->tile
        // entity back-link is set lazily), causing NPE inside setPlacedBy. The
        // building IS registered before that internal call, so we catch the NPE and
        // continue. If no colony exists yet (town hall placement), setPlacedBy
        // succeeds without the problematic initialization path.
        try {
            block.setPlacedBy(level, pos, state, fakePlayer, stack);
        } catch (NullPointerException ignored) {}

        // Blueprint pack/path must be set on the IBuilding AFTER setPlacedBy.
        // IBuilding.setStructurePack(String) and setBlueprintPath(String) write
        // their own fields first, then try to sync to the tile entity via
        // getTileEntity(). getTileEntity() returns null immediately after
        // setPlacedBy (the building<->tileEntity back-link is set lazily on the
        // next tick or chunk reload), so these calls throw NPE during the sync
        // step. We catch and swallow those NPEs: the building fields ARE already
        // written before the NPE, so IBuilding.getStructurePack() /
        // getBlueprintPath() return the correct values and requestUpgrade works.
        // We also call TileEntityColonyBuilding.setStructurePack/setBlueprintPath
        // directly (these just write their own fields, no back-call, always safe).
        String blueprintNote = "";
        if (path != null) {
            StructurePackMeta pack = getPinnedPack();
            if (pack != null) {
                IColony bldColony = findColonyAt(level, pos);
                if (bldColony != null) {
                    // getBuilding(pos) uses a key-lookup path that can miss buildings
                    // registered via setPlacedBy (key format mismatch). Fall back to
                    // scanning getBuildings().values() so we always find the building.
                    IBuilding bld = bldColony.getServerBuildingManager().getBuilding(pos);
                    if (bld == null) {
                        for (IBuilding candidate : bldColony.getServerBuildingManager().getBuildings().values()) {
                            if (candidate.getPosition().equals(pos)) { bld = candidate; break; }
                        }
                    }
                    if (bld != null) {
                        try { bld.setStructurePack(pack.getName()); } catch (NullPointerException ignored) {}
                        try { bld.setBlueprintPath(path); } catch (NullPointerException ignored) {}
                        try { bld.markDirty(); } catch (Exception ignored) {}
                        // onPlacement()'s own claimBuildingChunks throws before
                        // pack/path exist, leaving footprint chunks unclaimed
                        // (WorkManager then silently drops build orders that touch
                        // them). Redo the claim now that the path is set.
                        try {
                            forceLoadAndClaim(bldColony, level, pos, bld.getClaimRadius(1), bld.getCorners());
                        } catch (Exception e) {
                            LOGGER.warn("post-place chunk claim failed for {}: {}", pos, e.toString());
                        }
                    }
                }
                // Also set directly on the tile entity (these methods only write
                // their own fields, no back-delegation, safe without building link).
                BlockEntity te = level.getBlockEntity(pos);
                if (te instanceof TileEntityColonyBuilding) {
                    try { ((TileEntityColonyBuilding) te).setStructurePack(pack); } catch (Exception ignored) {}
                    try { ((TileEntityColonyBuilding) te).setBlueprintPath(path); } catch (Exception ignored) {}
                }
                blueprintNote = " (blueprint " + pack.getName() + "/" + path + ")";
            }
        } else {
            blueprintNote = " (no known blueprint path for type '" + typeName + "', placed without one)";
        }

        return "placed " + blockId + " at " + x + "," + y + "," + z + blueprintNote;
    }

    // Robust colony lookup: tries the standard position-based lookup first, then
    // falls back to scanning all colonies for one that has a building registered
    // at the given position. The fallback iterates getBuildings() directly rather
    // than calling getBuilding(pos) because getBuilding() may use a different
    // key-lookup path than the map's own containsKey, causing false negatives when
    // the colony was auto-created via setPlacedBy rather than the normal founding flow.
    private IColony findColonyAt(ServerLevel level, BlockPos pos) {
        IColony colony = IColonyManager.getInstance().getIColony(level, pos);
        if (colony != null) return colony;
        for (IColony c : IColonyManager.getInstance().getAllColonies()) {
            if (!c.getDimension().equals(level.dimension())) continue;
            if (c.getServerBuildingManager().getBuildings().containsKey(pos)) return c;
        }
        return null;
    }

    // Maps a ?type= query value to a whitelisted Heightmap.Types.
    // Default (null/absent) = MOTION_BLOCKING_NO_LEAVES: for building placement we
    // want the terrain surface (grass/dirt/stone) and want tree *leaves* excluded
    // so overhanging canopy doesn't inflate the sampled ground height. Returns null
    // for an unrecognised name so the caller can answer HTTP 400.
    //
    // Caveat (Agent B handles): MOTION_BLOCKING_NO_LEAVES still counts tree TRUNKS
    // (logs) and other motion-blocking blocks (e.g. water). A column under a tree
    // therefore reports the trunk top, not the dirt beneath it. Callers that need
    // true ground under vegetation must post-filter / probe downward themselves.
    private static Heightmap.Types parseHeightmapType(String name) {
        if (name == null || name.isEmpty()) return Heightmap.Types.MOTION_BLOCKING_NO_LEAVES;
        switch (name.toUpperCase(java.util.Locale.ROOT)) {
            case "WORLD_SURFACE": return Heightmap.Types.WORLD_SURFACE;
            case "OCEAN_FLOOR": return Heightmap.Types.OCEAN_FLOOR;
            case "MOTION_BLOCKING_NO_LEAVES": return Heightmap.Types.MOTION_BLOCKING_NO_LEAVES;
            default: return null;
        }
    }

    // GET /surfaceY?x=<int>&z=<int>[&type=WORLD_SURFACE|OCEAN_FLOOR|MOTION_BLOCKING_NO_LEAVES]
    //
    // Returns the surface Y for a single column: {"x":..,"z":..,"y":..,"type":".."}.
    // NOTE: level.getHeight() returns the y of the first EMPTY position ABOVE the
    // surface (topmost matching block + 1), i.e. where a building would rest its
    // floor. The top solid block itself is at y-1. Agent B relies on this convention.
    private void handleSurfaceY(HttpExchange exchange) throws IOException {
        try {
            java.util.Map<String, String> params = parseQuery(exchange.getRequestURI().getQuery());
            final int x = Integer.parseInt(params.get("x"));
            final int z = Integer.parseInt(params.get("z"));
            String typeName = params.get("type");
            final Heightmap.Types type = parseHeightmapType(typeName);
            if (type == null) {
                respond(exchange, 400, "{\"error\":\"invalid type '" + escape(String.valueOf(typeName))
                        + "', use WORLD_SURFACE|OCEAN_FLOOR|MOTION_BLOCKING_NO_LEAVES\"}");
                return;
            }
            // Chunk loading + heightmap access must run on the server thread.
            java.util.concurrent.CompletableFuture<String> result = new java.util.concurrent.CompletableFuture<>();
            server.execute(() -> {
                try {
                    ServerLevel level = server.overworld();
                    // getHeight needs the column's chunk loaded. Force a synchronous
                    // full load first (returns cached chunk if already loaded), so an
                    // unloaded/never-generated area is generated & sampled rather than
                    // returning a stale/void height. This can generate terrain on demand.
                    level.getChunk(x >> 4, z >> 4);
                    int y = level.getHeight(type, x, z);
                    result.complete("{\"x\":" + x + ",\"z\":" + z + ",\"y\":" + y
                            + ",\"type\":\"" + type.name() + "\"}");
                } catch (Exception e) {
                    result.complete("ERROR: " + e);
                }
            });
            String outcome = result.get();
            if (outcome.startsWith("ERROR")) {
                respond(exchange, 500, "{\"error\":\"" + escape(outcome) + "\"}");
            } else {
                respond(exchange, 200, outcome);
            }
        } catch (Exception e) {
            respond(exchange, 400, "{\"error\":\"" + escape(String.valueOf(e)) + "\"}");
        }
    }

    // GET /heightmap?x0=<int>&z0=<int>&x1=<int>&z1=<int>[&type=...]
    //
    // Rectangular batch sample for one-shot footprint sampling. Corners are
    // inclusive and order-independent (min/max are normalised). Response:
    //   {"x0":,"z0":,"x1":,"z1":,"width":,"depth":,"type":"..","rows":[[..],..]}
    // "rows" is ROW-MAJOR: rows[i] is the line at z = z0 + i (i in 0..depth-1),
    // and rows[i][j] is the surface Y at x = x0 + j (j in 0..width-1).
    // Rectangle is capped at 64x64 columns to bound per-request cost / on-demand
    // chunk generation; larger requests get HTTP 400.
    private void handleHeightmap(HttpExchange exchange) throws IOException {
        try {
            java.util.Map<String, String> params = parseQuery(exchange.getRequestURI().getQuery());
            int qx0 = Integer.parseInt(params.get("x0"));
            int qz0 = Integer.parseInt(params.get("z0"));
            int qx1 = Integer.parseInt(params.get("x1"));
            int qz1 = Integer.parseInt(params.get("z1"));
            String typeName = params.get("type");
            final Heightmap.Types type = parseHeightmapType(typeName);
            if (type == null) {
                respond(exchange, 400, "{\"error\":\"invalid type '" + escape(String.valueOf(typeName))
                        + "', use WORLD_SURFACE|OCEAN_FLOOR|MOTION_BLOCKING_NO_LEAVES\"}");
                return;
            }
            final int minX = Math.min(qx0, qx1);
            final int maxX = Math.max(qx0, qx1);
            final int minZ = Math.min(qz0, qz1);
            final int maxZ = Math.max(qz0, qz1);
            final int width = maxX - minX + 1;
            final int depth = maxZ - minZ + 1;
            final int MAX_SIDE = 64;
            if (width > MAX_SIDE || depth > MAX_SIDE) {
                respond(exchange, 400, "{\"error\":\"rectangle " + width + "x" + depth
                        + " exceeds " + MAX_SIDE + "x" + MAX_SIDE + " limit\"}");
                return;
            }
            java.util.concurrent.CompletableFuture<String> result = new java.util.concurrent.CompletableFuture<>();
            server.execute(() -> {
                try {
                    ServerLevel level = server.overworld();
                    // Force-load every chunk overlapping the rectangle up front (see
                    // handleSurfaceY note). getChunk returns cached chunks cheaply, so
                    // this is O(#chunks) not O(#columns); heightmap reads below then hit
                    // loaded chunks only.
                    for (int cx = minX >> 4; cx <= (maxX >> 4); cx++) {
                        for (int cz = minZ >> 4; cz <= (maxZ >> 4); cz++) {
                            level.getChunk(cx, cz);
                        }
                    }
                    StringBuilder sb = new StringBuilder();
                    sb.append("{\"x0\":").append(minX)
                      .append(",\"z0\":").append(minZ)
                      .append(",\"x1\":").append(maxX)
                      .append(",\"z1\":").append(maxZ)
                      .append(",\"width\":").append(width)
                      .append(",\"depth\":").append(depth)
                      .append(",\"type\":\"").append(type.name()).append("\"")
                      .append(",\"rows\":[");
                    for (int zz = minZ; zz <= maxZ; zz++) {
                        if (zz > minZ) sb.append(",");
                        sb.append("[");
                        for (int xx = minX; xx <= maxX; xx++) {
                            if (xx > minX) sb.append(",");
                            sb.append(level.getHeight(type, xx, zz));
                        }
                        sb.append("]");
                    }
                    sb.append("]}");
                    result.complete(sb.toString());
                } catch (Exception e) {
                    result.complete("ERROR: " + e);
                }
            });
            String outcome = result.get();
            if (outcome.startsWith("ERROR")) {
                respond(exchange, 500, "{\"error\":\"" + escape(outcome) + "\"}");
            } else {
                respond(exchange, 200, outcome);
            }
        } catch (Exception e) {
            respond(exchange, 400, "{\"error\":\"" + escape(String.valueOf(e)) + "\"}");
        }
    }

    // ==================== Persona-phase endpoints: /threats /moveCitizen /guardOrder ====================
    //
    // Backing for the citizen-persona reactor (DESIGN_DECISIONS_persona.md, Agent P0):
    // a Node daemon polls /threats, lets each persona decide, then drives citizens
    // with /moveCitizen and /guardOrder. HTTP threads only validate and (de)register
    // orders in the maps below; ALL entity access happens on the server thread inside
    // tickCitizenOrders(), which onServerTick calls every tick (same pattern as
    // keepColoniesActive). Orders are in-memory only - a server restart clears them.

    private static final class MoveOrder {
        final int colonyId;
        final int citizenId;
        final BlockPos target;
        final int range;          // arrival distance in blocks
        final long deadlineTick;  // bridgeTick after which the order times out
        volatile String status = "moving"; // moving -> arrived | timeout | lost | replaced
        MoveOrder(int colonyId, int citizenId, BlockPos target, int range, long deadlineTick) {
            this.colonyId = colonyId;
            this.citizenId = citizenId;
            this.target = target;
            this.range = range;
            this.deadlineTick = deadlineTick;
        }
    }

    private static final class GuardOrder {
        final int colonyId;
        final int citizenId;
        final String mode;     // engage | standdown
        final BlockPos target; // engage: destination to fight at; standdown: anchor to hold
        volatile String status = "active"; // active | lost (entity currently absent)
        GuardOrder(int colonyId, int citizenId, String mode, BlockPos target) {
            this.colonyId = colonyId;
            this.citizenId = citizenId;
            this.mode = mode;
            this.target = target;
        }
    }

    private final java.util.concurrent.ConcurrentHashMap<String, MoveOrder> moveOrders = new java.util.concurrent.ConcurrentHashMap<>();
    private final java.util.concurrent.ConcurrentHashMap<String, GuardOrder> guardOrders = new java.util.concurrent.ConcurrentHashMap<>();
    // Server tick counter for order deadlines. Tick-based (not wall clock) so the
    // timeout tracks in-world time under the tick-rate governor.
    private volatile long bridgeTick = 0;

    private static String citizenKey(int colonyId, int citizenId) {
        return colonyId + ":" + citizenId;
    }

    // Server thread only.
    private com.minecolonies.core.entity.citizen.EntityCitizen resolveCitizenEntity(int colonyId, int citizenId) {
        IColony colony = IColonyManager.getInstance().getColonyByWorld(colonyId, server.overworld());
        if (colony == null) return null;
        ICitizenData cd = colony.getCitizenManager().getCivilian(citizenId);
        if (cd == null) return null;
        java.util.Optional<AbstractEntityCitizen> opt = cd.getEntity();
        if (opt.isEmpty() || !(opt.get() instanceof com.minecolonies.core.entity.citizen.EntityCitizen ec)) return null;
        return ec;
    }

    private void tickCitizenOrders() {
        bridgeTick++;
        if (server == null || (moveOrders.isEmpty() && guardOrders.isEmpty())) return;
        for (MoveOrder o : moveOrders.values()) {
            if (!"moving".equals(o.status)) continue;
            try {
                com.minecolonies.core.entity.citizen.EntityCitizen ent = resolveCitizenEntity(o.colonyId, o.citizenId);
                if (ent == null) { o.status = "lost"; continue; }
                if (bridgeTick > o.deadlineTick) {
                    o.status = "timeout";
                    ent.getNavigation().stop();
                    continue;
                }
                // MineColonies has no citizen-pause API in 1.1.1231, so we win the
                // navigator tug-of-war by re-issuing instead: walkToPos re-claims the
                // navigation whenever the citizen's job AI stole it (it checks the
                // current path job via PathJobMoveToLocation.isJobFor and re-paths if
                // it is not ours), keeps walking when the path is already ours, and
                // returns true + stops the navigator once within `range` blocks.
                // Called every tick, this outpaces the work AI's own (much rarer)
                // navigation calls without touching its state machine.
                if (com.minecolonies.core.entity.pathfinding.navigation.EntityNavigationUtils.walkToPos(ent, o.target, o.range, true)) {
                    o.status = "arrived";
                }
            } catch (Exception e) {
                LOGGER.warn("moveCitizen tick failed for {}:{}: {}", o.colonyId, o.citizenId, e.toString());
            }
        }
        for (GuardOrder g : guardOrders.values()) {
            try {
                com.minecolonies.core.entity.citizen.EntityCitizen ent = resolveCitizenEntity(g.colonyId, g.citizenId);
                if (ent == null) { g.status = "lost"; continue; }
                g.status = "active";
                if ("standdown".equals(g.mode)) {
                    tickStanddown(g, ent);
                } else {
                    tickEngage(g, ent);
                }
            } catch (Exception e) {
                LOGGER.warn("guardOrder tick failed for {}:{}: {}", g.colonyId, g.citizenId, e.toString());
            }
        }
    }

    private static final double ENGAGE_SEEK_RADIUS = 24.0;  // enemy search radius around guard and around target pos
    private static final double ENGAGE_LEASH_RADIUS = 40.0; // ignore enemies further than this from the guard

    // engage: march to the ordered position, then feed enemies into the guard's own
    // combat machinery. Guards acquire targets through their ThreatTable (EntityCitizen
    // implements IThreatTableEntity), so injecting threat + entity target makes the
    // native combat AI (Knight/Ranger/Druid) do the actual approach/strafe/attack -
    // no need to reimplement fighting. Persists until mode=return or standdown.
    private void tickEngage(GuardOrder g, com.minecolonies.core.entity.citizen.EntityCitizen ent) {
        ServerLevel level = server.overworld();
        net.minecraft.world.entity.LivingEntity enemy = nearestEnemy(level, ent.blockPosition(), ENGAGE_SEEK_RADIUS);
        if (enemy == null) enemy = nearestEnemy(level, g.target, ENGAGE_SEEK_RADIUS);
        if (enemy != null && ent.distanceTo(enemy) <= ENGAGE_LEASH_RADIUS) {
            // Refresh every 10 ticks (or when the target died) so the combat AI keeps
            // this enemy hot without us fighting the AI for control every tick.
            if (bridgeTick % 10 == 0 || ent.getTarget() == null || !ent.getTarget().isAlive()) {
                ent.getThreatTable().addThreat(enemy, 50);
                ent.setTarget(enemy);
            }
        } else {
            // No live enemy in reach: march to / hold the ordered position. Returns
            // true (and stops pathing) once within 3 blocks; re-walks if the guard's
            // job AI (patrol, return-to-tower) tries to drag it away.
            com.minecolonies.core.entity.pathfinding.navigation.EntityNavigationUtils.walkToPos(ent, g.target, 3, true);
        }
    }

    // standdown ("betrayal"): stay put and refuse combat. The guard AI re-acquires
    // targets from its ThreatTable every AI tick, so we clear the table, the entity
    // target AND the AI's internal `target` field (reflection, cached per AI class)
    // every server tick for as long as the order stands.
    private void tickStanddown(GuardOrder g, com.minecolonies.core.entity.citizen.EntityCitizen ent) {
        if (ent.getTarget() != null) ent.setTarget(null);
        try { ent.getThreatTable().resetTable(); } catch (Exception ignored) {}
        clearGuardAITarget(ent);
        if (com.minecolonies.api.util.BlockPosUtil.dist(ent.blockPosition(), g.target) > 3) {
            com.minecolonies.core.entity.pathfinding.navigation.EntityNavigationUtils.walkToPos(ent, g.target, 2, true);
        }
    }

    private static net.minecraft.world.entity.LivingEntity nearestEnemy(ServerLevel level, BlockPos around, double radius) {
        net.minecraft.world.phys.AABB box = new net.minecraft.world.phys.AABB(
            around.getX() - radius, around.getY() - radius, around.getZ() - radius,
            around.getX() + radius, around.getY() + radius, around.getZ() + radius);
        net.minecraft.world.entity.LivingEntity best = null;
        double bestDist = Double.MAX_VALUE;
        for (net.minecraft.world.entity.LivingEntity e : level.getEntitiesOfClass(
                net.minecraft.world.entity.LivingEntity.class, box,
                le -> le.isAlive() && le instanceof net.minecraft.world.entity.monster.Enemy)) {
            double d = e.distanceToSqr(around.getX() + 0.5, around.getY() + 0.5, around.getZ() + 0.5);
            if (d < bestDist) { bestDist = d; best = e; }
        }
        return best;
    }

    // The guard AI keeps its current target in a protected LivingEntity field named
    // `target` (declared on AbstractEntityAIFight / AbstractEntityAIGuard). Null it
    // via reflection so a fight already in progress stops too.
    private static final java.util.concurrent.ConcurrentHashMap<Class<?>, java.util.List<java.lang.reflect.Field>> aiTargetFieldCache =
        new java.util.concurrent.ConcurrentHashMap<>();

    private void clearGuardAITarget(com.minecolonies.core.entity.citizen.EntityCitizen ent) {
        try {
            ICitizenData cd = ent.getCitizenData();
            if (cd == null) return;
            com.minecolonies.api.colony.jobs.IJob<?> job = cd.getJob();
            if (!(job instanceof com.minecolonies.core.colony.jobs.AbstractJobGuard<?> guardJob)) return;
            Object ai = guardJob.getWorkerAI();
            if (ai == null) return;
            java.util.List<java.lang.reflect.Field> fields = aiTargetFieldCache.computeIfAbsent(ai.getClass(), cls -> {
                java.util.List<java.lang.reflect.Field> out = new java.util.ArrayList<>();
                for (Class<?> c = cls; c != null; c = c.getSuperclass()) {
                    for (java.lang.reflect.Field f : c.getDeclaredFields()) {
                        if ("target".equals(f.getName())
                                && net.minecraft.world.entity.LivingEntity.class.isAssignableFrom(f.getType())) {
                            f.setAccessible(true);
                            out.add(f);
                        }
                    }
                }
                return out;
            });
            for (java.lang.reflect.Field f : fields) f.set(ai, null);
        } catch (Exception ignored) {}
    }

    // GET /threats?colonyId=1[&radius=200]
    // Hostile entities within `radius` blocks (full height) of the colony center,
    // plus the MineColonies raid state. Filter is `instanceof Enemy`, which catches
    // both vanilla monsters (zombie etc.) and MineColonies raiders (barbarians,
    // pirates... all implement net.minecraft.world.entity.monster.Enemy).
    private void handleThreats(HttpExchange exchange) throws IOException {
        try {
            java.util.Map<String, String> params = parseQuery(exchange.getRequestURI().getQuery());
            int colonyId = Integer.parseInt(params.getOrDefault("colonyId", "1"));
            int radius = Integer.parseInt(params.getOrDefault("radius", "200"));

            java.util.concurrent.CompletableFuture<String> result = new java.util.concurrent.CompletableFuture<>();
            server.execute(() -> {
                try {
                    ServerLevel level = server.overworld();
                    IColony colony = IColonyManager.getInstance().getColonyByWorld(colonyId, level);
                    if (colony == null) { result.complete("ERROR: no colony with id " + colonyId); return; }
                    BlockPos center = colony.getCenter();
                    net.minecraft.world.phys.AABB box = new net.minecraft.world.phys.AABB(
                        center.getX() - radius, level.getMinBuildHeight(), center.getZ() - radius,
                        center.getX() + radius, level.getMaxBuildHeight(), center.getZ() + radius);
                    StringBuilder sb = new StringBuilder();
                    sb.append("{\"colonyId\":").append(colonyId)
                      .append(",\"center\":{\"x\":").append(center.getX())
                      .append(",\"y\":").append(center.getY())
                      .append(",\"z\":").append(center.getZ()).append("}")
                      .append(",\"radius\":").append(radius)
                      .append(",\"threats\":[");
                    boolean first = true;
                    for (net.minecraft.world.entity.LivingEntity e : level.getEntitiesOfClass(
                            net.minecraft.world.entity.LivingEntity.class, box,
                            le -> le.isAlive() && le instanceof net.minecraft.world.entity.monster.Enemy)) {
                        if (!first) sb.append(",");
                        first = false;
                        ResourceLocation typeKey = ForgeRegistries.ENTITY_TYPES.getKey(e.getType());
                        // Which citizen (if any) the mob is hunting - lets the reactor
                        // warn/evacuate that specific citizen.
                        Integer targetCitizenId = null;
                        try {
                            if (e instanceof net.minecraft.world.entity.Mob mob
                                    && mob.getTarget() instanceof AbstractEntityCitizen tc
                                    && tc.getCitizenData() != null) {
                                targetCitizenId = tc.getCitizenData().getId();
                            }
                        } catch (Exception ignored) {}
                        double dist = Math.sqrt(e.distanceToSqr(center.getX() + 0.5, e.getY(), center.getZ() + 0.5));
                        sb.append("{\"id\":").append(e.getId())
                          .append(",\"type\":\"").append(typeKey != null ? typeKey : "unknown").append("\"")
                          .append(",\"x\":").append(String.format(java.util.Locale.ROOT, "%.1f", e.getX()))
                          .append(",\"y\":").append(String.format(java.util.Locale.ROOT, "%.1f", e.getY()))
                          .append(",\"z\":").append(String.format(java.util.Locale.ROOT, "%.1f", e.getZ()))
                          .append(",\"health\":").append(String.format(java.util.Locale.ROOT, "%.1f", e.getHealth()))
                          .append(",\"maxHealth\":").append(String.format(java.util.Locale.ROOT, "%.1f", e.getMaxHealth()))
                          .append(",\"raider\":").append(e instanceof com.minecolonies.api.entity.mobs.AbstractEntityMinecoloniesRaider)
                          .append(",\"distanceFromCenter\":").append(String.format(java.util.Locale.ROOT, "%.1f", dist))
                          .append(",\"targetCitizenId\":").append(targetCitizenId == null ? "null" : targetCitizenId)
                          .append("}");
                    }
                    sb.append("],\"raid\":{");
                    try {
                        com.minecolonies.api.colony.managers.interfaces.IRaiderManager rm = colony.getRaiderManager();
                        sb.append("\"active\":").append(rm.isRaided())
                          .append(",\"willRaidTonight\":").append(rm.willRaidTonight())
                          .append(",\"raidLevel\":").append(rm.getColonyRaidLevel())
                          .append(",\"nightsSinceLastRaid\":").append(rm.getNightsSinceLastRaid());
                    } catch (Exception e) {
                        sb.append("\"active\":false,\"error\":\"").append(escape(e.toString())).append("\"");
                    }
                    sb.append("}}");
                    result.complete(sb.toString());
                } catch (Exception e) {
                    LOGGER.error("threats failed", e);
                    result.complete("ERROR: " + e);
                }
            });
            String outcome = result.get();
            if (outcome.startsWith("ERROR")) {
                respond(exchange, 500, "{\"error\":\"" + escape(outcome) + "\"}");
            } else {
                respond(exchange, 200, outcome);
            }
        } catch (Exception e) {
            respond(exchange, 400, "{\"error\":\"" + escape(String.valueOf(e)) + "\"}");
        }
    }

    // POST /moveCitizen?colonyId=1&citizenId=5&x=..&y=..&z=..[&range=2][&timeout=60]
    //   Walks the citizen to the position for real (see tickCitizenOrders for how the
    //   job-AI conflict is handled). timeout is in seconds of GAME ticks (x20).
    //   A new move order supersedes any previous move/guard order for that citizen.
    // GET /moveCitizen?colonyId=1&citizenId=5
    //   Status of the current/last order: moving | arrived | timeout | lost | replaced | none.
    private void handleMoveCitizen(HttpExchange exchange) throws IOException {
        try {
            java.util.Map<String, String> params = parseQuery(exchange.getRequestURI().getQuery());
            int colonyId = Integer.parseInt(params.getOrDefault("colonyId", "1"));
            int citizenId = Integer.parseInt(params.get("citizenId"));
            String key = citizenKey(colonyId, citizenId);

            if ("GET".equalsIgnoreCase(exchange.getRequestMethod())) {
                MoveOrder o = moveOrders.get(key);
                if (o == null) { respond(exchange, 200, "{\"status\":\"none\"}"); return; }
                java.util.concurrent.CompletableFuture<String> result = new java.util.concurrent.CompletableFuture<>();
                server.execute(() -> {
                    double dist = -1;
                    try {
                        com.minecolonies.core.entity.citizen.EntityCitizen ent = resolveCitizenEntity(colonyId, citizenId);
                        if (ent != null) {
                            dist = Math.sqrt(ent.distanceToSqr(o.target.getX() + 0.5, o.target.getY() + 0.5, o.target.getZ() + 0.5));
                        }
                    } catch (Exception ignored) {}
                    result.complete(String.format(java.util.Locale.ROOT,
                        "{\"status\":\"%s\",\"target\":{\"x\":%d,\"y\":%d,\"z\":%d},\"distance\":%.1f}",
                        o.status, o.target.getX(), o.target.getY(), o.target.getZ(), dist));
                });
                respond(exchange, 200, result.get());
                return;
            }
            if (!"POST".equalsIgnoreCase(exchange.getRequestMethod())) {
                respond(exchange, 405, "{\"error\":\"use GET or POST\"}");
                return;
            }
            int x = Integer.parseInt(params.get("x"));
            int y = Integer.parseInt(params.get("y"));
            int z = Integer.parseInt(params.get("z"));
            int range = Integer.parseInt(params.getOrDefault("range", "2"));
            int timeoutSec = Integer.parseInt(params.getOrDefault("timeout", "60"));

            java.util.concurrent.CompletableFuture<String> result = new java.util.concurrent.CompletableFuture<>();
            server.execute(() -> {
                try {
                    IColony colony = IColonyManager.getInstance().getColonyByWorld(colonyId, server.overworld());
                    if (colony == null) { result.complete("ERROR: no colony with id " + colonyId); return; }
                    ICitizenData cd = colony.getCitizenManager().getCivilian(citizenId);
                    if (cd == null) { result.complete("ERROR: no citizen with id " + citizenId); return; }
                    if (cd.getEntity().isEmpty()) {
                        result.complete("ERROR: citizen " + citizenId + " has no live entity right now");
                        return;
                    }
                    guardOrders.remove(key); // move supersedes any standing guard order
                    MoveOrder prev = moveOrders.put(key,
                        new MoveOrder(colonyId, citizenId, new BlockPos(x, y, z), range, bridgeTick + timeoutSec * 20L));
                    if (prev != null && "moving".equals(prev.status)) prev.status = "replaced";
                    result.complete("citizen " + citizenId + " moving to " + x + "," + y + "," + z
                        + " (range " + range + ", timeout " + timeoutSec + "s)");
                } catch (Exception e) {
                    result.complete("ERROR: " + e);
                }
            });
            String outcome = result.get();
            if (outcome.startsWith("ERROR")) {
                respond(exchange, 500, "{\"error\":\"" + escape(outcome) + "\"}");
            } else {
                respond(exchange, 200, "{\"result\":\"" + escape(outcome) + "\"}");
            }
        } catch (Exception e) {
            respond(exchange, 400, "{\"error\":\"" + escape(String.valueOf(e)) + "\"}");
        }
    }

    // POST /guardOrder?colonyId=1&citizenId=7&mode=engage|standdown|return[&x=&y=&z=]
    //   engage:    x,y,z required - move there and fight enemies in reach (persists).
    //   standdown: hold position and refuse combat (anchor = x,y,z if given, else the
    //              guard's current position). Persists until return.
    //   return:    drop any engage/standdown order and resume normal duty.
    // GET /guardOrder?colonyId=1&citizenId=7 - current order, if any.
    // Works on any citizen, but only guards (AbstractJobGuard) actually fight on
    // engage; non-guards will just walk there.
    private void handleGuardOrder(HttpExchange exchange) throws IOException {
        try {
            java.util.Map<String, String> params = parseQuery(exchange.getRequestURI().getQuery());
            int colonyId = Integer.parseInt(params.getOrDefault("colonyId", "1"));
            int citizenId = Integer.parseInt(params.get("citizenId"));
            String key = citizenKey(colonyId, citizenId);

            if ("GET".equalsIgnoreCase(exchange.getRequestMethod())) {
                GuardOrder g = guardOrders.get(key);
                if (g == null) { respond(exchange, 200, "{\"mode\":\"none\"}"); return; }
                respond(exchange, 200, String.format(java.util.Locale.ROOT,
                    "{\"mode\":\"%s\",\"status\":\"%s\",\"target\":{\"x\":%d,\"y\":%d,\"z\":%d}}",
                    g.mode, g.status, g.target.getX(), g.target.getY(), g.target.getZ()));
                return;
            }
            if (!"POST".equalsIgnoreCase(exchange.getRequestMethod())) {
                respond(exchange, 405, "{\"error\":\"use GET or POST\"}");
                return;
            }
            String mode = params.getOrDefault("mode", "");
            if (!"engage".equals(mode) && !"standdown".equals(mode) && !"return".equals(mode)) {
                respond(exchange, 400, "{\"error\":\"mode must be engage, standdown or return\"}");
                return;
            }

            java.util.concurrent.CompletableFuture<String> result = new java.util.concurrent.CompletableFuture<>();
            server.execute(() -> {
                try {
                    IColony colony = IColonyManager.getInstance().getColonyByWorld(colonyId, server.overworld());
                    if (colony == null) { result.complete("ERROR: no colony with id " + colonyId); return; }
                    ICitizenData cd = colony.getCitizenManager().getCivilian(citizenId);
                    if (cd == null) { result.complete("ERROR: no citizen with id " + citizenId); return; }

                    if ("return".equals(mode)) {
                        GuardOrder prev = guardOrders.remove(key);
                        MoveOrder mo = moveOrders.get(key);
                        if (mo != null && "moving".equals(mo.status)) mo.status = "replaced";
                        com.minecolonies.core.entity.citizen.EntityCitizen ent = resolveCitizenEntity(colonyId, citizenId);
                        if (ent != null) ent.getNavigation().stop();
                        result.complete(prev == null
                            ? "citizen " + citizenId + " had no guard order; nothing to clear"
                            : "citizen " + citizenId + " released from " + prev.mode + ", back to normal duty");
                        return;
                    }

                    com.minecolonies.core.entity.citizen.EntityCitizen ent = resolveCitizenEntity(colonyId, citizenId);
                    if (ent == null) {
                        result.complete("ERROR: citizen " + citizenId + " has no live entity right now");
                        return;
                    }
                    BlockPos target;
                    if (params.containsKey("x") && params.containsKey("y") && params.containsKey("z")) {
                        target = new BlockPos(Integer.parseInt(params.get("x")),
                            Integer.parseInt(params.get("y")), Integer.parseInt(params.get("z")));
                    } else if ("standdown".equals(mode)) {
                        target = ent.blockPosition(); // hold where the guard stands now
                    } else {
                        result.complete("ERROR: engage requires x, y and z");
                        return;
                    }
                    MoveOrder mo = moveOrders.get(key);
                    if (mo != null && "moving".equals(mo.status)) mo.status = "replaced";
                    guardOrders.put(key, new GuardOrder(colonyId, citizenId, mode, target));
                    boolean isGuard = cd.getJob() instanceof com.minecolonies.core.colony.jobs.AbstractJobGuard<?>;
                    result.complete("citizen " + citizenId + " " + mode + " at "
                        + target.getX() + "," + target.getY() + "," + target.getZ()
                        + (isGuard ? "" : " (warning: not a guard - will move but not fight)"));
                } catch (Exception e) {
                    result.complete("ERROR: " + e);
                }
            });
            String outcome = result.get();
            if (outcome.startsWith("ERROR")) {
                respond(exchange, 500, "{\"error\":\"" + escape(outcome) + "\"}");
            } else {
                respond(exchange, 200, "{\"result\":\"" + escape(outcome) + "\"}");
            }
        } catch (Exception e) {
            respond(exchange, 400, "{\"error\":\"" + escape(String.valueOf(e)) + "\"}");
        }
    }

    private static java.util.Map<String, String> parseQuery(String query) {
        java.util.Map<String, String> map = new java.util.HashMap<>();
        if (query == null) return map;
        for (String pair : query.split("&")) {
            int idx = pair.indexOf('=');
            if (idx < 0) continue;
            map.put(pair.substring(0, idx), pair.substring(idx + 1));
        }
        return map;
    }

    private static String escape(String s) {
        return s.replace("\"", "'").replace("\n", " ");
    }

    private static void respond(HttpExchange exchange, int code, String body) throws IOException {
        byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
        exchange.getResponseHeaders().add("Content-Type", "application/json");
        exchange.sendResponseHeaders(code, bytes.length);
        try (OutputStream os = exchange.getResponseBody()) {
            os.write(bytes);
        }
    }
}
