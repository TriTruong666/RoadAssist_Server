const { S3Client } = require("@aws-sdk/client-s3");
const config = require("./app.config").s3;
module.exports = new S3Client({
  region: config.region,
  ...(config.endpoint && { endpoint: config.endpoint, forcePathStyle: true }),
  ...(config.accessKeyId &&
    config.secretAccessKey && {
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
    }),
});
