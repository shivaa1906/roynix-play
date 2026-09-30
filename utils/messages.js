const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ContainerBuilder, MediaGalleryBuilder, MediaGalleryItemBuilder, TextDisplayBuilder, SeparatorBuilder, SeparatorSpacingSize } = require('discord.js');
const emojis = require('../emojis.js');
const config = require('../config.js');

const lastQueueMessages = new Map();

function formatDuration(ms) {
    if (!ms || ms <= 0 || ms === 'Infinity') return 'LIVE';
    const seconds = Math.floor((ms / 1000) % 60);
    const minutes = Math.floor((ms / (1000 * 60)) % 60);
    const hours = Math.floor(ms / (1000 * 60 * 60));
    if (hours > 0) {
        return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
    }
    return `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
}

function getDurationString(track) {
    if (track.info.isStream) return 'LIVE';
    if (!track.info.duration) return 'N/A';
    return formatDuration(track.info.duration);
}

function createControlButtons(isPlaying, hasQueue) {
    const row = new ActionRowBuilder()
        .addComponents(
            new ButtonBuilder()
                .setCustomId('previous')
                .setLabel('Previous')
                .setStyle(ButtonStyle.Secondary)
                .setEmoji(emojis.previous),
            new ButtonBuilder()
                .setCustomId(isPlaying ? 'pause' : 'resume')
                .setLabel(isPlaying ? 'Pause' : 'Resume')
                .setStyle(isPlaying ? ButtonStyle.Secondary : ButtonStyle.Success)
                .setEmoji(isPlaying ? emojis.pause : emojis.play),
            new ButtonBuilder()
                .setCustomId('stop')
                .setLabel('Stop')
                .setStyle(ButtonStyle.Danger)
                .setEmoji(emojis.stop),
            new ButtonBuilder()
                .setCustomId('skip')
                .setLabel('Skip')
                .setStyle(ButtonStyle.Secondary)
                .setEmoji(emojis.skip),
            new ButtonBuilder()
                .setCustomId('shuffle')
                .setLabel('Shuffle')
                .setStyle(ButtonStyle.Secondary)
                .setEmoji(emojis.shuffle)
        );

    return row;
}

function createExtraButtons() {
    const row = new ActionRowBuilder()
        .addComponents(
            new ButtonBuilder()
                .setCustomId('loop')
                .setLabel('Loop')
                .setStyle(ButtonStyle.Secondary)
                .setEmoji(emojis.repeat),
            new ButtonBuilder()
                .setCustomId('lyrics')
                .setLabel('Lyrics')
                .setStyle(ButtonStyle.Secondary)
                .setEmoji('📝'),
            new ButtonBuilder()
                .setCustomId('volume_down')
                .setLabel('Vol -')
                .setStyle(ButtonStyle.Secondary)
                .setEmoji('🔉'),
            new ButtonBuilder()
                .setCustomId('volume_up')
                .setLabel('Vol +')
                .setStyle(ButtonStyle.Secondary)
                .setEmoji('🔊'),
            new ButtonBuilder()
                .setCustomId('queue')
                .setLabel('Queue')
                .setStyle(ButtonStyle.Secondary)
                .setEmoji(emojis.queue)
        );

    return row;
}

function buildQueueAddedContainer(tracks, requester) {
    const list = Array.isArray(tracks) ? tracks : [tracks];
    const visibleTracks = list.slice(0, 4);
    const container = new ContainerBuilder();
    const galleryItems = visibleTracks
        .map((track) => {
            const artwork = track?.info?.thumbnail || track?.info?.artworkUrl || track?.info?.image;
            return artwork
                ? new MediaGalleryItemBuilder()
                    .setURL(artwork)
                    .setDescription((track?.info?.title || 'Queued song artwork').slice(0, 100))
                : null;
        })
        .filter(item => item !== null);

    if (galleryItems.length > 0) {
        container.addMediaGalleryComponents(new MediaGalleryBuilder().addItems(galleryItems));
    }

    const songLines = visibleTracks.map((track, index) => {
        const title = track?.info?.title || 'Unknown Track';
        const uri = track?.info?.uri || '';
        const song = uri ? `[${title}](${uri})` : title;
        return `**#${index + 2}** ${song}`;
    });

    const requesterText = requester ? `<@${requester.id || requester}>` : 'Unknown';
    const remainingCount = list.length - visibleTracks.length;
    const songListText = songLines.join('\n') || 'No tracks in queue.';
    const displayText = remainingCount > 0
        ? `${songListText}\n\n*...and ${remainingCount} more track${remainingCount > 1 ? 's' : ''} in queue.*`
        : songListText;

    container
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(displayText))
        .addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small))
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(`*Requested by: ${requesterText}*`));

    return container;
}

