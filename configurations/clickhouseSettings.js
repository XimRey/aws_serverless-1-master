require('dotenv').config();
const { createClient } = require('@clickhouse/client');

const clickHouseclient = createClient({
  host: process.env.CLICKHOUSE_HOST,
  username: process.env.CLICKHOUSE_USERNAME,
  password: process.env.CLICKHOUSE_PASSWORD,
  database: process.env.CLICKHOUSE_DATABASE,
  tls: {
    rejectUnauthorized: true,
  },
});


module.exports = clickHouseclient;