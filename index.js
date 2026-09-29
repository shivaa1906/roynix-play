require("node:dns").setDefaultResultOrder("ipv4first");
require("dotenv").config();

// Capture Node warnings (help locate TimeoutNaNWarning stack traces)
process.on('warning', (warning) => {
    try {
        console.warn('Node warning:', warning.name, warning.message);
        if (warning.stack) console.warn(warning.stack);
    } catch (e) {
        console.warn('Warning handler error:', e);
    }
});

const { Client } = require("discord.js");
const { Riffy } = require("riffy");
const config = require("./config.js");
const messages = require("./utils/messages.js");
const emojis = require("./emojis.js");

const { Agent } = require("undici");

// Discord Client with increased timeout and heartbeat settings
const client = new Client({
    intents: [
        "Guilds",
        "GuildMessages",
        "GuildVoiceStates",
        "GuildMessageReactions",
        "MessageContent",
        "DirectMessages",
    ],
    retryLimit: 10, // Increased from 5
    ws: {
        large_threshold: 250,
        compress: true,
        properties: {
            $browser: "Discord iOS", // More stable connection handling
        }
    },
    rest: {
        agent: new Agent({ connect: { timeout: 30000 } }),
        timeout: 30000,
    },
    restRequestTimeout: 30000, // Increased timeout
    restGlobalRateLimit: 50 // More conservative rate limit
});

