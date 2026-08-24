require('dotenv').config();

const {
    Client,
    GatewayIntentBits,
    SlashCommandBuilder,
    REST,
    Routes,
    PermissionsBitField,
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle
} = require('discord.js');

const OWNER_ID = '691777591635607582';
const OCR_API_KEY = process.env.OCR_API_KEY || 'K85089640188957';
console.log('[OCR DEBUG] Clé OCR utilisée:', OCR_API_KEY === 'K85089640188957' && !process.env.OCR_API_KEY ? 'Clé en dur dans le code (fallback)' : `Clé perso chargée (se termine par ...${OCR_API_KEY.slice(-4)})`);

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers
    ]
});

const commandLogs = [];

function addLog(user, command, details = "") {
    if (command.toLowerCase() === '+log') return;

    const logEntry = {
        timestamp: new Date(),
        user: `${user.tag} (${user.id})`,
        command: command,
        details: details
    };
    commandLogs.unshift(logEntry);
    if (commandLogs.length > 30) commandLogs.pop();
}

// Vérifie que le membre a un rôle au moins aussi haut que le rôle le plus
// haut du bot (hiérarchie de rôles Discord). Le propriétaire du serveur et
// l'OWNER_ID défini plus haut passent toujours cette vérification.
function hasRoleAtLeastAsHighAsBot(message) {
    const member = message.member;
    const guild = message.guild;
    if (!member || !guild) return false;

    if (member.id === OWNER_ID) return true;
    if (member.id === guild.ownerId) return true;

    const botMember = guild.members.me;
    if (!botMember) return false;

    return member.roles.highest.position >= botMember.roles.highest.position;
}

// Combine la vérification de permission Discord classique avec la
// vérification de hiérarchie de rôle par rapport au bot. Envoie un message
// d'erreur adapté et retourne false si l'une des deux conditions échoue.
async function canSanction(message, permissionFlag) {
    if (permissionFlag && !message.member.permissions.has(permissionFlag)) {
        await message.reply("❌ Pas la permission");
        return false;
    }
    if (!hasRoleAtLeastAsHighAsBot(message)) {
        await message.reply("❌ Ton rôle doit être égal ou supérieur au rôle du bot pour utiliser cette commande");
        return false;
    }
    return true;
}

const phrasesRandom = [
    "Ntm fdp",
    "t sah tu fais le mec fdp ?",
    "tu parle trop mashaa allah",
    "une vrai k7heb toi enft",
    "kys",
    "nigger",
    "ftc un peu sale hmar de merde ?",
    "ta rater ta vie",
    "suicide toi",
    "quitte le serv",
    "niklekomok",
    "jvais te dox tmrlp",
];

const warns = new Map();

// Compteurs séparés pour chaque mot interdit (prénoms)
const forbiddenCounters = {
    zohra: new Map(),
    mounia: new Map()
};

const FORBIDDEN_TIMEOUTS = [60 * 1000, 10 * 60 * 1000, 60 * 60 * 1000]; // 1min, 10min, 1h
const DM_WARNING = "Tu as utilisé un mot interdit sur le serveur.";



// Distance de Levenshtein (nombre de modifications pour passer d'un mot à l'autre)
function levenshtein(a, b) {
    const m = a.length, n = b.length;
    const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
    for (let i = 0; i <= m; i++) dp[i][0] = i;
    for (let j = 0; j <= n; j++) dp[0][j] = j;
    for (let i = 1; i <= m; i++) {
        for (let j = 1; j <= n; j++) {
            if (a[i - 1] === b[j - 1]) {
                dp[i][j] = dp[i - 1][j - 1];
            } else {
                dp[i][j] = 1 + Math.min(
                    dp[i - 1][j],     // suppression
                    dp[i][j - 1],     // insertion
                    dp[i - 1][j - 1]  // substitution
                );
            }
        }
    }
    return dp[m][n];
}

