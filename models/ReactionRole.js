const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const ReactionRole = sequelize.define('ReactionRole', {
  messageId: {
    type: DataTypes.STRING,
    allowNull: false
  },
  channelId: {
    type: DataTypes.STRING,
    allowNull: false
  },
  guildId: {
    type: DataTypes.STRING,
    allowNull: false
  },
  emoji: {
    type: DataTypes.STRING,
    allowNull: false
  },
  roleId: {
    type: DataTypes.STRING,
    allowNull: false
  }
}, {
  indexes: [
    {
      unique: true,
      fields: ['messageId', 'emoji']
    }
  ]
});

module.exports = ReactionRole;