// Riffy Player Setup
console.log(`${emojis.info} Lavalink config: ${config.nodes.map(n => `${n.secure ? "wss" : "ws"}://${n.host}:${n.port}`).join(", ")}`);

client.riffy = new Riffy(client, config.nodes, {
    send: (payload) => {
        const guild = client.guilds.cache.get(payload.d.guild_id);
        if (guild) guild.shard.send(payload);
    },
    defaultSearchPlatform: "ytmsearch",
    restVersion: "v4",
    reconnectTries: 10,
    reconnectTimeout: 5000
});

console.log(`${emojis.info} Default search platform: ytmsearch`);

// Ensure Lavalink node is available, with a few init retries
async function ensureNodeConnected(retries = 3, delayMs = 2000) {
    const nodes = [...client.riffy.nodeMap.values()];
    if (nodes.length && nodes.some(n => n.connected)) return true;
    
    for (let i = 0; i < retries; i++) {
        console.log(`${emojis.info} Attempting Lavalink node connect (${i + 1}/${retries})`);
        try {
            // If no nodes exist (destroyed after failed reconnects), recreate them
            if (!client.riffy.nodeMap.size) {
                console.log(`${emojis.info} Node map empty, recreating nodes...`);
                config.nodes.forEach(node => {
                    if (!client.riffy.nodeMap.has(node.name || node.host)) {
                        client.riffy.createNode(node);
                    }
                });
            }
            // If node exists but disconnected, connect it directly
            if (client.riffy.nodeMap.size) {
                for (const [name, node] of client.riffy.nodeMap) {
                    if (!node.connected && !node.ws) {
                        console.log(`${emojis.info} Reconnecting node "${name}"...`);
                        node.connect();
                    }
                }
            }
        } catch (e) {
            console.warn(`${emojis.error} Lavalink connect attempt failed: ${e?.message || e}`);
        }
        
        await new Promise(res => setTimeout(res, delayMs));
        
        const currentNodes = [...client.riffy.nodeMap.values()];
        if (currentNodes.length && currentNodes.some(n => n.connected)) return true;
    }
    return false;
}

// Help Command Info
const commands = [
    { name: 'play <query>', description: 'Play a song or playlist' },
    { name: 'pause', description: 'Pause the current track' },
    { name: 'resume', description: 'Resume the current track' },
    { name: 'skip', description: 'Skip the current track' },
    { name: 'stop', description: 'Stop playback and clear queue' },
    { name: 'queue', description: 'Show the current queue' },
    { name: 'nowplaying', description: 'Show current track info' },
    { name: 'volume <0-9999>', description: 'Adjust player volume (Developer only)' },
    { name: 'shuffle', description: 'Shuffle the current queue' },
    { name: 'loop', description: 'Toggle queue loop mode' },
    { name: 'remove <position>', description: 'Remove a track from queue' },
    { name: 'clear', description: 'Clear the current queue' },
    { name: 'status', description: 'Show player status' },
    { name: 'test', description: 'Test Lavalink connection and play a test song' },
    { name: 'help', description: 'Show this help message' },
    { name: '24/7', description: 'Keep the bot connected 24/7' }
];

// Enhanced reconnection handling with jitter
let reconnectAttempts = 0;
const maxReconnectAttempts = Number.isFinite(Number(config.reconnect.maxAttempts)) ? Number(config.reconnect.maxAttempts) : 5;
let reconnectDelay = Number.isFinite(Number(config.reconnect.initialDelay)) ? Number(config.reconnect.initialDelay) : 5000;
const maxReconnectDelay = Number.isFinite(Number(config.reconnect.maxDelay)) ? Number(config.reconnect.maxDelay) : 60000;

// Add jitter to avoid thundering herd problem
function getJitteredDelay(baseDelay) {
    const safeBase = Number.isFinite(Number(baseDelay)) ? Number(baseDelay) : 5000;
    const jitter = Math.random() * 0.3; // 30% jitter
    return Math.floor(safeBase * (1 + jitter));
}

async function handleReconnect() {
    if (reconnectAttempts >= maxReconnectAttempts) {
        console.error(`${emojis.error} Failed to reconnect after ${maxReconnectAttempts} attempts. Please check your bot token and network connection.`);
        process.exit(1);
    }

    reconnectAttempts++;
    const currentDelay = getJitteredDelay(reconnectDelay);

    console.log(`${emojis.info} Attempting to reconnect (${reconnectAttempts}/${maxReconnectAttempts}) in ${Math.floor(currentDelay / 1000)}s...`);

    try {
        // Ensure clean disconnect
        if (client.ws.connection) {
            client.ws.destroy();
        }
        await client.destroy();

        // Wait for connection to fully close
        await new Promise(resolve => setTimeout(resolve, 2000));

        // Verify token before attempting reconnect
        if (!config.botToken?.length || config.botToken === 'your-token-here') {
            throw new Error('Invalid bot token configuration');
        }

        await client.login(config.botToken);

        // Reset counters on successful connection
        reconnectAttempts = 0;
        reconnectDelay = config.reconnect.initialDelay;

        console.log(`${emojis.success} Successfully reconnected!`);
    } catch (error) {
        console.error(`${emojis.error} Reconnection failed:`, error.message);

        // Implement exponential backoff with max delay (ensure numeric)
        reconnectDelay = Number.isFinite(Number(reconnectDelay)) ? Math.min(reconnectDelay * 2, maxReconnectDelay) : Math.min(5000 * 2, maxReconnectDelay);

        // Schedule next attempt with jitter (use safe delay)
        const nextDelay = getJitteredDelay(reconnectDelay);
        setTimeout(handleReconnect, nextDelay);
    }
}

client.on("disconnect", (event) => {
    console.log(`${emojis.error} Bot disconnected! Code: ${event.code}, Reason: ${event.reason}`);
    const delay = getJitteredDelay(reconnectDelay);
    setTimeout(handleReconnect, delay);
});

client.on("error", (error) => {
    console.error(`${emojis.error} Client error:`, error.message);
    if (error.message.includes("token")) {
        console.error(`${emojis.error} Invalid token detected. Please check your bot token.`);
        process.exit(1);
    }
});

client.once("ready", async () => {
    reconnectAttempts = 0;
    reconnectDelay = config.reconnect.initialDelay; // Reset delay on successful connection
    await client.riffy.init(client.user.id);
    console.log(`${emojis.success} Logged in as ${client.user.tag}`);
});

client.on("messageCreate", async (message) => {
    if (!message.content.startsWith(config.prefix) || message.author.bot) return;

    const args = message.content.slice(config.prefix.length).trim().split(" ");
    const command = args.shift().toLowerCase();

    const musicCommands = ["play", "skip", "stop", "pause", "resume", "queue", "nowplaying", "volume", "shuffle", "loop", "remove", "clear", "24/7"];
    if (musicCommands.includes(command)) {
        if (!message.member.voice.channel && command !== "queue" && command !== "nowplaying" && command !== "status") {
            return messages.error(message.channel, "You must be in a voice channel!");
        }
    }

    switch (command) {
        case "nodestatus": {
            const nodes = [...client.riffy.nodeMap.values()];
            if (!nodes.length) return messages.error(message.channel, "No Lavalink nodes configured.");
            const statusLines = nodes.map(n => `**${n.name}** — ${n.connected ? 'Connected' : 'Disconnected'} — ${n.host}:${n.port}`);
            return messages.success(message.channel, `Lavalink Nodes:\n${statusLines.join('\n')}`);
        }

        case "help":
            messages.help(message.channel, commands);
            break;

        case "24/7": {
            const voiceChannel = message.member.voice.channel;
            if (!voiceChannel) return messages.error(message.channel, "Join a voice channel first!");

            const nodes = [...client.riffy.nodeMap.values()];
            if (!nodes.length || !nodes.some(n => n.connected)) {
                const ok = await ensureNodeConnected();
                if (!ok) return messages.error(message.channel, "❌ Lavalink is not connected! Please try again later.");
            }

            const player = client.riffy.createConnection({
                guildId: message.guild.id,
                voiceChannel: voiceChannel.id,
                textChannel: message.channel.id,
                deaf: true,
            });

            const silentTrackURL = "https://www.youtube.com/watch?v=2Vv-BfVoq4g";
            const resolve = await client.riffy.resolve({
                query: silentTrackURL,
                requester: message.author,
            });

            if (resolve?.tracks?.length) {
                const silentTrack = resolve.tracks[0];
                silentTrack.info.requester = message.author;
                player.queue.add(silentTrack);
                if (!player.playing && !player.paused) player.play();
                messages.success(message.channel, "✅ Bot will now stay connected 24/7!");
            } else {
                messages.error(message.channel, "❌ Could not load silent track. Please check the link.");
            }
            break;
        }

        case "play": {
            const query = args.join(" ");
            if (!query) return messages.error(message.channel, "Please provide a search query!");

            const nodes = [...client.riffy.nodeMap.values()];
            if (!nodes.length || !nodes.some(n => n.connected)) {
                const ok = await ensureNodeConnected();
                if (!ok) return messages.error(message.channel, "❌ Lavalink is not connected! Please try again later.");
            }

            try {
                const player = client.riffy.createConnection({
                    guildId: message.guild.id,
                    voiceChannel: message.member.voice.channel.id,
                    textChannel: message.channel.id,
                    deaf: true,
                });

                const resolve = await client.riffy.resolve({
                    query,
                    requester: message.author,
                });

                const { loadType, tracks, playlistInfo } = resolve;

                if (loadType === "playlist") {
                    for (const track of tracks) {
                        track.info.requester = message.author;
                        player.queue.add(track);
                    }
                    messages.addedPlaylist(message.channel, playlistInfo, tracks);
                    if (!player.playing && !player.paused) player.play();
                } else if (loadType === "search" || loadType === "track") {
                    const track = tracks.shift();
                    track.info.requester = message.author;
                    const position = player.queue.length + 1;
                    player.queue.add(track);

                    messages.addedToQueue(message.channel, track, position);
                    if (!player.playing && !player.paused) player.play();
                } else {
                    messages.error(message.channel, "No results found! Try a different search.");
                }
            } catch (error) {
                console.error(error);
                messages.error(message.channel, "An error occurred while playing!");
            }
            break;
        }

        case "skip": {
            const player = client.riffy.players.get(message.guild.id);
            if (!player) return messages.error(message.channel, "Nothing is playing!");
            player.stop();
            messages.success(message.channel, "⏭️ Skipped current track!");
            break;
        }

        case "stop": {
            const player = client.riffy.players.get(message.guild.id);
            if (!player) return messages.error(message.channel, "Nothing is playing!");
            player.queue.clear();
            player.stop();
            messages.success(message.channel, "⏹️ Stopped music and cleared queue!");
            break;
        }

        case "pause": {
            const player = client.riffy.players.get(message.guild.id);
            if (!player || player.paused) return messages.error(message.channel, "Nothing is playing or already paused!");
            player.pause(true);
            messages.success(message.channel, "⏸️ Music paused!");
            break;
        }

        case "resume": {
            const player = client.riffy.players.get(message.guild.id);
            if (!player || !player.paused) return messages.error(message.channel, "Nothing paused or already playing!");
            player.pause(false);
            messages.success(message.channel, "▶️ Music resumed!");
            break;
        }

        case "queue": {
            const player = client.riffy.players.get(message.guild.id);
            if (!player || (!player.queue.length && !player.queue.current)) return messages.error(message.channel, "Queue is empty!");
            messages.queueList(message.channel, player.queue, player.queue.current);
            break;
        }

        case "nowplaying": {
            const player = client.riffy.players.get(message.guild.id);
            if (!player || !player.queue.current) return messages.error(message.channel, "No track is currently playing!");
            messages.nowPlaying(message.channel, player.queue.current);
            break;
        }

        case "volume": {
            // Developer-only check
            if (!config.developerIds.includes(message.author.id)) {
                return messages.error(message.channel, "❌ This command is restricted to developers only!");
            }

            const player = client.riffy.players.get(message.guild.id);
            if (!player) return messages.error(message.channel, "Nothing is playing!");
            const volume = parseInt(args[0], 10);
            // Developers keep the 9999 limit, but Riffy only supports up to 1000
            if (isNaN(volume) || volume < 0 || volume > 9999) {
                return messages.error(message.channel, "Volume must be between 0 and 9999!");
            }
            const finalVolume = Math.min(volume, 1000);
            player.setVolume(finalVolume);
            if (volume > 1000) {
                messages.success(message.channel, `🔊 Volume set to ${finalVolume}% (max supported; requested ${volume}%)`);
            } else {
                messages.success(message.channel, `🔊 Volume set to ${finalVolume}%`);
            }
            break;
        }

        case "shuffle": {
            const player = client.riffy.players.get(message.guild.id);
            if (!player || !player.queue.length) return messages.error(message.channel, "Queue is empty!");
            player.queue.shuffle();
            messages.success(message.channel, "🔀 Queue shuffled!");
            break;
        }

        case "loop": {
            const player = client.riffy.players.get(message.guild.id);
            if (!player) return messages.error(message.channel, "Nothing is playing!");
            const newMode = player.loop === "none" ? "queue" : "none";
            player.setLoop(newMode);
            messages.success(message.channel, `🔁 Loop mode: ${newMode}`);
            break;
        }

        case "remove": {
            const player = client.riffy.players.get(message.guild.id);
            if (!player || !player.queue.length) return messages.error(message.channel, "Queue is empty!");
            const position = parseInt(args[0], 10);
            if (isNaN(position) || position < 1 || position > player.queue.length) {
                return messages.error(message.channel, "Invalid track number!");
            }
            const removed = player.queue.remove(position - 1);
            messages.success(message.channel, `❌ Removed **${removed.info.title}** from queue.`);
            break;
        }

        case "clear": {
            const player = client.riffy.players.get(message.guild.id);
            if (!player || !player.queue.length) return messages.error(message.channel, "Queue is already empty!");
            player.queue.clear();
            messages.success(message.channel, "🗑️ Queue cleared!");
            break;
        }

        case "status": {
            const player = client.riffy.players.get(message.guild.id);
            if (!player) return messages.error(message.channel, "No active player.");
            messages.playerStatus(message.channel, player);
            break;
        }

        case "test": {
            const voiceChannel = message.member.voice.channel;
            if (!voiceChannel) return messages.error(message.channel, "Join a voice channel first!");

            await messages.success(message.channel, "🔧 Running Lavalink connection test...");

            // Step 1: Check node status
            const nodes = [...client.riffy.nodeMap.values()];
            const nodeStatus = nodes.length
                ? nodes.map(n => `**${n.name}**: ${n.connected ? '✅ Connected' : '❌ Disconnected'} (${n.host}:${n.port})`).join("\n")
                : "No nodes configured";
            await messages.info(message.channel, `**Step 1 - Node Status:**\n${nodeStatus}`);

            // Step 2: Try to connect if not connected
            if (!nodes.length || !nodes.some(n => n.connected)) {
                await messages.info(message.channel, "**Step 2 - Attempting to connect to Lavalink...**");
                const ok = await ensureNodeConnected(5, 3000);
                if (!ok) {
                    return messages.error(message.channel, `❌ **Step 2 Failed:** Could not connect to Lavalink.\nCheck if Lavalink is running: \`podman ps\``);
                }
                await messages.success(message.channel, "✅ **Step 2:** Connected to Lavalink!");
            } else {
                await messages.success(message.channel, "✅ **Step 2:** Already connected to Lavalink!");
            }

            // Step 3: Test resolving a YouTube URL
            await messages.info(message.channel, "**Step 3 - Testing YouTube URL resolution...**");
            try {
                const resolve = await client.riffy.resolve({
                    query: "https://www.youtube.com/watch?v=2Vv-BfVoq4g",
                    requester: message.author,
                });
                if (resolve?.tracks?.length) {
                    await messages.success(message.channel, `✅ **Step 3:** YouTube URL resolved: **${resolve.tracks[0].info.title}**`);
                } else {
                    return messages.error(message.channel, "❌ **Step 3 Failed:** Could not resolve YouTube URL");
                }
            } catch (e) {
                return messages.error(message.channel, `❌ **Step 3 Failed:** ${e?.message || e}`);
            }

            // Step 4: Create connection and play test song
            await messages.info(message.channel, "**Step 4 - Playing test song...**");
            try {
                const player = client.riffy.createConnection({
                    guildId: message.guild.id,
                    voiceChannel: voiceChannel.id,
                    textChannel: message.channel.id,
                    deaf: true,
                });

                const resolve = await client.riffy.resolve({
                    query: "https://www.youtube.com/watch?v=2Vv-BfVoq4g",
                    requester: message.author,
                });

                if (resolve?.tracks?.length) {
                    const track = resolve.tracks[0];
                    track.info.requester = message.author;
                    player.queue.add(track);
                    if (!player.playing && !player.paused) player.play();
                    await messages.success(message.channel, `✅ **Step 4:** Playing **${track.info.title}**!`);
                } else {
                    return messages.error(message.channel, "❌ **Step 4 Failed:** No track found to play");
                }
            } catch (e) {
                return messages.error(message.channel, `❌ **Step 4 Failed:** ${e?.message || e}`);
            }

            return messages.success(message.channel, "🎉 **All tests passed! Lavalink is working correctly!**");
        }
    }
});

// Lavalink Events
client.riffy.on("nodeConnect", (node) => {
    console.log(`${emojis.success} Node "${node.name}" connected.`);
});

client.riffy.on("nodeDisconnect", async (node, reason) => {
    console.log(`${emojis.error} Node "${node.name}" disconnected: ${reason || 'unknown reason'}`);
    console.log(`${emojis.info} Attempting to reconnect node "${node.name}"...`);
    setTimeout(async () => {
        try {
            const ok = await ensureNodeConnected(5, 3000);
            if (ok) {
                console.log(`${emojis.success} Node "${node.name}" reconnected successfully.`);
            } else {
                console.error(`${emojis.error} Failed to reconnect node "${node.name}".`);
            }
        } catch (e) {
            console.error(`${emojis.error} Failed to reconnect node: ${e?.message || e}`);
        }
    }, 5000);
});

client.riffy.on("nodeError", (node, error) => {
    console.log(`${emojis.error} Node "${node.name}" error: ${error.message}`);
});

client.riffy.on("trackStart", (player, track) => {
    const channel = client.channels.cache.get(player.textChannel);
    messages.nowPlaying(channel, track);
});

// 24/7 Keep Alive Logic
client.riffy.on("queueEnd", async (player) => {
    const channel = client.channels.cache.get(player.textChannel);
    messages.queueEnded(channel);

    try {
        const silentTrackURL = "https://www.youtube.com/watch?v=2Vv-BfVoq4g";
        const resolve = await client.riffy.resolve({
            query: silentTrackURL,
            requester: client.user,
        });

        if (resolve?.tracks?.length) {
            const silentTrack = resolve.tracks[0];
            player.queue.add(silentTrack);
            if (!player.playing && !player.paused) player.play();
        }
    } catch (error) {
        console.error(`${emojis.error} Failed to load silent track:`, error.message);
    }
});

// Voice state updates
client.on("raw", (d) => {
    if (!["VOICE_STATE_UPDATE", "VOICE_SERVER_UPDATE"].includes(d.t)) return;
    client.riffy.updateVoiceState(d);
});

// Initial login attempt with improved error handling
async function initializeBot() {
    try {
        await client.login(config.botToken);
    } catch (error) {
        console.error(`${emojis.error} Failed to login:`, error);
        const delay = getJitteredDelay(reconnectDelay);
        setTimeout(handleReconnect, delay);
    }
}

// Web server for uptime (Render, Replit etc.)
const express = require("express");
const app = express();
const PORT = process.env.PORT || 10000;
app.get("/", (req, res) => res.send("Bot is alive!"));
app.listen(PORT, () => console.log(`🌐 Web server on port ${PORT}`));

// Start the bot
initializeBot();