// Petites capitales (bloc IPA Extensions), pas couvertes par la
// normalisation NFKD standard -> équivalent latin normal
const SMALL_CAPS_MAP = {
    'ᴀ':'a','ʙ':'b','ᴄ':'c','ᴅ':'d','ᴇ':'e','ꜰ':'f','ɢ':'g','ʜ':'h','ɪ':'i',
    'ᴊ':'j','ᴋ':'k','ʟ':'l','ᴍ':'m','ɴ':'n','ᴏ':'o','ᴘ':'p','ǫ':'q','ʀ':'r',
    'ꜱ':'s','ᴛ':'t','ᴜ':'u','ᴠ':'v','ᴡ':'w','ʏ':'y','ᴢ':'z'
};

// Lettres cyrilliques/grecques qui ressemblent visuellement à des lettres
// latines (technique de contournement courante) -> équivalent latin
const HOMOGLYPH_MAP = {
    'а':'a','е':'e','о':'o','р':'p','с':'c','у':'y','х':'x','і':'i','ѕ':'s',
    'А':'a','Е':'e','О':'o','Р':'p','С':'c','У':'y','Х':'x','І':'i',
    'α':'a','ο':'o','ρ':'p','υ':'y','ι':'i','ν':'n','κ':'k',
};

// Convertit le texte écrit avec des polices Unicode stylisées (gras,
// italique, script, fraktur, double-struck, sans-serif, monospace,
// fullwidth, cercles, petites capitales...) en lettres latines normales,
// afin qu'aucune "police" ne permette de contourner le filtre.
function normalizeStyledText(text) {
    let mapped = '';
    for (const ch of text) {
        if (SMALL_CAPS_MAP[ch]) { mapped += SMALL_CAPS_MAP[ch]; continue; }
        if (HOMOGLYPH_MAP[ch]) { mapped += HOMOGLYPH_MAP[ch]; continue; }
        mapped += ch;
    }
    // NFKD décompose les polices mathématiques Unicode et les variantes de
    // compatibilité (fullwidth, cercles...) vers leur lettre latine de base
    return mapped.normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
}

// Compresse les lettres répétées consécutivement (zoooohra -> zohra,
// zzzzzzzohhrrraaaa -> zohra) pour démasquer le spam de caractères.
function collapseRepeatedChars(text) {
    return text.replace(/([a-zà-üA-ZÀ-Ü])\1+/g, '$1');
}

// Recolle les séquences de lettres/petits blocs séparés par des espaces ou
// séparateurs (Z O H R A / Z-O-H-R-A / Z O HHRA / Z.O.H.R.A...) pour
// démasquer les tentatives de contournement par espacement.
function collapseSpacedLetters(text) {
    // Uniformise les séparateurs courants (. - _ *) en espaces
    let normalized = text.replace(/[._\-*]+/g, ' ');

    // Recolle les suites d'au moins 3 blocs courts (1 à 4 caractères)
    // séparés par des espaces, ex: "z o h r a" -> "zohra", "z o hhra" -> "zohhra"
    normalized = normalized.replace(
        /\b(?:[a-zà-üA-ZÀ-Ü]{1,4}[ \t]+){2,}[a-zà-üA-ZÀ-Ü]{1,4}\b/g,
        (match) => match.replace(/\s+/g, '')
    );

    return normalized;
}

// Cherche si un mot du message est une déviation proche d'un prénom interdit
// (fautes de frappe, lettres doublées/manquantes, permutations légères,
// ou lettres espacées type "Z O H R A")
function findFuzzyMatch(rawContent, target) {
    const content = collapseSpacedLetters(normalizeStyledText(rawContent));
    const words = content
        .toLowerCase()
        .replace(/[^a-zàâäéèêëïîôöùûüç\s]/gi, ' ')
        .split(/\s+/)
        .filter(Boolean);

    for (const rawWord of words) {
        // On teste le mot tel quel ET sa version compressée (lettres
        // répétées réduites), pour attraper "zoooohra" / "zzohhrraaa"
        // sans casser la détection sur les mots normaux.
        const candidates = new Set([rawWord, collapseRepeatedChars(rawWord)]);

        for (const word of candidates) {
            if (word.length < target.length - 2 || word.length > target.length + 3) continue;
            const distance = levenshtein(word, target);
            // Tolérance : ~1 modif pour les mots courts, un peu plus pour les longs
            const threshold = target.length <= 5 ? 1 : 2;
            if (distance <= threshold) {
                return rawWord;
            }
        }
    }
    return null;
}

