const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const Quiz = sequelize.define('Quiz', {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true
  },
  question: {
    type: DataTypes.STRING(1000),
    allowNull: false
  },
  optionA: {
    type: DataTypes.STRING(500),
    allowNull: false
  },
  optionB: {
    type: DataTypes.STRING(500),
    allowNull: false
  },
  optionC: {
    type: DataTypes.STRING(500),
    allowNull: false
  },
  optionD: {
    type: DataTypes.STRING(500),
    allowNull: false
  },
  correctAnswer: {
    type: DataTypes.STRING(1),
    allowNull: false,
    validate: {
      isIn: [['A', 'B', 'C', 'D']]
    }
  },
  createdBy: {
    type: DataTypes.STRING,
    allowNull: false
  },
  guildId: {
    type: DataTypes.STRING,
    allowNull: false
  }
});

module.exports = Quiz;