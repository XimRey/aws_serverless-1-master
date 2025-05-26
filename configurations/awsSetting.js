'use strict';
const AWS = require('aws-sdk');
const Athena = require('aws-sdk/clients/athena');

// Configure AWS SDK
AWS.config.update({
    region: 'us-east-1',
    accessKeyId: process.env.ACCES_KEY_ID_ENV_VAR,
    secretAccessKey: process.env.SECRET_ACCES_KEY_ENV_VAR
});

const athena = new Athena();
const ses = new AWS.SES();

module.exports = {
    athena,
    ses
};