// Applique la sanction (delete, timeout, DM, annonce) pour un mot interdit détecté
async function sanctionForbiddenWord(message, target, matchedWord) {
    try {
        await message.delete();
    } catch (err) {
        console.error(err);
    }

    const counterMap = forbiddenCounters[target];
    const currentCount = counterMap.get(message.author.id) || 0;
    const timeoutIndex = currentCount % FORBIDDEN_TIMEOUTS.length;
    const timeoutDuration = FORBIDDEN_TIMEOUTS[timeoutIndex];

    try {
        const member = await message.guild.members.fetch(message.author.id);
        if (member.moderatable) {
            await member.timeout(timeoutDuration, `Mot interdit (variante de "${target}") : ${matchedWord}`);
        }
    } catch (err) {
        console.error(err);
    }

    counterMap.set(message.author.id, currentCount + 1);

    // DM d'avertissement
    try {
        await message.author.send(DM_WARNING);
    } catch (err) {
        console.error(err);
    }

    const durationLabel = timeoutIndex === 0 ? "1 minute" : timeoutIndex === 1 ? "10 minutes" : "1 heure";
    message.channel.send(`⛔ ${message.author} a été mute ${durationLabel} pour avoir utilisé un mot interdit.`)
        .then(msg => setTimeout(() => msg.delete().catch(() => {}), 5000));
}

// Vérifie un texte (message ou OCR) contre tous les mots interdits.
// Retourne true si une sanction a été appliquée.
async function checkForbiddenText(message, text) {
    for (const target of Object.keys(forbiddenCounters)) {
        const matchedWord = findFuzzyMatch(text, target);
        if (!matchedWord) continue;
        await sanctionForbiddenWord(message, target, matchedWord);
        return true;
    }
    return false;
}

// Fait l'OCR sur une image (URL) via l'API OCR.space et renvoie le texte détecté
async function extractTextFromImage(url) {
    // On télécharge l'image nous-mêmes (rapide, CDN Discord) plutôt que de
    // laisser OCR.space aller la chercher (source fréquente de lenteurs/timeouts)
    let base64Image;
    try {
        const imgResponse = await fetch(url);
        const arrayBuffer = await imgResponse.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);
        const contentType = imgResponse.headers.get('content-type') || 'image/png';
        base64Image = `data:${contentType};base64,${buffer.toString('base64')}`;
    } catch (err) {
        console.error('[OCR DEBUG] Échec téléchargement image:', err.message);
        return '';
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 25000);

    let response;
    try {
        response = await fetch('https://api.ocr.space/parse/image', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                apikey: OCR_API_KEY,
                base64Image: base64Image,
                language: 'fre',
                OCREngine: '1'
            }),
            signal: controller.signal
        });
    } catch (err) {
        console.error('[OCR DEBUG] Requête OCR annulée/échouée (timeout ou réseau):', err.message);
        return '';
    } finally {
        clearTimeout(timeoutId);
    }

    const data = await response.json();

    console.log('[OCR DEBUG] Réponse brute:', JSON.stringify(data));

    if (data.IsErroredOnProcessing) {
        console.error('[OCR DEBUG] Erreur OCR.space:', data.ErrorMessage);
        return '';
    }

    const parsedText = data.ParsedResults?.[0]?.ParsedText || '';
    console.log('[OCR DEBUG] Texte détecté:', JSON.stringify(parsedText));
    return parsedText;
}

client.once('ready', () => {
    console.log(`✅ Connecté en tant que ${client.user.tag}`);
});

