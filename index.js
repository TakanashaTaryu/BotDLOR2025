
const { Client, GatewayIntentBits, Collection, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionFlagsBits } = require('discord.js');
const express = require('express');
const session = require('express-session');
const passport = require('passport');
const DiscordStrategy = require('passport-discord').Strategy;
const bodyParser = require('body-parser');
const path = require('path');

// Keep only one import for @discordjs/voice - add the missing entersState function
const { joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus, VoiceConnectionStatus, entersState } = require('@discordjs/voice');
const ytdl = require('ytdl-core');
const play = require('play-dl'); // Add this new import
const ytSearch = require('yt-search');

const sequelize = require('./config/database');
const ReactionRole = require('./models/ReactionRole');

const Quiz = require('./models/Quiz');
const QuizTimer = require('./models/QuizTimer');



// Initialize Discord client
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.GuildMessageReactions,
        GatewayIntentBits.GuildMembers
    ],
    partials: ['MESSAGE', 'CHANNEL', 'REACTION'] // Add this line for handling uncached reactions
});

client.musicQueues = new Map();

// Collections for commands and music queues
client.commands = new Collection();
client.musicQueues = new Collection();

// Express app setup
const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use(express.static('public'));


// Session setup
app.use(session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false
}));

// Passport setup
app.use(passport.initialize());
app.use(passport.session());

passport.serializeUser((user, done) => {
    done(null, user);
});

passport.deserializeUser((obj, done) => {
    done(null, obj);
});

passport.use(new DiscordStrategy({
    clientID: process.env.DISCORD_CLIENT_ID,
    clientSecret: process.env.DISCORD_CLIENT_SECRET,
    callbackURL: "http://localhost:3000/auth/discord/callback",
    scope: ['identify', 'guilds']
}, (accessToken, refreshToken, profile, done) => {
    return done(null, profile);
}));

// ==============================================
// Music Bot Functionality
// ==============================================
const youtubeSearch = require('youtube-search-api');

class MusicQueue {
    constructor() {
        this.songs = [];
        this.isPlaying = false;
        this.connection = null;
        this.player = null;
        this.currentSong = null;
    }
}

// Music commands
const musicCommands = {
    // ... existing code ...
    play: async (interaction) => {
        const query = interaction.options.getString('query');
        
        // Check if user is in a voice channel
        const voiceChannel = interaction.member.voice.channel;
        if (!voiceChannel) {
            return interaction.reply({
                content: '❌ You need to be in a voice channel to play music!',
                ephemeral: true
            });
        }
        
        // Check permissions
        const permissions = voiceChannel.permissionsFor(interaction.client.user);
        if (!permissions.has(PermissionFlagsBits.Connect) || !permissions.has(PermissionFlagsBits.Speak)) {
            return interaction.reply({
                content: '❌ I need permissions to join and speak in your voice channel!',
                ephemeral: true
            });
        }
        
        await interaction.deferReply();
        
        try {
            let song;
            
            // Improved YouTube URL validation and handling
            const isYoutubeUrl = play.yt_validate(query);
            
            if (isYoutubeUrl) {
                // It's a valid YouTube video URL
                try {
                    // For YouTube URLs, ensure we have the correct format
                    let videoUrl = query;
                    
                    // Extract video ID if it's a valid YouTube URL
                    const videoId = extractYoutubeVideoId(query);
                    if (videoId) {
                        // Reconstruct a proper YouTube watch URL
                        videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
                    }
                    
                    const videoInfo = await play.video_info(videoUrl);
                    const videoDetails = videoInfo.video_details;
                    
                    song = {
                        title: videoDetails.title,
                        url: videoDetails.url,
                        duration: formatDuration(videoDetails.durationInSec),
                        thumbnail: videoDetails.thumbnails[0].url
                    };
                } catch (error) {
                    console.error(`Error fetching video info: ${error.message}`);
                    return interaction.editReply(`❌ Error fetching video info: ${error.message}`);
                }
            } else {
                // Search for the song on YouTube using play-dl
                try {
                    const searchResults = await play.search(query, { limit: 1 });
                    
                    if (!searchResults || searchResults.length === 0) {
                        return interaction.editReply('❌ No video results found for this search query!');
                    }
                    
                    const videoResult = searchResults[0];
                    song = {
                        title: videoResult.title,
                        url: videoResult.url,
                        duration: formatDuration(videoResult.durationInSec),
                        thumbnail: videoResult.thumbnails[0].url
                    };
                } catch (error) {
                    console.error(`Error searching for video: ${error.message}`);
                    return interaction.editReply(`❌ Error searching for video: ${error.message}`);
                }
            }
            
            // Verify we have a valid URL before proceeding
            if (!song.url || !song.url.startsWith('http')) {
                return interaction.editReply('❌ Could not get a valid video URL. Please try another video.');
            }
            
            console.log(`Song URL: ${song.url}`);
            // Get or create queue
            let queue = interaction.client.musicQueues.get(interaction.guildId);
            
            // Create a new queue if it doesn't exist
            if (!queue) {
                // Create a new queue
                queue = {
                    voiceChannel: voiceChannel,
                    textChannel: interaction.channel,
                    connection: null,
                    player: null,
                    songs: [],
                    volume: 50,
                    playing: true
                };
                
                // Create connection to voice channel
                try {
                    // Create the connection
                    const connection = joinVoiceChannel({
                        channelId: voiceChannel.id,
                        guildId: interaction.guildId,
                        adapterCreator: interaction.guild.voiceAdapterCreator,
                    });
                    
                    // Create audio player
                    const player = createAudioPlayer();
                    connection.subscribe(player);
                    
                    // Set up connection error handling
                    connection.on(VoiceConnectionStatus.Disconnected, async () => {
                        try {
                            // Try to reconnect
                            await Promise.race([
                                entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
                                entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
                            ]);
                            // Seems to be reconnecting to a new channel - ignore disconnect
                        } catch (error) {
                            // Seems to be a real disconnect which SHOULDN'T be recovered from
                            connection.destroy();
                            interaction.client.musicQueues.delete(interaction.guildId);
                        }
                    });
                    
                    // Set up player event handling
                    player.on(AudioPlayerStatus.Idle, () => {
                        // Remove the song that just finished
                        queue.songs.shift();
                        
                        // Play the next song if there are any left
                        if (queue.songs.length > 0) {
                            playSong(queue.songs[0], queue, interaction.guildId, interaction.client);
                        } else {
                            // No more songs, disconnect after a delay
                            setTimeout(() => {
                                if (queue.songs.length === 0) {
                                    connection.destroy();
                                    interaction.client.musicQueues.delete(interaction.guildId);
                                }
                            }, 60000); // Disconnect after 1 minute of inactivity
                        }
                    });
                    
                    player.on('error', error => {
                        console.error(`Error: ${error.message}`);
                        queue.songs.shift();
                        if (queue.songs.length > 0) {
                            playSong(queue.songs[0], queue, interaction.guildId, interaction.client);
                        }
                    });
                    
                    queue.connection = connection;
                    queue.player = player;
                    
                    // Save the queue
                    interaction.client.musicQueues.set(interaction.guildId, queue);
                } catch (error) {
                    console.error(error);
                    interaction.client.musicQueues.delete(interaction.guildId);
                    return interaction.editReply(`❌ Error connecting to voice channel: ${error.message}`);
                }
            }
            
            // Add song to queue
            queue.songs.push(song);
            
            // Create embed for song added message
            const embed = new EmbedBuilder()
                .setColor('#0099ff')
                .setTitle('Added to Queue')
                .setDescription(`[${song.title}](${song.url})`)
                .setThumbnail(song.thumbnail)
                .addFields(
                    { name: 'Duration', value: song.duration, inline: true },
                    { name: 'Position in queue', value: queue.songs.length > 1 ? `${queue.songs.length - 1}` : 'Now Playing', inline: true }
                );
            
            await interaction.editReply({ embeds: [embed] });
            
            // If there's only one song in the queue (the one we just added), start playing
            if (queue.songs.length === 1) {
                playSong(song, queue, interaction.guildId, interaction.client);
            }
            
        } catch (error) {
            console.error(error);
            return interaction.editReply(`❌ Error: ${error.message}`);
        }
    },
    
    // ... rest of the music commands ...
    


    skip: async (interaction) => {
        const queue = interaction.client.musicQueues.get(interaction.guildId);
        
        if (!queue) {
            return interaction.reply({
                content: '❌ There is no music playing!',
                ephemeral: true
            });
        }
        
        if (!interaction.member.voice.channel) {
            return interaction.reply({
                content: '❌ You need to be in a voice channel to skip music!',
                ephemeral: true
            });
        }
        
        if (queue.songs.length <= 1) {
            return interaction.reply({
                content: '❌ There are no more songs in the queue to skip to!',
                ephemeral: true
            });
        }
        
        // Skip the current song
        queue.player.stop();
        
        interaction.reply('⏭️ Skipped to the next song!');
    },
    
    stop: async (interaction) => {
        const queue = interaction.client.musicQueues.get(interaction.guildId);
        
        if (!queue) {
            return interaction.reply({
                content: '❌ There is no music playing!',
                ephemeral: true
            });
        }
        
        if (!interaction.member.voice.channel) {
            return interaction.reply({
                content: '❌ You need to be in a voice channel to stop music!',
                ephemeral: true
            });
        }
        
        // Clear the queue and stop playing
        queue.songs = [];
        queue.player.stop();
        queue.connection.destroy();
        interaction.client.musicQueues.delete(interaction.guildId);
        
        interaction.reply('⏹️ Music stopped and queue cleared!');
    },
    
    queue: async (interaction) => {
        const queue = interaction.client.musicQueues.get(interaction.guildId);
        
        if (!queue || queue.songs.length === 0) {
            return interaction.reply({
                content: '❌ There are no songs in the queue!',
                ephemeral: true
            });
        }
        
        // Create queue embed
        const queueEmbed = new EmbedBuilder()
            .setColor('#0099ff')
            .setTitle('Music Queue');
        
        // Add current song
        if (queue.songs.length > 0) {
            queueEmbed.addFields({
                name: '🎵 Now Playing',
                value: `[${queue.songs[0].title}](${queue.songs[0].url}) | \`${queue.songs[0].duration}\``
            });
        }
        
        // Add upcoming songs (up to 10)
        if (queue.songs.length > 1) {
            let description = '';
            const songsToShow = Math.min(queue.songs.length - 1, 10);
            
            for (let i = 1; i <= songsToShow; i++) {
                description += `**${i}.** [${queue.songs[i].title}](${queue.songs[i].url}) | \`${queue.songs[i].duration}\`\n`;
            }
            
            if (queue.songs.length > 11) {
                description += `\n*And ${queue.songs.length - 11} more songs...*`;
            }
            
            queueEmbed.addFields({
                name: '📋 Up Next',
                value: description
            });
        }
        
        interaction.reply({ embeds: [queueEmbed] });
    }
};
function playSong(song, queue, guildId, client) {
    try {
        // Log the song URL for debugging
        console.log(`Attempting to play: ${song.url}`);
        
        // Make sure we have a valid URL
        if (!song.url || !song.url.startsWith('http')) {
            console.error(`Invalid URL: ${song.url}`);
            queue.textChannel.send('❌ Invalid video URL. Skipping to next song...');
            queue.songs.shift();
            if (queue.songs.length > 0) {
                playSong(queue.songs[0], queue, guildId, client);
            } else {
                client.musicQueues.delete(guildId);
            }
            return;
        }
        
        // Send a "loading" message that we'll update later
        queue.textChannel.send('🔄 Loading song, please wait...').then(loadingMessage => {
            // Use play-dl with better options for more reliable streaming
            play.stream(song.url, { 
                discordPlayerCompatibility: true,
                quality: 2, // Lower quality for faster loading
                seek: 0,
                requestOptions: {
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
                    }
                }
            })
            .then(stream => {
                try {
                    // Create an audio resource from the stream
                    const resource = createAudioResource(stream.stream, {
                        inputType: stream.type,
                        inlineVolume: true
                    });
                    
                    // Set the volume
                    resource.volume.setVolume(queue.volume / 100);
                    
                    // Play the song
                    queue.player.play(resource);
                    
                    // Delete the loading message
                    loadingMessage.delete().catch(() => {});
                    
                    // Send now playing message
                    const embed = new EmbedBuilder()
                        .setColor('#0099ff')
                        .setTitle('Now Playing')
                        .setDescription(`[${song.title}](${song.url})`)
                        .setThumbnail(song.thumbnail)
                        .addFields(
                            { name: 'Duration', value: song.duration, inline: true },
                            { name: 'Requested by', value: 'User', inline: true }
                        );
                    
                    queue.textChannel.send({ embeds: [embed] });
                } catch (resourceError) {
                    console.error(`Error creating audio resource: ${resourceError.message}`);
                    loadingMessage.edit('❌ Error playing this song. Skipping to next song...');
                    queue.songs.shift();
                    if (queue.songs.length > 0) {
                        playSong(queue.songs[0], queue, guildId, client);
                    } else {
                        client.musicQueues.delete(guildId);
                    }
                }
            })
            .catch(error => {
                console.error(`Error streaming song: ${error.message}`);
                loadingMessage.edit('❌ Error streaming this song. Skipping to next song...');
                queue.songs.shift();
                if (queue.songs.length > 0) {
                    playSong(queue.songs[0], queue, guildId, client);
                } else {
                    client.musicQueues.delete(guildId);
                }
            });
        });
        
    } catch (error) {
        console.error(`Error playing song: ${error.message}`);
        queue.textChannel.send('❌ Error playing this song. Skipping to next song...');
        queue.songs.shift();
        if (queue.songs.length > 0) {
            playSong(queue.songs[0], queue, guildId, client);
        } else {
            client.musicQueues.delete(guildId);
        }
    }
}

