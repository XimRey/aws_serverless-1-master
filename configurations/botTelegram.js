require("dotenv").config();

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

module.exports = {
    TELEGRAM_TOKEN,
    TELEGRAM_CHAT_ID
};