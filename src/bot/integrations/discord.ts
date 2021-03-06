// 3rdparty libraries
import chalk from 'chalk';
import { get } from 'lodash';
import * as DiscordJs from 'discord.js';

// bot libraries
import Integration from './_interface';
import { command, settings, ui } from '../decorators';
import { onChange, onStartup, onStreamEnd, onStreamStart } from '../decorators/on';
import { chatIn, chatOut, debug, error, info, warning, whisperOut } from '../helpers/log';
import { adminEndpoint } from '../helpers/socket';
import { debounce } from '../helpers/debounce';

import { v5 as uuidv5 } from 'uuid';
import oauth from '../oauth';
import Expects from '../expects';
import { isUUID } from '../commons';

import { getRepository, IsNull, LessThan, Not } from 'typeorm';
import { Permissions as PermissionsEntity } from '../database/entity/permissions';
import { DiscordLink } from '../database/entity/discord';
import { User } from '../database/entity/user';
import { HOUR, MINUTE } from '../constants';
import Parser from '../parser';
import { Message } from '../message';
import api from '../api';
import moment from 'moment';
import general from '../general';
import { isDbConnected } from '../helpers/database';
import permissions from '../permissions';

const timezone = (process.env.TIMEZONE ?? 'system') === 'system' || !process.env.TIMEZONE ? moment.tz.guess() : process.env.TIMEZONE;

class Discord extends Integration {
  client: DiscordJs.Client | null = null;

  embed: DiscordJs.MessageEmbed | null = null;
  embedMessage: DiscordJs.Message | null = null;
  embedStartedAt = '';

  @settings('general')
  @ui({ type: 'text-input', secret: true })
  clientId = '';

  @settings('general')
  @ui({ type: 'text-input', secret: true })
  token = '';

  @ui({
    type: 'btn-emit',
    class: 'btn btn-primary btn-block mt-1 mb-1',
    if: () => self.clientId.length > 0 && self.token.length > 0,
    emit: 'discord::authorize',
  }, 'general')
  joinToServerBtn = null;

  @ui({
    type: 'btn-emit',
    class: 'btn btn-primary btn-block mt-1 mb-1',
    if: () => self.clientId.length === 0 || self.token.length === 0,
  }, 'general')
  cannotJoinToServerBtn = null;

  @settings('bot')
  @ui({
    type: 'discord-guild',
    if: () => self.clientId.length > 0 && self.token.length > 0,
  })
  guild = '';

  @ui({
    if: () => self.clientId.length > 0 && self.guild.length === 0,
    type: 'helpbox',
    variant: 'info',
  }, 'bot')
  noGuildSelectedBox = null;

  @settings('bot')
  @ui({
    type: 'discord-channel',
    if: () => self.guild.length > 0,
  })
  listenAtChannels = '';

  @settings('bot')
  @ui({
    type: 'discord-channel',
    if: () => self.guild.length > 0,
  })
  sendOnlineAnnounceToChannel = '';

  @settings('bot')
  @ui({
    type: 'discord-channel',
    if: () => self.guild.length > 0,
  })
  sendGeneralAnnounceToChannel = '';

  @settings('mapping')
  @ui({
    type: 'discord-mapping',
    if: () => self.guild.length > 0,
  })
  rolesMapping: { [permissionId: string]: string } = {};

  @settings('bot')
  @ui({
    type: 'toggle-enable',
    if: () => self.guild.length > 0,
  })
  deleteMessagesAfterWhile = false;

  constructor() {
    super();

    // embed updater
    setInterval(() => {
      if (this.embed && this.embedMessage && api.isStreamOnline) {
        this.embed.spliceFields(0, this.embed.fields.length);
        this.embed.addFields([
          { name: 'Now Playing', value: api.stats.currentGame},
          { name: 'Stream Title', value: api.stats.currentTitle},
          { name: 'Started At', value: this.embedStartedAt, inline: true},
          { name: 'Total Views', value: api.stats.currentViews, inline: true},
          { name: 'Followers', value: api.stats.currentFollowers, inline: true},
        ]);
        this.embed.setImage(`https://static-cdn.jtvnw.net/previews-ttv/live_user_${oauth.broadcasterUsername}-1920x1080.jpg?${Date.now()}`);

        if (oauth.broadcasterType !== '') {
          this.embed.addField('Subscribers', api.stats.currentSubscribers, true);
        }
        this.embedMessage.edit(this.embed);
      }
    }, MINUTE * 10);

    setInterval(() => this.updateRolesOfLinkedUsers(), HOUR);
  }

