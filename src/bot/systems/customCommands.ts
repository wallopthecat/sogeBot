import _ from 'lodash';
import XRegExp from 'xregexp';
import safeEval from 'safe-eval';

import { command, default_permission, helper } from '../decorators';
import { permission } from '../permissions';
import System from './_interface';
import * as constants from '../constants';
import { parser } from '../decorators';
import Expects from '../expects';
import { getOwner, isBot, isBroadcaster, isModerator, isOwner, isSubscriber, isVIP, message, prepare, sendMessage } from '../commons';
import { getCountOfCommandUsage, incrementCountOfCommandUsage, resetCountOfCommandUsage } from '../helpers/commands/count';
import uuid from 'uuid';

import { chatOut } from '../helpers/log';
import { adminEndpoint } from '../helpers/socket';

/*
 * !command                                                                 - gets an info about command usage
 * !command add (-p [uuid|name]) ?-s true|false ![cmd] [response]           - add command with specified response
 * !command edit (-p [uuid|name]) ?-s true|false ![cmd] [number] [response] - edit command with specified response
 * !command remove ![cmd]                                                   - remove specified command
 * !command remove ![cmd] [number]                                          - remove specified response of command
 * !command toggle ![cmd]                                                   - enable/disable specified command
 * !command toggle-visibility ![cmd]                                        - enable/disable specified command
 * !command list                                                            - get commands list
 * !command list ![cmd]                                                     - get responses of command
 */

class CustomCommands extends System {
  constructor () {
    super();
    this.addMenu({ category: 'manage', name: 'customcommands', id: 'manage/commands' });
  }

  sockets () {
    adminEndpoint(this.nsp, 'find.commands', async (opts, cb) => {
      opts.collection = opts.collection || 'data';
      if (opts.collection.startsWith('_')) {
        opts.collection = opts.collection.replace('_', '');
      } else {
        opts.collection = this.collection[opts.collection];
      }

      opts.where = opts.where || {};

      const items: (Types.CustomCommands.Command & { responses?: Types.CustomCommands.Response[] })[] = await global.db.engine.find(opts.collection, opts.where);
      for (const i of items) {
        i.count = await getCountOfCommandUsage(i.command);
        i.responses = await global.db.engine.find(this.collection.responses, { cid: i.id });
      }
      if (_.isFunction(cb)) {
        cb(null, items);
      }
    });
    adminEndpoint(this.nsp, 'findOne.command', async (opts, cb) => {
      opts.collection = opts.collection || 'data';
      if (opts.collection.startsWith('_')) {
        opts.collection = opts.collection.replace('_', '');
      } else {
        opts.collection = this.collection[opts.collection];
      }

      opts.where = opts.where || {};

      const item: Types.CustomCommands.Command = await global.db.engine.findOne(opts.collection, opts.where);
      item.count = await getCountOfCommandUsage(item.command);
      const responses = await global.db.engine.find(this.collection.responses, { cid: item.id });
      if (_.isFunction(cb)) {
        cb(null, { responses, ...item });
      }
    });
    adminEndpoint(this.nsp, 'update.command', async (opts, cb) => {
      opts.collection = opts.collection || 'data';
      if (opts.collection.startsWith('_')) {
        opts.collection = opts.collection.replace('_', '');
      } else {
        opts.collection = this.collection[opts.collection];
      }

      if (opts.items) {
        for (const item of opts.items) {
          const id = item.id; delete item._id;
          const count = item.count; delete item.count;
          const responses = item.responses; delete item.responses;

          let itemFromDb = item;
          if (_.isNil(id)) {
            itemFromDb = await global.db.engine.insert(opts.collection, item);
          } else {
            await global.db.engine.update(opts.collection, { id }, item);
          }

          // set command count
          const cCount = await getCountOfCommandUsage(itemFromDb.command);
          if (count !== cCount && count === 0) {
            // we assume its always reset (set to 0)
            await resetCountOfCommandUsage(itemFromDb.command);
          }

          // update responses
          const rIds: any[] = [];
          for (const r of responses) {
            if (!r.cid) {
              r.cid = id || String(itemFromDb.id);
            }

            if (!r._id) {
              rIds.push(
                String((await global.db.engine.insert(this.collection.responses, r))._id)
              );
            } else {
              const _id = String(r._id); delete r._id;
              rIds.push(_id);
              await global.db.engine.update(this.collection.responses, { _id }, r);
            }
          }

          itemFromDb.id = id || String(itemFromDb.id);

          // remove responses
          for (const r of await global.db.engine.find(this.collection.responses, { cid: itemFromDb.id })) {
            if (!rIds.includes(String(r._id))) {
              await global.db.engine.remove(this.collection.responses, { _id: String(r._id) });
            }
          }

          if (_.isFunction(cb)) {
            cb(null, {
              command: itemFromDb,
              responses: await global.db.engine.find(this.collection.responses, { cid: itemFromDb.id }),
            });
          }
        }
      } else {
        if (_.isFunction(cb)) {
          cb(null, []);
        }
      }
    });
  }

