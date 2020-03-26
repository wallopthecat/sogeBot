import Core from './_interface';
import { settings, ui } from './decorators';
import { MINUTE, SECOND } from './constants';
import { isMainThread } from './cluster';
import { v4 as uuid } from 'uuid';
import { permission } from './helpers/permissions';
import { adminEndpoint, endpoints } from './helpers/socket';
import { onLoad } from './decorators/on';

import { getRepository, LessThanOrEqual } from 'typeorm';
import { Socket as SocketEntity, SocketInterface } from './database/entity/socket';
import permissions from './permissions';
import { debug, isDebugEnabled } from './helpers/log';
import { isDbConnected } from './helpers/database';
import { Dashboard } from './database/entity/dashboard';
import { isModerator } from './commons';
import { User } from './database/entity/user';

let _self: any = null;

const invalidatedTokens: { [token: string]: number } = {};
const latestAuthorizationPerToken: { [accessToken: string]: number } = new Proxy({}, {
  get: function (obj, prop) {
    if (typeof obj[prop] === 'undefined') {
      return 0;
    } else {
      return obj[prop];
    }
  },
  deleteProperty: function(obj, prop) {
    if (obj[prop]) {
      debug('sockets', 'Deleting property ' + String(prop));
      delete obj[prop];
    } else {
      debug('sockets', 'Property ' + String(prop) + ' already deleted');
    }
    return true;
  },
  set: function (obj, prop, value) {
    if (!Object.keys(invalidatedTokens).includes(String(prop))) {
      debug('sockets', 'Setting property ' + String(prop));
      obj[prop] = value;
    } else {
      debug('sockets', 'Skipping setting invalidated property ' + String(prop));
    }
    return true;
  },
});

enum Authorized {
  inProgress,
  NotAuthorized,
  Authorized,
}

if (isDebugEnabled('sockets')) {
  setInterval(() => {
    debug('sockets', {latestAuthorizationPerToken, invalidatedTokens});
  }, 10000);
}

setInterval(() => {
  for (const [token, timestamp] of Object.entries(invalidatedTokens)) {
    if (Date.now() - timestamp > 10 * MINUTE) {
      delete invalidatedTokens[token];
    }
  }
}, MINUTE);

const createDashboardIfNeeded = async (userId: number, opts: { haveAdminPrivileges: Authorized; haveModPrivileges: Authorized; haveViewerPrivileges: Authorized }) => {
  // create main admin dashboard if needed;
  if (opts.haveAdminPrivileges === Authorized.Authorized) {
    const mainDashboard = await getRepository(Dashboard).findOne({
      userId, name: 'Main', type: 'admin',
    });
    if (!mainDashboard) {
      await getRepository(Dashboard).save({
        name: 'Main', createdAt: 0, userId, type: 'admin',
      });
    }
  }

  // create main admin dashboard if needed;
  if (opts.haveModPrivileges === Authorized.Authorized) {
    const mainDashboard = await getRepository(Dashboard).findOne({
      userId, name: 'Main', type: 'mod',
    });
    if (!mainDashboard) {
      await getRepository(Dashboard).save({
        name: 'Main', createdAt: 0, userId, type: 'mod',
      });
    }
  }

  // create main viewer dashboard if needed;
  if (opts.haveViewerPrivileges === Authorized.Authorized) {
    const mainDashboard = await getRepository(Dashboard).findOne({
      userId, name: 'Main', type: 'viewer',
    });
    if (!mainDashboard) {
      await getRepository(Dashboard).save({
        name: 'Main', createdAt: 0, userId, type: 'viewer',
      });
    }
  }
};

const getPrivileges = async(type: SocketInterface['type'], userId: number) => {
  const user = await getRepository(User).findOne({ userId });
  return {
    haveAdminPrivileges: type === 'admin' ? Authorized.Authorized : Authorized.NotAuthorized,
    haveModPrivileges: isModerator(user) ? Authorized.Authorized : Authorized.NotAuthorized,
    haveViewerPrivileges: Authorized.Authorized };
};

class Socket extends Core {
  @settings('connection')
  accessTokenExpirationTime = 120;

  @settings('connection')
  refreshTokenExpirationTime = 604800;

  @settings('connection')
  @ui({
    type: 'uuid-generator',
  }, 'connection')
  socketToken = '';

  @ui({
    type: 'btn-emit',
    class: 'btn btn-danger btn-block mt-1 mb-1',
    emit: 'purgeAllConnections',
  }, 'connection')
  purgeAllConnections = null;
  @ui({
    type: 'socket-list',
  }, 'connection')
  socketsList = null;

  constructor() {
    super();

    if (isMainThread) {
      setInterval(() => {
        // remove expired tokens
        if (isDbConnected) {
          getRepository(SocketEntity).delete({
            refreshTokenTimestamp: LessThanOrEqual(Date.now()),
          });
        }
      }, MINUTE);

      setInterval(() => {
        // expire access token
        if (isDbConnected) {
          getRepository(SocketEntity).update({
            accessTokenTimestamp: LessThanOrEqual(Date.now()),
          }, {
            accessToken: null,
          });
        }
      }, 10 * SECOND);
    }
  }

