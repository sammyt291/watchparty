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
  CLIENT_DIRECTORY: process.env.CLIENT_DIRECTORY || ".",
};
