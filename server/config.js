const { loadEnvFile } = require("node:process");

try {
  loadEnvFile();
} catch (error) {
  if (error.code !== "ENOENT") {
    console.warn(error);
  }
}

module.exports = {
  HOST: process.env.HOST || "0.0.0.0",
  PORT: Number(process.env.PORT || 8080),
  PUBLIC_DIRECTORY: process.env.PUBLIC_DIRECTORY || "public",
};