  @command('!command')
  @default_permission(permission.CASTERS)
  @helper()
  main (opts: CommandOptions) {
    sendMessage(global.translate('core.usage') + ': !command add (-p [uuid|name]) (-s=true|false) <!cmd> <response> | !command edit (-p [uuid|name]) (-s=true|false) <!cmd> <number> <response> | !command remove <!command> | !command remove <!command> <number> | !command list | !command list <!command>', opts.sender, opts.attr);
  }

  @command('!command edit')
  @default_permission(permission.CASTERS)
  async edit (opts: CommandOptions) {
    try {
      const [userlevel, stopIfExecuted, command, rId, response] = new Expects(opts.parameters)
        .permission({ optional: true, default: permission.VIEWERS })
        .argument({ optional: true, name: 's', default: null, type: Boolean })
        .argument({ name: 'c', type: String, multi: true, delimiter: '' })
        .argument({ name: 'rid', type: Number })
        .argument({ name: 'r', type: String, multi: true, delimiter: '' })
        .toArray();

      if (!command.startsWith('!')) {
        throw Error('Command should start with !');
      }

      const cDb = await global.db.engine.findOne(this.collection.data, { command });
      if (!cDb.id) {
        return sendMessage(prepare('customcmds.command-was-not-found', { command }), opts.sender, opts.attr);
      }

      const rDb = await global.db.engine.findOne(this.collection.responses, { cid: cDb.id, order: rId - 1 });
      if (!rDb._id) {
        return sendMessage(prepare('customcmds.response-was-not-found', { command, response: rId }), opts.sender, opts.attr);
      }


      const pItem: Permissions.Item | null = await global.permissions.get(userlevel);
      if (!pItem) {
        throw Error('Permission ' + userlevel + ' not found.');
      }

      const _id = rDb._id; delete rDb._id;
      rDb.response = response;
      rDb.permission = pItem.id;
      if (stopIfExecuted) {
        rDb.stopIfExecuted = stopIfExecuted;
      }

      await global.db.engine.update(this.collection.responses, { _id }, rDb);
      sendMessage(prepare('customcmds.command-was-edited', { command, response }), opts.sender, opts.attr);
    } catch (e) {
      sendMessage(prepare('customcmds.commands-parse-failed'), opts.sender, opts.attr);
    }
  }

  @command('!command add')
  @default_permission(permission.CASTERS)
  async add (opts: CommandOptions) {
    try {
      const [userlevel, stopIfExecuted, command, response] = new Expects(opts.parameters)
        .permission({ optional: true, default: permission.VIEWERS })
        .argument({ optional: true, name: 's', default: false, type: Boolean })
        .argument({ name: 'c', type: String, multi: true, delimiter: '' })
        .argument({ name: 'r', type: String, multi: true, delimiter: '' })
        .toArray();

      if (!command.startsWith('!')) {
        throw Error('Command should start with !');
      }

      let cDb = await global.db.engine.findOne(this.collection.data, { command });
      if (!cDb.id) {
        cDb = await global.db.engine.insert(this.collection.data, {
          command, enabled: true, visible: true, id: uuid(),
        });
      }

      const pItem: Permissions.Item | null = await global.permissions.get(userlevel);
      if (!pItem) {
        throw Error('Permission ' + userlevel + ' not found.');
      }

      const rDb = await global.db.engine.find(this.collection.responses, { cid: cDb.id });
      await global.db.engine.insert(this.collection.responses, {
        cid: cDb.id,
        order: rDb.length,
        permission: pItem.id,
        stopIfExecuted,
        response,
      });
      sendMessage(prepare('customcmds.command-was-added', { command }), opts.sender, opts.attr);
    } catch (e) {
      sendMessage(prepare('customcmds.commands-parse-failed'), opts.sender, opts.attr);
    }
  }