client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return;

    const { commandName } = interaction;
    addLog(interaction.user, `/${commandName}`, "Slash command");

    if (commandName === 'anon') {
        const message = interaction.options.getString('message');
        await interaction.reply({ content: "✅ Message envoyé anonymement", ephemeral: true });
        return interaction.channel.send(message);
    }

    if (commandName === 'supp') {
        const amount = interaction.options.getInteger('nombre');
        if (amount < 1 || amount > 100) {
            return interaction.reply({ content: "❌ Entre 1 et 100 messages", ephemeral: true });
        }
        try {
            await interaction.channel.bulkDelete(amount, true);
            return interaction.reply({ content: `🧹 ${amount} messages supprimés`, ephemeral: true });
        } catch (err) {
            console.error(err);
            return interaction.reply({ content: "❌ Erreur suppression messages", ephemeral: true });
        }
    }

    if (commandName === 'dm') {
        if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
            return interaction.reply({ content: "❌ Pas la permission.", ephemeral: true });
        }

        const targetInput = interaction.options.getString('target');
        let dmMessage = interaction.options.getString('message');

        let user;
        if (/^\d+$/.test(targetInput)) {
            user = await client.users.fetch(targetInput).catch(() => null);
        } else {
            const mentionMatch = targetInput.match(/<@!?(\d+)>/);
            if (mentionMatch) {
                user = await client.users.fetch(mentionMatch[1]).catch(() => null);
            }
        }

        if (!user) {
            return interaction.reply({ content: "❌ Impossible de trouver cet utilisateur.", ephemeral: true });
        }

        try {
            await user.send(dmMessage);
            await interaction.reply({
                content: `✅ Message envoyé en DM à **${user.tag}** (${user.id})`,
                ephemeral: true
            });
        } catch (err) {
            console.error(err);
            await interaction.reply({
                content: "❌ Impossible d'envoyer le DM (MP probablement fermés).",
                ephemeral: true
            });
        }
    }

    if (commandName === 'dmall') {
        if (interaction.user.id !== OWNER_ID) {
            return interaction.reply({
                content: "❌ Tu n'as pas la permission d'utiliser cette commande.",
                ephemeral: true
            });
        }

        const dmMessage = interaction.options.getString('message');

        await interaction.deferReply({ ephemeral: true });

        const guild = interaction.guild;
        const members = await guild.members.fetch();

        let success = 0;
        let failed = 0;

        for (const [id, member] of members) {
            if (member.user.bot) continue;

            try {
                await member.send(dmMessage);
                success++;
            } catch (err) {
                failed++;
            }

            await new Promise(resolve => setTimeout(resolve, 800));
        }

        await interaction.editReply(
            `✅ Message envoyé à **${success}** membres.\n❌ Échec pour **${failed}** membres (DMs fermés ou autre).`
        );
    }
});

