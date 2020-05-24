const { getRepository } = require('typeorm');
const { User } = require('../../dest/database/entity/user');

const viewer = {
  userId: 1,
  username: '__viewer__',
  badges: {},
  emotes: [],
};

const viewer2 = {
  userId: 3,
  username: '__viewer2__',
  badges: {},
  emotes: [],
};

const owner = {
  userId: 2,
  username: 'soge',
  badges: {},
  emotes: [],
};

module.exports = {
  prepare: async () => {
    await getRepository(User).save(viewer);
    await getRepository(User).save(viewer2);
    await getRepository(User).save(owner);
  },
  viewer,
  viewer2,
  owner,
};