  @parser({ priority: constants.LOW })
  async run (opts: ParserOptions) {
    if (!opts.message.startsWith('!')) {
      return true;
    } // do nothing if it is not a command
    const commands: {
      command: Types.CustomCommands.Command;
      cmdArray: string[];
    }[] = [];
    const cmdArray = opts.message.toLowerCase().split(' ');
    for (let i = 0, len = opts.message.toLowerCase().split(' ').length; i < len; i++) {
      const db_commands: Types.CustomCommands.Command[] = await global.db.engine.find(this.collection.data, { command: cmdArray.join(' '), enabled: true });
      for (const command of db_commands) {
        commands.push({
          cmdArray: _.cloneDeep(cmdArray),
          command,
        });
      }
      cmdArray.pop(); // remove last array item if not found
    }
    if (commands.length === 0) {
      return true;
    } // no command was found - return

    // go through all commands
    let atLeastOnePermissionOk = false;
    for (const command of commands) {
      const _responses: Types.CustomCommands.Response[] = [];
      // remove found command from message to get param
      const param = opts.message.replace(new RegExp('^(' + command.cmdArray.join(' ') + ')', 'i'), '').trim();
      const count = await incrementCountOfCommandUsage(command.command.command);
      const responses: Types.CustomCommands.Response[] = await global.db.engine.find(this.collection.responses, { cid: command.command.id });
      for (const r of _.orderBy(responses, 'order', 'asc')) {
        if ((await global.permissions.check(opts.sender.userId, r.permission)).access
            && await this.checkFilter(opts, r.filter)) {
          if (param.length > 0
            && !(r.response.includes('$param')
              || r.response.includes('$touser')
              || r.response.search(/\$_[a-zA-Z_]*/g) >= 0)) {
            continue;
          }
          _responses.push(r);
          atLeastOnePermissionOk = true;
          if (r.stopIfExecuted) {
            break;
          }
        }
      }
      this.sendResponse(_.cloneDeep(_responses), { param, sender: opts.sender, command: command.command.command, count });
    }
    return atLeastOnePermissionOk;
  }

  sendResponse(responses, opts) {
    for (let i = 0; i < responses.length; i++) {
      setTimeout(() => {
        sendMessage(responses[i].response, opts.sender, {
          param: opts.param,
          cmd: opts.command,
        });
      }, i * 750);
    }
  }

  @command('!command list')
  @default_permission(permission.CASTERS)
  async list (opts: CommandOptions) {
    const command = new Expects(opts.parameters).command({ optional: true }).toArray()[0];

    if (!command) {
      // print commands
      const commands = await global.db.engine.find(this.collection.data, { visible: true, enabled: true });
      const output = (commands.length === 0 ? global.translate('customcmds.list-is-empty') : global.translate('customcmds.list-is-not-empty').replace(/\$list/g, _.map(_.orderBy(commands, 'command'), 'command').join(', ')));
      sendMessage(output, opts.sender, opts.attr);
    } else {
      // print responses
      const cid = String((await global.db.engine.findOne(this.collection.data, { command })).id);
      const responses = _.orderBy((await global.db.engine.find(this.collection.responses, { cid })), 'order', 'asc');

      if (responses.length === 0) {
        sendMessage(prepare('customcmdustomcmds.list-of-responses-is-empty', { command }), opts.sender, opts.attr);
      }
      const permissions = (await global.db.engine.find(global.permissions.collection.data)).map((o) => {
        return {
          v: o.id, string: o.name,
        };
      });
      for (const r of responses) {
        const rPrmsn: any = permissions.find(o => o.v === r.permission);
        const response = await prepare('customcmds.response', { command, index: ++r.order, response: r.response, after: r.stopIfExecuted ? '_' : 'v', permission: rPrmsn.string });
        chatOut(`${response} [${opts.sender.username}]`);
        message(global.tmi.sendWithMe ? 'me' : 'say', getOwner(), response);
      }
    }
  }

  async togglePermission (opts: CommandOptions) {
    const command = await global.db.engine.findOne(this.collection.data, { command: opts.parameters });
    if (!_.isEmpty(command)) {
      await global.db.engine.update(this.collection.data, { id: command.id }, { permission: command.permission === 3 ? 0 : ++command.permission });
    }
  }

  @command('!command toggle')
  @default_permission(permission.CASTERS)
  async toggle (opts: CommandOptions) {
    const match = XRegExp.exec(opts.parameters, constants.COMMAND_REGEXP) as unknown as { [x: string]: string } | null;
    if (_.isNil(match)) {
      const message = await prepare('customcmds.commands-parse-failed');
      sendMessage(message, opts.sender, opts.attr);
      return false;
    }

    const command = await global.db.engine.findOne(this.collection.data, { command: match.command });
    if (_.isEmpty(command)) {
      const message = await prepare('customcmds.command-was-not-found', { command: match.command });
      sendMessage(message, opts.sender, opts.attr);
      return false;
    }

    await global.db.engine.update(this.collection.data, { command: match.command }, { enabled: !command.enabled });

    const message = await prepare(!command.enabled ? 'customcmds.command-was-enabled' : 'customcmds.command-was-disabled', { command: command.command });
    sendMessage(message, opts.sender, opts.attr);
  }