  async updateRolesOfLinkedUsers() {
    if (!isDbConnected || !this.client) {
      return;
    }

    // go through mappings and delete zombies
    for (const mapped of Object.keys(this.rolesMapping)) {
      const doesPermissionExist = typeof (await permissions.get(mapped)) !== 'undefined';
      if (!doesPermissionExist || this.rolesMapping[mapped] === '') {
        // delete permission if doesn't exist anymore
        delete this.rolesMapping[mapped];
        continue;
      }
    }

    const linkedUsers = await getRepository(DiscordLink).find();
    for (const user of linkedUsers) {
      if (!user.userId) {
        continue;
      }
      const guild = this.client.guilds.cache.get(this.guild);
      if (!guild) {
        return warning('No servers found for discord');
      }
      const discordUser = guild.member(await guild.members.fetch(user.discordId));
      if (!discordUser) {
        warning('Discord user not found');
        continue;
      }
      const botPermissionsSortedByPriority = await getRepository(PermissionsEntity).find({
        relations: ['filters'],
        order: {
          order: 'ASC',
        },
      });

      const alreadyAssignedRoles: string[] = [];
      for (const botPermission of botPermissionsSortedByPriority) {
        if (!this.rolesMapping[botPermission.id]) {
          debug('discord.roles', `Permission ${botPermission.name}#${botPermission.id} is not mapped.`);
          // we don't have mapping set for this permission
          continue;
        }

        // role was already assigned by higher permission (we don't want to remove it)
        // e.g. Ee have same role for Subscriber and VIP
        //      User is subscriber but not VIP -> should have role
        if (alreadyAssignedRoles.includes(this.rolesMapping[botPermission.id])) {
          debug('discord.roles', `Role ${this.rolesMapping[botPermission.id]} is already mapped for user ${user.userId}`);
          continue;
        }

        const haveUserAnAccess = (await permissions.check(user.userId, botPermission.id, true)).access;
        const role = await guild.roles.fetch(this.rolesMapping[botPermission.id]);
        if (!role) {
          warning(`Role with ID ${this.rolesMapping[botPermission.id]} not found on your Discord Server`);
          continue;
        }
        debug('discord.roles', `User ${user.userId} - permission ${botPermission.id} - role ${role.name} - ${haveUserAnAccess}`);

        if (haveUserAnAccess) {
          // add role to user
          alreadyAssignedRoles.push(role.id);
          if (discordUser.roles.cache.has(role.id)) {
            debug('discord.roles', `User ${user.userId} already have role ${role.name}`);
          } else {
            discordUser.roles.add(role).catch(roleError => {
              warning('Cannot add role to user, check permission for bot (bot cannot set role above his own)');
              warning(roleError);
            }).then(member => {
              debug('discord.roles', `User ${user.userId} have new role ${role.name}`);
            });
          }
        } else {
          // remove role from user
          if (!discordUser.roles.cache.has(role.id)) {
            debug('discord.roles', `User ${user.userId} already doesn't have role ${role.name}`);
          } else {
            discordUser.roles.remove(role).catch(roleError => {
              warning('Cannot remove role to user, check permission for bot (bot cannot set role above his own)');
              warning(roleError);
            }).then(member => {
              debug('discord.roles', `User ${user.userId} have removed role ${role.name}`);
            });
          }
        }
      }
    }
  }

  @onStartup()
  @onChange('enabled')
  @onChange('token')
  async onStateChange(key: string, value: boolean) {
    if (await debounce(uuidv5('onStateChange', this.uuid), 1000)) {
      if (this.enabled && this.token.length > 0) {
        this.initClient();
        if (this.client) {
          this.client.login(this.token).catch((reason) => {
            error(chalk.bgRedBright('DISCORD') + ': ' + reason);
          });
        }
      } else {
        if (this.client) {
          this.client.destroy();
        }
      }
    }
  }

  removeExpiredLinks() {
    // remove expired links
    getRepository(DiscordLink).delete({
      userId: IsNull(), createdAt: LessThan(Date.now() - (MINUTE * 10)),
    });
  }