  async authorize(socket, next) {
    let haveAdminPrivileges = Authorized.inProgress;
    let haveModPrivileges = Authorized.inProgress;
    let haveViewerPrivileges = Authorized.inProgress;
    let accessToken: null | string = null;
    const interval = setInterval(() => {
      if (accessToken && (typeof latestAuthorizationPerToken[accessToken] === 'undefined' || Date.now() - latestAuthorizationPerToken[accessToken] > MINUTE)) {
        latestAuthorizationPerToken[accessToken] = Date.now();
        accessToken = null;
        emitAuthorize(socket);
      }
    }, SECOND);

    socket.on('disconnect', () => {
      clearInterval(interval);
      if (accessToken) {
        invalidatedTokens[accessToken] = Date.now();
        delete latestAuthorizationPerToken[accessToken];
      }
    });

    const sendAuthorized = (socket, auth: Readonly<SocketInterface>) => {
      socket.emit('authorized', { accessToken: auth.accessToken, refreshToken: auth.refreshToken, type: auth.type });
    };
    const emitAuthorize = (socket) => {
      socket.emit('authorize', async (cb: { token: string; type: 'socket' | 'access' }) => {
        if (cb.type === 'socket') {
          // check if we have global socket
          if (cb.token === _self.socketToken) {
            haveAdminPrivileges = Authorized.Authorized;
            haveModPrivileges = Authorized.Authorized;
            haveViewerPrivileges = Authorized.Authorized;
            sendAuthorized(socket, {
              type: 'admin',
              accessToken: _self.socketToken,
              userId: 0,
              refreshToken: '',
              accessTokenTimestamp: 0,
              refreshTokenTimestamp: 0,
            });

            return;
          }

          haveAdminPrivileges = Authorized.NotAuthorized;
          haveModPrivileges = Authorized.NotAuthorized;
          haveViewerPrivileges = Authorized.NotAuthorized;
          return socket.emit('unauthorized');
        }

        if (cb.token === '' || !cb.token) {
          // we don't have anything
          haveAdminPrivileges = Authorized.NotAuthorized;
          haveModPrivileges = Authorized.NotAuthorized;
          haveViewerPrivileges = Authorized.NotAuthorized;
          return socket.emit('unauthorized');
        } else {
          let auth;
          if (cb.type === 'access') {
            if (Object.keys(invalidatedTokens).includes(cb.token)) {
              debug('sockets', `Invalidated access token - ${cb.token} used.`);
            } else {
              auth = await getRepository(SocketEntity).findOne({ accessToken: cb.token });
            }
            if (!auth) {
              debug('sockets', `Incorrect access token - ${cb.token}, asking for refresh token`);
              invalidatedTokens[cb.token] = Date.now();
              delete latestAuthorizationPerToken[cb.token];

              return socket.emit('refreshToken', async (cb: { userId: number; token: string }) => {
                auth = await getRepository(SocketEntity).findOne({ userId: cb.userId, refreshToken: cb.token });
                if (!auth) {
                  debug('sockets', `Incorrect refresh token for userId - ${cb.token}, ${cb.userId}`);
                  return socket.emit('unauthorized');
                } else {
                  auth.accessToken = uuid();

                  latestAuthorizationPerToken[auth.accessToken] = Date.now();
                  accessToken = auth.accessToken;

                  auth.accessTokenTimestamp = Date.now() + (_self.accessTokenExpirationTime * 1000);
                  auth.refreshTokenTimestamp = Date.now() + (_self.refreshTokenExpirationTime * 1000);
                  await getRepository(SocketEntity).save(auth);
                  debug('sockets', `Login OK by refresh token - ${cb.token}, access token set to ${auth.accessToken}`);

                  const privileges = await getPrivileges(auth.type, cb.userId);
                  haveAdminPrivileges = privileges.haveAdminPrivileges;
                  haveModPrivileges = privileges.haveModPrivileges;
                  haveViewerPrivileges = privileges.haveViewerPrivileges;
                  await createDashboardIfNeeded(cb.userId, { haveAdminPrivileges, haveModPrivileges, haveViewerPrivileges });

                  sendAuthorized(socket, auth);
                }
              });
            } else {
              // update refreshToken timestamp to expire only if not used
              auth.refreshTokenTimestamp = Date.now() + (_self.refreshTokenExpirationTime * 1000);

              latestAuthorizationPerToken[auth.accessToken] = Date.now();
              accessToken = auth.accessToken;

              await getRepository(SocketEntity).save(auth);
              const privileges = await getPrivileges(auth.type, auth.userId);
              haveAdminPrivileges = privileges.haveAdminPrivileges;
              haveModPrivileges = privileges.haveModPrivileges;
              haveViewerPrivileges = privileges.haveViewerPrivileges;
              await createDashboardIfNeeded(auth.userId, { haveAdminPrivileges, haveModPrivileges, haveViewerPrivileges });

              debug('sockets', `Login OK by access token - ${cb.token}`);
              sendAuthorized(socket, auth);

              if (auth.type === 'admin') {
                haveAdminPrivileges = Authorized.Authorized;
              } else {
                haveAdminPrivileges = Authorized.NotAuthorized;
              }
              haveViewerPrivileges = Authorized.Authorized;
            }
          }
        }
      });
    };

    socket.on('logout', async(tokens: { accessToken: string | null; refreshToken: string | null}) => {
      clearInterval(interval);
      debug('sockets', 'user::logout');
      debug('sockets', tokens);
      if (tokens.accessToken) {
        invalidatedTokens[tokens.accessToken] = Date.now();
        delete latestAuthorizationPerToken[tokens.accessToken];
        await getRepository(SocketEntity).delete({ accessToken: tokens.accessToken });
      }

      if (tokens.refreshToken) {
        await getRepository(SocketEntity).delete({ refreshToken: tokens.refreshToken });
      }
    });

    socket.on('newAuthorization', async (userData, cb) => {
      const userId = Number(userData.userId);
      const username = userData.username;

      const userPermission = await permissions.getUserHighestPermission(userId);
      const user = await getRepository(User).findOne({ userId });
      await getRepository(User).save({
        ...user,
        userId,
        username,
      });
      const auth: Readonly<SocketInterface> = {
        accessToken: uuid(),
        refreshToken: uuid(),
        accessTokenTimestamp: Date.now() + (_self.accessTokenExpirationTime * 1000),
        refreshTokenTimestamp: Date.now() + (_self.refreshTokenExpirationTime * 1000),
        userId: Number(userId),
        type: userPermission === permission.CASTERS ? 'admin' : 'viewer',
      };
      haveViewerPrivileges = Authorized.Authorized;
      if (userPermission === permission.CASTERS) {
        haveAdminPrivileges = Authorized.Authorized;
      } else {
        haveAdminPrivileges = Authorized.NotAuthorized;
      }
      await getRepository(SocketEntity).save(auth);
      sendAuthorized(socket, auth);

      cb();
    });
    emitAuthorize(socket);

    for (const endpoint of endpoints.filter(o => o.type === 'public' && o.nsp === socket.nsp.name)) {
      socket.removeAllListeners(endpoint.on);
      socket.on(endpoint.on, (...args) => {
        endpoint.callback(...args, socket);
      });
    }

    for (const endpoint of endpoints.filter(o => (o.type === 'admin') && o.nsp == socket.nsp.name)) {
      socket.removeAllListeners(endpoint.on);
      socket.on(endpoint.on, async (...args) => {
        await new Promise(resolve => {
          const waitForAuthorization = () => {
            if (haveAdminPrivileges !== Authorized.inProgress) {
              resolve();
            } else {
              setTimeout(waitForAuthorization, 10);
            }
          };
          waitForAuthorization();
        });

        if (haveAdminPrivileges === Authorized.Authorized) {
          endpoint.callback(...args, socket);
        } else {
          // check if we have public endpoint
          const publicEndpoint = endpoints.find(o => o.type === 'public' && o.nsp == socket.nsp.name && o.on === endpoint.on);
          if (publicEndpoint) {
            publicEndpoint.callback(...args, socket);
          } else {
            for (const arg of args) {
              if (typeof arg === 'function') {
                arg('User doesn\'t have access to this endpoint', null);
              }
            }
          }
        }
      });
    }

    for (const endpoint of endpoints.filter(o => (o.type === 'viewer') && o.nsp == socket.nsp.name)) {
      socket.removeAllListeners(endpoint.on);
      socket.on(endpoint.on, async (...args) => {
        await new Promise(resolve => {
          const waitForAuthorization = () => {
            if (haveViewerPrivileges !== Authorized.inProgress) {
              resolve();
            } else {
              setTimeout(waitForAuthorization, 10);
            }
          };
          waitForAuthorization();
        });

        if (haveViewerPrivileges === Authorized.Authorized) {
          endpoint.callback(...args, socket);
        } else {
          for (const arg of args) {
            if (typeof arg === 'function') {
              arg('User doesn\'t have access to this endpoint', null);
            }
          }
        }
      });
    }

    next();
  }

  sockets () {
    adminEndpoint(this.nsp, 'purgeAllConnections', (cb) => {
      getRepository(SocketEntity).clear();
      cb(null);
    });
    adminEndpoint(this.nsp, 'listConnections', async (cb) => {
      cb(null, await getRepository(SocketEntity).find());
    });
    adminEndpoint(this.nsp, 'removeConnection', async (item: Required<SocketInterface>, cb) => {
      cb(null, await getRepository(SocketEntity).remove(item));
    });
  }

  @onLoad('socketToken')
  generateSocketTokenIfNeeded() {
    if (this.socketToken === '') {
      this.socketToken = uuid();
    }
  }
}

_self = new Socket();
export default _self;
export { Socket };