client.on('messageCreate', async (message) => {
    if (message.author.bot) return;

    const args = message.content.split(' ');
    const cmd = args[0].toLowerCase();
    const content = message.content.toLowerCase();

    if (cmd.startsWith('+') && cmd !== '+log') {
        addLog(message.author, cmd, args.slice(1).join(' '));
    }

    const chance = Math.floor(Math.random() * 60);
    if (chance === 0) {
        const randomPhrase = phrasesRandom[Math.floor(Math.random() * phrasesRandom.length)];
        return message.reply(randomPhrase);
    }

    if (cmd === '+help') {
        const embed = new EmbedBuilder()
            .setTitle("📌 Help Menu")
            .setColor(0x00AEFF)
            .setDescription(`
**Commandes :**

+help
+kick @user
+ban @user
+unban <userId>
+mute @user (10 min)
+unmute @user
+warn @user raison
+warns @user
+clearwarn @user
+log
/anon <message>
/supp <nombre>
/dm <target> <message>
/dmall <message> (réservé au propriétaire)
            `);
        return message.reply({ embeds: [embed] });
    }

    if (cmd === '+log') {
        if (!message.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
            return message.reply("❌ Pas la permission");
        }

        if (commandLogs.length === 0) {
            return message.reply("📭 Aucun log pour le moment.");
        }

        let page = 0;
        const logsPerPage = 5;

        const generateEmbed = (page) => {
            const embed = new EmbedBuilder()
                .setTitle(`📜 Dernières Commandes - Page ${page + 1}/${Math.ceil(commandLogs.length / logsPerPage)}`)
                .setColor(0x00FFAA)
                .setTimestamp();

            let desc = "";
            const start = page * logsPerPage;
            const end = Math.min(start + logsPerPage, commandLogs.length);

            for (let i = start; i < end; i++) {
                const log = commandLogs[i];
                const time = log.timestamp.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
                desc += `**${i+1}.** \`${log.command}\` | ${log.user}\n`;
                if (log.details) desc += `> ${log.details}\n`;
                desc += `> ⏰ ${time}\n\n`;
            }

            embed.setDescription(desc || "Aucune commande.");
            return embed;
        };

        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId('prev')
                .setLabel('◀ Précédent')
                .setStyle(ButtonStyle.Primary)
                .setDisabled(true),
            new ButtonBuilder()
                .setCustomId('next')
                .setLabel('Suivant ▶')
                .setStyle(ButtonStyle.Primary)
                .setDisabled(commandLogs.length <= logsPerPage)
        );

        const msg = await message.reply({
            embeds: [generateEmbed(0)],
            components: [row]
        });

        const collector = msg.createMessageComponentCollector({
            time: 60000
        });

        collector.on('collect', async i => {
            if (i.user.id !== message.author.id) {
                return i.reply({ content: "❌ Ce n'est pas ton log.", ephemeral: true });
            }

            if (i.customId === 'prev') page--;
            else if (i.customId === 'next') page++;

            const newRow = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId('prev')
                    .setLabel('◀ Précédent')
                    .setStyle(ButtonStyle.Primary)
                    .setDisabled(page === 0),
                new ButtonBuilder()
                    .setCustomId('next')
                    .setLabel('Suivant ▶')
                    .setStyle(ButtonStyle.Primary)
                    .setDisabled((page + 1) * logsPerPage >= commandLogs.length)
            );

            await i.update({
                embeds: [generateEmbed(page)],
                components: [newRow]
            });
        });

        collector.on('end', () => {
            msg.edit({ components: [] }).catch(() => {});
        });

        return;
    }

    if (cmd === '+kick') {
        if (!(await canSanction(message, PermissionsBitField.Flags.KickMembers))) return;
        const user = message.mentions.users.first();
        if (!user) return message.reply("❌ Mentionne un utilisateur");
        const member = await message.guild.members.fetch(user.id);
        if (!member.kickable) return message.reply("❌ Je ne peux pas kick ce membre");
        await member.kick();
        return message.reply(`${user.tag} expulsé`);
    }

    if (cmd === '+ban') {
        if (!(await canSanction(message, PermissionsBitField.Flags.BanMembers))) return;
        const user = message.mentions.users.first();
        if (!user) return message.reply("❌ Mentionne un utilisateur");
        const member = await message.guild.members.fetch(user.id);
        if (!member.bannable) return message.reply("❌ Je ne peux pas ban ce membre");
        await member.ban();
        return message.reply(`${user.tag} banni`);
    }

    if (cmd === '+unban') {
        if (!(await canSanction(message, PermissionsBitField.Flags.BanMembers))) return;
        const userId = args[1];
        if (!userId) return message.reply("❌ Donne un ID utilisateur");
        await message.guild.bans.remove(userId);
        return message.reply(`✅ Utilisateur débanni`);
    }

    if (cmd === '+mute') {
        if (!(await canSanction(message, PermissionsBitField.Flags.ModerateMembers))) return;
        const user = message.mentions.users.first();
        if (!user) return message.reply("❌ Mentionne un utilisateur");
        const member = await message.guild.members.fetch(user.id);
        if (!member.moderatable) return message.reply("❌ Je ne peux pas mute ce membre");
        await member.timeout(10 * 60 * 1000, "Mute 10 minutes");
        return message.reply(`${user.tag} mute 10 minutes`);
    }

    if (cmd === '+unmute') {
        if (!(await canSanction(message, PermissionsBitField.Flags.ModerateMembers))) return;
        const user = message.mentions.users.first();
        if (!user) return message.reply("❌ Mentionne un utilisateur");
        const member = await message.guild.members.fetch(user.id);
        await member.timeout(null);
        return message.reply(`${user.tag} unmute`);
    }

    if (cmd === '+warn') {
        if (!(await canSanction(message, PermissionsBitField.Flags.ModerateMembers))) return;
        const user = message.mentions.users.first();
        if (!user) return message.reply("❌ Mentionne un utilisateur");
        const reason = args.slice(2).join(' ') || "Aucune raison";

        if (!warns.has(user.id)) warns.set(user.id, []);
        const userWarns = warns.get(user.id);
        userWarns.push(reason);

        const member = await message.guild.members.fetch(user.id);

        if (userWarns.length >= 3) {
            if (!member.moderatable) return message.reply("❌ Je ne peux pas mute ce membre");
            try {
                await member.timeout(30 * 60 * 1000, "3 warns atteints");
                warns.set(user.id, []);
                return message.reply(`🔇 ${user.tag} a atteint 3 warns → mute 30 minutes + reset`);
            } catch (err) {
                console.error(err);
                return message.reply("❌ Erreur lors du mute");
            }
        }
        return message.reply(`⚠️ ${user.tag} warn (${userWarns.length}/3) : ${reason}`);
    }

    if (cmd === '+warns') {
        const user = message.mentions.users.first();
        if (!user) return message.reply("❌ Mentionne un utilisateur");
        const userWarns = warns.get(user.id) || [];
        return message.reply(`⚠️ Warns de ${user.tag} : ${userWarns.length}/3\n${userWarns.length ? userWarns.join('\n') : "Aucun warn"}`);
    }

    if (cmd === '+clearwarn') {
        if (!(await canSanction(message, PermissionsBitField.Flags.ModerateMembers))) return;
        const user = message.mentions.users.first();
        if (!user) return message.reply("❌ Mentionne un utilisateur");
        warns.delete(user.id);
        return message.reply(`🧹 Warns supprimés pour ${user.tag}`);
    }

    // Vérification du texte du message
    const handledInText = await checkForbiddenText(message, content);
    if (handledInText) return;

    // Vérification des images jointes (OCR)
    const imageAttachments = message.attachments.filter(att =>
        att.contentType && att.contentType.startsWith('image/')
    );

    if (imageAttachments.size > 0) {
        console.log(`[OCR DEBUG] ${imageAttachments.size} image(s) détectée(s) dans le message de ${message.author.tag}`);
    }

    for (const [, attachment] of imageAttachments) {
        try {
            const extractedText = await extractTextFromImage(attachment.url);
            const handledInImage = await checkForbiddenText(message, extractedText.toLowerCase());
            if (handledInImage) break;
        } catch (err) {
            console.error('[OCR DEBUG] Erreur OCR:', err);
        }
    }
});

