const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const QuizTimer = sequelize.define('QuizTimer', {
  guildId: {
    type: DataTypes.STRING,
    primaryKey: true,
    allowNull: false
  },
  durationMinutes: {
    type: DataTypes.INTEGER,
    allowNull: false,
    defaultValue: 5
  },
  isActive: {
    type: DataTypes.BOOLEAN,
    allowNull: false,
    defaultValue: false
  },
  startTime: {
    type: DataTypes.DATE,
    allowNull: true
  },
  endTime: {
    type: DataTypes.DATE,
    allowNull: true
  }
});

module.exports = QuizTimer;