  @command('!unlink')
  async unlinkAccounts(opts: CommandOptions) {
    this.removeExpiredLinks();
    await getRepository(DiscordLink).delete({ userId: Number(opts.sender.userId) });
    return [{ response: '$sender, all links were deleted', ...opts }];
  }

  @command('!link')
  async linkAccounts(opts: CommandOptions) {
    enum errors { NOT_UUID }
    this.removeExpiredLinks();

    try {
      const [ uuid ] = new Expects(opts.parameters).everything({ name: 'uuid' }).toArray();
      if (!isUUID(uuid)) {
        throw new Error(String(errors.NOT_UUID));
      }

      const link = await getRepository(DiscordLink).findOneOrFail({ id: uuid });
      // link user
      await getRepository(DiscordLink).save({
        ...link, userId: opts.sender.userId,
      });
      return [{ response: `$sender, this account was linked with ${link.tag}.`, ...opts }];
    } catch (e) {
      if (e.message === String(errors.NOT_UUID)) {
        return [{ response: '$sender, invalid or expired token.', ...opts }];
      } else if (e.message.includes('Expected parameter')) {
        return [
          { response: '$sender, to link you account on Discord: 1. Go to Discord server and send !link in bot channel. | 2. Wait for PM from bot | 3. Send command from you Discord PM here in twitch chat.', ...opts },
        ];
      } else {
        warning(e.stack);
        return [{ response: '$sender, something went wrong.', ...opts }];
      }
    }
  }

  @onStreamEnd()
  updateStreamStartAnnounce() {
    if (this.embed && this.embedMessage) {
      this.embed.setColor(0xff0000);
      this.embed.setDescription(`${oauth.broadcasterUsername.charAt(0).toUpperCase() + oauth.broadcasterUsername.slice(1)} is not streaming anymore! Check it next time!`);
      this.embed.spliceFields(0, this.embed.fields.length);
      this.embed.addFields([
        { name: 'Now Playing', value: api.stats.currentGame},
        { name: 'Stream Title', value: api.stats.currentTitle},
        { name: 'Streamed At', value: `${this.embedStartedAt} - ${moment().tz(timezone).format('LLL')}`, inline: true},
        { name: 'Total Views', value: api.stats.currentViews, inline: true},
        { name: 'Followers', value: api.stats.currentFollowers, inline: true},
      ]);
      this.embed.setImage(`https://static-cdn.jtvnw.net/ttv-static/404_preview-1920x1080.jpg?${Date.now()}`);

      if (oauth.broadcasterType !== '') {
        this.embed.addField('Subscribers', api.stats.currentSubscribers, true);
      }
      this.embedMessage.edit(this.embed);
    }
    this.embed = null;
    this.embedMessage = null;
  }

  @onStreamStart()
  async sendStreamStartAnnounce() {
    moment.locale(general.lang); // set moment locale

    try {
      if (this.client && this.sendOnlineAnnounceToChannel.length > 0 && this.guild.length > 0) {
        const channel = this.client.guilds.cache.get(this.guild)?.channels.cache.get(this.sendOnlineAnnounceToChannel);
        if (!channel) {
          throw new Error(`Channel ${this.sendOnlineAnnounceToChannel} not found on your discord server`);
        }

        this.embedStartedAt = moment().tz(timezone).format('LLL');
        const embed = new DiscordJs.MessageEmbed()
          .setURL('https://twitch.tv/' + oauth.broadcasterUsername)
          .addFields([
            { name: 'Now Playing', value: api.stats.currentGame},
            { name: 'Stream Title', value: api.stats.currentTitle},
            { name: 'Started At', value: this.embedStartedAt, inline: true},
            { name: 'Total Views', value: api.stats.currentViews, inline: true},
            { name: 'Followers', value: api.stats.currentFollowers, inline: true},
          ])
          // Set the title of the field
          .setTitle('https://twitch.tv/' + oauth.broadcasterUsername)
          // Set the color of the embed
          .setColor(0x00ff00)
          // Set the main content of the embed
          .setDescription(`${oauth.broadcasterUsername.charAt(0).toUpperCase() + oauth.broadcasterUsername.slice(1)} started stream! Check it out!`)
          .setImage(`https://static-cdn.jtvnw.net/previews-ttv/live_user_${oauth.broadcasterUsername}-1920x1080.jpg?${Date.now()}`)
          .setThumbnail(oauth.profileImageUrl)
          .setFooter('Announced by sogeBot - https://www.sogebot.xyz');

        if (oauth.broadcasterType !== '') {
          embed.addField('Subscribers', api.stats.currentSubscribers, true);
        }
        // Send the embed to the same channel as the message
        this.embedMessage = await (channel as DiscordJs.TextChannel).send(embed);
        chatOut(`#${(channel as DiscordJs.TextChannel).name}: [[online announce embed]] [${this.client.user?.tag}]`);
        this.embed = embed;
      }
    } catch (e) {
      warning(e.stack);
    }
  }