  @command('!command toggle-visibility')
  @default_permission(permission.CASTERS)
  async toggleVisibility (opts: CommandOptions) {
    const match = XRegExp.exec(opts.parameters, constants.COMMAND_REGEXP) as unknown as { [x: string]: string } | null;
    if (_.isNil(match)) {
      const message = await prepare('customcmds.commands-parse-failed');
      sendMessage(message, opts.sender, opts.attr);
      return false;
    }

    const command = await global.db.engine.findOne(this.collection.data, { command: match.command });
    if (_.isEmpty(command)) {
      const message = await prepare('customcmds.command-was-not-found', { command: match.command });
      sendMessage(message, opts.sender, opts.attr);
      return false;
    }

    await global.db.engine.update(this.collection.data, { command: match.command }, { visible: !command.visible });
    const message = await prepare(!command.visible ? 'customcmds.command-was-exposed' : 'customcmds.command-was-concealed', { command: command.command });
    sendMessage(message, opts.sender, opts.attr);
  }

  @command('!command remove')
  @default_permission(permission.CASTERS)
  async remove (opts: CommandOptions) {
    try {
      const [command, response] = new Expects(opts.parameters).command().number({ optional: true }).toArray();
      let cid = (await global.db.engine.findOne(this.collection.data, { command })).id;
      if (!cid) {
        sendMessage(prepare('customcmds.command-was-not-found', { command }), opts.sender, opts.attr);
      } else {
        cid = String(cid);
        if (response) {
          const order = Number(response) - 1;
          const removed = await global.db.engine.remove(this.collection.responses, { cid, order });
          if (removed > 0) {
            sendMessage(prepare('customcmds.response-was-removed', { command, response }), opts.sender, opts.attr);

            // update order
            const responses = _.orderBy(await global.db.engine.find(this.collection.responses, { cid }), 'order', 'asc');
            if (responses.length === 0) {
              // remove command if 0 responses
              await global.db.engine.remove(this.collection.data, { command });
            }

            let order = 0;
            for (const r of responses) {
              const _id = String(r._id); delete r._id;
              r.order = order;
              await global.db.engine.update(this.collection.responses, { _id }, r);
              order++;
            }
          } else {
            sendMessage(prepare('customcmds.response-was-not-found', { command, response }), opts.sender, opts.attr);
          }
        } else {
          await global.db.engine.remove(this.collection.data, { command });
          sendMessage(prepare('customcmds.command-was-removed', { command }), opts.sender, opts.attr);
        }
      }
    } catch (e) {
      return sendMessage(prepare('customcmds.commands-parse-failed'), opts.sender, opts.attr);
    }
  }

  async checkFilter (opts: CommandOptions | ParserOptions, filter: string) {
    if (typeof filter === 'undefined' || filter.trim().length === 0) {
      return true;
    }
    const toEval = `(function evaluation () { return ${filter} })()`;

    const $userObject = await global.users.getByName(opts.sender.username);
    let $rank = null;
    if (global.systems.ranks.enabled) {
      $rank = await global.systems.ranks.get($userObject);
    }

    const $is = {
      moderator: await isModerator(opts.sender.username),
      subscriber: await isSubscriber(opts.sender.username),
      vip: await isVIP(opts.sender.username),
      broadcaster: isBroadcaster(opts.sender.username),
      bot: isBot(opts.sender.username),
      owner: isOwner(opts.sender.username),
    };

    // get custom variables
    const customVariablesDb = await global.db.engine.find('custom.variables');
    const customVariables = {};
    for (const cvar of customVariablesDb) {
      customVariables[cvar.variableName] = cvar.currentValue;
    }

    const context = {
      _: _,
      $sender: opts.sender.username,
      $is,
      $rank,
      // add global variables
      $game: global.api.stats.currentGame || 'n/a',
      $title: global.api.stats.currentTitle || 'n/a',
      $views: global.api.stats.currentViews,
      $followers: global.api.stats.currentFollowers,
      $hosts: global.api.stats.currentHosts,
      $subscribers: global.api.stats.currentSubscribers,
      ...customVariables,
    };
    let result = false;
    try {
      result = safeEval(toEval, context);
    } catch (e) {
      // do nothing
    }
    delete context._;
    return !!result; // force boolean
  }
}

export default CustomCommands;
export { CustomCommands };