function formatDuration(seconds) {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;
    
    if (hours > 0) {
        return `${hours}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    } else {
        return `${minutes}:${secs.toString().padStart(2, '0')}`;
    }
}

// Helper function to extract YouTube video ID from various URL formats
// Helper function to extract YouTube video ID from various URL formats
function extractYoutubeVideoId(url) {
    // Handle shortened URLs without protocol
    if (url.startsWith('youtube.com') || url.startsWith('youtu.be')) {
        url = 'https://' + url;
    }
    
    // Regular expressions to match different YouTube URL formats
    const regexPatterns = [
        /(?:https?:\/\/)?(?:www\.)?youtube\.com\/watch\?v=([^&]+)/i,
        /(?:https?:\/\/)?(?:www\.)?youtu\.be\/([^?]+)/i,
        /(?:https?:\/\/)?(?:www\.)?youtube\.com\/embed\/([^?]+)/i,
        /(?:https?:\/\/)?(?:www\.)?youtube\.com\/v\/([^?]+)/i,
        /(?:https?:\/\/)?(?:www\.)?youtube\.com\/shorts\/([^?]+)/i
    ];
    
    for (const regex of regexPatterns) {
        const match = url.match(regex);
        if (match && match[1]) {
            return match[1];
        }
    }
    
    return null;
}



// ==============================================
// Channel Management Commands
// ==============================================
const channelCommands = {
    createchannel: async (interaction) => {
        if (!interaction.member.permissions.has(PermissionFlagsBits.ManageChannels)) {
            return interaction.reply('You need Manage Channels permission to use this command!');
        }

        const name = interaction.options.getString('name');
        const type = interaction.options.getString('type') || 'text';
        const category = interaction.options.getChannel('category');

        try {
            const channelType = type === 'voice' ? 2 : 0;
            const channel = await interaction.guild.channels.create({
                name: name,
                type: channelType,
                parent: category?.id
            });

            const embed = new EmbedBuilder()
                .setColor('#00ff00')
                .setTitle('✅ Channel Created')
                .setDescription(`Successfully created ${type} channel: ${channel}`)
                .setTimestamp();

            interaction.reply({ embeds: [embed] });
        } catch (error) {
            console.error(error);
            interaction.reply('There was an error creating the channel!');
        }
    },

    deletechannel: async (interaction) => {
        if (!interaction.member.permissions.has(PermissionFlagsBits.ManageChannels)) {
            return interaction.reply('You need Manage Channels permission to use this command!');
        }

        const channel = interaction.options.getChannel('channel');

        try {
            await channel.delete();
            interaction.reply(`✅ Successfully deleted channel: **${channel.name}**`);
        } catch (error) {
            console.error(error);
            interaction.reply('There was an error deleting the channel!');
        }
    },

    lockdown: async (interaction) => {
        if (!interaction.member.permissions.has(PermissionFlagsBits.ManageChannels)) {
            return interaction.reply('You need Manage Channels permission to use this command!');
        }

        const channel = interaction.channel;

        try {
            await channel.permissionOverwrites.edit(interaction.guild.roles.everyone, {
                SendMessages: false
            });

            const embed = new EmbedBuilder()
                .setColor('#ff9900')
                .setTitle('🔒 Channel Locked')
                .setDescription(`This channel has been locked down by ${interaction.user}`)
                .setTimestamp();

            interaction.reply({ embeds: [embed] });
        } catch (error) {
            console.error(error);
            interaction.reply('There was an error locking the channel!');
        }
    },

    unlock: async (interaction) => {
        if (!interaction.member.permissions.has(PermissionFlagsBits.ManageChannels)) {
            return interaction.reply('You need Manage Channels permission to use this command!');
        }

        const channel = interaction.channel;

        try {
            await channel.permissionOverwrites.edit(interaction.guild.roles.everyone, {
                SendMessages: null
            });

            const embed = new EmbedBuilder()
                .setColor('#00ff00')
                .setTitle('🔓 Channel Unlocked')
                .setDescription(`This channel has been unlocked by ${interaction.user}`)
                .setTimestamp();

            interaction.reply({ embeds: [embed] });
        } catch (error) {
            console.error(error);
            interaction.reply('There was an error unlocking the channel!');
        }
    }
};
// ... existing code ...

// ==============================================
// Reaction Role System
// ==============================================

// Add this event handler for reaction roles
client.on('messageReactionAdd', async (reaction, user) => {
    // Don't respond to bot reactions
    if (user.bot) return;
    
    // If the reaction is partial, fetch it
    if (reaction.partial) {
        try {
            await reaction.fetch();
        } catch (error) {
            console.error('Error fetching reaction:', error);
            return;
        }
    }
    
    // Check if we have reaction roles for this message
    const messageReactionRoles = client.reactionRoles?.get(reaction.message.id);
    if (!messageReactionRoles) {
        console.log(`No reaction roles found for message ID: ${reaction.message.id}`);
        return;
    }
    
    console.log(`Found reaction roles for message ID: ${reaction.message.id}`);
    
    // Get emoji details for better debugging
    const emojiName = reaction.emoji.name;
    const emojiId = reaction.emoji.id;
    
    console.log(`User ${user.tag} reacted with: ${emojiName} (ID: ${emojiId || 'standard emoji'})`);
    console.log(`Available reaction roles for this message:`, messageReactionRoles);
    
    // Try different emoji formats for matching
    let matchingRole = null;
    
    for (const rr of messageReactionRoles) {
        console.log(`Comparing with stored emoji: ${rr.emoji}`);
        
        // For standard emoji (no ID)
        if (!emojiId && rr.emoji === emojiName) {
            console.log(`✅ Match found with standard emoji: ${emojiName}`);
            matchingRole = rr;
            break;
        }
        
        // For custom emoji, try different formats
        if (emojiId) {
            const possibleFormats = [
                `<:${emojiName}:${emojiId}>`,  // Full format
                `${emojiName}:${emojiId}`,     // Without brackets
                emojiId.toString(),            // Just the ID as string
                emojiName                      // Just the name
            ];
            
            if (possibleFormats.includes(rr.emoji) || rr.emoji.includes(emojiId)) {
                console.log(`✅ Match found with custom emoji format: ${rr.emoji}`);
                matchingRole = rr;
                break;
            }
        }
    }
    
    if (matchingRole) {
        console.log(`Found matching role: ${matchingRole.roleId} for emoji: ${matchingRole.emoji}`);
        try {
            // Get the guild member
            const guild = reaction.message.guild;
            const member = await guild.members.fetch(user.id);
            
            // Add the role
            await member.roles.add(matchingRole.roleId);
            console.log(`Added role ${matchingRole.roleId} to user ${user.tag}`);
        } catch (error) {
            console.error('Error adding role:', error);
        }
    } else {
        console.log(`No matching role found for emoji: ${emojiName}`);
    }
});


const reactionRoleMultiCommand = {
    name: 'reactionrolemulti',
    description: 'Create a reaction role message with multiple emoji-role pairs',
    options: [
        {
            name: 'channel',
            description: 'Channel to send the message',
            type: 7,
            required: true
        },
        {
            name: 'title',
            description: 'Title for the reaction role message',
            type: 3,
            required: true
        },
        {
            name: 'description',
            description: 'Description for the reaction role message',
            type: 3,
            required: true
        },
        {
            name: 'pairs',
            description: 'Emoji-role pairs in format: emoji1,roleID1;emoji2,roleID2;...',
            type: 3,
            required: true
        },
        {
            name: 'color',
            description: 'Embed color (hex code)',
            type: 3,
            required: false
        }
    ]
};


const reactionCommands = {
    reactionrole: async (interaction) => {
        // Check permissions
        if (!interaction.member.permissions.has(PermissionFlagsBits.ManageRoles)) {
            return interaction.reply({
                content: '❌ You need Manage Roles permission to use this command!',
                ephemeral: true
            });
        }
        
        const channel = interaction.options.getChannel('channel');
        const role = interaction.options.getRole('role');
        const emoji = interaction.options.getString('emoji');
        const messageContent = interaction.options.getString('message');
        
        // Validate inputs
        if (!channel || !role || !emoji) {
            return interaction.reply({
                content: '❌ Please provide all required options: channel, role, and emoji',
                ephemeral: true
            });
        }
        
        try {
            // Initialize reactionRoles collection if it doesn't exist
            if (!client.reactionRoles) {
                client.reactionRoles = new Collection();
            }

            
            // Create a new message if messageContent is provided, otherwise use existing message
            let message;
            let messageId;

            
            
            // First, acknowledge the interaction to prevent timeout
            await interaction.deferReply({ ephemeral: true });
            
            if (messageContent) {
                // Create a new embed for the reaction role
                const embed = new EmbedBuilder()
                    .setColor('#0099ff')
                    .setTitle('Reaction Roles')
                    .setDescription(messageContent)
                    .setFooter({ text: 'React to get roles!' });
                
                message = await channel.send({ embeds: [embed] });
                messageId = message.id;
            } else {
                // Check if there's a previous message in this channel with reaction roles
                const channelMessages = Array.from(client.reactionRoles.entries())
                    .filter(([msgId, roles]) => {
                        return roles.some(r => r.channelId === channel.id);
                    })
                    .map(([msgId]) => msgId);
                
                if (channelMessages.length > 0) {
                    // Use the most recent message
                    messageId = channelMessages[channelMessages.length - 1];
                    try {
                        message = await channel.messages.fetch(messageId);
                    } catch (error) {
                        return interaction.editReply({
                            content: '❌ Could not find a previous reaction role message in this channel. Please provide a message.',
                        });
                    }
                } else {
                    return interaction.editReply({
                        content: '❌ No existing reaction role message found. Please provide a message.',
                    });
                }
            }
            
            // Get existing reaction roles for this message or create a new array
            const messageReactionRoles = client.reactionRoles.get(messageId) || [];
            
            // Check if this emoji is already used for this message
            const existingReactionRole = messageReactionRoles.find(rr => rr.emoji === emoji);
            if (existingReactionRole) {
                return interaction.editReply({
                    content: `❌ This emoji is already used for the role <@&${existingReactionRole.roleId}> on this message`,
                });
            }
            
            let normalizedEmoji = emoji;
        
            // Add the reaction to the message
            await message.react(emoji);
            
            // Add the new reaction role to the array
            messageReactionRoles.push({
                emoji: normalizedEmoji,
                roleId: role.id,
                channelId: channel.id
            });
            
            
            // Save the updated array back to the collection
            client.reactionRoles.set(messageId, messageReactionRoles);

            await ReactionRole.create({
                messageId: messageId,
                channelId: channel.id,
                guildId: interaction.guild.id,
                emoji: normalizedEmoji,
                roleId: role.id
            });
    
            console.log(`Added reaction role: ${messageId} -> ${role.id} with emoji ${normalizedEmoji}`);
            
            // Update the message embed to show all roles if it's our message
            if (message.author.id === client.user.id && message.embeds.length > 0) {
                const embed = EmbedBuilder.from(message.embeds[0]);
                
                // Create a description that lists all roles and their emojis
                let description = embed.data.description || '';
                
                // Add a separator if there's existing content
                if (description && !description.endsWith('\n\n')) {
                    description += '\n\n';
                }
                
                description += '**Available Roles:**\n';
                
                for (const rr of messageReactionRoles) {
                    const roleObj = interaction.guild.roles.cache.get(rr.roleId);
                    if (roleObj) {
                        description += `${rr.emoji} - ${roleObj.name}\n`;
                    }
                }
                
                embed.setDescription(description);
                
                // Update the message
                await message.edit({ embeds: [embed] });
            }
            
            // Confirm to the user using editReply instead of reply
            return interaction.editReply({
                content: `✅ Successfully added reaction role!\nChannel: ${channel}\nMessage ID: ${messageId}\nRole: ${role}\nEmoji: ${emoji}`,
            });
            
        } catch (error) {
            console.error('Error setting up reaction role:', error);
            return interaction.editReply({
                content: `❌ An error occurred: ${error.message}`,
            });
        }
    },

    // Update the removereactionrole command to use client.reactionRoles
    removereactionrole: async (interaction) => {
        if (!interaction.member.permissions.has(PermissionFlagsBits.ManageRoles)) {
            return interaction.reply({
                content: 'You need Manage Roles permission to use this command!',
                ephemeral: true
            });
        }
    
        const messageId = interaction.options.getString('messageid');
        const emoji = interaction.options.getString('emoji');
    
        // Check if we have reaction roles for this message
        const messageReactionRoles = client.reactionRoles.get(messageId);
        if (!messageReactionRoles) {
            return interaction.reply({
                content: '❌ No reaction roles found for that message!',
                ephemeral: true
            });
        }
    
        // Find the index of the reaction role with this emoji
        const index = messageReactionRoles.findIndex(rr => rr.emoji === emoji);
        if (index === -1) {
            return interaction.reply({
                content: '❌ No reaction role found for that emoji on this message!',
                ephemeral: true
            });
        }
    
        // Acknowledge the interaction first
        await interaction.deferReply({ ephemeral: true });
    
        // Get the channel ID to find the message
        const channelId = messageReactionRoles[index].channelId;
        try {
            // Try to find the channel and message
            const channel = await interaction.guild.channels.fetch(channelId);
            const message = await channel.messages.fetch(messageId);
            
            // Remove the reaction from the message
            await message.reactions.cache.find(r => 
                r.emoji.name === emoji || r.emoji.toString() === emoji
            )?.remove();
            
            // Remove the reaction role from the array
            messageReactionRoles.splice(index, 1);
    
            // Remove from database
            await ReactionRole.destroy({
                where: {
                    messageId: messageId,
                    emoji: emoji
                }
            });
            
            // If there are still reaction roles for this message, update the collection
            if (messageReactionRoles.length > 0) {
                client.reactionRoles.set(messageId, messageReactionRoles);
    
                // Update the message embed if it's our message
                if (message.author.id === client.user.id && message.embeds.length > 0) {
                    const embed = EmbedBuilder.from(message.embeds[0]);
                    
                    // Create a description that lists all roles and their emojis
                    let description = embed.data.description || '';
                    
                    // Remove the old roles list if it exists
                    if (description.includes('**Available Roles:**')) {
                        description = description.split('**Available Roles:**')[0].trim();
                    }
                    
                    // Add the updated roles list
                    description += '\n\n**Available Roles:**\n';
                    
                    for (const rr of messageReactionRoles) {
                        const roleObj = interaction.guild.roles.cache.get(rr.roleId);
                        if (roleObj) {
                            description += `${rr.emoji} - ${roleObj.name}\n`;
                        }
                    }
                    
                    embed.setDescription(description);
                    
                    // Update the message
                    await message.edit({ embeds: [embed] });
                }
            } else {
                // If there are no more reaction roles for this message, delete it from the collection
                client.reactionRoles.delete(messageId);
            }
            
            // Use editReply instead of reply
            interaction.editReply({
                content: '✅ Reaction role removed successfully!',
            });
        } catch (error) {
            console.error('Error removing reaction role:', error);
            interaction.editReply({
                content: `❌ Error removing reaction role: ${error.message}`,
            });
        }
    },

    // Update the reactionrolemulti command to use client.reactionRoles
    reactionrolemulti: async (interaction) => {
        if (!interaction.member.permissions.has(PermissionFlagsBits.ManageRoles)) {
            return interaction.reply({ content: 'You need Manage Roles permission to use this command!', ephemeral: true });
        }
        
        const channel = interaction.options.getChannel('channel');
        const title = interaction.options.getString('title');
        const description = interaction.options.getString('description');
        const pairsString = interaction.options.getString('pairs');
        const color = interaction.options.getString('color') || '#0099ff';
        
        if (channel.type !== 0) {
            return interaction.reply({ content: 'Please select a text channel!', ephemeral: true });
        }
        
        // Parse the pairs string (emoji1,roleID1;emoji2,roleID2;...)
        const pairs = [];
        const pairsArray = pairsString.split(';');
        
        for (const pair of pairsArray) {
            const [emoji, roleId] = pair.split(',');
            if (!emoji || !roleId) {
                return interaction.reply({ 
                    content: 'Invalid format for pairs. Use: emoji1,roleID1;emoji2,roleID2;...', 
                    ephemeral: true 
                });
            }
            
            const role = interaction.guild.roles.cache.get(roleId.trim());
            if (!role) {
                return interaction.reply({ 
                    content: `Role with ID ${roleId.trim()} not found!`, 
                    ephemeral: true 
                });
            }
            
            pairs.push({ emoji: emoji.trim(), roleId: roleId.trim() });
        }
        
        if (pairs.length === 0) {
            return interaction.reply({ content: 'No valid emoji-role pairs provided!', ephemeral: true });
        }
        
        // Acknowledge the interaction first
        await interaction.deferReply({ ephemeral: true });
        
        // Create the embed description with the role list
        let embedDescription = description + '\n\n**Available Roles:**\n';
        
        for (const pair of pairs) {
            const role = interaction.guild.roles.cache.get(pair.roleId);
            embedDescription += `${pair.emoji} - ${role.name}\n`;
        }
        
        // Create and send the embed
        const embed = new EmbedBuilder()
            .setColor(color)
            .setTitle(title)
            .setDescription(embedDescription)
            .setFooter({ text: 'React untuk mengklaim Role, hapus React untuk menghapus Role!' });
        
        const message = await channel.send({ embeds: [embed] });
        
        // Initialize reactionRoles collection if it doesn't exist
        if (!client.reactionRoles) {
            client.reactionRoles = new Collection();
        }
        
        // Create an array to store all reaction roles for this message
        const messageReactionRoles = [];
        
        // Add reactions and store in the client.reactionRoles collection
        for (const pair of pairs) {
            try {
                // Normalize emoji before storing
                let normalizedEmoji = pair.emoji;
                
                await message.react(pair.emoji);
                
                // Add to the messageReactionRoles array
                messageReactionRoles.push({
                    emoji: normalizedEmoji,
                    roleId: pair.roleId,
                    channelId: channel.id
                });
                
                // Save to database
                await ReactionRole.create({
                    messageId: message.id,
                    channelId: channel.id,
                    guildId: interaction.guild.id,
                    emoji: normalizedEmoji,
                    roleId: pair.roleId
                });
                
                console.log(`Added reaction role: ${message.id} -> ${pair.roleId} with emoji ${normalizedEmoji}`);
            } catch (error) {
                console.error(`Error adding reaction ${pair.emoji}:`, error);
            }
        }   
        
        // Store all reaction roles for this message
        client.reactionRoles.set(message.id, messageReactionRoles);
        
        // Use editReply instead of reply
        await interaction.editReply({ 
            content: `Reaction role message created in ${channel}!`
        });
    }
};

// ... existing code ...

// ==============================================
// Slash Commands Registration
// ==============================================

const { SlashCommandBuilder } = require('discord.js');



client.once('ready', async () => {
    console.log(`Logged in as ${client.user.tag}!`);

    if (!client.reactionRoles) {
        client.reactionRoles = new Collection();
    }
    
    try {
        // Initialize database connection
        await sequelize.authenticate();
        console.log('Database connection established successfully.');
        
        // Sync models with database
        await sequelize.sync();
        console.log('Database models synchronized.');
        
        // Load reaction roles from database
        await loadReactionRolesFromDatabase();
        
        // Convert SlashCommandBuilder objects to JSON for API compatibility
        const commandsData = commands.map(command => command.toJSON());
        
        // Register commands
        await client.application.commands.set(commandsData);
        console.log('Slash commands registered successfully!');
    } catch (error) {
        console.error('Error during initialization:', error);
    }
});

// ... existing code ...

async function loadReactionRolesFromDatabase() {
    try {
        const reactionRoles = await ReactionRole.findAll();
        
        console.log(`Found ${reactionRoles.length} reaction roles in database.`);
        
        // Clear existing collection to avoid duplicates on restart
        client.reactionRoles = new Collection();
        
        // Group reaction roles by messageId
        for (const rr of reactionRoles) {
            const messageId = rr.messageId;
            
            // If this message doesn't exist in the collection yet, create a new array
            if (!client.reactionRoles.has(messageId)) {
                client.reactionRoles.set(messageId, []);
                console.log(`Created new entry for message ID: ${messageId}`);
            }
            
            // Store the emoji exactly as it is in the database
            const emoji = rr.emoji;
            
            // Add this reaction role to the array
            client.reactionRoles.get(messageId).push({
                emoji: emoji,
                roleId: rr.roleId,
                channelId: rr.channelId
            });
            
            console.log(`Loaded reaction role from database: Message ID: ${messageId}, Role ID: ${rr.roleId}, Emoji: ${emoji}, Channel ID: ${rr.channelId}`);
        }
        
        // Log the entire reaction roles collection for debugging
        console.log('Current reaction roles collection:');
        for (const [messageId, roles] of client.reactionRoles.entries()) {
            console.log(`Message ID: ${messageId}, Roles:`, roles);
        }
        
        // Verify the messages still exist and fetch them
        for (const [messageId, roles] of client.reactionRoles.entries()) {
            if (roles.length > 0) {
                const channelId = roles[0].channelId;
                try {
                    const channel = await client.channels.fetch(channelId);
                    if (channel) {
                        try {
                            await channel.messages.fetch(messageId);
                            console.log(`Successfully verified message ${messageId} exists in channel ${channelId}`);
                        } catch (error) {
                            console.error(`Message ${messageId} no longer exists in channel ${channelId}, removing from collection`);
                            client.reactionRoles.delete(messageId);
                            
                            // Remove from database
                            await ReactionRole.destroy({
                                where: { messageId: messageId }
                            });
                        }
                    }
                } catch (error) {
                    console.error(`Channel ${channelId} no longer exists, removing message ${messageId} from collection`);
                    client.reactionRoles.delete(messageId);
                    
                    // Remove from database
                    await ReactionRole.destroy({
                        where: { messageId: messageId }
                    });
                }
            }
        }
        
        console.log(`Successfully loaded and verified ${client.reactionRoles.size} reaction role messages`);
    } catch (error) {
        console.error('Error loading reaction roles from database:', error);
    }
}

async function syncDatabase() {
    try {
        // Sync all models
        await sequelize.sync({ alter: true });
        console.log('Database synchronized');
        
        // Load reaction roles
        await loadReactionRolesFromDatabase();
    } catch (error) {
        console.error('Error syncing database:', error);
    }
}

// ... existing code ....

// Update your commands array
const commands = [

    
    // Quiz commands
    new SlashCommandBuilder()
        .setName('makequiz')
        .setDescription('Create a new quiz question')
        .addStringOption(option =>
            option.setName('question')
                .setDescription('The quiz question')
                .setRequired(true))
        .addStringOption(option =>
            option.setName('optiona')
                .setDescription('Option A')
                .setRequired(true))
        .addStringOption(option =>
            option.setName('optionb')
                .setDescription('Option B')
                .setRequired(true))
        .addStringOption(option =>
            option.setName('optionc')
                .setDescription('Option C')
                .setRequired(true))
        .addStringOption(option =>
            option.setName('optiond')
                .setDescription('Option D')
                .setRequired(true))
        .addStringOption(option =>
            option.setName('correct')
                .setDescription('Correct answer (A, B, C, or D)')
                .setRequired(true)
                .addChoices(
                    { name: 'A', value: 'A' },
                    { name: 'B', value: 'B' },
                    { name: 'C', value: 'C' },
                    { name: 'D', value: 'D' }
                )),
    
    new SlashCommandBuilder()
        .setName('quiztimer')
        .setDescription('Set the timer for quizzes')
        .addIntegerOption(option =>
            option.setName('minutes')
                .setDescription('Duration in minutes (5, 10, 30)')
                .setRequired(true)
                .addChoices(
                    { name: '5 minutes', value: 5 },
                    { name: '10 minutes', value: 10 },
                    { name: '30 minutes', value: 30 }
                )),
    
    new SlashCommandBuilder()
        .setName('startquiz')
        .setDescription('Start a quiz session'),

    new SlashCommandBuilder()
    .setName('announcement')
    .setDescription('Send an announcement to the channel')
    .addStringOption(option =>
        option.setName('title')
            .setDescription('Title of the announcement')
            .setRequired(true))
    .addStringOption(option =>
        option.setName('description')
            .setDescription('Content of the announcement')
            .setRequired(true))
    .addStringOption(option =>
        option.setName('tags')
            .setDescription('Tags to mention (format: @role1, @role2, @role3)')
            .setRequired(false))
    .addStringOption(option =>
        option.setName('author')
            .setDescription('Who is making this announcement')
            .setRequired(false))
    .addChannelOption(option =>
        option.setName('channel')
            .setDescription('Channel to send the announcement (defaults to current channel)')
            .setRequired(false)),


    // Music commands
    new SlashCommandBuilder()
        .setName('play')
        .setDescription('Play a song from YouTube')
        .addStringOption(option => 
            option.setName('query')
                .setDescription('Song name or YouTube URL')
                .setRequired(true)),
    
    new SlashCommandBuilder()
        .setName('skip')
        .setDescription('Skip the current song'),

    new SlashCommandBuilder()
        .setName('stop')
        .setDescription('Stop music and clear queue'),

    new SlashCommandBuilder()
        .setName('queue')
        .setDescription('Show the music queue'),

    // Channel management commands
    new SlashCommandBuilder()
        .setName('createchannel')
        .setDescription('Create a new channel')
        .addStringOption(option =>
            option.setName('name')
                .setDescription('Channel name')
                .setRequired(true))
        .addStringOption(option =>
            option.setName('type')
                .setDescription('Channel type')
                .addChoices(
                    { name: 'Text', value: 'text' },
                    { name: 'Voice', value: 'voice' }
                ))
        .addChannelOption(option =>
            option.setName('category')
                .setDescription('Category to place the channel in')),

    new SlashCommandBuilder()
        .setName('deletechannel')
        .setDescription('Delete a channel')
        .addChannelOption(option =>
            option.setName('channel')
                .setDescription('Channel to delete')
                .setRequired(true)),

    new SlashCommandBuilder()
        .setName('lockdown')
        .setDescription('Lock the current channel'),

    new SlashCommandBuilder()
        .setName('unlock')
        .setDescription('Unlock the current channel'),

    // Reaction role commands
    new SlashCommandBuilder()
    .setName('reactionrole')
    .setDescription('Setup a reaction role')
    .addChannelOption(option =>
        option.setName('channel')
            .setDescription('Channel to send the message')
            .setRequired(true))
    .addRoleOption(option =>
        option.setName('role')
            .setDescription('Role to assign')
            .setRequired(true))
    .addStringOption(option =>
        option.setName('emoji')
            .setDescription('Emoji for reaction')
            .setRequired(true))
    .addStringOption(option =>
        option.setName('message')
            .setDescription('Custom message content (optional)')),

new SlashCommandBuilder()
    .setName('removereactionrole')
    .setDescription('Remove a reaction role')
    .addStringOption(option =>
        option.setName('messageid')
            .setDescription('Message ID')
            .setRequired(true))
    .addStringOption(option =>
        option.setName('emoji')
            .setDescription('Emoji to remove')
            .setRequired(true)),

// Add this command to your commands array
new SlashCommandBuilder()
    .setName('reactionrolemulti')
    .setDescription('Create multiple reaction roles at once')
    .addChannelOption(option =>
        option.setName('channel')
            .setDescription('Channel to send the message')
            .setRequired(true))
    .addStringOption(option =>
        option.setName('title')
            .setDescription('Title for the embed')
            .setRequired(true))
    .addStringOption(option =>
        option.setName('description')
            .setDescription('Description for the embed')
            .setRequired(true))
    .addStringOption(option =>
        option.setName('pairs')
            .setDescription('Emoji-role pairs (format: emoji1,roleID1;emoji2,roleID2;...)')
            .setRequired(true))
    .addStringOption(option =>
        option.setName('color')
            .setDescription('Color for the embed (hex code)')),
                
    // New utility commands
    new SlashCommandBuilder()
        .setName('help')
        .setDescription('Display all available commands'),
    
    new SlashCommandBuilder()
        .setName('ping')
        .setDescription('Check bot latency'),
    
    new SlashCommandBuilder()
        .setName('clear')
        .setDescription('Clear messages in a channel')
        .addIntegerOption(option => 
            option.setName('amount')
                .setDescription('Number of messages to clear')
                .setRequired(true)
                .setMinValue(1)
                .setMaxValue(100)),
    
    new SlashCommandBuilder()
        .setName('serverinfo')
        .setDescription('Display server information'),
    
    // Moderation commands
    new SlashCommandBuilder()
        .setName('kick')
        .setDescription('Kick a user from the server')
        .addUserOption(option => 
            option.setName('user')
                .setDescription('The user to kick')
                .setRequired(true))
        .addStringOption(option => 
            option.setName('reason')
                .setDescription('Reason for kicking')),
    
    new SlashCommandBuilder()
        .setName('ban')
        .setDescription('Ban a user from the server')
        .addUserOption(option => 
            option.setName('user')
                .setDescription('The user to ban')
                .setRequired(true))
        .addStringOption(option => 
            option.setName('reason')
                .setDescription('Reason for banning'))
];

client.quizSessions = new Collection();
client.quizResults = new Collection();


client.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    if (!interaction.isButton()) return;

    const { commandName } = interaction;
    const customId = interaction.customId;

    if (customId.startsWith('quiz_')) {
        const [prefix, answer, questionId] = customId.split('_');
        const userId = interaction.user.id;
        
        // Get the user's quiz session
        const session = client.quizSessions.get(userId);
        
        if (!session) {
            return interaction.reply({
                content: 'This quiz session is no longer active.',
                ephemeral: true
            });
        }
        
        // Check if the quiz has expired
        if (Date.now() > session.endTime) {
            client.quizSessions.delete(userId);
            return interaction.reply({
                content: 'This quiz has expired.',
                ephemeral: true
            });
        }
        
        // Mark as answered
        session.answered = true;
        
        // Check if the answer is correct
        const isCorrect = answer === session.correctAnswer;
        
        // Update quiz results
        if (!client.quizResults.has(userId)) {
            client.quizResults.set(userId, { correct: 0, total: 0 });
        }
        
        const userResults = client.quizResults.get(userId);
        userResults.total++;
        
        if (isCorrect) {
            userResults.correct++;
        }
        
        // Create result embed
        const resultEmbed = new EmbedBuilder()
            .setColor(isCorrect ? '#4CAF50' : '#F44336')
            .setTitle(isCorrect ? '✅ Correct Answer!' : '❌ Wrong Answer!')
            .setDescription(`The correct answer was: ${session.correctAnswer}`)
            .addFields(
                { name: 'Your Score', value: `${userResults.correct}/${userResults.total} (${Math.round(userResults.correct / userResults.total * 100)}%)`, inline: false }
            )
            .setTimestamp();
        
        // Disable all buttons
        const disabledRow = new ActionRowBuilder()
            .addComponents(
                new ButtonBuilder()
                    .setCustomId(`quiz_A_disabled`)
                    .setLabel('A')
                    .setStyle(session.correctAnswer === 'A' ? ButtonStyle.Success : (answer === 'A' && !isCorrect ? ButtonStyle.Danger : ButtonStyle.Secondary))
                    .setDisabled(true),
                new ButtonBuilder()
                    .setCustomId(`quiz_B_disabled`)
                    .setLabel('B')
                    .setStyle(session.correctAnswer === 'B' ? ButtonStyle.Success : (answer === 'B' && !isCorrect ? ButtonStyle.Danger : ButtonStyle.Secondary))
                    .setDisabled(true),
                new ButtonBuilder()
                    .setCustomId(`quiz_C_disabled`)
                    .setLabel('C')
                    .setStyle(session.correctAnswer === 'C' ? ButtonStyle.Success : (answer === 'C' && !isCorrect ? ButtonStyle.Danger : ButtonStyle.Secondary))
                    .setDisabled(true),
                new ButtonBuilder()
                    .setCustomId(`quiz_D_disabled`)
                    .setLabel('D')
                    .setStyle(session.correctAnswer === 'D' ? ButtonStyle.Success : (answer === 'D' && !isCorrect ? ButtonStyle.Danger : ButtonStyle.Secondary))
                    .setDisabled(true)
            );
        
        // Add a button to start a new quiz
        const newQuizRow = new ActionRowBuilder()
            .addComponents(
                new ButtonBuilder()
                    .setCustomId(`new_quiz`)
                    .setLabel('Start New Quiz')
                    .setStyle(ButtonStyle.Primary)
            );
        
        // Update the message
        await interaction.update({
            content: isCorrect ? 'Congratulations! You got it right!' : 'Sorry, that\'s not correct.',
            embeds: [resultEmbed],
            components: [disabledRow, newQuizRow]
        });
        
        // Clean up the session
        client.quizSessions.delete(userId);
    }
    
    // Handle "Start New Quiz" button
    if (interaction.customId === 'new_quiz') {
        // Create a new interaction to trigger the startquiz command
        const command = client.application.commands.cache.find(cmd => cmd.name === 'startquiz');
        
        if (!command) {
            return interaction.reply({
                content: 'Unable to start a new quiz. Please use the /startquiz command.',
                ephemeral: true
            });
        }
        
        // Acknowledge the button click
        await interaction.deferUpdate();
        
        // Create a new slash command
        const { commandName } = interaction;
        try {
            // Manually trigger the startquiz command
            const startQuizCommand = 'startquiz';
            const interactionCreate = client._events.interactionCreate;
            
            // Create a mock interaction
            const mockInteraction = {
                ...interaction,
                commandName: startQuizCommand,
                options: {
                    getString: () => null,
                    getInteger: () => null
                },
                isChatInputCommand: () => true,
                reply: interaction.followUp.bind(interaction),
                deferReply: interaction.deferReply.bind(interaction)
            };
            
            // Call the handler
            await interactionCreate[0](mockInteraction);
        } catch (error) {
            console.error('Error starting new quiz:', error);
            await interaction.followUp({
                content: 'There was an error starting a new quiz. Please use the /startquiz command.',
                ephemeral: true
            });
        }
    }

    try {
        // Handle existing command categories
        if (musicCommands[commandName]) {
            await musicCommands[commandName](interaction);
        } else if (channelCommands[commandName]) {
            await channelCommands[commandName](interaction);
        } else if (reactionCommands[commandName]) {
            await reactionCommands[commandName](interaction);
        } 
        // Handle new commands
        else if (commandName === 'help') {
            const helpEmbed = new EmbedBuilder()
                .setColor('#5865F2')
                .setTitle('Bot Commands')
                .setDescription('Here are all the available commands:')
                .addFields(
                    { name: '🎵 Music Commands', value: 
                        '`/play [song]` - Play a song from YouTube\n' +
                        '`/skip` - Skip the current song\n' +
                        '`/stop` - Stop the music and clear the queue\n' +
                        '`/queue` - View the current music queue'
                    },
                    { name: '⚙️ Channel Commands', value: 
                        '`/createchannel` - Create a new channel\n' +
                        '`/deletechannel` - Delete a channel\n' +
                        '`/lockdown` - Lock the current channel\n' +
                        '`/unlock` - Unlock the current channel'
                    },
                    { name: '🔄 Reaction Roles', value: 
                        '`/reactionrole` - Create a reaction role message\n' +
                        '`/removereactionrole` - Remove a reaction role'
                    },
                    { name: '📢 Announcements', value:
                        '`/announcement` - Send a formatted announcement with optional role mentions'
                    },
                    { name: '🛠️ Moderation', value: 
                        '`/kick` - Kick a user from the server\n' +
                        '`/ban` - Ban a user from the server\n' +
                        '`/clear` - Clear messages in a channel'
                    },
                    { name: '📊 Utility', value: 
                        '`/help` - Display this help message\n' +
                        '`/ping` - Check bot latency\n' +
                        '`/serverinfo` - Display server information'
                    },
                    { name: '❓ Quiz System', value: 
                        '`/makequiz` - Create a new quiz question (Admin only)\n' +
                        '`/quiztimer` - Set the timer for quizzes (Admin only)\n' +
                        '`/startquiz` - Start a quiz session'
                    }
                );
            
            await interaction.reply({ embeds: [helpEmbed] });
        }
        
        else if (commandName === 'ping') {
            const sent = await interaction.reply({ content: 'Pinging...', fetchReply: true });
            const pingTime = sent.createdTimestamp - interaction.createdTimestamp;
            await interaction.editReply(`Pong! Latency is ${pingTime}ms. API Latency is ${Math.round(client.ws.ping)}ms`);
        }

        else if (commandName === 'makequiz') {
            // Check permissions
            if (!interaction.memberPermissions.has(PermissionFlagsBits.ManageMessages)) {
                return interaction.reply({ 
                    content: 'You need Manage Messages permission to create quizzes!', 
                    ephemeral: true 
                });
            }
            
            const question = interaction.options.getString('question');
            const optionA = interaction.options.getString('optiona');
            const optionB = interaction.options.getString('optionb');
            const optionC = interaction.options.getString('optionc');
            const optionD = interaction.options.getString('optiond');
            const correctAnswer = interaction.options.getString('correct');
            
            try {
                // Create quiz in database
                await Quiz.create({
                    question,
                    optionA,
                    optionB,
                    optionC,
                    optionD,
                    correctAnswer,
                    createdBy: interaction.user.id,
                    guildId: interaction.guild.id
                });
                
                const quizEmbed = new EmbedBuilder()
                    .setColor('#4CAF50')
                    .setTitle('Quiz Question Created')
                    .setDescription(question)
                    .addFields(
                        { name: 'A', value: optionA, inline: true },
                        { name: 'B', value: optionB, inline: true },
                        { name: '\u200B', value: '\u200B', inline: false }, // Empty field for spacing
                        { name: 'C', value: optionC, inline: true },
                        { name: 'D', value: optionD, inline: true }
                    )
                    .setFooter({ text: `Created by ${interaction.user.tag}` })
                    .setTimestamp();
                
                await interaction.reply({ 
                    content: 'Quiz question created successfully!', 
                    embeds: [quizEmbed],
                    ephemeral: true 
                });
            } catch (error) {
                console.error('Error creating quiz:', error);
                await interaction.reply({ 
                    content: 'There was an error creating the quiz question!', 
                    ephemeral: true 
                });
            }
        }
        else if (commandName === 'quiztimer') {
            // Check permissions
            if (!interaction.memberPermissions.has(PermissionFlagsBits.ManageMessages)) {
                return interaction.reply({ 
                    content: 'You need Manage Messages permission to set quiz timers!', 
                    ephemeral: true 
                });
            }
            
            const minutes = interaction.options.getInteger('minutes');
            const guildId = interaction.guild.id;
            
            try {
                // Update or create quiz timer
                const [timer, created] = await QuizTimer.findOrCreate({
                    where: { guildId },
                    defaults: {
                        durationMinutes: minutes,
                        isActive: false
                    }
                });
                
                if (!created) {
                    timer.durationMinutes = minutes;
                    await timer.save();
                }
                
                await interaction.reply({ 
                    content: `Quiz timer set to ${minutes} minutes!`, 
                    ephemeral: true 
                });
            } catch (error) {
                console.error('Error setting quiz timer:', error);
                await interaction.reply({ 
                    content: 'There was an error setting the quiz timer!', 
                    ephemeral: true 
                });
            }
        }
        else if (commandName === 'startquiz') {
            const guildId = interaction.guild.id;
            const userId = interaction.user.id;
            
            try {
                // Check if there's an active quiz session
                const timer = await QuizTimer.findOne({ where: { guildId } });
                
                if (!timer) {
                    return interaction.reply({ 
                        content: 'No quiz timer has been set up for this server. Ask an admin to use /quiztimer first!', 
                        ephemeral: true 
                    });
                }
                
                // Get all quiz questions for this guild
                const quizQuestions = await Quiz.findAll({ where: { guildId } });
                
                if (quizQuestions.length === 0) {
                    return interaction.reply({ 
                        content: 'No quiz questions available. Ask an admin to add some with /makequiz!', 
                        ephemeral: true 
                    });
                }
                
                // Select a random question
                const randomQuestion = quizQuestions[Math.floor(Math.random() * quizQuestions.length)];
                
                // Create buttons for answers
                const row = new ActionRowBuilder()
                    .addComponents(
                        new ButtonBuilder()
                            .setCustomId(`quiz_A_${randomQuestion.id}`)
                            .setLabel('A')
                            .setStyle(ButtonStyle.Primary),
                        new ButtonBuilder()
                            .setCustomId(`quiz_B_${randomQuestion.id}`)
                            .setLabel('B')
                            .setStyle(ButtonStyle.Primary),
                        new ButtonBuilder()
                            .setCustomId(`quiz_C_${randomQuestion.id}`)
                            .setLabel('C')
                            .setStyle(ButtonStyle.Primary),
                        new ButtonBuilder()
                            .setCustomId(`quiz_D_${randomQuestion.id}`)
                            .setLabel('D')
                            .setStyle(ButtonStyle.Primary)
                    );
                
                // Calculate end time
                const durationMs = timer.durationMinutes * 60 * 1000;
                const endTime = new Date(Date.now() + durationMs);
                
                // Create quiz embed
                const quizEmbed = new EmbedBuilder()
                    .setColor('#3498DB')
                    .setTitle('Quiz Time!')
                    .setDescription(randomQuestion.question)
                    .addFields(
                        { name: 'A', value: randomQuestion.optionA, inline: true },
                        { name: 'B', value: randomQuestion.optionB, inline: true },
                        { name: '\u200B', value: '\u200B', inline: false }, // Empty field for spacing
                        { name: 'C', value: randomQuestion.optionC, inline: true },
                        { name: 'D', value: randomQuestion.optionD, inline: true },
                        { name: 'Time Remaining', value: `Quiz ends <t:${Math.floor(endTime.getTime() / 1000)}:R>`, inline: false }
                    )
                    .setFooter({ text: `You have ${timer.durationMinutes} minutes to answer` })
                    .setTimestamp();
                
                // Store the quiz session
                client.quizSessions.set(userId, {
                    questionId: randomQuestion.id,
                    correctAnswer: randomQuestion.correctAnswer,
                    endTime: endTime,
                    answered: false
                });
                
                // Send the quiz
                await interaction.reply({ 
                    content: 'Your quiz has started! Select your answer:',
                    embeds: [quizEmbed],
                    components: [row],
                    ephemeral: true 
                });
                
                // Set a timeout to end the quiz
                setTimeout(async () => {
                    const session = client.quizSessions.get(userId);
                    
                    if (session && !session.answered) {
                        // User didn't answer in time
                        client.quizSessions.delete(userId);
                        
                        try {
                            // Try to edit the original message if it still exists
                            await interaction.editReply({
                                content: 'Time\'s up! You didn\'t answer in time.',
                                components: []
                            });
                        } catch (error) {
                            console.error('Error updating expired quiz:', error);
                        }
                    }
                }, durationMs);
                
            } catch (error) {
                console.error('Error starting quiz:', error);
                await interaction.reply({ 
                    content: 'There was an error starting the quiz!', 
                    ephemeral: true 
                });
            }
        }


        else if (commandName === 'clear') {
            if (!interaction.memberPermissions.has(PermissionFlagsBits.ManageMessages)) {
                return interaction.reply({ content: 'You need Manage Messages permission to use this command!', ephemeral: true });
            }
            
            const amount = interaction.options.getInteger('amount');
            if (amount < 1 || amount > 100) {
                return interaction.reply({ content: 'You need to input a number between 1 and 100.', ephemeral: true });
            }
            
            await interaction.channel.bulkDelete(amount, true)
                .then(messages => {
                    interaction.reply({ content: `Successfully deleted ${messages.size} messages.`, ephemeral: true });
                })
                .catch(error => {
                    console.error(error);
                    interaction.reply({ content: 'There was an error trying to clear messages in this channel!', ephemeral: true });
                });
        }
        else if (commandName === 'serverinfo') {
            const guild = interaction.guild;
            const serverInfoEmbed = new EmbedBuilder()
                .setColor('#5865F2')
                .setTitle(guild.name)
                .setThumbnail(guild.iconURL({ dynamic: true }))
                .addFields(
                    { name: 'Owner', value: `<@${guild.ownerId}>`, inline: true },
                    { name: 'Created On', value: `<t:${Math.floor(guild.createdTimestamp / 1000)}:F>`, inline: true },
                    { name: 'Members', value: `${guild.memberCount}`, inline: true },
                    { name: 'Channels', value: `${guild.channels.cache.size}`, inline: true },
                    { name: 'Roles', value: `${guild.roles.cache.size}`, inline: true },
                    { name: 'Boost Level', value: `${guild.premiumTier}`, inline: true }
                )
                .setFooter({ text: `Server ID: ${guild.id}` });
            
            await interaction.reply({ embeds: [serverInfoEmbed] });
        }
        else if (commandName === 'kick') {
            if (!interaction.memberPermissions.has(PermissionFlagsBits.KickMembers)) {
                return interaction.reply({ content: 'You need Kick Members permission to use this command!', ephemeral: true });
            }
            
            const targetUser = interaction.options.getUser('user');
            const reason = interaction.options.getString('reason') || 'No reason provided';
            
            const targetMember = await interaction.guild.members.fetch(targetUser.id).catch(() => null);
            
            if (!targetMember) {
                return interaction.reply({ content: 'That user is not in this server!', ephemeral: true });
            }
            
            if (!targetMember.kickable) {
                return interaction.reply({ content: 'I cannot kick this user! They may have higher permissions than me.', ephemeral: true });
            }
            
            await targetMember.kick(reason);
            
            const kickEmbed = new EmbedBuilder()
                .setColor('#FF0000')
                .setTitle('User Kicked')
                .setDescription(`${targetUser.tag} has been kicked from the server.`)
                .addFields(
                    { name: 'Reason', value: reason },
                    { name: 'Moderator', value: interaction.user.tag }
                )
                .setTimestamp();
            
            await interaction.reply({ embeds: [kickEmbed] });
        }

        else if (commandName === 'announcement') {
            // Check if user has permission to manage messages
            if (!interaction.memberPermissions.has(PermissionFlagsBits.ManageMessages)) {
                return interaction.reply({ 
                    content: 'You need Manage Messages permission to use this command!', 
                    ephemeral: true 
                });
            }
            
            // Get command options
            const title = interaction.options.getString('title');
            const description = interaction.options.getString('description');
            const tagsInput = interaction.options.getString('tags') || '';
            const author = interaction.options.getString('author') || interaction.user.tag;
            const targetChannel = interaction.options.getChannel('channel') || interaction.channel;
            
            // Process tags
            let mentionString = '';
            if (tagsInput.trim()) {
                const tagsList = tagsInput.split(',').map(tag => tag.trim());
                
                for (const tag of tagsList) {
                    // Handle role mentions
                    if (tag.startsWith('@')) {
                        const roleName = tag.substring(1);
                        const role = interaction.guild.roles.cache.find(r => 
                            r.name.toLowerCase() === roleName.toLowerCase() || 
                            r.id === roleName
                        );
                        
                        if (role) {
                            mentionString += `${role} `;
                        }
                    } else {
                        // Just add the tag as is
                        mentionString += `${tag} `;
                    }
                }
            }
            
            // Create the announcement embed
            const announcementEmbed = new EmbedBuilder()
                .setColor('#FF9900')
                .setTitle(`📢 ${title}`)
                .setDescription(description)
                .setFooter({ text: `Announcement by: ${author}` })
                .setTimestamp();
            
            // Send the announcement
            await interaction.deferReply({ ephemeral: true });
            
            try {
                await targetChannel.send({ 
                    content: mentionString.trim() ? mentionString : null,
                    embeds: [announcementEmbed] 
                });
                
                await interaction.editReply({ 
                    content: `Announcement successfully sent to ${targetChannel}!`,
                    ephemeral: true
                });
            } catch (error) {
                console.error('Error sending announcement:', error);
                await interaction.editReply({ 
                    content: `Error sending announcement: ${error.message}`,
                    ephemeral: true
                });
            }
        }

        else if (commandName === 'ban') {
            if (!interaction.memberPermissions.has(PermissionFlagsBits.BanMembers)) {
                return interaction.reply({ content: 'You need Ban Members permission to use this command!', ephemeral: true });
            }
            
            const targetUser = interaction.options.getUser('user');
            const reason = interaction.options.getString('reason') || 'No reason provided';
            
            const targetMember = await interaction.guild.members.fetch(targetUser.id).catch(() => null);
            
            if (targetMember && !targetMember.bannable) {
                return interaction.reply({ content: 'I cannot ban this user! They may have higher permissions than me.', ephemeral: true });
            }
            
            await interaction.guild.members.ban(targetUser, { reason });
            
            const banEmbed = new EmbedBuilder()
                .setColor('#FF0000')
                .setTitle('User Banned')
                .setDescription(`${targetUser.tag} has been banned from the server.`)
                .addFields(
                    { name: 'Reason', value: reason },
                    { name: 'Moderator', value: interaction.user.tag }
                )
                .setTimestamp();
            
            await interaction.reply({ embeds: [banEmbed] });
        }
    } catch (error) {
        console.error(error);
        if (interaction.replied || interaction.deferred) {
            await interaction.followUp({ content: 'There was an error executing this command!', ephemeral: true });
        } else {
            await interaction.reply({ content: 'There was an error executing this command!', ephemeral: true });
        }
    }
});

client.on('messageReactionRemove', async (reaction, user) => {
    // Don't respond to bot reactions
    if (user.bot) return;
    
    // If the reaction is partial, fetch it
    if (reaction.partial) {
        try {
            await reaction.fetch();
        } catch (error) {
            console.error('Error fetching reaction:', error);
            return;
        }
    }
    
    // Check if we have reaction roles for this message
    const messageReactionRoles = client.reactionRoles?.get(reaction.message.id);
    if (!messageReactionRoles) return;
    
    // Get emoji details for better debugging
    const emojiName = reaction.emoji.name;
    const emojiId = reaction.emoji.id;
    const emojiIdentifier = emojiId ? `${emojiName}:${emojiId}` : emojiName;
    
    console.log(`User ${user.tag} removed reaction: ${emojiName} (ID: ${emojiId || 'standard emoji'})`);
    
    // Normalize the emoji for comparison
    let normalizedEmoji;
    if (emojiId) {
        // For custom emoji, try multiple formats
        normalizedEmoji = [
            `<:${emojiName}:${emojiId}>`,  // Full format
            `${emojiName}:${emojiId}`,     // Without brackets
            emojiId,                       // Just the ID
            emojiName                      // Just the name
        ];
    } else {
        // For standard emoji
        normalizedEmoji = [emojiName];
    }
    
    // Find the matching reaction role with improved emoji matching
    let matchingRole = null;
    
    for (const rr of messageReactionRoles) {
        // Check if any of our normalized formats match
        if (normalizedEmoji.some(format => format === rr.emoji)) {
            matchingRole = rr;
            break;
        }
    }
    
    if (matchingRole) {
        try {
            // Get the guild member
            const guild = reaction.message.guild;
            const member = await guild.members.fetch(user.id);
            
            // Remove the role
            await member.roles.remove(matchingRole.roleId);
            console.log(`Removed role ${matchingRole.roleId} from user ${user.tag}`);
        } catch (error) {
            console.error('Error removing role:', error);
        }
    }
});

// ==============================================
// Web Routes
// ==============================================

// Auth middleware
function ensureAuthenticated(req, res, next) {
    if (req.isAuthenticated()) {
        return next();
    }
    res.redirect('/login');
}

// Routes
app.get('/', (req, res) => {
    res.render('index', { user: req.user });
});

app.get('/login', (req, res) => {
    res.render('login');
});

app.get('/auth/discord', passport.authenticate('discord'));
app.get('/auth/discord/callback', 
    passport.authenticate('discord', { failureRedirect: '/login' }),
    (req, res) => {
        res.redirect('/dashboard');
    }
);

app.get('/logout', (req, res) => {
    req.logout(() => {
        res.redirect('/');
    });
});

app.get('/dashboard', ensureAuthenticated, async (req, res) => {
    try {
        const userGuilds = req.user.guilds.filter(guild => 
            (guild.permissions & 0x20) === 0x20 // Administrator permission
        );

        const botGuilds = client.guilds.cache.map(guild => guild.id);
        const mutualGuilds = userGuilds.filter(guild => botGuilds.includes(guild.id));

        res.render('dashboard', { 
            user: req.user, 
            guilds: mutualGuilds 
        });
    } catch (error) {
        console.error(error);
        res.render('dashboard', { user: req.user, guilds: [] });
    }
});

app.get('/server/:id', ensureAuthenticated, async (req, res) => {
    const guildId = req.params.id;
    const userGuilds = req.user.guilds;
    const guild = userGuilds.find(g => g.id === guildId);

    const reactionRolesData = [];

    if (!guild) {
        return res.redirect('/dashboard');
    }

    // Check if user has manage server permission
    if ((guild.permissions & 0x20) !== 0x20) {
        return res.redirect('/dashboard');
    }

    try {
        const discordGuild = client.guilds.cache.get(guildId);
        if (!discordGuild) {
            return res.redirect('/dashboard');
        }

        const channels = discordGuild.channels.cache.filter(c => c.type !== 4); // Exclude categories
        const roles = await discordGuild.roles.fetch();
        
        // Get music queue if exists
        const musicQueue = client.musicQueues.get(guildId);
        
        // Get reaction roles data
        const reactionRolesData = [];
        
        // Convert the reactionRoles Map to an array of objects with detailed information
        for (const [messageId, rolesList] of client.reactionRoles.entries()) {
            for (const roleData of rolesList) {
                const emoji = roleData.emoji;
                const roleId = roleData.roleId;
                const channelId = roleData.channelId;
                
                // Try to find the channel name
                let channelName = 'Unknown';
                const channel = discordGuild.channels.cache.get(channelId);
                if (channel) {
                    channelName = channel.name;
                }
                
                // Try to find the role name
                let roleName = 'Unknown';
                const role = await discordGuild.roles.fetch(roleId).catch(() => null);
                if (role) {
                    roleName = role.name;
                }
                
                reactionRolesData.push({
                    messageId,
                    emoji,
                    channelName,
                    roleName
                });
            }
        }

        res.render('server', {
            user: req.user,
            guild: discordGuild,
            channels,
            roles,
            musicQueue: musicQueue || null,
            reactionRoles: reactionRolesData
        });
    } catch (error) {
        console.error(error);
        res.redirect('/dashboard');
    }
});
// Keep only one version of this endpoint and remove the duplicate
app.post('/api/music/control', ensureAuthenticated, async (req, res) => {
    const { guildId, action } = req.body;
    const queue = client.musicQueues.get(guildId);

    if (!queue) {
        return res.json({ success: false, error: 'No music queue found' });
    }

    try {
        switch (action) {
            case 'skip':
                if (queue.songs.length <= 1) {
                    return res.json({ success: false, error: 'No more songs in queue' });
                }
                queue.player.stop();
                res.json({ success: true, message: 'Skipped current song' });
                break;
            case 'stop':
                queue.songs = [];
                queue.player.stop();
                queue.connection.destroy();
                client.musicQueues.delete(guildId);
                res.json({ success: true, message: 'Stopped music and cleared queue' });
                break;
            case 'pause':
                queue.player.pause();
                res.json({ success: true, message: 'Paused music' });
                break;
            case 'resume':
                queue.player.unpause();
                res.json({ success: true, message: 'Resumed music' });
                break;
            default:
                res.json({ success: false, error: 'Invalid action' });
        }
    } catch (error) {
        console.error(error);
        res.json({ success: false, error: error.message });
    }
});

// API endpoints for server management
app.post('/api/channel/create', ensureAuthenticated, async (req, res) => {
    const { guildId, name, type, categoryId } = req.body;
    const guild = client.guilds.cache.get(guildId);

    if (!guild) {
        return res.json({ success: false, error: 'Guild not found' });
    }

    try {
        const channelType = type === 'voice' ? 2 : 0;
        const channel = await guild.channels.create({
            name: name,
            type: channelType,
            parent: categoryId || null
        });

        res.json({ success: true, channel: { id: channel.id, name: channel.name } });
    } catch (error) {
        console.error(error);
        res.json({ success: false, error: error.message });
    }
});

app.post('/api/channel/delete', ensureAuthenticated, async (req, res) => {
    const { guildId, channelId } = req.body;
    const guild = client.guilds.cache.get(guildId);

    if (!guild) {
        return res.json({ success: false, error: 'Guild not found' });
    }

    try {
        const channel = guild.channels.cache.get(channelId);
        if (channel) {
            await channel.delete();
            res.json({ success: true });
        } else {
            res.json({ success: false, error: 'Channel not found' });
        }
    } catch (error) {
        console.error(error);
        res.json({ success: false, error: error.message });
    }
});



app.post('/api/reaction/create', async (req, res) => {
    if (!req.isAuthenticated()) {
        return res.status(401).json({ success: false, error: 'Not authenticated' });
    }
    
    const { guildId, channelId, roleId, emoji, messageId, messageContent, additionalRoles } = req.body;
    
    try {
        const guild = client.guilds.cache.get(guildId);
        if (!guild) {
            return res.status(404).json({ success: false, error: 'Guild not found' });
        }
        
        const channel = guild.channels.cache.get(channelId);
        if (!channel) {
            return res.status(404).json({ success: false, error: 'Channel not found' });
        }
        
        const role = guild.roles.cache.get(roleId);
        if (!role) {
            return res.status(404).json({ success: false, error: 'Role not found' });
        }
        
        // Check bot permissions
        const botMember = guild.members.cache.get(client.user.id);
        if (!botMember.permissions.has(PermissionFlagsBits.ManageRoles)) {
            return res.status(403).json({ 
                success: false, 
                error: 'Bot does not have Manage Roles permission' 
            });
        }
        
        // Check role hierarchy
        if (botMember.roles.highest.position <= role.position) {
            return res.status(403).json({ 
                success: false, 
                error: 'Bot role must be higher than the role to assign' 
            });
        }
        
        // Process all roles (primary + additional)
        const allRoles = [roleId];
        
        // Add additional roles if provided
        if (additionalRoles) {
            const additionalRoleIds = additionalRoles.split(',');
            
            for (const additionalRoleId of additionalRoleIds) {
                if (additionalRoleId === roleId) continue; // Skip if same as primary role
                
                const additionalRole = await guild.roles.fetch(additionalRoleId);
                if (!additionalRole) continue;
                
                // Check hierarchy for additional role
                if (botMember.roles.highest.position <= additionalRole.position) {
                    return res.status(403).json({
                        success: false,
                        error: `Bot role must be higher than the role "${additionalRole.name}" to assign`
                    });
                }
                
                allRoles.push(additionalRoleId);
            }
        }
        
        let message;
        
        // Use existing message or create new one
        if (messageId) {
            try {
                message = await channel.messages.fetch(messageId);
            } catch (error) {
                return res.status(404).json({ 
                    success: false, 
                    error: 'Message not found. Please check the message ID.' 
                });
            }
        } else {
            // Create a new message with embed
            const roleNames = allRoles.map(id => {
                const r = guild.roles.cache.get(id);
                return r ? r.name : 'Unknown Role';
            }).join(', ');
            
            const embed = new EmbedBuilder()
                .setColor('#0099ff')
                .setTitle('React for Role')
                .setDescription(messageContent || `React with ${emoji} to get the ${roleNames} role${allRoles.length > 1 ? 's' : ''}!`)
                .setFooter({ text: 'React below to get your role!' });
                
            message = await channel.send({ embeds: [embed] });
        }
        
        // Add the reaction
        await message.react(emoji);
        
        // Store reaction role data
        const key = `${message.id}_${emoji}`;
        reactionRoles.set(key, allRoles);
        
        // Return success
        res.json({ 
            success: true, 
            message: 'Reaction role created successfully',
            messageId: message.id
        });
        
    } catch (error) {
        console.error('Error creating reaction role:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/reaction/create-multiple', async (req, res) => {
    if (!req.isAuthenticated()) {
        return res.status(401).json({ success: false, error: 'Not authenticated' });
    }
    
    const { guildId, channelId, messageId, messageContent, pairs } = req.body;
    
    try {
        const guild = client.guilds.cache.get(guildId);
        if (!guild) {
            return res.status(404).json({ success: false, error: 'Guild not found' });
        }
        
        const channel = guild.channels.cache.get(channelId);
        if (!channel) {
            return res.status(404).json({ success: false, error: 'Channel not found' });
        }
        
        // Check bot permissions
        const botMember = guild.members.cache.get(client.user.id);
        if (!botMember.permissions.has(PermissionFlagsBits.ManageRoles)) {
            return res.status(403).json({ 
                success: false, 
                error: 'Bot does not have Manage Roles permission' 
            });
        }
        
        // Validate all roles first
        for (const pair of pairs) {
            const role = guild.roles.cache.get(pair.roleId);
            if (!role) {
                return res.status(404).json({ 
                    success: false, 
                    error: `Role not found for emoji ${pair.emoji}` 
                });
            }
            
            // Check role hierarchy
            if (botMember.roles.highest.position <= role.position) {
                return res.status(403).json({ 
                    success: false, 
                    error: `Bot role must be higher than the role "${role.name}" to assign` 
                });
            }
        }
        
        let message;
        
        // Use existing message or create new one
        if (messageId) {
            try {
                message = await channel.messages.fetch(messageId);
            } catch (error) {
                return res.status(404).json({ 
                    success: false, 
                    error: 'Message not found. Please check the message ID.' 
                });
            }
        } else {
            // Create a new message with embed
            const rolesList = pairs.map(pair => {
                const role = guild.roles.cache.get(pair.roleId);
                return `${pair.emoji} - ${role.name}`;
            }).join('\n');
            
            const embed = new EmbedBuilder()
                .setColor('#0099ff')
                .setTitle('Reaction Roles')
                .setDescription(messageContent || `React with the emojis below to get roles:\n\n${rolesList}`)
                .setFooter({ text: 'React below to get your roles!' });
                
            message = await channel.send({ embeds: [embed] });
        }
        
        // Add all reactions
        for (const pair of pairs) {
            await message.react(pair.emoji);
            
            // Store reaction role data
            const key = `${message.id}_${pair.emoji}`;
            reactionRoles.set(key, [pair.roleId]);
            
            console.log(`Added reaction role: ${key} -> ${pair.roleId}`);
        }
        
        res.json({ 
            success: true, 
            message: 'Reaction roles created successfully',
            messageId: message.id
        });
    } catch (error) {
        console.error('Error creating reaction roles:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});


app.post('/api/reaction/remove', async (req, res) => {
    if (!req.isAuthenticated()) {
        return res.status(401).json({ success: false, error: 'Not authenticated' });
    }
    
    const { guildId, messageId, emoji } = req.body;
    
    try {
        const guild = client.guilds.cache.get(guildId);
        if (!guild) {
            return res.status(404).json({ success: false, error: 'Guild not found' });
        }
        
        // Check if user has permission to manage this server
        const userGuild = req.user.guilds.find(g => g.id === guildId);
        if (!userGuild || (userGuild.permissions & 0x20) !== 0x20) {
            return res.status(403).json({ success: false, error: 'You do not have permission to manage this server' });
        }
        
        const key = `${messageId}_${emoji}`;
        
        if (reactionRoles.has(key)) {
            // Try to find the message and remove the reaction
            try {
                // Find the channel that contains this message
                const channels = guild.channels.cache.filter(c => c.type === 0); // Text channels only
                
                for (const channel of channels.values()) {
                    try {
                        const message = await channel.messages.fetch(messageId);
                        if (message) {
                            // Try to remove the bot's reaction
                            const botReactions = message.reactions.cache.filter(reaction => 
                                reaction.emoji.name === emoji && reaction.me
                            );
                            
                            for (const reaction of botReactions.values()) {
                                await reaction.remove();
                            }
                            break;
                        }
                    } catch (error) {
                        // Message not in this channel, continue to next channel
                        continue;
                    }
                }
            } catch (error) {
                console.error('Error removing reaction:', error);
                // Continue anyway to remove from the map
            }
            
            // Remove from the reaction roles map
            reactionRoles.delete(key);
            
            res.json({ success: true, message: 'Reaction role removed successfully' });
        } else {
            res.status(404).json({ success: false, error: 'No reaction role found for that message and emoji' });
        }
    } catch (error) {
        console.error('Error removing reaction role:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ==============================================
// HTML Templates
// ==============================================

// Create views directory structure and templates
// views/layout.ejs

// ==============================================
// Setup Instructions & Additional Files
// ==============================================

// Create the following directory structure in your project:
/*
project/
├── package.json
├── .env
├── index.js
├── views/
│   ├── index.ejs
│   ├── login.ejs
│   ├── dashboard.ejs
│   └── server.ejs
└── public/
    └── (static files - optional)
*/

// Installation & Setup Instructions:
/*
1. Create a new directory for your bot:
   mkdir discord-bot-manager
   cd discord-bot-manager

2. Initialize npm and install dependencies:
   npm init -y
   npm install discord.js@14.14.1 express express-session passport passport-discord @discordjs/voice ytdl-core youtube-search-api ffmpeg-static libsodium-wrappers dotenv ejs body-parser

3. Create the .env file with your bot credentials:
   DISCORD_TOKEN=your_bot_token_here
   DISCORD_CLIENT_ID=your_client_id_here
   DISCORD_CLIENT_SECRET=your_client_secret_here
   SESSION_SECRET=your_random_session_secret_here
   PORT=3000

4. Create the views directory and add the EJS templates above

5. Create Discord Application:
   - Go to https://discord.com/developers/applications
   - Create a new application
   - Go to Bot section and create a bot
   - Copy the token to your .env file
   - Go to OAuth2 section and copy Client ID and Client Secret
   - Add redirect URL: http://localhost:3000/auth/discord/callback

6. Invite the bot to your server:
   - Use this URL (replace YOUR_CLIENT_ID):
   https://discord.com/api/oauth2/authorize?client_id=YOUR_CLIENT_ID&permissions=8&scope=bot%20applications.commands

7. Start the bot:
   node index.js
   or
   npm run dev (if you have nodemon installed)

8. Access the web dashboard:
   http://localhost:3000
*/

// Bot Commands Available:
/*
Music Commands:
- /play <query> - Play a song from YouTube
- /skip - Skip the current song
- /stop - Stop music and clear queue
- /queue - Show the current music queue

Channel Management Commands:
- /createchannel <name> [type] [category] - Create a new channel
- /deletechannel <channel> - Delete a channel
- /lockdown - Lock the current channel
- /unlock - Unlock the current channel

Reaction Role Commands:
- /reactionrole <channel> <role> <emoji> [message] - Setup reaction roles
- /removereactionrole <messageid> <emoji> - Remove reaction role
*/

// Troubleshooting:
/*
Common Issues:
1. Bot not responding to commands:
   - Make sure the bot is online and has proper permissions
   - Check if slash commands are registered properly

2. Music not working:
   - Install ffmpeg on your system
   - Make sure the bot has voice channel permissions

3. Web dashboard not loading:
   - Check if all EJS templates are in the views folder
   - Verify your Discord OAuth2 settings

4. Permission errors:
   - Make sure the bot has Administrator permissions
   - Check role hierarchy in Discord server

5. Voice connection issues:
   - Install libsodium-wrappers and ffmpeg-static
   - Make sure voice channel permissions are correct
*/

// Security Notes:
/*
1. Never share your bot token publicly
2. Use environment variables for sensitive data
3. Add .env to your .gitignore file
4. Use proper permission checks for admin commands
5. Validate user input on web dashboard
*/

// Start the bot and web server


// Add this after your existing event handlers
client.on('guildMemberAdd', async (member) => {
    try {
        // Get the landing-zone channel by ID
        const welcomeChannel = member.guild.channels.cache.get('1376179921398796379');
        
        // If the channel doesn't exist, log an error and return
        if (!welcomeChannel) {
            console.error(`Welcome channel with ID 1376179921398796379 not found in guild ${member.guild.name}`);
            return;
        }
        
        // Create a welcome embed
        const welcomeEmbed = new EmbedBuilder()
            .setColor('#00ff00')
            .setTitle(`Welcome to ${member.guild.name}!`)
            .setDescription(`Hey ${member}, Selamat datang di Cristal Tavern`)
            .setThumbnail(member.user.displayAvatarURL({ dynamic: true }))
            .addFields(
                { name: 'Jumlah Member', value: `Kamu adalah member ke ${member.guild.memberCount} !`, inline: true },
                { name: 'Akun dibuat', value: `<t:${Math.floor(member.user.createdTimestamp / 1000)}:R>`, inline: true }
            )
            .setFooter({ text: 'Find your Gem, Shape your desteny!' })
            .setTimestamp();
        
        // Send the welcome message
        await welcomeChannel.send({ embeds: [welcomeEmbed] });
        
        console.log(`Sent welcome message for ${member.user.tag} in channel #landing-zone`);
    } catch (error) {
        console.error('Error sending welcome message:', error);
    }
});