  initClient() {
    if (!this.client) {
      this.client = new DiscordJs.Client({
        partials: ['REACTION', 'MESSAGE', 'CHANNEL'],
        ws: { intents: ['GUILD_MESSAGES', 'GUILDS'] },
      });
      this.client.on('ready', () => {
        if (this.client) {
          info(chalk.yellow('DISCORD: ') + `Logged in as ${get(this.client, 'user.tag', 'unknown')}!`);
        }
      });

      this.client.on('message', async (msg) => {
        if (this.client && this.guild) {
          if (msg.author.tag === get(this.client, 'user.tag', null)) {
            // don't do anything on self messages;
            return;
          }

          // don't listen discord DM messages and other guilds
          if (msg.channel.type === 'dm' || msg.guild?.id !== this.guild) {
            return;
          }

          const channels = this.listenAtChannels.split(',').map(o => o.trim());
          if (msg.channel.type === 'text' && channels.length > 0) {
            if (channels.includes(msg.channel.name) || channels.includes(msg.channel.id)) {
              this.message(msg.content, msg.channel, msg.author, msg);
            }
          }
        }
      });
    }
  }

  async message(content: string, channel: DiscordJsTextChannel, author: DiscordJsUser, msg?: DiscordJs.Message) {
    const channels = this.listenAtChannels.split(',').map(o => o.trim());
    chatIn(`#${channel.name}: ${content} [${author.tag}]`);
    if (msg) {
      if (content === '!link') {
        this.removeExpiredLinks();
        const link = await getRepository(DiscordLink).save({
          userId: null,
          tag: author.tag,
          discordId: author.id,
          createdAt: Date.now(),
        });
        author.send(`Hello ${msg.author.tag}, to link this Discord account with your Twitch account on ${oauth.broadcasterUsername} channel, go to https://twitch.tv/${oauth.broadcasterUsername}, login to your account and send this command to chat \n\n\t\t\`!link ${link.id}\`\n\nNOTE: This expires in 10 minutes.`);
        whisperOut(`${author.tag}: Hello ${author.tag}, to link this Discord account with your Twitch account on ${oauth.broadcasterUsername} channel, go to https://twitch.tv/${oauth.broadcasterUsername}, login to your account and send this command to chat \\n\\n\\t\\t\`!link ${link.id}\`\\n\\nNOTE: This expires in 10 minutes.`);

        const reply = await msg.reply('check your DMs for steps to link your account.');
        chatOut(`#${channel.name}: @${author.tag}, check your DMs for steps to link your account. [${msg.author.tag}]`);
        if (this.deleteMessagesAfterWhile) {
          setTimeout(() => {
            msg.delete();
            reply.delete();
          }, 10000);
        }
        return;
      } else if (content === '!unlink') {
        await getRepository(DiscordLink).delete({ tag: author.tag });
        msg.reply('all links were deleted');
        return;
      }
    }
    try {
      // get linked account
      const link = await getRepository(DiscordLink).findOneOrFail({ tag: author.tag, userId: Not(IsNull()) });
      if (link.userId) {
        const user = await getRepository(User).findOneOrFail({ userId: link.userId });
        const parser = new Parser();
        parser.started_at = (msg || { createdTimestamp: Date.now() }).createdTimestamp;
        parser.sender = {
          badges: {}, color: '',  displayName: '', emoteSets: [], emotes: [], userId: link.userId, username: user.username, userType: 'viewer',
          mod: 'false', subscriber: 'false', turbo: 'false', discord: { author, channel },
        };
        parser.message = content;
        parser.process().then(responses => {
          if (responses) {
            for (let i = 0; i < responses.length; i++) {
              setTimeout(async () => {
                if (channel.type === 'text' && channels.length > 0) {
                  const messageToSend = await new Message(await responses[i].response).parse({
                    ...responses[i].attr,
                    forceWithoutAt: true, // we dont need @
                    sender: { ...responses[i].sender, username: author },
                  }) as string;
                  const reply = await channel.send(messageToSend);
                  chatOut(`#${channel.name}: ${messageToSend} [${author.tag}]`);
                  if (this.deleteMessagesAfterWhile) {
                    setTimeout(() => {
                      reply.delete();
                    }, 10000);
                  }
                }
              }, 1000 * i);
            }
          }
          if (this.deleteMessagesAfterWhile) {
            if (msg) {
              setTimeout(() => {
                msg.delete();
              }, 10000);
            }
          }
        });
      }
    } catch (e) {
      const message = `your account is not linked, use \`!link\``;
      if (msg) {
        const reply = await msg.reply(message);
        chatOut(`#${channel.name}: @${author.tag}, ${message} [${author.tag}]`);
        if (this.deleteMessagesAfterWhile) {
          setTimeout(() => {
            msg.delete();
            reply.delete();
          }, 10000);
        }
      }
    }
  }