module.exports = {
    buildQueueAddedContainer,

    success: (channel, message) => {
        const embed = new EmbedBuilder()
            .setColor(config.embedColor)
            .setDescription(`${emojis.success} | ${message}`)
            .setFooter({ text: '✨ Premium Music Experience' });
        return channel.send({ embeds: [embed] });
    },

    error: (channel, message) => {
        const embed = new EmbedBuilder()
            .setColor('#ff0000')
            .setDescription(`${emojis.error} | ${message}`)
            .setFooter({ text: '✨ Premium Music Experience' });
        return channel.send({ embeds: [embed] });
    },

    info: (channel, message) => {
        const embed = new EmbedBuilder()
            .setColor('#0099ff')
            .setDescription(`${emojis.info} | ${message}`)
            .setFooter({ text: '✨ Premium Music Experience' });
        return channel.send({ embeds: [embed] });
    },

    nowPlaying: (channel, track) => {
        const embed = new EmbedBuilder()
            .setColor(config.embedColor)
            .setTitle(`${emojis.music} Now Playing`)
            .setDescription(`[${track.info.title}](${track.info.uri})`)
            .setThumbnail(track.info.thumbnail || 'https://i.imgur.com/PMmebc2.png')
            .addFields([
                { name: 'Artist', value: `${emojis.info} ${track.info.author}`, inline: true },
                { name: 'Duration', value: `${emojis.time} ${getDurationString(track)}`, inline: true },
                { name: 'Requested By', value: `${emojis.info} ${track.info.requester?.tag || track.info.requester}`, inline: true }
            ])
            .setFooter({ text: '✨ Premium Music Experience' });

        const buttons = [
            createControlButtons(true, true),
            createExtraButtons()
        ];

        return channel.send({ embeds: [embed], components: buttons });
    },

    addedToQueue: async (channel, track, position, queue, requester) => {
        const tracksToUse = (queue && queue.length > 0) ? [...queue] : [track];
        const container = buildQueueAddedContainer(tracksToUse, requester || track.info?.requester);
        const oldMsgId = lastQueueMessages.get(channel.guild?.id);
        if (oldMsgId) {
            try {
                const oldMsg = await channel.messages.fetch(oldMsgId).catch(() => null);
                if (oldMsg) await oldMsg.delete().catch(() => {});
            } catch (_) {}
        }
        const sent = await channel.send({
            components: [container],
            flags: ['IsComponentsV2']
        });
        if (channel.guild?.id && sent) {
            lastQueueMessages.set(channel.guild.id, sent.id);
        }
        return sent;
    },

    addedPlaylist: async (channel, playlistInfo, tracks, requester) => {
        const container = buildQueueAddedContainer(tracks, requester);
        const oldMsgId = lastQueueMessages.get(channel.guild?.id);
        if (oldMsgId) {
            try {
                const oldMsg = await channel.messages.fetch(oldMsgId).catch(() => null);
                if (oldMsg) await oldMsg.delete().catch(() => {});
            } catch (_) {}
        }
        const sent = await channel.send({
            components: [container],
            flags: ['IsComponentsV2']
        });
        if (channel.guild?.id && sent) {
            lastQueueMessages.set(channel.guild.id, sent.id);
        }
        return sent;
    },

    queueEnded: (channel) => {
        const embed = new EmbedBuilder()
            .setColor(config.embedColor)
            .setDescription(`${emojis.info} Queue has ended. Leaving voice channel.`)
            .setFooter({ text: '✨ Premium Music Experience' });
        return channel.send({ embeds: [embed] });
    },

    queueList: (channel, queue, currentTrack) => {
        const embed = new EmbedBuilder()
            .setColor(config.embedColor)
            .setTitle(`${emojis.queue} Queue List`)
            .setThumbnail(currentTrack?.info.thumbnail || 'https://i.imgur.com/n7uBEvU.png');

        if (currentTrack) {
            embed.setDescription(
                `**Now Playing:**\n${emojis.play} [${currentTrack.info.title}](${currentTrack.info.uri}) - ${getDurationString(currentTrack)}\n\n**Up Next:**`
            );
        }

        if (queue.length) {
            const tracks = queue.slice(0, 10).map((track, i) => 
                `\`${(i + 1).toString().padStart(2, '0')}\` ${emojis.song} [${track.info.title}](${track.info.uri}) - ${getDurationString(track)}`
            ).join('\n');

            embed.addFields({ name: '\u200b', value: tracks });

            if (queue.length > 10) {
                embed.addFields({ name: '\u200b', value: `*And ${queue.length - 10} more tracks...*` });
            }

            const totalDuration = queue.reduce((acc, track) => acc + (track.info.duration || 0), 0);
            embed.setFooter({ 
                text: `✨ Premium Music Experience • ${queue.length} tracks • Total Duration: ${formatDuration(totalDuration)}` 
            });
        } else {
            embed.addFields({ name: '\u200b', value: 'No tracks in queue' });
            embed.setFooter({ text: '✨ Premium Music Experience' });
        }

        const buttons = [createControlButtons(true, queue.length > 0)];
        return channel.send({ embeds: [embed], components: buttons });
    },

    playerStatus: (channel, player) => {
        const embed = new EmbedBuilder()
            .setColor(config.embedColor)
            .setTitle(`${emojis.info} Player Status`)
            .addFields([
                { name: 'Status', value: player.playing ? `${emojis.play} Playing` : `${emojis.pause} Paused`, inline: true },
                { name: 'Volume', value: `${emojis.volume} ${player.volume}%`, inline: true },
                { name: 'Loop Mode', value: `${emojis.repeat} ${player.loop === "queue" ? 'Queue' : 'Disabled'}`, inline: true }
            ])
            .setFooter({ text: '✨ Premium Music Experience' });

        if (player.queue.current) {
            const track = player.queue.current;
            embed.setDescription(
                `**Currently Playing:**\n${emojis.music} [${track.info.title}](${track.info.uri})\n` +
                `${emojis.time} Duration: ${getDurationString(track)}`
            )
            .setThumbnail(track.info.thumbnail || 'https://i.imgur.com/0JhhPo3.png');
        }

        const buttons = [
            createControlButtons(player.playing, player.queue.length > 0),
            createExtraButtons()
        ];

        return channel.send({ embeds: [embed], components: buttons });
    },

    help: (channel, commands) => {
        const embed = new EmbedBuilder()
            .setColor(config.embedColor)
            .setTitle(`${emojis.info} Premium Music Commands`)
            .setDescription(commands.map(cmd => 
                `${emojis.music} \`${cmd.name}\` - ${cmd.description}`
            ).join('\n'))
            .setThumbnail('https://i.imgur.com/PMmebc2.png')
            .setFooter({ text: '✨ Premium Music Experience • Prefix: !' });
        return channel.send({ embeds: [embed] });
    },

    alwaysOnMode: (channel, status) => {
        const embed = new EmbedBuilder()
            .setColor(config.embedColor)
            .setTitle(`${emojis.info} 24/7 Mode`)
            .setDescription(status ? 
                `${emojis.success} 24/7 mode has been **enabled**. I will stay in the voice channel.` : 
                `${emojis.error} 24/7 mode has been **disabled**. I will leave when the queue ends.`
            )
            .setFooter({ text: '✨ Premium Music Experience • Use !247 to toggle' });

        return channel.send({ embeds: [embed] });
    }
};