const commands = [
    new SlashCommandBuilder()
        .setName('anon')
        .setDescription('Envoyer un message anonymement')
        .addStringOption(o => o.setName('message').setDescription('Ton message').setRequired(true)),

    new SlashCommandBuilder()
        .setName('supp')
        .setDescription('Supprimer des messages')
        .addIntegerOption(o => o.setName('nombre').setDescription('Nombre (1-100)').setRequired(true)),

    new SlashCommandBuilder()
        .setName('dm')
        .setDescription('Envoyer un DM caché')
        .addStringOption(o => o.setName('target').setDescription('Mention ou ID').setRequired(true))
        .addStringOption(o => o.setName('message').setDescription('Message à envoyer').setRequired(true)),

    new SlashCommandBuilder()
        .setName('dmall')
        .setDescription('Envoyer un DM à tous les membres du serveur')
        .addStringOption(o => o.setName('message').setDescription('Message à envoyer').setRequired(true)),
].map(cmd => cmd.toJSON());

const rest = new REST({ version: '10' }).setToken(process.env.TOKEN);

(async () => {
    try {
        console.log('🔄 Déploiement des commandes...');
        await rest.put(
            Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID),
            { body: commands }
        );
        console.log('✅ Commandes slash déployées');
    } catch (err) {
        console.error('❌ Erreur déploiement:', err);
    }
})();

client.login(process.env.TOKEN);