  sockets() {
    adminEndpoint(this.nsp, 'discord::getRoles', async (cb) => {
      try {
        if (this.client && this.guild) {
          return cb(null, this.client.guilds.cache.get(this.guild)?.roles.cache
            .sort((a, b) => {
              const nameA = a.name.toUpperCase(); // ignore upper and lowercase
              const nameB = b.name.toUpperCase(); // ignore upper and lowercase
              if (nameA < nameB) {
                return -1;
              }
              if (nameA > nameB) {
                return 1;
              }
              // names must be equal
              return 0;
            })
            .map(o => ({ html: `<strong>${o.name}</strong> &lt;${o.id}&gt;`, value: o.id }))
          );
        } else {
          cb(null, []);
        }
      } catch (e) {
        cb(e.message, []);
      }
    });
    adminEndpoint(this.nsp, 'discord::getGuilds', async (cb) => {
      try {
        if (this.client) {
          return cb(null, this.client.guilds.cache
            .sort((a, b) => {
              const nameA = a.name.toUpperCase(); // ignore upper and lowercase
              const nameB = b.name.toUpperCase(); // ignore upper and lowercase
              if (nameA < nameB) {
                return -1;
              }
              if (nameA > nameB) {
                return 1;
              }
              // names must be equal
              return 0;
            })
            .map(o => ({ html: `<strong>${o.name}</strong> &lt;${o.id}&gt;`, value: o.id })));
        } else {
          cb(null, []);
        }
      } catch (e) {
        cb(e.message, []);
      }
    });
    adminEndpoint(this.nsp, 'discord::getChannels', async (cb) => {
      try {
        if (this.client && this.guild) {
          cb(null, this.client.guilds.cache.get(this.guild)?.channels.cache
            .filter(o => o.type === 'text')
            .sort((a, b) => {
              const nameA = (a as DiscordJs.TextChannel).name.toUpperCase(); // ignore upper and lowercase
              const nameB = (b as DiscordJs.TextChannel).name.toUpperCase(); // ignore upper and lowercase
              if (nameA < nameB) {
                return -1;
              }
              if (nameA > nameB) {
                return 1;
              }
              // names must be equal
              return 0;
            })
            .map(o => ({ html: `<strong>#${(o as DiscordJs.TextChannel).name}</strong> &lt;${o.id}&gt;`, value: o.id }))
          );
        } else {
          cb(null, []);
        }
      } catch (e) {
        cb(e.stack, []);
      }
    });
    adminEndpoint(this.nsp, 'discord::authorize', async (cb) => {
      if (this.token === '' || this.clientId === '') {
        cb('Cannot authorize! Missing clientId or token.', null);
      } else {
        try {
          cb(null, { do: 'redirect', opts: [`https://discordapp.com/oauth2/authorize?&scope=bot&permissions=8&client_id=${this.clientId}`] });
        } catch (e) {
          error(e.stack);
          cb(e.stack, null);
        }
      }
    });
  }
}

const self = new Discord();
export default self;