// ... existing code ...

// Add this function to your code
function sendLogMessage(guild, title, description, color = '#5865F2') {
    // Find a logging channel
    const logChannel = guild.channels.cache.find(
        channel => channel.name === 'logs' || channel.name === 'bot-logs' || channel.name === 'mod-logs'
    );
    
    if (!logChannel) return;
    
    const logEmbed = new EmbedBuilder()
        .setColor(color)
        .setTitle(title)
        .setDescription(description)
        .setTimestamp();
    
    logChannel.send({ embeds: [logEmbed] });
}

// Add these event listeners
client.on('channelCreate', channel => {
    if (!channel.guild) return;
    sendLogMessage(
        channel.guild,
        'Channel Created',
        `Name: ${channel.name}\nType: ${channel.type}\nID: ${channel.id}`,
        '#00FF00'
    );
});

client.on('channelDelete', channel => {
    if (!channel.guild) return;
    sendLogMessage(
        channel.guild,
        'Channel Deleted',
        `Name: ${channel.name}\nType: ${channel.type}\nID: ${channel.id}`,
        '#FF0000'
    );
});

client.on('guildMemberRemove', member => {
    sendLogMessage(
        member.guild,
        'Member Left',
        `User: ${member.user.tag}\nID: ${member.id}\nJoined At: ${member.joinedAt ? member.joinedAt.toLocaleDateString() : 'Unknown'}`,
        '#FF0000'
    );
});


client.login(process.env.DISCORD_TOKEN);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Web server running on port ${PORT}`);
    console.log(`Dashboard: http://localhost:${PORT}`);
});