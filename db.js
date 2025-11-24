// db.js
const mysql = require('mysql2');

const pool = mysql.createPool({
  host: 'localhost',      // change if needed
  user: 'root',           // change if needed
  password: 'sanjana@2802',           // change if needed
  database: 'social_media', // change to your DB name
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

// Promise wrapper
const db = pool.promise();

module.exports = db;
